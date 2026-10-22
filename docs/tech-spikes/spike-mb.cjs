// spike-mb.cjs -- verify mediabunny mux (canvas -> MP4 -> read back) and long-lived GDI grabber pipe.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');

app.setPath('userData', path.join(__dirname, '..', '.spike-data'));
const WORK = path.join(__dirname, '..', 'work');
fs.mkdirSync(WORK, { recursive: true });

const grabberCs = [
  'using System;',
  'using System.Drawing;',
  'using System.Drawing.Imaging;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'static class Grabber {',
  '  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);',
  '  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);',
  '  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);',
  '  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);',
  '  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);',
  '  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);',
  '  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);',
  '  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);',
  '  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);',
  '  static void Main(string[] a) {',
  '    SetProcessDpiAwarenessContext(new IntPtr(-4));',
  '    int w = int.Parse(a[0]), h = int.Parse(a[1]), x = int.Parse(a[2]), y = int.Parse(a[3]), q = int.Parse(a[4]);',
  '    var stdout = Console.OpenStandardOutput();',
  '    IntPtr sdc = GetDC(IntPtr.Zero);',
  '    IntPtr mdc = CreateCompatibleDC(sdc);',
  '    IntPtr bmp = CreateCompatibleBitmap(sdc, w, h);',
  '    IntPtr old = SelectObject(mdc, bmp);',
  '    var codec = GetEncoder(ImageFormat.Jpeg);',
  '    var enc = new EncoderParameters(1);',
  '    enc.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);',
  '    string line;',
  '    while ((line = Console.ReadLine()) != null) {',
  '      if (line.Trim() == "q") break;',
  '      BitBlt(mdc, 0, 0, w, h, sdc, x, y, 0x00CC0020);',
  '      using (var img = Image.FromHbitmap(bmp))',
  '      using (var ms = new MemoryStream()) {',
  '        img.Save(ms, codec, enc);',
  '        var bytes = ms.ToArray();',
  '        var len = BitConverter.GetBytes(bytes.Length);',
  '        stdout.Write(len, 0, 4);',
  '        stdout.Write(bytes, 0, bytes.Length);',
  '        stdout.Flush();',
  '      }',
  '    }',
  '    SelectObject(mdc, old); DeleteObject(bmp); DeleteDC(mdc); ReleaseDC(IntPtr.Zero, sdc);',
  '  }',
  '  static ImageCodecInfo GetEncoder(ImageFormat f) {',
  '    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == f.Guid) return c;',
  '    return null;',
  '  }',
  '}',
].join('\n');

function compileGrabber() {
  const csPath = path.join(WORK, 'grabber.cs');
  const exePath = path.join(WORK, 'grabber.exe');
  fs.writeFileSync(csPath, grabberCs, 'utf8');
  if (fs.existsSync(exePath)) return Promise.resolve(exePath);
  return new Promise((resolve, reject) => {
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const cp = spawn(csc, ['/nologo', '/optimize+', '/out:' + exePath, csPath, '/r:System.Drawing.dll'], { stdio: 'inherit' });
    cp.on('close', (code) => (code === 0 ? resolve(exePath) : reject(new Error('csc failed ' + code))));
  });
}

app.whenReady().then(async () => {
  const log = (m) => console.log('[MB] ' + m);
  try {
    // ---- 1. GDI grabber pipe ----
    const exe = await compileGrabber();
    log('grabber compiled');
    const W = 1280, H = 720;
    const grabber = spawn(exe, [String(W), String(H), '0', '0', '90'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let acc = Buffer.alloc(0);
    const waiters = [];
    grabber.stdout.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 4) {
        const len = acc.readUInt32LE(0);
        if (acc.length < 4 + len) break;
        const jpeg = acc.subarray(4, 4 + len);
        acc = acc.subarray(4 + len);
        const w = waiters.shift();
        if (w) w(jpeg);
      }
    });
    const grab = () => new Promise((resolve) => { waiters.push(resolve); grabber.stdin.write('g\n'); });

    const t0 = Date.now();
    const N = 30;
    let total = 0;
    const jpegs = [];
    for (let i = 0; i < N; i++) {
      const j = await grab();
      jpegs.push(j);
      total += j.length;
    }
    const ms = Date.now() - t0;
    log('grabber: frames=' + N + ' ms=' + ms + ' fps=' + (N * 1000 / ms).toFixed(1) + ' avgKB=' + (total / N / 1024).toFixed(0));
    grabber.stdin.write('q\n');
    grabber.kill();

    // ---- 2. mediabunny mux ----
    const server = http.createServer((req, res) => {
      if (req.url === '/mediabunny.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.cjs')));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="http://127.0.0.1:' + port + '/mediabunny.js"></script></head><body><script>' +
      'window.probe = () => { const MB = window.Mediabunny; return { has: !!MB, keys: Object.keys(MB) }; };' +
      'window.mux = async (b64, W, H, FPS) => {' +
      '  const out = {};' +
      '  try {' +
      '    const MB = window.Mediabunny;' +
      '    const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } = MB;' +
      '    out.missing = ["Output","Mp4OutputFormat","BufferTarget","CanvasSource","AudioBufferSource"].filter(k => !MB[k]);' +
      '    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });' +
      '    const canvas = new OffscreenCanvas(W, H);' +
      '    const ctx = canvas.getContext("2d");' +
      '    const vs = new CanvasSource(canvas, { codec: "avc", bitrate: 6000000 });' +
      '    output.addVideoTrack(vs, { frameRate: FPS });' +
      '    const ac = new OfflineAudioContext(2, 48000, 48000);' +
      '    const ab = ac.createBuffer(2, 48000 * 2, 48000);' +
      '    for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = Math.sin(2*Math.PI*440*i/48000) * 0.2; }' +
      '    const as = new AudioBufferSource({ codec: "aac", bitrate: 192000 });' +
      '    output.addAudioTrack(as);' +
      '    await output.start();' +
      '    for (let i = 0; i < b64.length; i++) {' +
      '      const bin = atob(b64[i]); const arr = new Uint8Array(bin.length);' +
      '      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);' +
      '      const bmp = await createImageBitmap(new Blob([arr], { type: "image/jpeg" }));' +
      '      ctx.drawImage(bmp, 0, 0, W, H);' +
      '      await vs.add(i / FPS, 1 / FPS);' +
      '    }' +
      '    await as.add(ab);' +
      '    await output.finalize();' +
      '    out.bytes = output.target.buffer.byteLength;' +
      '    out.data = Array.from(new Uint8Array(output.target.buffer));' +
      '  } catch (e) { out.error = String(e) + " | " + (e.stack || ""); }' +
      '  return out;' +
      '};' +
      '</script></body></html>';
    const htmlPath = path.join(WORK, 'mb.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);

    log('probe: ' + JSON.stringify(await win.webContents.executeJavaScript('window.probe()')));

    const FPS = 30;
    const b64 = jpegs.map((b) => b.toString('base64'));
    const t1 = Date.now();
    const r = await win.webContents.executeJavaScript('window.mux(' + JSON.stringify(b64) + ', ' + W + ', ' + H + ', ' + FPS + ')');
    log('mux elapsed=' + (Date.now() - t1) + 'ms bytes=' + r.bytes + ' missing=' + JSON.stringify(r.missing) + ' error=' + (r.error || 'none'));

    if (r.data && r.data.length) {
      const outPath = path.join(process.cwd(), 'spike-mb.mp4');
      fs.writeFileSync(outPath, Buffer.from(r.data));
      log('wrote ' + outPath + ' size=' + fs.statSync(outPath).size);

      // Read back with mediabunny in node
      const verifyCode = [
        'const mb = require(' + JSON.stringify(path.join(__dirname, '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs')) + ');',
        '(async () => {',
        '  const input = new mb.Input({ source: new mb.FilePathSource(' + JSON.stringify(outPath) + '), formats: mb.ALL_FORMATS });',
        '  const v = await input.getPrimaryVideoTrack();',
        '  const a = await input.getPrimaryAudioTrack();',
        '  const res = {',
        '    duration: await input.computeDuration(),',
        '    video: v ? { codec: await v.getCodec(), w: await v.getCodedWidth(), h: await v.getCodedHeight(), fps: await v.getAveragePacketRate() } : null,',
        '    audio: a ? { codec: await a.getCodec(), rate: await a.getSampleRate(), ch: await a.getNumberOfChannels() } : null,',
        '  };',
        '  const sink = new mb.VideoSampleSink(v);',
        '  let n = 0;',
        '  for await (const s of sink.samples(0, 2)) { n++; s.close(); }',
        '  res.decodedFrames = n;',
        '  console.log("VERIFY " + JSON.stringify(res));',
        '})().catch(e => console.log("VERIFY_FAIL " + String(e)));',
      ].join('\n');
      const vp = spawn(process.execPath, ['-e', verifyCode], { stdio: 'inherit' });
      await new Promise((r2) => vp.on('close', r2));
    }

    server.close();
    win.destroy();
    log('DONE');
  } catch (e) {
    console.error('[MB] ERROR', e);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
