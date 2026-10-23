// grabber.cs —— 常驻 GDI 屏幕采集工作进程（C# 5 语法，勿用 $"" 插值）
//
// 为什么用 GDI：本机 Windows.Graphics.Capture 被系统拒绝（E_ACCESSDENIED），
// 而文档 §7.1 把「区域录制」定义为「选定显示器上的矩形裁切」，GDI BitBlt 正好符合该定义。
//
// 协议（stdout）：
//   每帧 = 4 字节小端长度 + 8 字节小端 int64 QPC 时间戳 + JPEG 字节
//   启动时向 stderr 打印一行 "QPCFREQ <频率>"，主进程据此把 QPC 换算为秒。
//
// 协议（stdin）：
//   "q\n" 退出；其它任何输入忽略（流式模式下无需逐帧请求）。
//
// 命令行：
//   grabber.exe <width> <height> <x> <y> <jpegQuality> <fps> [--probe]
//   --probe 只抓一帧到 stdout 后退出（用于能力探测）
//
// 编译：
//   csc /nologo /optimize+ /out:grabber.exe grabber.cs /r:System.Drawing.dll

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Grabber
{
    // ---- Win32 ----
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("winmm.dll")]
    private static extern int timeBeginPeriod(int period);

    [DllImport("winmm.dll")]
    private static extern int timeEndPeriod(int period);

    [DllImport("kernel32.dll")]
    private static extern bool QueryPerformanceFrequency(out long frequency);

    [DllImport("kernel32.dll")]
    private static extern bool QueryPerformanceCounter(out long counter);

    private static long _qpcFrequency;

    /// <summary>
    /// 退出标志。必须是 volatile 静态字段：读线程与采集循环跨线程共享，
    /// 若用被闭包捕获的局部 bool，JIT 没有义务在循环里重新读取，极端情况下按 q 后不退出。
    /// </summary>
    private static volatile bool _quit;

    private static double NowSeconds()
    {
        long counter;
        QueryPerformanceCounter(out counter);
        return counter / (double)_qpcFrequency;
    }

    private static Stream _stdout;

    private static void WriteFrame(byte[] jpeg, long qpc)
    {
        byte[] header = new byte[12];
        int len = jpeg.Length;
        header[0] = (byte)(len & 0xFF);
        header[1] = (byte)((len >> 8) & 0xFF);
        header[2] = (byte)((len >> 16) & 0xFF);
        header[3] = (byte)((len >> 24) & 0xFF);
        for (int i = 0; i < 8; i++)
        {
            header[4 + i] = (byte)((qpc >> (8 * i)) & 0xFF);
        }
        _stdout.Write(header, 0, header.Length);
        _stdout.Write(jpeg, 0, jpeg.Length);
        _stdout.Flush();
    }

    private static void Log(string message)
    {
        Console.Error.WriteLine(message);
        Console.Error.Flush();
    }

    private static int Main(string[] args)
    {
        // 每显示器 DPI 感知 v2：保证坐标与位图都是物理像素
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { /* 旧系统忽略 */ }

        QueryPerformanceFrequency(out _qpcFrequency);
        Log("QPCFREQ " + _qpcFrequency);

        if (args.Length < 5)
        {
            Log("USAGE grabber.exe <width> <height> <x> <y> <quality> <fps> [--probe]");
            return 2;
        }

        int width, height, offsetX, offsetY, quality;
        int fps = 30;
        bool probe = false;
        try
        {
            width = int.Parse(args[0]);
            height = int.Parse(args[1]);
            offsetX = int.Parse(args[2]);
            offsetY = int.Parse(args[3]);
            quality = int.Parse(args[4]);
            if (args.Length >= 6 && args[5] != "--probe") fps = int.Parse(args[5]);
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--probe") probe = true;
            }
        }
        catch (Exception ex)
        {
            Log("ARGS_ERROR " + ex.Message);
            return 2;
        }

        if (width <= 0 || height <= 0)
        {
            Log("ARGS_ERROR 尺寸必须为正");
            return 2;
        }
        if (fps < 1 || fps > 240) fps = 30;
        if (quality < 20) quality = 20;
        if (quality > 100) quality = 100;

        // 裁剪到虚拟桌面范围内，避免越界导致全黑
        int screenW = GetSystemMetrics(78); // SM_CXVIRTUALSCREEN
        int screenH = GetSystemMetrics(79); // SM_CYVIRTUALSCREEN
        if (screenW > 0 && screenH > 0)
        {
            if (offsetX < 0) offsetX = 0;
            if (offsetY < 0) offsetY = 0;
            if (offsetX + width > screenW) offsetX = Math.Max(0, screenW - width);
            if (offsetY + height > screenH) offsetY = Math.Max(0, screenH - height);
        }

        _stdout = Console.OpenStandardOutput();

        ImageCodecInfo jpegCodec = null;
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.FormatID == ImageFormat.Jpeg.Guid) { jpegCodec = codec; break; }
        }
        if (jpegCodec == null)
        {
            Log("NO_JPEG_ENCODER");
            return 3;
        }
        EncoderParameters encoderParams = new EncoderParameters(1);
        encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);

        Bitmap bitmap;
        Graphics graphics;
        MemoryStream buffer = new MemoryStream(512 * 1024);
        try
        {
            bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            graphics = Graphics.FromImage(bitmap);
        }
        catch (Exception ex)
        {
            Log("BITMAP_ERROR " + ex.GetType().Name + ": " + ex.Message);
            return 3;
        }

        // 用后台线程读 stdin，主线程专注采集
        Thread reader = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Trim() == "q") { _quit = true; break; }
                }
            }
            catch { /* 父进程关闭管道 */ }
            _quit = true;
        });
        reader.IsBackground = true;
        reader.Start();

        timeBeginPeriod(1);
        Log("READY " + width + "x" + height + "@" + offsetX + "," + offsetY + " fps=" + fps + " q=" + quality);

        int frameIntervalUs = 1000000 / fps;
        long nextDeadlineUs = 0;
        int frames = 0;
        int failures = 0;
        Stopwatch clock = Stopwatch.StartNew();

        try
        {
            while (!_quit)
            {
                long qpc;
                QueryPerformanceCounter(out qpc);
                long nowUs = clock.ElapsedTicks * 1000000L / Stopwatch.Frequency;

                if (nowUs < nextDeadlineUs)
                {
                    // 不要忙等：旧实现在剩余时间不足 1ms 时 waitMs 取整为 0，
                    // 于是 while 循环原地空转烧掉一个核（每帧最多 1ms，约占 3% CPU）。
                    // 向上取整并至少睡 1ms；上限 50ms 以便及时响应 stdin 的 q。
                    long remainUs = nextDeadlineUs - nowUs;
                    int waitMs = (int)((remainUs + 999) / 1000);
                    if (waitMs > 50) waitMs = 50;
                    if (waitMs < 1) waitMs = 1;
                    Thread.Sleep(waitMs);
                    continue;
                }

                bool ok = false;
                try
                {
                    graphics.CopyFromScreen(offsetX, offsetY, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                    ok = true;
                }
                catch (Exception ex)
                {
                    failures++;
                    if (failures <= 3) Log("CAPTURE_ERROR " + ex.GetType().Name + ": " + ex.Message);
                }

                if (ok)
                {
                    try
                    {
                        buffer.SetLength(0);
                        bitmap.Save(buffer, jpegCodec, encoderParams);
                        WriteFrame(buffer.ToArray(), qpc);
                        frames++;
                    }
                    catch (IOException)
                    {
                        // 管道关闭：父进程退出
                        break;
                    }
                    catch (Exception ex)
                    {
                        failures++;
                        if (failures <= 3) Log("ENCODE_ERROR " + ex.GetType().Name + ": " + ex.Message);
                    }
                }

                if (probe)
                {
                    Log("PROBE_DONE frames=" + frames);
                    break;
                }

                nextDeadlineUs += frameIntervalUs;
                long afterUs = clock.ElapsedTicks * 1000000L / Stopwatch.Frequency;
                if (nextDeadlineUs < afterUs - frameIntervalUs * 2L)
                {
                    // 落后超过两帧就重新对齐，避免追赶风暴
                    nextDeadlineUs = afterUs;
                }
            }
        }
        finally
        {
            timeEndPeriod(1);
            try { graphics.Dispose(); } catch { }
            try { bitmap.Dispose(); } catch { }
            try { buffer.Dispose(); } catch { }
            try { encoderParams.Dispose(); } catch { }
        }

        Log("DONE frames=" + frames + " failures=" + failures);
        return failures > 0 && frames == 0 ? 4 : 0;
    }
}
