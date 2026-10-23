using System;
using System.Runtime.InteropServices;
using System.Threading;
internal static class InjectClick {
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x,y; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x,uint y,uint data, UIntPtr extra);
    static void Main(string[] args) {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        POINT old; GetCursorPos(out old);
        try { if (!SetCursorPos(int.Parse(args[0]),int.Parse(args[1]))) throw new Exception("SetCursorPos denied: " + Marshal.GetLastWin32Error()); Thread.Sleep(100); mouse_event(2,0,0,0,UIntPtr.Zero); Thread.Sleep(100); mouse_event(4,0,0,0,UIntPtr.Zero); Thread.Sleep(100); }
        finally { SetCursorPos(old.x,old.y); }
    }
}
