// spike-wasapi.cs —— 验证 WASAPI 回环（系统声音）与麦克风采集（C# 5 语法）
// 编译：csc.exe /nologo /optimize+ /out:spike-wasapi.exe spike-wasapi.cs
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

static class WasapiProbe
{
    const int CLSCTX_ALL = 23;
    const int eRender = 0, eCapture = 1;
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

    static void Probe(int flow)
    {
        string label = flow == eRender ? "render(loopback)" : "capture(mic)";
        try
        {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(flow, 0, out device);
            if (hr != 0) { Console.WriteLine(label + " GetDefaultAudioEndpoint hr=0x" + hr.ToString("X8")); return; }
            string id;
            device.GetId(out id);

            var iid = typeof(IAudioClient).GUID;
            object obj;
            hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj);
            if (hr != 0) { Console.WriteLine(label + " Activate hr=0x" + hr.ToString("X8")); return; }
            var client = (IAudioClient)obj;

            IntPtr mixFormatPtr;
            hr = client.GetMixFormat(out mixFormatPtr);
            if (hr != 0) { Console.WriteLine(label + " GetMixFormat hr=0x" + hr.ToString("X8")); return; }
            var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(mixFormatPtr, typeof(WAVEFORMATEX));
            Console.WriteLine(label + " mix: tag=" + fmt.wFormatTag + " ch=" + fmt.nChannels + " rate=" + fmt.nSamplesPerSec
                + " bits=" + fmt.wBitsPerSample + " blockAlign=" + fmt.nBlockAlign + " avgBps=" + fmt.nAvgBytesPerSec);

            int flags = flow == eRender ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
            hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2000000, 0, mixFormatPtr, IntPtr.Zero);
            Console.WriteLine(label + " Initialize hr=0x" + hr.ToString("X8"));
            if (hr != 0) return;

            var iidCap = typeof(IAudioCaptureClient).GUID;
            object capObj;
            hr = client.GetService(ref iidCap, out capObj);
            if (hr != 0) { Console.WriteLine(label + " GetService hr=0x" + hr.ToString("X8")); return; }
            var capture = (IAudioCaptureClient)capObj;

            int bufferFrames;
            client.GetBufferSize(out bufferFrames);
            Console.WriteLine(label + " bufferFrames=" + bufferFrames);

            hr = client.Start();
            if (hr != 0) { Console.WriteLine(label + " Start hr=0x" + hr.ToString("X8")); return; }

            var sw = Stopwatch.StartNew();
            long totalFrames = 0;
            double peak = 0;
            int packets = 0;
            int silentPackets = 0;
            while (sw.ElapsedMilliseconds < 1500)
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
                    bool silent = (pflags & 2) != 0;
                    if (silent) silentPackets++;
                    if (!silent && data != IntPtr.Zero)
                    {
                        int sampleCount = frames * fmt.nChannels * (fmt.wBitsPerSample / 8) / 2;
                        if (sampleCount > 0)
                        {
                            var samples = new short[sampleCount];
                            Marshal.Copy(data, samples, 0, sampleCount);
                            for (int i = 0; i < samples.Length; i++)
                            {
                                double v = Math.Abs(samples[i] / 32768.0);
                                if (v > peak) peak = v;
                            }
                        }
                    }
                    capture.ReleaseBuffer(frames);
                    capture.GetNextPacketSize(out next);
                }
            }
            client.Stop();
            Console.WriteLine(label + " packets=" + packets + " silent=" + silentPackets + " frames=" + totalFrames
                + " seconds=" + (totalFrames / (double)fmt.nSamplesPerSec).ToString("F2") + " peak=" + peak.ToString("F4"));
        }
        catch (Exception ex)
        {
            Console.WriteLine(label + " EXCEPTION " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    static void Main()
    {
        Probe(eRender);
        Probe(eCapture);
        Console.WriteLine("WASAPI_DONE");
    }
}
