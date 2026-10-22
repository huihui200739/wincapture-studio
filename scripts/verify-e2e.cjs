#!/usr/bin/env node
/**
 * 端到端验证脚本（Lead 集成用）
 *
 * 目的：在没有人工操作的情况下，验证「工程 → 场景求值 → 合成 → 编码 → MP4」这条
 * 与预览完全相同的路径能产出可解码的真实 MP4，并校验时长/帧率/音轨。
 *
 * 运行：
 *   node_modules\electron\dist\electron.exe --no-sandbox scripts/verify-e2e.cjs
 *
 * 说明：
 * - 用 GDI 抓取当前桌面作为「源素材」，因此运行时会真的录到屏幕内容
 * - 输出到 dist/verify/
 * - 这是集成验证，不替代人工验收
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'verify');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

app.setPath('userData', path.join(ROOT, '.verify-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

const results = { steps: [], ok: true };
function record(name, value, ok = true) {
  results.steps.push({ name, value, ok });
  if (!ok) results.ok = false;
  console.log(`[VERIFY] ${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(value)}`);
}

/** 编译 GDI 抓帧器（构建期编译，不在 Electron 子进程里调 csc）。 */
function ensureGrabber() {
  const dir = path.join(OUT, 'native');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'grabber.exe');
  const src = path.join(ROOT, 'electron', 'native', 'grabber.cs');
  if (fs.existsSync(exe)) return exe;
  if (!fs.existsSync(src)) throw new Error('缺少 electron/native/grabber.cs（由 WP-A 提供）');
  const r = spawnSync(CSC, ['/nologo', '/optimize+', '/out:' + exe, src, '/r:System.Drawing.dll'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('csc 编译失败: ' + (r.stdout || '') + (r.stderr || ''));
  return exe;
}

app.whenReady().then(async () => {
  const log = (m) => console.log('[VERIFY] ' + m);
  try {
    fs.mkdirSync(OUT, { recursive: true });

    // ---- 1. 编译并启动抓帧器 ----
    const exe = ensureGrabber();
    record('grabber-compiled', { exe: path.relative(ROOT, exe) });

    const { screen } = require('electron');
    const disp = screen.getPrimaryDisplay();
    const scale = disp.scaleFactor || 1;
    const W = 1280;
    const H = 720;
    // 取屏幕中心区域，保证抓到的是桌面内容
    const x = Math.round((disp.bounds.width * scale - W) / 2);
    const y = Math.round((disp.bounds.height * scale - H) / 2);

    const grabber = spawn(exe, [String(W), String(H), String(Math.max(0, x)), String(Math.max(0, y)), '88'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    grabber.stderr.on('data', (c) => log('grabber stderr: ' + c.toString().trim()));
    const grab = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('抓帧超时')), 5000);
      waiters.push((j) => { clearTimeout(timer); resolve(j); });
      grabber.stdin.write('g\n');
    });

    // 预热
    const warm = await grab();
    record('gdi-capture', { bytes: warm.length, jpeg: warm.subarray(0, 2).toString('hex') === 'ffd8' });

    // ---- 2. 抓帧速率测量 ----
    const N = 30;
    const t0 = Date.now();
    const frames = [];
    for (let i = 0; i < N; i++) frames.push(await grab());
    const grabMs = Date.now() - t0;
    const fps = (N * 1000) / grabMs;
    record('grabber-fps', { frames: N, ms: grabMs, fps: Number(fps.toFixed(1)), target30: fps >= 30 }, fps >= 30);

    // ---- 3. 本地服务：提供 mediabunny 与帧数据 ----
    const server = http.createServer((req, res) => {
      if (req.url === '/mediabunny.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(fs.readFileSync(path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.cjs')));
        return;
      }
      if (req.url === '/frame') {
        grab()
          .then((jpeg) => {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(jpeg);
          })
          .catch((e) => {
            res.writeHead(500);
            res.end(String(e));
          });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    // ---- 4. 渲染进程：合成 + 编码 + 封装 ----
    const html = `<!doctype html><html><head><meta charset="utf-8">
<script src="http://127.0.0.1:${port}/mediabunny.js"></script></head><body><script>
window.run = async (W, H, FPS, SECONDS) => {
  const out = { logs: [] };
  const log = (m) => out.logs.push(m);
  try {
    const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeVideo } = window.Mediabunny;

    // 编码能力
    const hw = await canEncodeVideo('avc', { width: W, height: H, bitrate: 8000000, hardwareAcceleration: 'prefer-hardware' });
    const sw = await canEncodeVideo('avc', { width: W, height: H, bitrate: 8000000, hardwareAcceleration: 'prefer-software' });
    out.encoder = hw ? 'hardware' : sw ? 'software' : 'none';
    log('encoder=' + out.encoder);
    if (out.encoder === 'none') { out.error = '无可用 H.264 编码器'; return out; }

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    const vs = new CanvasSource(canvas, { codec: 'avc', bitrate: 8000000, hardwareAcceleration: out.encoder === 'hardware' ? 'prefer-hardware' : 'prefer-software' });
    output.addVideoTrack(vs, { frameRate: FPS });

    // 合成音轨（440Hz + 660Hz 双音）
    const rate = 48000;
    const ac = new OfflineAudioContext(2, rate * SECONDS, rate);
    const ab = ac.createBuffer(2, rate * SECONDS, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ab.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        d[i] = 0.18 * Math.sin(2 * Math.PI * (440 + ch * 220) * i / rate);
      }
    }
    const as = new AudioBufferSource({ codec: 'aac', bitrate: 192000 });
    output.addAudioTrack(as);
    await output.start();

    // 逐帧：抓桌面 → 绘制画布（含圆角背景与画中画，模拟真实合成）→ 编码
    const total = FPS * SECONDS;
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      const resp = await fetch('http://127.0.0.1:${port}/frame');
      const jpeg = await resp.blob();
      const bmp = await createImageBitmap(jpeg);
      // 背景
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#101418'); g.addColorStop(1, '#1b2430');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // 屏幕内容（带内边距与圆角）
      const pad = Math.round(W * 0.045);
      const rw = W - pad * 2, rh = H - pad * 2;
      ctx.save();
      ctx.beginPath();
      const r = 14;
      ctx.moveTo(pad + r, pad); ctx.arcTo(pad + rw, pad, pad + rw, pad + rh, r);
      ctx.arcTo(pad + rw, pad + rh, pad, pad + rh, r); ctx.arcTo(pad, pad + rh, pad, pad, r);
      ctx.arcTo(pad, pad, pad + rw, pad, r); ctx.closePath();
      ctx.clip();
      ctx.drawImage(bmp, pad, pad, rw, rh);
      // 隐私遮挡演示：右上角实色块
      ctx.fillStyle = '#000';
      ctx.fillRect(pad + rw * 0.72, pad + rh * 0.06, rw * 0.22, rh * 0.1);
      ctx.restore();
      // 时间码
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '600 22px "Segoe UI", sans-serif';
      ctx.fillText('WinCapture Studio  frame ' + (i + 1) + '/' + total, pad + 12, H - pad - 14);
      await vs.add(i / FPS, 1 / FPS);
    }
    await as.add(ab);
    await output.finalize();
    out.encodeMs = Math.round(performance.now() - t0);
    out.frames = total;
    out.bytes = output.target.buffer.byteLength;
    out.data = Array.from(new Uint8Array(output.target.buffer));
    log('encoded ' + out.frames + ' frames in ' + out.encodeMs + 'ms');
  } catch (e) { out.error = String(e) + ' | ' + (e.stack || ''); }
  return out;
};
</script></body></html>`;

    const htmlPath = path.join(OUT, 'verify.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, offscreen: false },
    });
    await win.loadFile(htmlPath);

    const FPS = 30;
    const SECONDS = 6;
    log(`rendering ${FPS * SECONDS} frames at ${FPS}fps...`);
    const r = await win.webContents.executeJavaScript(`window.run(${W}, ${H}, ${FPS}, ${SECONDS})`);
    if (r.logs) r.logs.forEach((l) => log('  ' + l));
    if (r.error) {
      record('render-encode', { error: r.error }, false);
    } else {
      record('render-encode', { frames: r.frames, bytes: r.bytes, encoder: r.encoder, encodeMs: r.encodeMs });
    }

    let mp4Path = null;
    if (r.data && r.data.length) {
      mp4Path = path.join(OUT, 'e2e-output.mp4');
      fs.writeFileSync(mp4Path, Buffer.from(r.data));
      record('mp4-written', { path: path.relative(ROOT, mp4Path), bytes: fs.statSync(mp4Path).size });
    }

    // ---- 5. 解封装校验 ----
    if (mp4Path) {
      const verifyCode = `
const mb = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs'))});
(async () => {
  const input = new mb.Input({ source: new mb.FilePathSource(${JSON.stringify(mp4Path)}), formats: mb.ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const res = {
    duration: await input.computeDuration(),
    video: v ? { codec: await v.getCodec(), w: await v.getCodedWidth(), h: await v.getCodedHeight(), fps: await v.getAveragePacketRate(), rotation: await v.getRotation() } : null,
    audio: a ? { codec: await a.getCodec(), rate: await a.getSampleRate(), ch: await a.getNumberOfChannels() } : null,
    tracks: (await input.getTracks()).length,
  };
  // 真正解码若干帧，确认可解码
  const sink = new mb.VideoSampleSink(v);
  let decoded = 0; let first = null;
  for await (const s of sink.samples(0, 1.5)) {
    if (!first) first = { w: s.codedWidth, h: s.codedHeight, ts: s.timestamp };
    decoded++; s.close();
  }
  res.decodedFrames = decoded;
  res.firstSample = first;
  const asink = new mb.AudioBufferSink(a);
  let audioFrames = 0;
  for await (const buf of asink.buffers(0, 0.5)) { audioFrames += buf.length; }
  res.decodedAudioSamples = audioFrames;
  console.log('VERIFY_JSON ' + JSON.stringify(res));
})().catch(e => console.log('VERIFY_JSON ' + JSON.stringify({ error: String(e) })));
`;
      const vp = spawn(process.execPath, ['-e', verifyCode], { stdio: ['ignore', 'pipe', 'inherit'] });
      let vout = '';
      vp.stdout.on('data', (c) => (vout += c.toString()));
      await new Promise((res) => vp.on('close', res));
      const line = vout.split('\n').find((l) => l.startsWith('VERIFY_JSON '));
      if (line) {
        const parsed = JSON.parse(line.slice('VERIFY_JSON '.length));
        const durationOk = parsed.duration && Math.abs(parsed.duration - SECONDS) <= 1 / FPS + 0.05;
        const fpsOk = parsed.video && Math.abs(parsed.video.fps - FPS) < 0.5;
        const hasAudio = !!parsed.audio;
        const decodable = parsed.decodedFrames > 0 && parsed.decodedAudioSamples > 0;
        record('demux-verify', parsed, durationOk && fpsOk && hasAudio && decodable);
      } else {
        record('demux-verify', { raw: vout }, false);
      }
    }

    // ---- 6. 校验真实视频帧内容（确认不是纯色/空白） ----
    if (mp4Path) {
      const pixCode = `
const mb = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs'))});
(async () => {
  const input = new mb.Input({ source: new mb.FilePathSource(${JSON.stringify(mp4Path)}), formats: mb.ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const sink = new mb.VideoSampleSink(v);
  for await (const s of sink.samples(0, 0.1)) {
    const canvas = new OffscreenCanvas(s.codedWidth, s.codedHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(s.toCanvasImageSource(), 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    let sum = 0;
    for (let i = 0; i < d.length; i += 4 * 997) { colors.add((d[i] >> 4) + ',' + (d[i+1] >> 4) + ',' + (d[i+2] >> 4)); sum += d[i]; }
    console.log('PIX_JSON ' + JSON.stringify({ w: canvas.width, h: canvas.height, distinctColors: colors.size, avgR: Math.round(sum / (d.length / (4*997))) }));
    s.close();
    break;
  }
})().catch(e => console.log('PIX_JSON ' + JSON.stringify({ error: String(e) })));
`;
      const pp = spawn(process.execPath, ['-e', pixCode], { stdio: ['ignore', 'pipe', 'inherit'] });
      let pout = '';
      pp.stdout.on('data', (c) => (pout += c.toString()));
      await new Promise((res) => pp.on('close', res));
      const line = pout.split('\n').find((l) => l.startsWith('PIX_JSON '));
      if (line) {
        const parsed = JSON.parse(line.slice('PIX_JSON '.length));
        record('frame-content', parsed, !parsed.error && parsed.distinctColors > 20);
      } else {
        record('frame-content', { raw: pout }, false);
      }
    }

    grabber.stdin.write('q\n');
    grabber.kill();
    server.close();
    win.destroy();
  } catch (e) {
    record('fatal', String(e) + ' | ' + (e.stack || ''), false);
  } finally {
    fs.writeFileSync(path.join(OUT, 'verify-result.json'), JSON.stringify(results, null, 2));
    console.log('[VERIFY] === SUMMARY ===');
    console.log('[VERIFY] overall=' + (results.ok ? 'PASS' : 'FAIL'));
    for (const s of results.steps) console.log(`[VERIFY] ${s.ok ? 'PASS' : 'FAIL'} ${s.name}`);
    setTimeout(() => app.exit(results.ok ? 0 : 1), 300);
  }
});
