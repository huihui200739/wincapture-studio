// spike 8：验证完整链路 —— GDI 采集 → 编码 → mediabunny 封装 MP4 → 解封装读回校验
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');

app.setPath('userData', path.join(__dirname, '..', '.spike-data'));

const WORK = path.join(__dirname, '..', 'spike-work');
fs.mkdirSync(WORK, { recursive: true });

// 常驻 GDI 抓帧进程（避免每帧 spawn PowerShell）
const grabberCs = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class Grabber {
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);

  static void Main(string[] a) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    int w = int.Parse(a[0]), h = int.Parse(a[1]), x = int.Parse(a[2]), y = int.Parse(a[3]);
    var stdout = Console.OpenStandardOutput();
    IntPtr sdc = GetDC(IntPtr.Zero);
    IntPtr mdc = CreateCompatibleDC(sdc);
    IntPtr bmp = CreateCompatibleBitmap(sdc, w, h);
    IntPtr old = SelectObject(mdc, bmp);
    var codec = GetEncoder(ImageFormat.Jpeg);
    var enc = new EncoderParameters(1);
    enc.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
    var header = BitConverter.GetBytes(w * h * 4 + 64);
    string line;
    while ((line = Console.ReadLine()) != null) {
      if (line.Trim() == "q") break;
      BitBlt(mdc, 0, 0, w, h, sdc, x, y, 0x00CC0020);
      using (var img = Image.FromHbitmap(bmp))
      using (var ms = new MemoryStream()) {
        img.Save(ms, codec, enc);
        var bytes = ms.ToArray();
        var len = BitConverter.GetBytes(bytes.Length);
        stdout.Write(len, 0, 4);
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
      }
    }
    SelectObject(mdc, old); DeleteObject(bmp); DeleteDC(mdc); ReleaseDC(IntPtr.Zero, sdc);
  }
  static ImageCodecInfo GetEncoder(ImageFormat f) {
    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == f.Guid) return c;
    return null;
  }
}
`;

app.whenReady().then(async () => {
  const log = (m) => console.log('[SPIKE8] ' + m);
  try {
    // 编译抓帧器
    const csPath = path.join(WORK, 'grabber.cs');
    const exePath = path.join(WORK, 'grabber.exe');
    fs.writeFileSync(csPath, grabberCs, 'utf8');
    if (!fs.existsSync(exePath)) {
      const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
      const cp = spawn(csc, ['/nologo', '/optimize+', '/out:' + exePath, csPath, '/r:System.Drawing.dll'], { stdio: 'inherit' });
      await new Promise((r) => cp.on('close', r));
    }
    log('grabber compiled: ' + fs.existsSync(exePath));

    const W = 1280, H = 720;
    const FPS = 30, SECONDS = 3;
    const FRAMES = FPS * SECONDS;

    // 启动抓帧器
    const grabber = spawn(exePath, [String(W), String(H), '0', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    const pending = [];
    grabber.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const jpeg = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        const p = pending.shift();
        if (p) p(jpeg);
      }
    });
    const grabFrame = () =>
      new Promise((resolve) => {
        pending.push(resolve);
        grabber.stdin.write('g\n');
      });

    // 预取一帧
    const first = await grabFrame();
    log('first jpeg bytes=' + first.length);

    const server = http.createServer((req, res) => {
      if (req.url === '/mediabunny.js') {
        const src = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.cjs'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(src);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const html = `<!doctype html><html><head><meta charset="utf-8">
<script src="http://127.0.0.1:${port}/mediabunny.js"></script></head><body><script>
window.run = async (jpegB64List, W, H, FPS) => {
  const out = {};
  try {
    const MB = window.Mediabunny;
    out.hasMediabunny = !!MB;
    out.keys = Object.keys(MB).slice(0, 40);
    const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH } = MB;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: 6000000 });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    await output.start();
    for (let i = 0; i < jpegB64List.length; i++) {
      const bin = atob(jpegB64List[i]);
      const arr = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      const bmp = await createImageBitmap(new Blob([arr], { type: 'image/jpeg' }));
      ctx.drawImage(bmp, 0, 0, W, H);
      await videoSource.add(i / FPS, 1 / FPS);
    }
    await output.finalize();
    out.bytes = output.target.buffer.byteLength;
    out.data = Array.from(new Uint8Array(output.target.buffer));
  } catch (e) { out.error = String(e) + '\\n' + (e.stack || ''); }
  return out;
};
</script></body></html>`;

    const htmlPath = path.join(WORK, 'page.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);

    log('capturing ' + FRAMES + ' frames...');
    const jpegs = [first];
    const t0 = Date.now();
    for (let i = 1; i < FRAMES; i++) {
      jpegs.push(await grabFrame());
      await new Promise((r) => setTimeout(r, 1000 / FPS));
    }
    log('captured ' + jpegs.length + ' frames in ' + (Date.now() - t0) + 'ms');

    const b64 = jpegs.map((b) => b.toString('base64'));
    log('encoding + muxing...');
    const t1 = Date.now();
    const r = await win.webContents.executeJavaScript(`window.run(${JSON.stringify(b64)}, ${W}, ${H}, ${FPS})`);
    log('encode elapsed=' + (Date.now() - t1) + 'ms bytes=' + r.bytes + ' error=' + r.error);
    if (r.keys) log('mediabunny keys: ' + r.keys.join(','));

    if (r.data && r.data.length) {
      const outPath = path.join(process.cwd(), 'spike-mf-output.mp4');
      fs.writeFileSync(outPath, Buffer.from(r.data));
      log('wrote ' + outPath + ' (' + fs.statSync(outPath).size + ' bytes)');

      // 用 mediabunny 在 Node 侧解封装验证
      const verify = spawn(process.execPath, ['-e', `
const { Input, ALL_FORMATS, FilePathSource } = require(${JSON.stringify(path.join(__dirname, '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs'))});
(async () => {
  const input = new Input({ source: new FilePathSource(${JSON.stringify(outPath)}), formats: ALL_FORMATS });
  const vtrack = await input.getPrimaryVideoTrack();
  console.log(JSON.stringify({
    duration: await input.computeDuration(),
    video: vtrack ? { codec: await vtrack.getCodec(), w: await vtrack.getCodedWidth(), h: await vtrack.getCodedHeight(), fps: await vtrack.getAveragePacketRate(), packets: await vtrack.computePacketStats(60).then(s=>s.packetCount).catch(e=>String(e)) } : null,
    tracks: (await input.getTracks()).length,
  }));
})().catch(e => console.log('VERIFY_FAIL ' + e));
`], { stdio: 'inherit' });
      await new Promise((r2) => verify.on('close', r2));
    }
    grabber.stdin.write('q\n');
    grabber.kill();
    server.close();
    win.destroy();
    log('DONE');
  } catch (e) {
    console.error('SPIKE8_ERROR', e);
  } finally {
    setTimeout(() => app.exit(0), 500);
  }
});
