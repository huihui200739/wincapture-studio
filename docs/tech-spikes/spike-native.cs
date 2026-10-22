// spike-native.cs —— 验证 GDI 区域采集帧率与 WASAPI 回环采集可行性
// 编译：csc.exe /nologo /optimize+ /out:spike-native.exe spike-native.cs /r:System.Drawing.dll
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class Native
{
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long v);
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long v);

    const uint SRCCOPY = 0x00CC0020;

    public static void Main(string[] args)
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        int width = args.Length > 0 ? int.Parse(args[0]) : 1280;
        int height = args.Length > 1 ? int.Parse(args[1]) : 720;
        int frames = args.Length > 2 ? int.Parse(args[2]) : 60;

        long freq; QueryPerformanceFrequency(out freq);
        long t0; QueryPerformanceCounter(out t0);

        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr hBmp = CreateCompatibleBitmap(screenDc, width, height);
        IntPtr old = SelectObject(memDc, hBmp);

        var sw = Stopwatch.StartNew();
        long jpegBytes = 0;
        long bgraBytes = 0;
        using (var enc = new EncoderParameters(1))
        {
            enc.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
            var codec = GetEncoder(ImageFormat.Jpeg);
            for (int i = 0; i < frames; i++)
            {
                BitBlt(memDc, 0, 0, width, height, screenDc, 0, 0, SRCCOPY);
                using (var bmp = Image.FromHbitmap(hBmp))
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, codec, enc);
                    jpegBytes += ms.Length;
                }
                bgraBytes += width * height * 4;
            }
        }
        sw.Stop();

        SelectObject(memDc, old);
        DeleteObject(hBmp);
        DeleteDC(memDc);
        ReleaseDC(IntPtr.Zero, screenDc);

        Console.WriteLine("gdi_frames=" + frames);
        Console.WriteLine("gdi_elapsed_ms=" + sw.ElapsedMilliseconds);
        Console.WriteLine("gdi_fps=" + (frames * 1000.0 / Math.Max(1, sw.ElapsedMilliseconds)).ToString("F1"));
        Console.WriteLine("jpeg_avg_kb=" + (jpegBytes / Math.Max(1, frames) / 1024.0).ToString("F0"));
        Console.WriteLine("bgra_avg_mb=" + (bgraBytes / Math.Max(1, frames) / 1048576.0).ToString("F1"));
    }

    static ImageCodecInfo GetEncoder(ImageFormat format)
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.FormatID == format.Guid) return c;
        return null;
    }
}
