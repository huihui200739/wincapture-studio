// Global mouse button events with the same QPC clock as the video/audio workers.
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Concurrent;

internal static class PointerCapture {
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSE { public POINT point; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT point; public uint reserved; }
    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wp, IntPtr lp);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] private static extern bool QueryPerformanceCounter(out long value);
    [DllImport("kernel32.dll")] private static extern bool QueryPerformanceFrequency(out long value);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    private static IntPtr hook;
    private static readonly HookProc callback = OnMouse;
    private static readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent available = new AutoResetEvent(false);
    private static int queued;
    private static bool quitting;
    private static long lastMoveQpc;
    private static IntPtr OnMouse(int code, IntPtr message, IntPtr data) {
        if (code >= 0) {
            int m = message.ToInt32();
            bool down = m == 0x201 || m == 0x204 || m == 0x207 || m == 0x20B;
            bool up = m == 0x202 || m == 0x205 || m == 0x208 || m == 0x20C;
            bool move = m == 0x200;
            if (down || up || move) {
                try {
                    MOUSE mouse = (MOUSE)Marshal.PtrToStructure(data, typeof(MOUSE));
                    long qpc; QueryPerformanceCounter(out qpc);
                    long frequency; QueryPerformanceFrequency(out frequency);
                    if (move && qpc - lastMoveQpc < frequency / 120) return CallNextHookEx(hook, code, message, data);
                    if (move) lastMoveQpc = qpc;
                    int button = m == 0x204 || m == 0x205 ? 2 : m == 0x207 || m == 0x208 ? 1 : m == 0x20B || m == 0x20C ? 3 : 0;
                    IntPtr target = GetAncestor(WindowFromPoint(mouse.point), 2); RECT bounds;
                    string geometry = "";
                    if (!move && GetWindowRect(target, out bounds)) geometry = ",\"hwnd\":\"" + target.ToInt64() + "\",\"bounds\":{\"x\":" + bounds.left + ",\"y\":" + bounds.top + ",\"width\":" + (bounds.right-bounds.left) + ",\"height\":" + (bounds.bottom-bounds.top) + "}";
                    // Never block the low-level hook on a full stdout pipe.
                    if (Interlocked.Increment(ref queued) <= 2048) {
                        events.Enqueue("{\"qpc\":\"" + qpc + "\",\"kind\":\"" + (move ? "move" : down ? "down" : "up") +
                            "\",\"x\":" + mouse.point.x + ",\"y\":" + mouse.point.y + ",\"button\":" + button + geometry + "}");
                        available.Set();
                    } else Interlocked.Decrement(ref queued);
                } catch { /* Never let logging interfere with the OS mouse hook. */ }
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }
    private static int Main() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        uint thread = GetCurrentThreadId();
        hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) { Console.Error.WriteLine("HOOK_ERROR " + Marshal.GetLastWin32Error()); return 1; }
        try {
            long frequency; QueryPerformanceFrequency(out frequency);
            MSG initial; PeekMessage(out initial, IntPtr.Zero, 0, 0, 0);
            // Force creation of the message queue before accepting a quit request.
            new Thread(delegate() { try { Console.ReadLine(); } finally { PostThreadMessage(thread, 0x12, UIntPtr.Zero, IntPtr.Zero); } }) { IsBackground=true }.Start();
            Console.WriteLine("{\"ready\":true,\"frequency\":\"" + frequency + "\"}");
            new Thread(delegate() {
                try { while (!quitting) { available.WaitOne(500); string line; while (events.TryDequeue(out line)) { Interlocked.Decrement(ref queued); Console.WriteLine(line); } } }
                catch { PostThreadMessage(thread, 0x12, UIntPtr.Zero, IntPtr.Zero); }
            }) { IsBackground=true }.Start();
            MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            return 0;
        } finally { quitting = true; available.Set(); UnhookWindowsHookEx(hook); }
    }
}
