// audio.cs —— 常驻 WASAPI 音频采集工作进程（C# 5 语法，勿用 $"" 插值）
//
// 一个进程内同时采集两路：
//   流 0 = 系统回环（默认渲染端点 + AUDCLNT_STREAMFLAGS_LOOPBACK）
//   流 1 = 麦克风（默认或指定采集端点）
// 两路都转换为 48 kHz 立体声 Float32 平面数据，按 20 ms（960 帧）一块输出。
//
// 为什么自己做而不是用 Chromium 的 getUserMedia：
//   系统回环在 Chromium 里需要 loopback 标志，本机实测会挂起；WASAPI 直接调用已验证可用。
//
// 协议（stdout），每个包：
//   uint32 totalLen        整个包（含本头）的字节数
//   uint32 streamId        0=系统, 1=麦克风, 0xFFFFFFFF=错误
//   int32  startFrame      该块首个采样在 48 kHz 时间轴上的帧序号
//   float32 rms            该块均方根电平 0..1
//   int64  qpcPosition     该块首个采样对应的 QPC 时刻（§9.2 统一时间基准）
//   float32 L[frames]      左声道
//   float32 R[frames]      右声道
// 错误包：streamId=0xFFFFFFFF，其后为 uint32 codeLen + UTF8 消息。
//
// 为什么必须带 qpcPosition：
//   系统回环与麦克风是两条独立的设备时钟，启动时刻也不同（实测回环首包比麦克风晚约 0.9 秒）。
//   若只用「帧序号」当作时间，两路音轨会相对错位，音画也不同步。
//   带上 WASAPI 返回的 qpcPosition 后，主进程可把两路音频与视频帧统一到同一条 QPC 时间轴上。
//
// 协议（stdin）："q\n" 退出。
//
// 命令行：
//   audio.cs.exe [--system] [--mic <endpointId>] [--no-system] [--no-mic]
//   audio.cs.exe --list-devices        输出 JSON 设备清单后退出
//
// 编译：
//   csc /nologo /optimize+ /out:audio.exe audio.cs

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class AudioWorker
{
    // ------------------------------------------------------------------
    // COM 互操作
    // ------------------------------------------------------------------

    private const int CLSCTX_ALL = 23;
    private const int eRender = 0;
    private const int eCapture = 1;
    private const int DEVICE_STATE_ACTIVE = 0x00000001;
    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const int STREAM_FLAGS_EVENTCALLBACK = 0x00040000;
    private const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);

    private const short WAVE_FORMAT_PCM = 1;
    private const short WAVE_FORMAT_IEEE_FLOAT = 3;
    private const short WAVE_FORMAT_EXTENSIBLE = unchecked((short)0xFFFE);

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IPropertyStore props);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        int GetCount(out int count);
        int GetAt(int index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, IntPtr value);
        int SetValue(ref PROPERTYKEY key, IntPtr value);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out int frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out int padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(int frames);
        int GetNextPacketSize(out int frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEX
    {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public short wValidBitsPerSample;
        public int dwChannelMask;
        public Guid SubFormat;
    }

    // ------------------------------------------------------------------
    // 全局状态
    // ------------------------------------------------------------------

    private const int TARGET_RATE = 48000;
    private const int BLOCK_FRAMES = 960; // 20 ms

    private static Stream _stdout;
    private static readonly object _writeLock = new object();
    private static volatile bool _quit = false;

    private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT =
        new Guid("00000003-0000-0010-8000-00AA00389B71");
    private static readonly Guid KSDATAFORMAT_SUBTYPE_PCM =
        new Guid("00000001-0000-0010-8000-00AA00389B71");

    [StructLayout(LayoutKind.Explicit)]
    private struct FloatInt32
    {
        [FieldOffset(0)] public float Float;
        [FieldOffset(0)] public int Int;
    }

    /// <summary>
    /// 无分配地写 little-endian float32。
    /// 旧实现每写一个采样就 BitConverter.GetBytes 一次（每 20ms 包约 1920 次小数组分配），
    /// 50 包/秒就是近 10 万次分配/秒，长期录制持续给 GC 加压。
    /// </summary>
    private static void WriteFloatLE(byte[] buffer, int offset, float value)
    {
        FloatInt32 v = new FloatInt32();
        v.Float = value;
        int bits = v.Int;
        buffer[offset] = (byte)(bits & 0xFF);
        buffer[offset + 1] = (byte)((bits >> 8) & 0xFF);
        buffer[offset + 2] = (byte)((bits >> 16) & 0xFF);
        buffer[offset + 3] = (byte)((bits >> 24) & 0xFF);
    }

    private static void Log(string message)
    {
        Console.Error.WriteLine(message);
        Console.Error.Flush();
    }

    private static void WritePacket(int streamId, int startFrame, float rms, long qpcPosition, float[] left, float[] right)
    {
        int frames = left.Length;
        int total = 24 + frames * 8;
        byte[] buffer = new byte[total];
        buffer[0] = (byte)(total & 0xFF);
        buffer[1] = (byte)((total >> 8) & 0xFF);
        buffer[2] = (byte)((total >> 16) & 0xFF);
        buffer[3] = (byte)((total >> 24) & 0xFF);
        buffer[4] = (byte)(streamId & 0xFF);
        buffer[5] = (byte)((streamId >> 8) & 0xFF);
        buffer[6] = (byte)((streamId >> 16) & 0xFF);
        buffer[7] = (byte)((streamId >> 24) & 0xFF);
        buffer[8] = (byte)(startFrame & 0xFF);
        buffer[9] = (byte)((startFrame >> 8) & 0xFF);
        buffer[10] = (byte)((startFrame >> 16) & 0xFF);
        buffer[11] = (byte)((startFrame >> 24) & 0xFF);
        byte[] rmsBytes = BitConverter.GetBytes(rms);
        Buffer.BlockCopy(rmsBytes, 0, buffer, 12, 4);
        for (int i = 0; i < 8; i++)
        {
            buffer[16 + i] = (byte)((qpcPosition >> (8 * i)) & 0xFF);
        }
        int offset = 24;
        for (int i = 0; i < frames; i++)
        {
            WriteFloatLE(buffer, offset, left[i]);
            offset += 4;
        }
        for (int i = 0; i < frames; i++)
        {
            WriteFloatLE(buffer, offset, right[i]);
            offset += 4;
        }
        try
        {
            lock (_writeLock)
            {
                _stdout.Write(buffer, 0, buffer.Length);
                _stdout.Flush();
            }
        }
        catch (IOException)
        {
            _quit = true;
        }
        catch (ObjectDisposedException)
        {
            _quit = true;
        }
    }

    private static void WriteError(int streamId, string code, string message)
    {
        byte[] msg = Encoding.UTF8.GetBytes(message ?? "");
        byte[] codeBytes = Encoding.UTF8.GetBytes(code ?? "");
        int total = 20 + codeBytes.Length + msg.Length;
        byte[] buffer = new byte[total];
        buffer[0] = (byte)(total & 0xFF);
        buffer[1] = (byte)((total >> 8) & 0xFF);
        buffer[2] = (byte)((total >> 16) & 0xFF);
        buffer[3] = (byte)((total >> 24) & 0xFF);
        buffer[4] = 0xFF; buffer[5] = 0xFF; buffer[6] = 0xFF; buffer[7] = 0xFF;
        buffer[8] = (byte)(streamId & 0xFF);
        buffer[9] = (byte)((streamId >> 8) & 0xFF);
        buffer[10] = (byte)((streamId >> 16) & 0xFF);
        buffer[11] = (byte)((streamId >> 24) & 0xFF);
        byte[] codeLen = BitConverter.GetBytes(codeBytes.Length);
        Buffer.BlockCopy(codeLen, 0, buffer, 12, 4);
        byte[] msgLen = BitConverter.GetBytes(msg.Length);
        Buffer.BlockCopy(msgLen, 0, buffer, 16, 4);
        Buffer.BlockCopy(codeBytes, 0, buffer, 20, codeBytes.Length);
        Buffer.BlockCopy(msg, 0, buffer, 20 + codeBytes.Length, msg.Length);
        try
        {
            lock (_writeLock)
            {
                _stdout.Write(buffer, 0, buffer.Length);
                _stdout.Flush();
            }
        }
        catch { }
    }

    // ------------------------------------------------------------------
    // 设备枚举
    // ------------------------------------------------------------------

    private static string GetFriendlyName(IMMDevice device)
    {
        IPropertyStore store;
        if (device.OpenPropertyStore(0, out store) != 0 || store == null) return null;
        try
        {
            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
            key.pid = 14;
            IntPtr pv = Marshal.AllocCoTaskMem(32);
            try
            {
                for (int i = 0; i < 32; i++) Marshal.WriteByte(pv, i, 0);
                int hr = store.GetValue(ref key, pv);
                if (hr != 0) return null;
                short vt = Marshal.ReadInt16(pv, 0);
                if (vt != 31) // VT_LPWSTR
                {
                    // 非字符串类型也可能持有需要释放的指针（VT_BSTR/VT_UNKNOWN 等），
                    // 统一交给 PropVariantClear，避免设备枚举路径泄漏 COM 内存。
                    NativeMethods.PropVariantClear(pv);
                    return null;
                }
                IntPtr str = Marshal.ReadIntPtr(pv, 8);
                if (str == IntPtr.Zero)
                {
                    NativeMethods.PropVariantClear(pv);
                    return null;
                }
                string name = Marshal.PtrToStringUni(str);
                NativeMethods.PropVariantClear(pv);
                return name;
            }
            finally
            {
                Marshal.FreeCoTaskMem(pv);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(store);
        }
    }

    private static string JsonEscape(string text)
    {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder(text.Length + 8);
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    private static int ListDevices()
    {
        var items = new List<string>();
        IMMDeviceEnumerator enumerator = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            int[] flows = new int[] { eRender, eCapture };
            string[] kinds = new string[] { "audiooutput", "audioinput" };
            string[] defaultIds = new string[2];
            for (int f = 0; f < 2; f++)
            {
                IMMDevice def;
                if (enumerator.GetDefaultAudioEndpoint(flows[f], 0, out def) == 0 && def != null)
                {
                    string id;
                    if (def.GetId(out id) == 0) defaultIds[f] = id;
                    Marshal.ReleaseComObject(def);
                }
            }
            for (int f = 0; f < 2; f++)
            {
                IMMDeviceCollection collection;
                if (enumerator.EnumAudioEndpoints(flows[f], DEVICE_STATE_ACTIVE, out collection) != 0 || collection == null) continue;
                int count;
                collection.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IMMDevice device;
                    if (collection.Item(i, out device) != 0 || device == null) continue;
                    try
                    {
                        string id;
                        if (device.GetId(out id) != 0 || string.IsNullOrEmpty(id)) continue;
                        string name = GetFriendlyName(device);
                        if (string.IsNullOrEmpty(name)) name = kinds[f] + " " + i;
                        bool isDefault = defaultIds[f] == id;
                        items.Add("{\"deviceId\":\"" + JsonEscape(id) + "\",\"label\":\"" + JsonEscape(name)
                            + "\",\"kind\":\"" + kinds[f] + "\",\"isDefault\":" + (isDefault ? "true" : "false") + "}");
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(device);
                    }
                }
                Marshal.ReleaseComObject(collection);
            }
        }
        catch (Exception ex)
        {
            Log("LIST_ERROR " + ex.GetType().Name + ": " + ex.Message);
            Console.WriteLine("[]");
            return 5;
        }
        finally
        {
            // 设备枚举器的 RCW 之前从不释放：每次枚举都泄漏一个 COM 对象。
            try { if (enumerator != null) Marshal.ReleaseComObject(enumerator); } catch { }
        }
        Console.WriteLine("[" + string.Join(",", items.ToArray()) + "]");
        Console.Out.Flush();
        return 0;
    }

    // ------------------------------------------------------------------
    // 采集流
    // ------------------------------------------------------------------

    private sealed class StreamConfig
    {
        public int Id;
        public string Label;
        public int Flow;
        public bool Loopback;
        public string EndpointId;
        public int SourceRate;
        public int SourceChannels;
        public bool IsFloat;
        public int BitsPerSample;
        public int BlockAlign;
    }

    private static long _qpcFrequency = 10000000L;

    /// <summary>
    /// 把交错原始字节转换为 48 kHz 立体声平面块，并按 960 帧一块发出。
    /// 每个输出块携带其首采样对应的 QPC 时刻，用于把两路音频与视频统一到同一时间轴。
    /// </summary>
    private sealed class StreamPump
    {
        private readonly StreamConfig _config;
        private readonly float[] _outL = new float[BLOCK_FRAMES];
        private readonly float[] _outR = new float[BLOCK_FRAMES];
        private int _outCount;
        private int _frameCursor;
        private double _phase;
        private float _prevL;
        private float _prevR;
        private bool _hasPrev;
        private long _blockStartQpc;
        private bool _hasQpc;

        public StreamPump(StreamConfig config)
        {
            _config = config;
            _frameCursor = 0;
            _phase = 0;
        }

        private float ReadSample(byte[] data, int byteOffset)
        {
            if (_config.IsFloat)
            {
                return BitConverter.ToSingle(data, byteOffset);
            }
            int bits = _config.BitsPerSample;
            if (bits == 16)
            {
                short v = (short)(data[byteOffset] | (data[byteOffset + 1] << 8));
                return v / 32768.0f;
            }
            if (bits == 24)
            {
                int v = data[byteOffset] | (data[byteOffset + 1] << 8) | (data[byteOffset + 2] << 16);
                if ((v & 0x800000) != 0) v |= unchecked((int)0xFF000000);
                return v / 8388608.0f;
            }
            if (bits == 32)
            {
                int v = data[byteOffset] | (data[byteOffset + 1] << 8) | (data[byteOffset + 2] << 16) | (data[byteOffset + 3] << 24);
                return (float)(v / 2147483648.0);
            }
            return 0f;
        }

        /// <summary>
        /// 处理一块交错输入，必要时按 48 kHz 重采样并发出 20 ms 包。
        /// qpcPosition 为该块首个源采样对应的 QPC 时刻。
        /// </summary>
        public void Process(byte[] data, int frames, long qpcPosition)
        {
            int channels = _config.SourceChannels;
            int blockAlign = _config.BlockAlign;
            if (channels <= 0 || blockAlign <= 0 || frames <= 0) return;

            double step = _config.SourceRate / (double)TARGET_RATE;
            for (int i = 0; i < frames; i++)
            {
                int baseOffset = i * blockAlign;
                float l;
                float r;
                if (channels == 1)
                {
                    l = ReadSample(data, baseOffset);
                    r = l;
                }
                else
                {
                    l = ReadSample(data, baseOffset);
                    r = ReadSample(data, baseOffset + (blockAlign / channels));
                }

                // 该源采样对应的 QPC 时刻。
                // 注意：WASAPI 的 qpcPosition 单位是 100 纳秒，不是 QPC 原始计数，
                // 因此先按 100ns 推进，再换算到 QPC 原始计数，与视频帧时间戳同一基准。
                long sampleQpc100ns = qpcPosition + (long)(i * (double)10000000L / _config.SourceRate);
                long sampleQpc = (long)(sampleQpc100ns * (double)_qpcFrequency / 10000000.0);

                // 线性插值重采样：输出点落在 [prev, cur] 之间
                if (!_hasPrev)
                {
                    _prevL = l;
                    _prevR = r;
                    _hasPrev = true;
                }
                while (_phase < 1.0)
                {
                    float t = (float)_phase;
                    float ol = _prevL + (l - _prevL) * t;
                    float or_ = _prevR + (r - _prevR) * t;
                    PushSample(ol, or_, sampleQpc);
                    _phase += step;
                }
                _phase -= 1.0;
                _prevL = l;
                _prevR = r;
            }
        }

        private void PushSample(float l, float r, long qpc)
        {
            if (_outCount == 0)
            {
                _blockStartQpc = qpc;
                _hasQpc = true;
            }
            _outL[_outCount] = l;
            _outR[_outCount] = r;
            _outCount++;
            if (_outCount >= BLOCK_FRAMES)
            {
                Flush();
            }
        }

        public void Flush()
        {
            if (_outCount == 0) return;
            float[] l = new float[_outCount];
            float[] r = new float[_outCount];
            Array.Copy(_outL, l, _outCount);
            Array.Copy(_outR, r, _outCount);
            double sum = 0;
            for (int i = 0; i < _outCount; i++)
            {
                double a = l[i];
                double b = r[i];
                sum += a * a + b * b;
            }
            float rms = (float)Math.Sqrt(sum / (_outCount * 2));
            if (rms > 1f) rms = 1f;
            WritePacket(_config.Id, _frameCursor, rms, _hasQpc ? _blockStartQpc : 0L, l, r);
            _frameCursor += _outCount;
            _outCount = 0;
            _hasQpc = false;
        }
    }

    private static void RunStream(StreamConfig config)
    {
        IMMDevice device = null;
        IAudioClient client = null;
        IAudioCaptureClient capture = null;
        IMMDeviceEnumerator enumerator = null;
        IntPtr mixFormatPtr = IntPtr.Zero;
        try
        {
            enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            int hr;
            if (string.IsNullOrEmpty(config.EndpointId))
            {
                hr = enumerator.GetDefaultAudioEndpoint(config.Flow, 0, out device);
            }
            else
            {
                hr = enumerator.GetDevice(config.EndpointId, out device);
            }
            // HRESULT 判断必须用 FAILED(hr)（hr < 0）：COM 成功码可能是非 0 正数
            // （如 S_FALSE / AUDCLNT_S_BUFFER_EMPTY），旧写法把它们当失败会误报设备错误。
            if (hr < 0 || device == null)
            {
                WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 无法打开（hr=0x" + hr.ToString("X8") + "）");
                return;
            }

            Guid iid = typeof(IAudioClient).GUID;
            object obj;
            hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj);
            if (hr < 0 || obj == null)
            {
                WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 激活失败（hr=0x" + hr.ToString("X8") + "）");
                return;
            }
            client = (IAudioClient)obj;

            hr = client.GetMixFormat(out mixFormatPtr);
            if (hr < 0 || mixFormatPtr == IntPtr.Zero)
            {
                WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 读取格式失败（hr=0x" + hr.ToString("X8") + "）");
                return;
            }

            var wf = (WAVEFORMATEX)Marshal.PtrToStructure(mixFormatPtr, typeof(WAVEFORMATEX));
            config.SourceRate = wf.nSamplesPerSec;
            config.SourceChannels = wf.nChannels;
            config.BitsPerSample = wf.wBitsPerSample;
            config.BlockAlign = wf.nBlockAlign;
            config.IsFloat = false;

            short tag = wf.wFormatTag;
            if (tag == WAVE_FORMAT_IEEE_FLOAT)
            {
                config.IsFloat = true;
            }
            else if (tag == WAVE_FORMAT_EXTENSIBLE)
            {
                var ext = (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(mixFormatPtr, typeof(WAVEFORMATEXTENSIBLE));
                if (ext.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) config.IsFloat = true;
                else if (ext.SubFormat == KSDATAFORMAT_SUBTYPE_PCM) config.IsFloat = false;
                if (ext.wValidBitsPerSample > 0 && ext.wValidBitsPerSample <= wf.wBitsPerSample)
                {
                    config.BitsPerSample = ext.wValidBitsPerSample;
                }
            }

            Log("STREAM " + config.Id + " " + config.Label + " fmt tag=" + tag + " ch=" + wf.nChannels
                + " rate=" + wf.nSamplesPerSec + " bits=" + wf.wBitsPerSample
                + " blockAlign=" + wf.nBlockAlign + " float=" + config.IsFloat);

            int flags = config.Loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
            hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2000000, 0, mixFormatPtr, IntPtr.Zero);
            if (hr < 0)
            {
                WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 初始化失败（hr=0x" + hr.ToString("X8") + "）");
                return;
            }

            Guid capIid = typeof(IAudioCaptureClient).GUID;
            object capObj;
            hr = client.GetService(ref capIid, out capObj);
            if (hr < 0 || capObj == null)
            {
                WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 获取采集接口失败（hr=0x" + hr.ToString("X8") + "）");
                return;
            }
            capture = (IAudioCaptureClient)capObj;

            int bufferFrames;
            client.GetBufferSize(out bufferFrames);

            hr = client.Start();
            if (hr < 0)
            {
                WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 启动失败（hr=0x" + hr.ToString("X8") + "）");
                return;
            }

            Log("STARTED " + config.Id + " bufferFrames=" + bufferFrames);
            var pump = new StreamPump(config);
            byte[] scratch = new byte[65536];
            // 静音包复用同一块零缓冲：旧实现每包 new byte[]（7.5KB），
            // 回环长时间静音时是纯 GC 垃圾。
            byte[] silentScratch = new byte[65536];
            int silentRun = 0;

            while (!_quit)
            {
                int next;
                hr = capture.GetNextPacketSize(out next);
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED)
                {
                    WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 设备已断开");
                    return;
                }
                if (hr < 0)
                {
                    WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 读取失败（hr=0x" + hr.ToString("X8") + "）");
                    return;
                }
                if (next <= 0)
                {
                    Thread.Sleep(4);
                    silentRun++;
                    // 连续 2 秒无数据时提示（回环静音是正常现象，不当作错误）
                    if (silentRun == 500) Log("IDLE " + config.Id + " 暂无数据");
                    continue;
                }
                silentRun = 0;

                while (next > 0 && !_quit)
                {
                    IntPtr data;
                    int frames;
                    int packetFlags;
                    long devicePosition;
                    long qpcPosition;
                    hr = capture.GetBuffer(out data, out frames, out packetFlags, out devicePosition, out qpcPosition);
                    if (hr == AUDCLNT_E_DEVICE_INVALIDATED)
                    {
                        WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 设备已断开");
                        return;
                    }
                    if (hr < 0)
                    {
                        // 旧实现这里 break 后回到外层再取包长，若错误持续存在会变成
                        // 「读失败→取包长>0→再读失败」的 100% CPU 忙循环。直接上报并退出该流。
                        WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 采集失败（hr=0x" + hr.ToString("X8") + "）");
                        return;
                    }
                    if (frames <= 0)
                    {
                        capture.ReleaseBuffer(frames);
                        break;
                    }
                    bool silent = (packetFlags & 2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                    if (silent)
                    {
                        int bytes = frames * config.BlockAlign;
                        if (silentScratch.Length < bytes) silentScratch = new byte[bytes];
                        else Array.Clear(silentScratch, 0, bytes);
                        pump.Process(silentScratch, frames, qpcPosition);
                    }
                    else if (data != IntPtr.Zero)
                    {
                        int bytes = frames * config.BlockAlign;
                        if (scratch.Length < bytes) scratch = new byte[bytes];
                        Marshal.Copy(data, scratch, 0, bytes);
                        pump.Process(scratch, frames, qpcPosition);
                    }
                    capture.ReleaseBuffer(frames);
                    hr = capture.GetNextPacketSize(out next);
                    if (hr < 0) next = 0;
                }
            }
            pump.Flush();
        }
        catch (Exception ex)
        {
            WriteError(config.Id, "E_AUDIO_DEVICE_LOST", config.Label + " 异常：" + ex.GetType().Name + " " + ex.Message);
            Log("STREAM_EXCEPTION " + config.Id + " " + ex);
        }
        finally
        {
            try { if (client != null) client.Stop(); } catch { }
            try { if (mixFormatPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormatPtr); } catch { }
            try { if (capture != null) Marshal.ReleaseComObject(capture); } catch { }
            try { if (client != null) Marshal.ReleaseComObject(client); } catch { }
            try { if (device != null) Marshal.ReleaseComObject(device); } catch { }
            // 设备枚举器 RCW 之前从不释放：每路流启动都泄漏一个 COM 对象
            try { if (enumerator != null) Marshal.ReleaseComObject(enumerator); } catch { }
        }
    }

    private static int Main(string[] args)
    {
        bool listOnly = false;
        bool enableSystem = true;
        bool enableMic = true;
        string micId = null;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--list-devices") listOnly = true;
            else if (a == "--no-system") enableSystem = false;
            else if (a == "--no-mic") enableMic = false;
            else if (a == "--mic" && i + 1 < args.Length) { micId = args[++i]; }
        }

        if (listOnly) return ListDevices();

        try { NativeMethods.CoInitializeEx(IntPtr.Zero, 0); }
        catch { }

        // QPC 频率：与 grabber 使用同一基准，保证音视频可对齐（§9.2）
        try
        {
            long freq;
            if (NativeMethods.QueryPerformanceFrequency(out freq) && freq > 0) _qpcFrequency = freq;
        }
        catch { }
        Log("QPCFREQ " + _qpcFrequency);

        _stdout = Console.OpenStandardOutput();

        Thread stdinThread = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Trim() == "q") { _quit = true; break; }
                }
            }
            catch { }
            _quit = true;
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();

        var threads = new List<Thread>();
        if (enableSystem)
        {
            StreamConfig system = new StreamConfig();
            system.Id = 0;
            system.Label = "system";
            system.Flow = eRender;
            system.Loopback = true;
            system.EndpointId = null;
            Thread t = new Thread(delegate() { RunStream(system); });
            t.IsBackground = true;
            threads.Add(t);
        }
        if (enableMic)
        {
            StreamConfig mic = new StreamConfig();
            mic.Id = 1;
            mic.Label = "mic";
            mic.Flow = eCapture;
            mic.Loopback = false;
            mic.EndpointId = micId;
            Thread t = new Thread(delegate() { RunStream(mic); });
            t.IsBackground = true;
            threads.Add(t);
        }

        for (int i = 0; i < threads.Count; i++) threads[i].Start();
        Log("READY streams=" + threads.Count);

        for (int i = 0; i < threads.Count; i++) threads[i].Join();
        Log("DONE");
        return 0;
    }

    private static class NativeMethods
    {
        [DllImport("ole32.dll")]
        public static extern int CoInitializeEx(IntPtr reserved, int coInit);

        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(IntPtr pvar);

        [DllImport("kernel32.dll")]
        public static extern bool QueryPerformanceFrequency(out long frequency);
    }
}
