// spike-loopback.cs 鈥斺€?鎾斁闊抽鐨勫悓鏃堕獙璇?WASAPI 鍥炵幆鑳藉惁鎹曡幏绯荤粺澹伴煶
// 缂栬瘧锛歝sc.exe /nologo /optimize+ /out:spike-loopback.exe spike-loopback.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Threading;

static class LoopbackProbe
{
    const int CLSCTX_ALL = 23;
    const int eRender = 0;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
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
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(int frames);
        int GetNextPacketSize(out int frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WAVEFORMATEX
    {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    static void Main(string[] args)
    {
        int seconds = args.Length > 0 ? int.Parse(args[0]) : 3;
        string wavOut = args.Length > 1 ? args[1] : Path.Combine(Environment.CurrentDirectory, "loopback-capture.wav");

        try
        {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            enumerator.GetDefaultAudioEndpoint(eRender, 0, out device);
            var iid = typeof(IAudioClient).GUID;
            object obj;
            int hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj);
            var client = (IAudioClient)obj;
            IntPtr fmtPtr;
            client.GetMixFormat(out fmtPtr);
            var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
            hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, fmtPtr, IntPtr.Zero);
            if (hr != 0) { Console.WriteLine("Initialize failed 0x" + hr.ToString("X8")); return; }
            var iidCap = typeof(IAudioCaptureClient).GUID;
            object capObj;
            client.GetService(ref iidCap, out capObj);
            var capture = (IAudioCaptureClient)capObj;
            client.Start();

            // 鍚屾椂鎾斁涓€娈?440Hz 闊宠皟
            string tonePath = Path.Combine(Environment.CurrentDirectory, "wcs-tone.wav");
            WriteTone(tonePath, 440, seconds);
            var player = new SoundPlayer(tonePath);
            player.Play();

            var pcm = new MemoryStream();
            var sw = Stopwatch.StartNew();
            long totalFrames = 0;
            double peak = 0;
            int packets = 0;
            int silentPackets = 0;
            while (sw.ElapsedMilliseconds < seconds * 1000 + 300)
            {
                int next;
                capture.GetNextPacketSize(out next);
                if (next == 0) { Thread.Sleep(5); continue; }
                while (next > 0)
                {
                    IntPtr data; int frames; int pflags; long devPos; long qpcPos;
                    hr = capture.GetBuffer(out data, out frames, out pflags, out devPos, out qpcPos);
                    if (hr != 0 || frames <= 0) break;
                    packets++;
                    totalFrames += frames;
                    if ((pflags & 2) != 0) silentPackets++;
                    else if (data != IntPtr.Zero)
                    {
                        int bytes = frames * fmt.nBlockAlign;
                        var tmp = new byte[bytes];
                        Marshal.Copy(data, tmp, 0, bytes);
                        pcm.Write(tmp, 0, bytes);
                        // float32
                        for (int i = 0; i + 4 <= bytes; i += 4)
                        {
                            float f = BitConverter.ToSingle(tmp, i);
                            double v = Math.Abs(f);
                            if (v > peak) peak = v;
                        }
                    }
                    capture.ReleaseBuffer(frames);
                    capture.GetNextPacketSize(out next);
                }
            }
            client.Stop();
            player.Stop();

            Console.WriteLine("packets=" + packets + " silent=" + silentPackets + " frames=" + totalFrames
                + " seconds=" + (totalFrames / (double)fmt.nSamplesPerSec).ToString("F2")
                + " peak=" + peak.ToString("F4") + " channels=" + fmt.nChannels + " rate=" + fmt.nSamplesPerSec);

            // 鍐?WAV锛坒loat32 鈫?杞?int16锛?            var raw = pcm.ToArray();
            int sampleCount = raw.Length / 4;
            var int16 = new byte[sampleCount * 2];
            for (int i = 0; i < sampleCount; i++)
            {
                float f = BitConverter.ToSingle(raw, i * 4);
                short s = (short)Math.Max(-32768, Math.Min(32767, f * 32767));
                int16[i * 2] = (byte)(s & 0xFF);
                int16[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }
            WriteWav(wavOut, int16, fmt.nChannels, fmt.nSamplesPerSec, 16);
            Console.WriteLine("wrote " + wavOut + " bytes=" + new FileInfo(wavOut).Length);
            Console.WriteLine("LOOPBACK_OK peak=" + (peak > 0.001 ? "CAPTURED" : "SILENT"));
        }
        catch (Exception ex)
        {
            Console.WriteLine("LOOPBACK_FAIL " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    static void WriteTone(string path, double freq, int seconds)
    {
        int rate = 48000;
        int samples = rate * seconds;
        var data = new byte[samples * 2];
        for (int i = 0; i < samples; i++)
        {
            short v = (short)(Math.Sin(2 * Math.PI * freq * i / rate) * 12000);
            data[i * 2] = (byte)(v & 0xFF);
            data[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
        }
        WriteWav(path, data, 1, rate, 16);
    }

    static void WriteWav(string path, byte[] data, int channels, int rate, int bits)
    {
        using (var fs = new FileStream(path, FileMode.Create))
        using (var bw = new BinaryWriter(fs))
        {
            bw.Write(new char[] { 'R', 'I', 'F', 'F' });
            bw.Write(36 + data.Length);
            bw.Write(new char[] { 'W', 'A', 'V', 'E' });
            bw.Write(new char[] { 'f', 'm', 't', ' ' });
            bw.Write(16);
            bw.Write((short)1);
            bw.Write((short)channels);
            bw.Write(rate);
            bw.Write(rate * channels * bits / 8);
            bw.Write((short)(channels * bits / 8));
            bw.Write((short)bits);
            bw.Write(new char[] { 'd', 'a', 't', 'a' });
            bw.Write(data.Length);
            bw.Write(data);
        }
    }
}
