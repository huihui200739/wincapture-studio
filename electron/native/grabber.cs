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
using System.Text;
using System.Collections.Generic;

internal static class Grabber
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER { public int biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount; public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public int biClrUsed; public int biClrImportant; }
    [StructLayout(LayoutKind.Sequential)]
    private class BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public int bmiColors; }
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr hdc, BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool PatBlt(IntPtr dc, int x, int y, int width, int height, uint rop);

    /// <summary>
    /// 一个可采集可编码的表面：GDI 侧通过 DIB section 的内存设备 DC 写入
    /// （BitBlt/PrintWindow/StretchBlt），GDI+ 侧用包装同一块内存的 Bitmap 读取
    /// （Save/DrawImage）。跨线程时 GDI 写入对 GDI+ 不可见是实测踩过的坑
    /// （成片全黑），DIB section 的共享内存是唯一可靠桥梁：两者读写的都是
    /// 同一块物理内存，不经过任何 GDI+ 私有后备存储。
    /// </summary>
    private sealed class Surface : IDisposable {
        public readonly int Width;
        public readonly int Height;
        public readonly IntPtr Dib;
        public readonly IntPtr DC;
        public readonly IntPtr Bits;
        public readonly Bitmap Wrapper;
        public readonly Graphics GdiPlus;
        public Surface(int width, int height, IntPtr referenceDc, bool bpp32) {
            Width = width; Height = height;
            // 源表面必须 32bpp：PW_RENDERFULLCONTENT 的 DWM 拷贝路径只写 32bpp DIB，
            // 24bpp 时返回 True 但内容全空（实测对照）。
            // 输出表面保持 24bpp：GDI+ JPEG 编码器原生 24bpp，从 32bpp 编码要多一次
            // 整帧格式转换（实测编码吞吐掉一半以上，直接导致采集池耗尽丢帧）。
            // 缩放 StretchBlt 32bpp→24bpp 由 GDI 在搬运时顺带完成。
            int bpp = bpp32 ? 32 : 24;
            int stride = ((width * bpp + 31) / 32) * 4;
            BITMAPINFO bmi = new BITMAPINFO();
            bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = width;
            bmi.bmiHeader.biHeight = -height; // top-down，与 GDI+ 行序一致
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = (ushort)bpp;
            bmi.bmiHeader.biCompression = 0; // BI_RGB
            Dib = CreateDIBSection(referenceDc, bmi, 0, out Bits, IntPtr.Zero, 0);
            if (Dib == IntPtr.Zero || Bits == IntPtr.Zero) throw new Exception("CreateDIBSection failed (" + Marshal.GetLastWin32Error() + ")");
            DC = CreateCompatibleDC(referenceDc);
            if (DC == IntPtr.Zero) { DeleteObject(Dib); Dib = IntPtr.Zero; throw new Exception("CreateCompatibleDC failed"); }
            SelectObject(DC, Dib);
            Wrapper = new Bitmap(width, height, stride, bpp32 ? PixelFormat.Format32bppRgb : PixelFormat.Format24bppRgb, Bits);
            GdiPlus = Graphics.FromImage(Wrapper);
            GdiPlus.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
        }
        public void Dispose() {
            try { if (GdiPlus != null) GdiPlus.Dispose(); } catch { }
            try { if (Wrapper != null) Wrapper.Dispose(); } catch { }
            if (DC != IntPtr.Zero) DeleteDC(DC);
            if (Dib != IntPtr.Zero) DeleteObject(Dib);
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, int size);

    private static string JsonString(string value)
    {
        StringBuilder json = new StringBuilder("\"");
        foreach (char c in value) {
            if (c == '\\' || c == '"') json.Append('\\').Append(c);
            else if (c < 32) json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }

    private static int ListWindows()
    {
        List<string> items = new List<string>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
            RECT r;
            if (!IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out r) || r.Right-r.Left < 64 || r.Bottom-r.Top < 64) return true;
            int cloaked = 0;
            try { DwmGetWindowAttribute(hwnd, 14, out cloaked, 4); } catch { }
            if (cloaked != 0) return true;
            StringBuilder title = new StringBuilder(1024);
            GetWindowText(hwnd, title, title.Capacity);
            if (title.Length == 0) return true;
            items.Add("{\"id\":\"window:" + hwnd.ToInt64() + "\",\"name\":" + JsonString(title.ToString()) +
                ",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right-r.Left) + ",\"height\":" + (r.Bottom-r.Top) +
                ",\"available\":" + (IsIconic(hwnd) ? "false" : "true") + "}");
            return true;
        }, IntPtr.Zero);
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine("[" + string.Join(",", items.ToArray()) + "]");
        return 0;
    }
    // ---- Win32 ----
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll", SetLastError=true)]
    private static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sx, int sy, uint operation);
    [DllImport("gdi32.dll", SetLastError=true)]
    private static extern bool StretchBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sx, int sy, int sourceWidth, int sourceHeight, uint operation);
    [DllImport("gdi32.dll")] private static extern int SetStretchBltMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] private static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr previous);

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

    private static readonly byte[] frameHeader = new byte[12];
    private static void WriteFrame(byte[] jpeg, int length, long qpc)
    {
        byte[] header = frameHeader;
        int len = length;
        header[0] = (byte)(len & 0xFF);
        header[1] = (byte)((len >> 8) & 0xFF);
        header[2] = (byte)((len >> 16) & 0xFF);
        header[3] = (byte)((len >> 24) & 0xFF);
        for (int i = 0; i < 8; i++)
        {
            header[4 + i] = (byte)((qpc >> (8 * i)) & 0xFF);
        }
        _stdout.Write(header, 0, header.Length);
        _stdout.Write(jpeg, 0, length);
        _stdout.Flush();
    }

    // ---- 有界发送队列 ----
    //
    // 编码线程不再直接写 stdout：父进程（Electron 主进程）事件循环被分段 IPC 序列化
    // 或 GC 卡住时，管道背压会一路反压到编码线程，再耗尽表面池，采集槽位被整帧跳过
    // （实测完整链路因此丢帧 1%~4%，而单独压测原生链路只有 0.03%）。
    // 这里用一条 FIFO 队列吸收父进程的短暂卡顿：队列按「帧数 + 总字节」双重上限，
    // 溢出时丢最旧的已编码帧（保住最新画面）并计数，绝不反压采集。
    private sealed class EncodedFrame
    {
        public readonly byte[] Data;
        public readonly long Qpc;
        public EncodedFrame(byte[] data, long qpc) { Data = data; Qpc = qpc; }
    }
    private static readonly object writeLock = new object();
    private static readonly Queue<EncodedFrame> writeQueue = new Queue<EncodedFrame>();
    private static long queuedBytes = 0;
    private static AutoResetEvent writeAvailable;
    private const int MAX_QUEUE_COUNT = 120;
    private const long MAX_QUEUE_BYTES = 48L * 1024 * 1024;
    private static int pipeDrops = 0;

    private static bool EnqueueFrame(byte[] data, long qpc)
    {
        lock (writeLock)
        {
            while (writeQueue.Count > 0 && (writeQueue.Count >= MAX_QUEUE_COUNT || queuedBytes + data.Length > MAX_QUEUE_BYTES))
            {
                EncodedFrame dropped = writeQueue.Dequeue();
                queuedBytes -= dropped.Data.Length;
                int drops = Interlocked.Increment(ref pipeDrops);
                if (drops == 1) Log("PIPE_DROP parent stalled, dropping oldest encoded frames");
            }
            if (queuedBytes + data.Length > MAX_QUEUE_BYTES) return false; // 单帧超出整条队列预算
            writeQueue.Enqueue(new EncodedFrame(data, qpc));
            queuedBytes += data.Length;
        }
        writeAvailable.Set();
        return true;
    }

    /// <summary>
    /// 一帧已采集（1:1、未缩放）等待编码的工作项。
    /// 采集线程只做 BitBlt/PrintWindow 到源尺寸表面；缩放与 JPEG 编码在编码线程并行。
    /// 实测（2568×1529→1920×1080 HALFTONE）缩放在采集线程要 ~25ms/帧、负载下 ~39ms，
    /// 是完整链路丢帧的全部来源；挪走之后应用内实测 30.00fps、采集缺失 0%。
    /// </summary>
    private sealed class CaptureWork
    {
        public readonly Surface Src;
        public readonly long Qpc;
        public readonly bool IsWindow;
        public readonly int Generation; // 窗口池代数：尺寸变化后旧表面归还时直接销毁
        public CaptureWork(Surface src, long qpc, bool isWindow, int generation) { Src = src; Qpc = qpc; IsWindow = isWindow; Generation = generation; }
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

        if (args.Length == 1 && args[0] == "--list-windows") return ListWindows();
        if (args.Length == 1 && args[0].StartsWith("--process-memory=")) {
            List<string> rows = new List<string>();
            foreach (string value in args[0].Substring(17).Split(',')) {
                int id; if (!int.TryParse(value, out id) || id <= 0) continue;
                try { using (Process process = Process.GetProcessById(id)) {
                    rows.Add("{\"pid\":" + id + ",\"workingSetBytes\":" + process.WorkingSet64 + ",\"privateBytes\":" + process.PrivateMemorySize64 + "}");
                } } catch { /* A worker may exit between enumeration and sampling. */ }
            }
            Console.WriteLine("[" + string.Join(",", rows.ToArray()) + "]"); return 0;
        }

        QueryPerformanceFrequency(out _qpcFrequency);
        if (args.Length == 1 && args[0] == "--clock") { long qpc; QueryPerformanceCounter(out qpc); Console.WriteLine("{\"qpc\":\"" + qpc + "\",\"frequency\":\"" + _qpcFrequency + "\"}"); return 0; }
        Log("QPCFREQ " + _qpcFrequency);

        if (args.Length < 5)
        {
            Log("USAGE grabber.exe <width> <height> <x> <y> <quality> <fps> [--probe]");
            return 2;
        }

        int width, height, offsetX, offsetY, quality;
        int fps = 30;
        bool probe = false;
        bool fastScale = false;
        IntPtr windowHandle = IntPtr.Zero;
        int outputWidth = 0, outputHeight = 0;
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
                if (args[i] == "--fast-scale") fastScale = true;
                if (args[i].StartsWith("--window=")) windowHandle = new IntPtr(long.Parse(args[i].Substring(9)));
                if (args[i].StartsWith("--output=")) { string[] output = args[i].Substring(9).Split('x'); outputWidth = int.Parse(output[0]); outputHeight = int.Parse(output[1]); }
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
        if (outputWidth <= 0 || outputHeight <= 0) { outputWidth = width; outputHeight = height; }

        // 裁剪到虚拟桌面范围内，避免越界导致全黑
        int screenW = GetSystemMetrics(78); // SM_CXVIRTUALSCREEN
        int screenH = GetSystemMetrics(79); // SM_CYVIRTUALSCREEN
        if (windowHandle == IntPtr.Zero && screenW > 0 && screenH > 0)
        {
            int screenX = GetSystemMetrics(76), screenY = GetSystemMetrics(77);
            offsetX = Math.Max(screenX, Math.Min(offsetX, screenX + screenW - width));
            offsetY = Math.Max(screenY, Math.Min(offsetY, screenY + screenH - height));
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

        // ---- 表面池 ----
        //
        // 三组池替代旧的单一输出池：
        //   源池（屏幕）—— 区域尺寸，采集线程 1:1 BitBlt；
        //   源池（窗口）—— 窗口客户尺寸，PrintWindow 1:1，窗口尺寸变化时整代重建；
        //   输出池 —— 输出尺寸，编码线程做缩放（HALFTONE/COLORONCOLOR）后 JPEG 编码。
        // 表面在「采集→编码」之间流转，最后归还各自的池；编码线程退出后统一销毁。
        AutoResetEvent available = new AutoResetEvent(false);
        writeAvailable = new AutoResetEvent(false);
        // DIB section 的调色板匹配参考 DC；表面自身的 DC 由 CreateCompatibleDC 派生
        IntPtr referenceDc = GetDC(IntPtr.Zero);
        List<Surface> allSurfaces = new List<Surface>(); // 所有创建过的表面，退出时统一 Dispose（幂等）
        Queue<Surface> screenSourceFree = new Queue<Surface>();
        Queue<Surface> windowSourceFree = new Queue<Surface>();
        int windowPoolGeneration = 0;
        Queue<Surface> outputFree = new Queue<Surface>();
        object sourceLock = new object();
        object outputLock = new object();
        try
        {
            if (windowHandle == IntPtr.Zero)
            {
                // 6 块源表面 ≈ 200ms@30fps 缓冲：编码线程偶发延迟尖峰（GPU 编码器
                // 与渲染进程争用）时不至于立刻跳过采集槽位。实测 4 块时 20 秒内
                // 出现最多 15 次 poolMisses（约 3.5% 丢帧）。
                for (int i = 0; i < 6; i++) { Surface item = new Surface(width, height, referenceDc, false); allSurfaces.Add(item); screenSourceFree.Enqueue(item); }
            }
            else
            {
                // 窗口池在首次取得窗口边界时按实际尺寸创建
            }
            for (int i = 0; i < 4; i++)
            {
                Surface item = new Surface(outputWidth, outputHeight, referenceDc, false);
                if (fastScale) item.GdiPlus.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                allSurfaces.Add(item); outputFree.Enqueue(item);
            }
        }
        catch (Exception ex)
        {
            foreach (Surface item in allSurfaces) item.Dispose();
            available.Dispose(); writeAvailable.Dispose(); encoderParams.Dispose();
            ReleaseDC(IntPtr.Zero, referenceDc);
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
        int poolMisses = 0;
        bool captureDone = false;
        int encodersAlive = 0;
        Queue<CaptureWork> ready = new Queue<CaptureWork>();
        object queueLock = new object();
        // 编码线程默认 2 个：GDI+ JPEG 编码是单帧 ~15ms 的 CPU 瓶颈，60fps 时单线程
        // 实测只能到 46.7fps；两个线程几乎翻倍编码吞吐。每个线程持有独立的
        // MemoryStream，各自操作不同 Surface 的 Bitmap，GDI+ 多线程互不干扰。
        // WCS_GRABBER_ENCODERS=1 可强制单线程（诊断用：区分「双线程调度争用」与
        // 「采集线程本身变慢」）。
        int encoderThreads = Math.Max(1, Math.Min(2, Environment.ProcessorCount));
        string encoderOverride = Environment.GetEnvironmentVariable("WCS_GRABBER_ENCODERS");
        if (!string.IsNullOrEmpty(encoderOverride)) {
            int requested;
            if (int.TryParse(encoderOverride, out requested) && requested >= 1 && requested <= 4) encoderThreads = requested;
        }
        encodersAlive = encoderThreads;

        // 把源表面归还给所属的池；窗口表面代数过期（尺寸已变）时直接销毁。
        Action<CaptureWork> returnSource = delegate(CaptureWork work) {
            lock (sourceLock) {
                if (work.IsWindow) {
                    if (work.Generation == windowPoolGeneration) windowSourceFree.Enqueue(work.Src);
                    else work.Src.Dispose();
                } else {
                    screenSourceFree.Enqueue(work.Src);
                }
            }
        };

        List<Thread> encoderThreadsList = new List<Thread>();
        for (int t = 0; t < encoderThreads; t++)
        {
            Thread encoder = new Thread(delegate() {
                using (MemoryStream buffer = new MemoryStream(512 * 1024)) {
                    while (true) {
                        CaptureWork item = null;
                        lock (queueLock) { if (ready.Count > 0) item = ready.Dequeue(); else if (captureDone) break; }
                        if (item == null) { available.WaitOne(50); continue; }
                        try {
                            Surface target = null;
                            try {
                                // 恒定经由 24bpp 输出表面编码（JPEG 快路径）：即使源与输出
                                // 同尺寸也做一次 1:1 blit 完成 32→24 转换（毫秒级），
                                // 避免从 32bpp 源直接编码让吞吐掉一半（实测导致采集池耗尽）。
                                lock (outputLock) {
                                    while (outputFree.Count == 0 && !_quit) Monitor.Wait(outputLock, 100);
                                    if (outputFree.Count > 0) target = outputFree.Dequeue();
                                }
                                if (target == null) break; // 正在退出
                                bool oneToOne = item.Src.Width == outputWidth && item.Src.Height == outputHeight;
                                if (!item.IsWindow && oneToOne) {
                                    if (!BitBlt(target.DC, 0, 0, outputWidth, outputHeight, item.Src.DC, 0, 0, 0x40CC0020))
                                        throw new Exception("Copy blit failed: " + Marshal.GetLastWin32Error());
                                } else if (!item.IsWindow) {
                                    SetStretchBltMode(target.DC, fastScale ? 3 : 4); SetBrushOrgEx(target.DC, 0, 0, IntPtr.Zero);
                                    bool scaled = StretchBlt(target.DC, 0, 0, outputWidth, outputHeight, item.Src.DC, 0, 0, item.Src.Width, item.Src.Height, 0x40CC0020);
                                    if (!scaled) scaled = StretchBlt(target.DC, 0, 0, outputWidth, outputHeight, item.Src.DC, 0, 0, item.Src.Width, item.Src.Height, 0x00CC0020);
                                    if (!scaled) throw new Exception("Scale blit failed: " + Marshal.GetLastWin32Error());
                                } else {
                                    PatBlt(target.DC, 0, 0, outputWidth, outputHeight, 0x00000042); // BLACKNESS
                                    double fit = Math.Min(outputWidth/(double)item.Src.Width, outputHeight/(double)item.Src.Height);
                                    int dw = Math.Max(1, (int)Math.Round(item.Src.Width*fit)), dh = Math.Max(1, (int)Math.Round(item.Src.Height*fit));
                                    target.GdiPlus.DrawImage(item.Src.Wrapper, (outputWidth-dw)/2, (outputHeight-dh)/2, dw, dh);
                                }
                                buffer.SetLength(0); target.Wrapper.Save(buffer, jpegCodec, encoderParams);
                                // ToArray 会拷贝一份精确长度的字节交给发送队列；
                                // MemoryStream 的后备缓冲可能远大于实际长度，不能直接外借。
                                EnqueueFrame(buffer.ToArray(), item.Qpc);
                            } finally { if (target != null) { lock (outputLock) { outputFree.Enqueue(target); Monitor.Pulse(outputLock); } } }
                        } catch (IOException) { _quit = true; break; }
                        catch (Exception ex) {
                            Interlocked.Increment(ref failures); Log("ENCODE_ERROR " + ex.GetType().Name + ": " + ex.Message); _quit = true; break;
                        } finally { returnSource(item); }
                    }
                }
                Interlocked.Decrement(ref encodersAlive);
            });
            encoder.IsBackground = true; encoder.Start();
            encoderThreadsList.Add(encoder);
        }
        // 发送线程：唯一写 stdout 的线程。父进程卡顿时队列吸收背压，
        // 采集/编码完全不感知；父进程消失时写失败立即退出。
        Thread writer = new Thread(delegate() {
            while (true) {
                EncodedFrame item = null;
                bool producersFinished = false;
                lock (writeLock) {
                    if (writeQueue.Count > 0) { item = writeQueue.Dequeue(); queuedBytes -= item.Data.Length; }
                    producersFinished = captureDone && encodersAlive == 0;
                }
                if (item == null) {
                    if (producersFinished) break;
                    writeAvailable.WaitOne(50);
                    continue;
                }
                try {
                    WriteFrame(item.Data, item.Data.Length, item.Qpc);
                    Interlocked.Increment(ref frames);
                } catch (IOException) { _quit = true; break; }
                catch (Exception ex) {
                    Interlocked.Increment(ref failures); Log("WRITE_ERROR " + ex.GetType().Name + ": " + ex.Message); _quit = true; break;
                }
            }
        });
        writer.IsBackground = true; writer.Start();
        Stopwatch clock = Stopwatch.StartNew();
        IntPtr desktopDC = windowHandle == IntPtr.Zero ? GetDC(IntPtr.Zero) : IntPtr.Zero;
        int lastWindowWidth = 0, lastWindowHeight = 0;

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

                Surface src = null;
                bool isWindow = windowHandle != IntPtr.Zero;
                int generation = 0;
                int sourceWaitMs = Math.Max(1, Math.Min(8, 1000 / fps));
                if (!isWindow)
                {
                    lock (sourceLock) {
                        if (screenSourceFree.Count == 0) Monitor.Wait(sourceLock, sourceWaitMs);
                        src = screenSourceFree.Count > 0 ? screenSourceFree.Dequeue() : null;
                    }
                }
                else
                {
                    RECT bounds;
                    if (!IsWindow(windowHandle) || IsIconic(windowHandle) || !GetWindowRect(windowHandle, out bounds)) {
                        Log("SOURCE_CLOSED window closed or minimized"); _quit = true; break;
                    }
                    int ww = bounds.Right-bounds.Left, wh = bounds.Bottom-bounds.Top;
                    if (bounds.Left != offsetX || bounds.Top != offsetY || ww != lastWindowWidth || wh != lastWindowHeight) {
                        offsetX = bounds.Left; offsetY = bounds.Top; lastWindowWidth = ww; lastWindowHeight = wh;
                        Log("WINDOW_BOUNDS " + offsetX + " " + offsetY + " " + ww + " " + wh);
                        if (ww > 0 && wh > 0) {
                            lock (sourceLock) {
                                // 整代重建：空闲的旧表面立即销毁，编码线程手中的旧表面
                                // 在归还时按代数判断后销毁，避免编码中 Dispose 崩溃。
                                windowPoolGeneration += 1;
                                while (windowSourceFree.Count > 0) windowSourceFree.Dequeue().Dispose();
                                try {
                                    for (int i = 0; i < 2; i++) { Surface item = new Surface(ww, wh, referenceDc, true); allSurfaces.Add(item); windowSourceFree.Enqueue(item); }
                                } catch (Exception ex) {
                                    int count = Interlocked.Increment(ref failures);
                                    if (count <= 3) Log("CAPTURE_ERROR Surface rebuild " + ex.GetType().Name + ": " + ex.Message);
                                }
                            }
                        }
                    }
                    lock (sourceLock) {
                        if (windowSourceFree.Count == 0) Monitor.Wait(sourceLock, sourceWaitMs);
                        src = windowSourceFree.Count > 0 ? windowSourceFree.Dequeue() : null;
                        generation = windowPoolGeneration;
                    }
                }
                if (src == null) { poolMisses++; nextDeadlineUs = nowUs + frameIntervalUs; Thread.Sleep(1); continue; }

                QueryPerformanceCounter(out qpc);
                bool ok = false;
                try
                {
                    if (!isWindow)
                    {
                        if (desktopDC == IntPtr.Zero) throw new Exception("Desktop DC unavailable");
                        // 采集线程只做 1:1 BitBlt：缩放是完整链路丢帧的全部来源，
                        // 已挪到编码线程（见 CaptureWork 注释）。写 DIB section 的内存 DC。
                        if (!BitBlt(src.DC, 0, 0, width, height, desktopDC, offsetX, offsetY, 0x40CC0020))
                            throw new Exception("Desktop blit failed: " + Marshal.GetLastWin32Error());
                    }
                    else
                    {
                        if (src.Width <= 0 || src.Height <= 0) throw new Exception("Invalid window bounds");
                        bool captured = PrintWindow(windowHandle, src.DC, 2);
                        if (!captured) { Log("SOURCE_CLOSED PrintWindow rejected"); _quit = true; }
                    }
                    ok = !_quit;
                }
                catch (Exception ex)
                {
                    int count = Interlocked.Increment(ref failures);
                    if (count <= 3) Log("CAPTURE_ERROR " + ex.GetType().Name + ": " + ex.Message);
                }

                if (ok)
                {
                    lock (queueLock) ready.Enqueue(new CaptureWork(src, qpc, isWindow, generation));
                    available.Set();
                }
                else
                {
                    returnSource(new CaptureWork(src, qpc, isWindow, generation));
                }

                if (probe)
                {
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
            lock (queueLock) captureDone = true;
            available.Set();
            foreach (Thread encoder in encoderThreadsList) encoder.Join(1500);
            // 等发送线程把队列里剩余的已编码帧写完（优雅退出时尾部帧不丢）；
            // 父进程已消失时写失败会自行退出，超时只是兜底。
            writer.Join(2000);
            if (desktopDC != IntPtr.Zero) ReleaseDC(IntPtr.Zero, desktopDC);
            ReleaseDC(IntPtr.Zero, referenceDc);
            timeEndPeriod(1);
            // A blocked stdout is terminated with the process; never dispose a
            // bitmap while the background encoder is still inside GDI+.
            if (encodersAlive == 0) {
                foreach (Surface item in allSurfaces) item.Dispose();
                available.Dispose(); writeAvailable.Dispose(); encoderParams.Dispose();
            }
        }

        if (probe) Log("PROBE_DONE frames=" + frames);
        Log("DONE frames=" + frames + " failures=" + failures + " poolMisses=" + poolMisses + " pipeDrops=" + pipeDrops);
        return failures > 0 && frames == 0 ? 4 : 0;
    }
}
