// Real Windows hook + controlled MediaStream pause/resume/segment verification.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'dist', 'verify');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
app.setPath('userData', path.join(ROOT, '.tmp', 'input-camera-data'));
app.on('window-all-closed', () => {});

async function pointerProbe(win) {
  const injector = path.join(OUT, 'inject-click.exe');
  assert(fs.existsSync(injector), 'Run node scripts/verify-input-camera.mjs to compile the test helper first');
  const worker = spawn(path.join(ROOT, 'dist', 'native', 'pointer.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', error = '', events = [], ready = false;
  worker.stdin.on('error', () => {});
  worker.stderr.on('data', bytes => { error += bytes; });
  worker.stdout.on('data', bytes => {
    pending += bytes;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const value = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      if (value.ready) ready = true; else events.push(value);
    }
  });
  const exited = new Promise(resolve => worker.once('exit', code => resolve(code)));
  try {
    for (let i = 0; !ready && i < 60; i++) await sleep(50);
    assert(ready, 'Native hook not ready: ' + error);
    const bounds = screen.dipToScreenRect(win, win.getBounds());
    const x = bounds.x + Math.round(bounds.width / 2), y = bounds.y + Math.round(bounds.height / 2);
    try { await promisify(execFile)(injector, [String(x), String(y)], { windowsHide: true }); }
    catch (error) {
      if (String(error.stderr).includes('SetCursorPos denied')) {
        worker.stdin.write('q\n');
        assert(await Promise.race([exited, sleep(1500).then(() => 'timeout')]) === 0, 'Hook failed to exit');
        return { hookStartup: true, cleanExit: true, physicalInjection: 'unavailable', reason: 'Windows denied SetCursorPos on this desktop; real click delivery still needs an interactive desktop check.' };
      }
      throw error;
    }
    await sleep(200);
    const found = events.filter(event => event.x === x && event.y === y && event.button === 0);
    assert(found.some(event => event.kind === 'down') && found.some(event => event.kind === 'up'), 'Missing click pair: ' + JSON.stringify(events));
    assert(BigInt(found[1].qpc) >= BigInt(found[0].qpc), 'Click QPC order');
    worker.stdin.write('q\n');
    assert(await Promise.race([exited, sleep(1500).then(() => 'timeout')]) === 0, 'Hook did not unhook/exit');
    return { realWindowsHook: true, physicalCoordinates: true, downUp: true, cleanExit: true };
  } finally { if (worker.exitCode === null) worker.kill(); }
}

async function cameraProbe() {
  const { mb } = CameraProbe;
  const source = document.createElement('canvas'); source.width = 2560; source.height = 1440;
  const context = source.getContext('2d'); let color = 'red';
  const paint = () => { context.fillStyle = color; context.fillRect(0, 0, source.width, source.height); };
  const OriginalFrame = window.VideoFrame; let maxWidth = 0, maxHeight = 0;
  window.VideoFrame = new Proxy(OriginalFrame, { construct(target, args) {
    const frame = Reflect.construct(target, args); maxWidth = Math.max(maxWidth, frame.displayWidth); maxHeight = Math.max(maxHeight, frame.displayHeight); return frame;
  } });
  paint(); const stream = source.captureStream(30); const timer = setInterval(paint, 30);
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => stream, configurable: true });
  const camera = window.__wcsCamera;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clock = (state, mediaTick) => camera.setClock({ state, mediaTick, wallTimeMs: performance.timeOrigin + performance.now() });
  const output = [];
  try {
    const opened = await camera.open(); if (!opened.ok) throw new Error(opened.error);
    clock('recording', 0); await sleep(850); clock('paused', 8_000_000);
    color = 'lime'; await sleep(350);
    color = 'blue'; paint(); await sleep(100); clock('recording', 8_000_000); await sleep(850);
    clock('stopped', 16_000_000); color = 'white'; await sleep(350);
    for (let index = 0; index < 2; index++) {
      const result = await camera.encodeSegment({ index: index + 1, startTick: index * 8_000_000, durationTicks: 8_000_000, fps: 30, width: 320, height: 180, sampleTimesMs: [] });
      if (!result.ok) throw new Error(result.error);
      const bytes = Uint8Array.from(atob(result.mp4), x => x.charCodeAt(0));
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(bytes) });
      try {
        const track = await input.getPrimaryVideoTrack();
        const stats = await track.computePacketStats();
        const sink = new mb.VideoSampleSink(track); const samples = [];
        for (const time of [0.1, 0.4, 0.7]) {
          const frame = await sink.getSample(time); const canvas = new OffscreenCanvas(8, 8), ctx = canvas.getContext('2d');
          frame.draw(ctx, 0, 0, 8, 8); frame.close(); samples.push(Array.from(ctx.getImageData(4, 4, 1, 1).data));
        }
        const channel = index === 0 ? 0 : 2;
        if (samples.some(pixel => pixel[channel] < 200 || pixel[1] > 45 || pixel[index === 0 ? 2 : 0] > 45)) throw new Error('Camera captured paused/future frames: ' + JSON.stringify(samples));
        if (stats.packetCount !== 24) throw new Error('Camera segment frame count: ' + stats.packetCount);
        output.push({ segment: index + 1, frames: stats.packetCount, duration: await input.computeDuration(), samples });
      } finally { input.dispose(); }
    }
    if (maxWidth !== 1280 || maxHeight > 720) throw new Error('Camera retained oversized frames: ' + JSON.stringify({maxWidth,maxHeight}));
    clock('recording', 0); color = 'red'; await sleep(180); clock('stopped', 1_800_000);
    const expired = await camera.encodeSegment({ index: 3, startTick: 100_000_000, durationTicks: 8_000_000, fps: 30, width: 320, height: 180 });
    if (expired.ok || !expired.error.includes('过期')) throw new Error('Stale camera frames accepted');
    return { controlledMediaStream: true, pauseExcluded: true, stopDoesNotRecapture: true, oversizedSourceBounded: {maxWidth,maxHeight}, staleFramesRejected: true, segments: output };
  } finally { clearInterval(timer); await camera.close(); window.VideoFrame = OriginalFrame; }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true }); let win, camera, report;
  const watchdog = setTimeout(() => app.exit(1), 30000);
  try {
    win = new BrowserWindow({ width: 400, height: 300, x: 40, y: 40, show: false });
    await win.loadURL('data:text/html,<title>Input test</title><body style="background:navy;color:white">Windows click verification</body>');
    win.showInactive(); await sleep(200); const pointer = await pointerProbe(win); win.destroy();
    const { build } = require('esbuild');
    const bundle = await build({ stdin: { contents: `import './src/renderer/cameraRuntime'; import * as mb from 'mediabunny'; import {configureMediabunny} from './src/media/decoder'; configureMediabunny(mb); export {mb};`, resolveDir: ROOT }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'CameraProbe' });
    const entry = path.join(OUT, 'input-camera.html'); fs.writeFileSync(entry, '<!doctype html><title>Camera sync probe</title>');
    camera = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await camera.loadFile(entry, { hash: 'camera' });
    const cameraResult = await camera.webContents.executeJavaScript(bundle.outputFiles[0].text + ';(' + cameraProbe.toString() + ')()');
    report = { ok: true, pointer, camera: cameraResult };
  } catch (error) { report = { ok: false, error: String(error.stack || error) }; }
  finally {
    clearTimeout(watchdog); if (win && !win.isDestroyed()) win.destroy(); if (camera && !camera.isDestroyed()) camera.destroy();
    fs.writeFileSync(path.join(OUT, 'input-camera.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
