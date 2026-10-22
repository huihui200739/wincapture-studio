// spike 4：GDI 截屏采集 + WebCodecs H.264 编码 + mp4-muxer 封装 → 真实 MP4
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');

const pythonDir = 'C:\\Users\\huihui\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python';

async function captureFrame(width, height) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $bmp = New-Object System.Drawing.Bitmap(${width}, ${height}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size(${width}, ${height}))); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $g.Dispose(); $bmp.Dispose(); [Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks = [];
    ps.stdout.on('data', (c) => chunks.push(c));
    ps.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('GDI spawn failed ' + code))));
  });
}

app.whenReady().then(async () => {
  try {
    const vs = screen.getPrimaryDisplay().bounds;
    const width = vs.width;
    const height = vs.height;
    console.log(`[SPIKE] screen ${width}x${height}`);

    const server = http.createServer(async (req, res) => {
      if (req.url === '/__frame') {
        try {
          const bmp = await captureFrame(width, height);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(bmp);
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      } else if (req.url === '/muxer.js') {
        const src = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mp4-muxer', 'build', 'mp4-muxer.min.js'));
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(src);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const html = `<!doctype html><html><head><meta charset="utf-8"><script src="http://127.0.0.1:${port}/muxer.js"></script></head><body>
<script>
window.encodeFramesFromBuffers = async (frameCount, fps, W, H) => {
  const out = {};
  try {
    const { Muxer, ArrayBufferTarget } = Mp4Muxer;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      fastStart: 'in-memory',
    });
    const enc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { out.error = String(e); },
    });
    enc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 12000000, framerate: fps });
    let ok = 0;
    for (let i = 0; i < frameCount; i++) {
      const resp = await fetch('http://127.0.0.1:${port}/__frame', { method: 'POST' });
      const buf = await resp.arrayBuffer();
      const bmp = await createImageBitmap(new Blob([buf]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % 30 === 0 });
      vf.close();
      ok++;
    }
    await enc.flush();
    enc.close();
    muxer.finalize();
    out.bytes = muxer.target.buffer.byteLength;
    out.frames = ok;
    return { bytes: out.bytes, frames: out.frames, b64: btoa(String.fromCharCode(...new Uint8Array(muxer.target.buffer).slice(0, 0))) , full: Array.from(new Uint8Array(muxer.target.buffer)) };
  } catch (e) { return { error: String(e) }; }
};
</script></body></html>`;

    const htmlPath = path.join(__dirname, 'probe-pipeline.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);

    const FPS = 10;
    const FRAMES = 40;
    console.log(`[SPIKE] capturing ${FRAMES} frames at ${FPS} fps...`);
    const t0 = Date.now();
    const enc = await win.webContents.executeJavaScript(`window.encodeFramesFromBuffers(${FRAMES}, ${FPS}, ${width}, ${height})`);
    const elapsed = Date.now() - t0;
    console.log(`[SPIKE] encode result: bytes=${enc.bytes} frames=${enc.frames} elapsed=${elapsed}ms error=${enc.error}`);

    if (enc.full && enc.full.length) {
      const outPath = path.join(process.cwd(), 'spike-output.mp4');
      fs.writeFileSync(outPath, Buffer.from(enc.full));
      console.log(`[SPIKE] wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
      const py = spawn(pythonDir + '\\python.exe', ['-c', `
import struct, sys
path = sys.argv[1]
data = open(path, 'rb').read()
print('file size', len(data))
print('ftyp:', data[4:8].decode('latin1'))
def walk(data, off, end, depth):
    while off < end - 7:
        size = struct.unpack('>I', data[off:off+4])[0]
        btype = data[off+4:off+8].decode('latin1')
        print('  ' * depth + f'{btype} @{off} size={size}')
        if size <= 0: break
        if btype in ('moov','trak','mdia','minf','stbl'):
            walk(data[off+8:off+size], 0, size-8, depth+1)
        off += size
walk(data, 0, len(data), 0)
`, outPath]);
      let pyOut = '';
      py.stdout.on('data', (c) => (pyOut += c.toString()));
      py.stderr.on('data', (c) => (pyOut += c.toString()));
      await new Promise((r) => py.on('close', r));
      console.log('[SPIKE] mp4 structure:\n' + pyOut);
    }
    console.log('SPIKE_DONE');
    server.close();
    win.destroy();
  } catch (e) {
    console.error('SPIKE_ERROR', e);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
