// spike-mf.cs 鈥斺€?楠岃瘉 Media Foundation SinkWriter 鑳藉惁鐩存帴浜у嚭 H.264 + AAC 鐨?MP4
// 缂栬瘧锛歝sc.exe /nologo /optimize+ /out:spike-mf.exe spike-mf.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

static class MfProbe
{
    const int MFSTARTUP_FULL = 0;
    const int MF_VERSION = 0x20070;
    const int MF_MT_MAJOR_TYPE = 0x48;
    const int MF_MT_SUBTYPE = 0x30;
    const int MF_MT_AVG_BITRATE = 0x03000000 + 203;
    const int MF_MT_FRAME_SIZE = 0x03000000 + 165;
    const int MF_MT_FRAME_RATE = 0x03000000 + 164;
    const int MF_MT_INTERLACE_MODE = 0x03000000 + 122;
    const int MF_MT_ALL_SAMPLES_INDEPENDENT = 0x03000000 + 55;
    const int MF_MT_PIXEL_ASPECT_RATIO = 0x03000000 + 186;
    const int MF_MT_AUDIO_NUM_CHANNELS = 0x03000000 + 37;
    const int MF_MT_AUDIO_SAMPLES_PER_SECOND = 0x03000000 + 38;
    const int MF_MT_AUDIO_BITS_PER_SAMPLE = 0x03000000 + 39;
    const int MF_MT_AUDIO_BLOCK_ALIGNMENT = 0x03000000 + 42;
    const int MF_MT_AUDIO_AVG_BYTES_PER_SECOND = 0x03000000 + 41;
    const int MF_MT_AUDIO_CHANNEL_MASK = 0x03000000 + 62;

    const int MFMediaType_Video = 0x73646976; // 'vids'
    const int MFMediaType_Audio = 0x73647561; // 'auds'
    const int MFVideoFormat_H264 = 0x34363248; // 'H264'
    const int MFAudioFormat_AAC = 0x00001610;
    const int MFVideoFormat_RGB32 = 0x00000016;
    const int MFVideoFormat_NV12 = 0x3231564E;
    const int MFVideoInterlace_Progressive = 2;
    const int MF_SINK_WRITER_DISABLE_THROTTLING = 0x00000008;

    [StructLayout(LayoutKind.Sequential)]
    struct MF_ATTRIBUTE { }

    [ComImport, Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFAttributes
    {
        int GetItem(ref Guid guidKey, IntPtr pValue);
        int GetItemType(ref Guid guidKey, out int pType);
        int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        int GetUINT32(ref Guid guidKey, out int punValue);
        int GetUINT64(ref Guid guidKey, out long punValue);
        int GetDouble(ref Guid guidKey, out double pfValue);
        int GetGUID(ref Guid guidKey, out Guid pguidValue);
        int GetStringLength(ref Guid guidKey, out int pcchLength);
        int GetString(ref Guid guidKey, IntPtr pwszValue, int cchBufSize, IntPtr pcchLength);
        int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, IntPtr pcbBlobSize);
        int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        int SetItem(ref Guid guidKey, IntPtr value);
        int DeleteItem(ref Guid guidKey);
        int DeleteAllItems();
        int SetUINT32(ref Guid guidKey, int unValue);
        int SetUINT64(ref Guid guidKey, long unValue);
        int SetDouble(ref Guid guidKey, double fValue);
        int SetGUID(ref Guid guidKey, ref Guid guidValue);
        int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        int LockStore();
        int UnlockStore();
        int GetCount(out int pcItems);
        int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        int CopyAllItems(IMFAttributes pDest);
    }

    [ComImport, Guid("44AE0FA8-EA31-4109-8D2E-4CAE4997C555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaType
    {
        // IMFAttributes
        int GetItem(ref Guid guidKey, IntPtr pValue);
        int GetItemType(ref Guid guidKey, out int pType);
        int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        int GetUINT32(ref Guid guidKey, out int punValue);
        int GetUINT64(ref Guid guidKey, out long punValue);
        int GetDouble(ref Guid guidKey, out double pfValue);
        int GetGUID(ref Guid guidKey, out Guid pguidValue);
        int GetStringLength(ref Guid guidKey, out int pcchLength);
        int GetString(ref Guid guidKey, IntPtr pwszValue, int cchBufSize, IntPtr pcchLength);
        int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, IntPtr pcbBlobSize);
        int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        int SetItem(ref Guid guidKey, IntPtr value);
        int DeleteItem(ref Guid guidKey);
        int DeleteAllItems();
        int SetUINT32(ref Guid guidKey, int unValue);
        int SetUINT64(ref Guid guidKey, long unValue);
        int SetDouble(ref Guid guidKey, double fValue);
        int SetGUID(ref Guid guidKey, ref Guid guidValue);
        int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        int LockStore();
        int UnlockStore();
        int GetCount(out int pcItems);
        int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        int CopyAllItems(IMFAttributes pDest);
        // IMFMediaType
        int GetMajorType(out int pguidMajorType);
        int IsCompressedFormat(out int pfCompressed);
        int IsEqual(IMFMediaType pIMediaType, out int pdwFlags);
        int GetRepresentation(ref Guid guidRepresentation, out IntPtr ppvRepresentation);
        int FreeRepresentation(ref Guid guidRepresentation, IntPtr pvRepresentation);
    }

    [ComImport, Guid("045FA593-8799-42B8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaBuffer
    {
        int Lock(out IntPtr ppbBuffer, out int pcbMaxLength, out int pcbCurrentLength);
        int Unlock();
        int GetCurrentLength(out int pcbCurrentLength);
        int SetCurrentLength(int cbCurrentLength);
        int GetMaxLength(out int pcbMaxLength);
    }

    [ComImport, Guid("C40A00F2-B93A-4D80-AE8C-5A1C634F58E4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSample
    {
        // IMFAttributes
        int GetItem(ref Guid guidKey, IntPtr pValue);
        int GetItemType(ref Guid guidKey, out int pType);
        int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        int GetUINT32(ref Guid guidKey, out int punValue);
        int GetUINT64(ref Guid guidKey, out long punValue);
        int GetDouble(ref Guid guidKey, out double pfValue);
        int GetGUID(ref Guid guidKey, out Guid pguidValue);
        int GetStringLength(ref Guid guidKey, out int pcchLength);
        int GetString(ref Guid guidKey, IntPtr pwszValue, int cchBufSize, IntPtr pcchLength);
        int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, IntPtr pcbBlobSize);
        int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        int SetItem(ref Guid guidKey, IntPtr value);
        int DeleteItem(ref Guid guidKey);
        int DeleteAllItems();
        int SetUINT32(ref Guid guidKey, int unValue);
        int SetUINT64(ref Guid guidKey, long unValue);
        int SetDouble(ref Guid guidKey, double fValue);
        int SetGUID(ref Guid guidKey, ref Guid guidValue);
        int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        int LockStore();
        int UnlockStore();
        int GetCount(out int pcItems);
        int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        int CopyAllItems(IMFAttributes pDest);
        // IMFSample
        int GetSampleFlags(out int pdwSampleFlags);
        int SetSampleFlags(int dwSampleFlags);
        int GetSampleTime(out long phnsSampleTime);
        int SetSampleTime(long hnsSampleTime);
        int GetSampleDuration(out long phnsSampleDuration);
        int SetSampleDuration(long hnsSampleDuration);
        int GetBufferCount(out int pdwBufferCount);
        int GetBufferByIndex(int dwIndex, out IMFMediaBuffer ppBuffer);
        int ConvertToContiguousBuffer(out IMFMediaBuffer ppBuffer);
        int AddBuffer(IMFMediaBuffer pBuffer);
        int RemoveBufferByIndex(int dwIndex);
        int RemoveAllBuffers();
        int GetTotalLength(out int pcbTotalLength);
        int CopyToBuffer(IMFMediaBuffer pBuffer);
    }

    [ComImport, Guid("3137F1CD-FE5E-4805-A5D8-FB477448CB3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSinkWriter
    {
        // IMFAttributes
        int GetItem(ref Guid guidKey, IntPtr pValue);
        int GetItemType(ref Guid guidKey, out int pType);
        int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        int GetUINT32(ref Guid guidKey, out int punValue);
        int GetUINT64(ref Guid guidKey, out long punValue);
        int GetDouble(ref Guid guidKey, out double pfValue);
        int GetGUID(ref Guid guidKey, out Guid pguidValue);
        int GetStringLength(ref Guid guidKey, out int pcchLength);
        int GetString(ref Guid guidKey, IntPtr pwszValue, int cchBufSize, IntPtr pcchLength);
        int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, IntPtr pcbBlobSize);
        int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        int SetItem(ref Guid guidKey, IntPtr value);
        int DeleteItem(ref Guid guidKey);
        int DeleteAllItems();
        int SetUINT32(ref Guid guidKey, int unValue);
        int SetUINT64(ref Guid guidKey, long unValue);
        int SetDouble(ref Guid guidKey, double fValue);
        int SetGUID(ref Guid guidKey, ref Guid guidValue);
        int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        int LockStore();
        int UnlockStore();
        int GetCount(out int pcItems);
        int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        int CopyAllItems(IMFAttributes pDest);
        // IMFSinkWriter
        int AddStream(IMFMediaType pTargetMediaType, out int pdwStreamIndex);
        int SetInputMediaType(int dwStreamIndex, IMFMediaType pInputMediaType, IMFAttributes pEncodingParameters);
        int BeginWriting();
        int WriteSample(int dwStreamIndex, IMFSample pSample);
        int SendStreamTick(int dwStreamIndex, long llTimestamp);
        int PlaceMarker(int dwStreamIndex, IntPtr pvContext);
        int NotifyEndOfSegment(int dwStreamIndex);
        int Flush(int dwStreamIndex);
        int DoFinalize();
        int GetServiceForStream(int dwStreamIndex, ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
        int GetStatistics(int dwStreamIndex, IntPtr pStats);
    }

    [DllImport("mfplat.dll", ExactSpelling = true)]
    static extern int MFStartup(int version, int dwFlags);
    [DllImport("mfplat.dll", ExactSpelling = true)]
    static extern int MFShutdown();
    [DllImport("mfplat.dll", ExactSpelling = true)]
    static extern int MFCreateMediaType(out IMFMediaType ppMFType);
    [DllImport("mfplat.dll", ExactSpelling = true)]
    static extern int MFCreateSample(out IMFSample ppIMFSample);
    [DllImport("mfplat.dll", ExactSpelling = true)]
    static extern int MFCreateMemoryBuffer(int cbMaxLength, out IMFMediaBuffer ppBuffer);
    [DllImport("mfplat.dll", ExactSpelling = true)]
    static extern int MFCreateAttributes(out IMFAttributes ppMFAttributes, int cInitialSize);
    [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern int MFCreateSinkWriterFromURL(string pwszOutputURL, IntPtr pByteStream, IMFAttributes pAttributes, out IMFSinkWriter ppSinkWriter);

    static Guid GuidFromInt(int v)
    {
        return new Guid(v, 0, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71);
    }

    static void Check(int hr, string what)
    {
        if (hr < 0) throw new Exception(what + " hr=0x" + hr.ToString("X8"));
    }

    static void Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : Path.Combine(Environment.CurrentDirectory, "spike-mf.mp4");
        int width = 1280, height = 720, fps = 30, frames = 90;
        try
        {
            Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup");

            IMFAttributes attrs;
            Check(MFCreateAttributes(out attrs, 2), "MFCreateAttributes");
            Guid k = GuidFromInt(MF_SINK_WRITER_DISABLE_THROTTLING);
            attrs.SetUINT32(ref k, 1);

            IMFSinkWriter writer;
            Check(MFCreateSinkWriterFromURL(outPath, IntPtr.Zero, attrs, out writer), "MFCreateSinkWriterFromURL");

            // --- 瑙嗛娴侊細杈撳嚭 H.264 ---
            IMFMediaType outVideo;
            Check(MFCreateMediaType(out outVideo), "MFCreateMediaType(outVideo)");
            k = GuidFromInt(MF_MT_MAJOR_TYPE); outVideo.SetGUID(ref k, ref VideoMajor);
            k = GuidFromInt(MF_MT_SUBTYPE); outVideo.SetGUID(ref k, ref H264Sub);
            k = GuidFromInt(MF_MT_AVG_BITRATE); outVideo.SetUINT32(ref k, 6000000);
            k = GuidFromInt(MF_MT_INTERLACE_MODE); outVideo.SetUINT32(ref k, MFVideoInterlace_Progressive);
            k = GuidFromInt(MF_MT_FRAME_SIZE); outVideo.SetUINT64(ref k, Pack(width, height));
            k = GuidFromInt(MF_MT_FRAME_RATE); outVideo.SetUINT64(ref k, Pack(fps, 1));
            k = GuidFromInt(MF_MT_PIXEL_ASPECT_RATIO); outVideo.SetUINT64(ref k, Pack(1, 1));

            int videoStream;
            Check(writer.AddStream(outVideo, out videoStream), "AddStream(video)");

            // --- 瑙嗛杈撳叆锛歊GB32 ---
            IMFMediaType inVideo;
            Check(MFCreateMediaType(out inVideo), "MFCreateMediaType(inVideo)");
            k = GuidFromInt(MF_MT_MAJOR_TYPE); inVideo.SetGUID(ref k, ref VideoMajor);
            k = GuidFromInt(MF_MT_SUBTYPE); inVideo.SetGUID(ref k, ref Rgb32Sub);
            k = GuidFromInt(MF_MT_INTERLACE_MODE); inVideo.SetUINT32(ref k, MFVideoInterlace_Progressive);
            k = GuidFromInt(MF_MT_FRAME_SIZE); inVideo.SetUINT64(ref k, Pack(width, height));
            k = GuidFromInt(MF_MT_FRAME_RATE); inVideo.SetUINT64(ref k, Pack(fps, 1));
            k = GuidFromInt(MF_MT_PIXEL_ASPECT_RATIO); inVideo.SetUINT64(ref k, Pack(1, 1));
            k = GuidFromInt(MF_MT_DEFAULT_STRIDE); inVideo.SetUINT32(ref k, width * 4);
            Check(writer.SetInputMediaType(videoStream, inVideo, null), "SetInputMediaType(video)");

            // --- 闊抽娴侊細AAC ---
            IMFMediaType outAudio;
            Check(MFCreateMediaType(out outAudio), "MFCreateMediaType(outAudio)");
            k = GuidFromInt(MF_MT_MAJOR_TYPE); outAudio.SetGUID(ref k, ref AudioMajor);
            k = GuidFromInt(MF_MT_SUBTYPE); outAudio.SetGUID(ref k, ref AacSub);
            k = GuidFromInt(MF_MT_AUDIO_NUM_CHANNELS); outAudio.SetUINT32(ref k, 2);
            k = GuidFromInt(MF_MT_AUDIO_SAMPLES_PER_SECOND); outAudio.SetUINT32(ref k, 48000);
            k = GuidFromInt(MF_MT_AUDIO_BITS_PER_SAMPLE); outAudio.SetUINT32(ref k, 16);
            k = GuidFromInt(MF_MT_AUDIO_AVG_BYTES_PER_SECOND); outAudio.SetUINT32(ref k, 24000);
            k = GuidFromInt(MF_MT_AUDIO_CHANNEL_MASK); outAudio.SetUINT32(ref k, 0x3);

            int audioStream;
            Check(writer.AddStream(outAudio, out audioStream), "AddStream(audio)");

            IMFMediaType inAudio;
            Check(MFCreateMediaType(out inAudio), "MFCreateMediaType(inAudio)");
            k = GuidFromInt(MF_MT_MAJOR_TYPE); inAudio.SetGUID(ref k, ref AudioMajor);
            k = GuidFromInt(MF_MT_SUBTYPE); inAudio.SetGUID(ref k, ref PcmSub);
            k = GuidFromInt(MF_MT_AUDIO_NUM_CHANNELS); inAudio.SetUINT32(ref k, 2);
            k = GuidFromInt(MF_MT_AUDIO_SAMPLES_PER_SECOND); inAudio.SetUINT32(ref k, 48000);
            k = GuidFromInt(MF_MT_AUDIO_BITS_PER_SAMPLE); inAudio.SetUINT32(ref k, 16);
            k = GuidFromInt(MF_MT_AUDIO_BLOCK_ALIGNMENT); inAudio.SetUINT32(ref k, 4);
            k = GuidFromInt(MF_MT_AUDIO_AVG_BYTES_PER_SECOND); inAudio.SetUINT32(ref k, 48000 * 4);
            Check(writer.SetInputMediaType(audioStream, inAudio, null), "SetInputMediaType(audio)");

            Check(writer.BeginWriting(), "BeginWriting");

            // 鍐欒棰戝抚
            long frameDur = 10000000L / fps;
            byte[] frameBytes = new byte[width * height * 4];
            var sw = Stopwatch.StartNew();
            for (int i = 0; i < frames; i++)
            {
                // 鐢熸垚娓愬彉 + 绉诲姩鏂瑰潡
                int shift = i * 8;
                for (int y = 0; y < height; y += 1)
                {
                    int rowOff = y * width * 4;
                    for (int x = 0; x < width; x += 1)
                    {
                        int off = rowOff + x * 4;
                        frameBytes[off] = (byte)((x + shift) % 256);
                        frameBytes[off + 1] = (byte)(y % 256);
                        frameBytes[off + 2] = (byte)((i * 2) % 256);
                        frameBytes[off + 3] = 255;
                    }
                }
                WriteBuffer(writer, videoStream, frameBytes, frameDur * i, frameDur);
            }
            Console.WriteLine("video_written_ms=" + sw.ElapsedMilliseconds);

            // 鍐欓煶棰戯紙90 甯?鈮?3 绉掞級
            int audioSamplesPerChunk = 1024;
            long audioDur = 10000000L * audioSamplesPerChunk / 48000;
            int chunks = (int)(frames * 10000000L / frameDur / (10000000.0 * audioSamplesPerChunk / 48000));
            byte[] audioBytes = new byte[audioSamplesPerChunk * 4];
            for (int i = 0; i < chunks; i++)
            {
                for (int s = 0; s < audioSamplesPerChunk; s++)
                {
                    double t = (i * (double)audioSamplesPerChunk + s) / 48000.0;
                    short v = (short)(Math.Sin(2 * Math.PI * 440 * t) * 8000);
                    audioBytes[s * 4] = (byte)(v & 0xFF);
                    audioBytes[s * 4 + 1] = (byte)((v >> 8) & 0xFF);
                    audioBytes[s * 4 + 2] = (byte)(v & 0xFF);
                    audioBytes[s * 4 + 3] = (byte)((v >> 8) & 0xFF);
                }
                WriteBuffer(writer, audioStream, audioBytes, audioDur * i, audioDur);
            }

            Check(writer.DoFinalize(), "Finalize");
            Marshal.ReleaseComObject(writer);
            MFShutdown();

            var fi = new FileInfo(outPath);
            Console.WriteLine("MF_OK path=" + outPath + " bytes=" + fi.Length);
        }
        catch (Exception ex)
        {
            Console.WriteLine("MF_FAIL " + ex.GetType().FullName + ": " + ex.Message + " | " + ex.StackTrace);
            try { MFShutdown(); } catch { }
        }
    }

    static Guid VideoMajor = new Guid(0x73646976, 0, 0x0010, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71);
    static Guid AudioMajor = new Guid(0x73647561, 0, 0x0010, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71);
    static Guid H264Sub = new Guid(0x34363248, 0, 0x0010, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71);
    static Guid Rgb32Sub = new Guid(0x00000016, 0, 0x0010, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71);
    static Guid AacSub = new Guid(0x00001610, 0, 0x0010, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71);
    static Guid PcmSub = new Guid(0x00000001, 0, 0x0010, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71);

    const int MF_MT_DEFAULT_STRIDE = 0x03000000 + 82;

    static long Pack(int a, int b) { return ((long)a << 32) | (uint)b; }

    static void WriteBuffer(IMFSinkWriter writer, int stream, byte[] data, long time, long duration)
    {
        IMFMediaBuffer buffer;
        Check(MFCreateMemoryBuffer(data.Length, out buffer), "MFCreateMemoryBuffer");
        IntPtr ptr; int max, cur;
        Check(buffer.Lock(out ptr, out max, out cur), "buffer.Lock");
        Marshal.Copy(data, 0, ptr, data.Length);
        buffer.Unlock();
        buffer.SetCurrentLength(data.Length);

        IMFSample sample;
        Check(MFCreateSample(out sample), "MFCreateSample");
        sample.AddBuffer(buffer);
        sample.SetSampleTime(time);
        sample.SetSampleDuration(duration);
        Check(writer.WriteSample(stream, sample), "WriteSample");
        Marshal.ReleaseComObject(sample);
        Marshal.ReleaseComObject(buffer);
    }
}
