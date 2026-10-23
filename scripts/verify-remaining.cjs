const { app, BrowserWindow, nativeImage, screen } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'verify');
app.setPath('userData', path.join(ROOT, '.tmp', 'remaining-data'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browserProbe() {
  const { mb, createEmptyProject, VideoFrameSource, exportProject, createExportProfile, evaluateScene, sourceToOutput, unprojectScreenPoint,
    drawScene, TimelineAudioMixer, buildExportPlan, AudioPreviewScheduler } = Features;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const S = 10_000_000, sr = 48_000;
  // Real PCM WAV input; both the preview mixer and M4A exporter decode these bytes.
  const wav = new Uint8Array(44 + sr * 4), view = new DataView(wav.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, sr * 4, true);
  for (let i = 0; i < sr; i++) {
    view.setInt16(44 + i * 4, Math.sin(2 * Math.PI * 440 * i / sr) * 16384, true);
    view.setInt16(46 + i * 4, Math.sin(2 * Math.PI * 660 * i / sr) * 8192, true);
  }
  const decoder = new VideoFrameSource({ readFile: async () => wav, nodeFilePaths: false }, [{ path: 'tone.wav', startTick: 0, durationTicks: S }]);
  await decoder.open();
  const p = createEmptyProject('features', 'Features');
  p.assets.push({ id: 'screen', kind: 'screen', path: 'screen.mp4', hash: 's', durationTicks: S,
    width: 640, height: 360, sampleRate: 0, channels: 0, createdAt: 0 },
    { id: 'audio', kind: 'mic', path: 'tone.wav', hash: 'a', durationTicks: S,
      width: 0, height: 0, sampleRate: sr, channels: 2, createdAt: 0 });
  const clip = { id: 'screen-clip', assetId: 'screen', sourceInTicks: 0, sourceDurationTicks: S,
    timelineInTicks: 0, rate: { num: 2, den: 1 }, linkGroupId: 'g' };
  p.tracks.find(t => t.kind === 'primaryVideo').clips.push(clip);
  const mic = p.tracks.find(t => t.kind === 'mic'); mic.gain = 0.5;
  mic.clips.push({ ...clip, id: 'audio-clip', assetId: 'audio' });
  const plan = buildExportPlan(p, { audioOnly: true });
  const sources = new Map([['audio', decoder]]), warnings = [];
  const offline = new OfflineAudioContext(2, sr, sr);
  const mixer = new TimelineAudioMixer(plan, sources, { audioBufferFactory: offline, addAudio: async () => {} }, () => {}, new Map([['audio-clip', 2]]), warnings);
  const buffer = await mixer.renderChunk(4800, 4800);
  const peak = channel => Math.max(...buffer.getChannelData(channel).map(Math.abs));
  assert(peak(0) > 0.245 && peak(0) < 0.255 && peak(1) > 0.12 && peak(1) < 0.13, '试听增益/声道不正确');
  const crossings = buffer.getChannelData(0).reduce((count, value, i, a) => count + (i > 0 && value >= 0 && a[i - 1] < 0 ? 1 : 0), 0);
  assert(Math.abs(crossings - 88) <= 1, '2 倍速试听未映射到源音频');
  mic.muted = true;
  const mutedMixer = new TimelineAudioMixer(buildExportPlan(p, { audioOnly: true }), sources,
    { audioBufferFactory: offline, addAudio: async () => {} }, () => {});
  const silence = await mutedMixer.renderChunk(4800, 4800);
  assert(silence.getChannelData(0).every(v => v === 0), '试听静音无效'); mic.muted = false;
  const files = new Map();
  const io = { writeFile: async (name, data) => files.set(name, data), readFile: async name => files.get(name),
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, removeFile: async name => files.delete(name) };
  const profile = { ...createExportProfile(p, { variantId: 'landscape', resolution: '720', fps: '30', quality: 'balanced', includeTutorial: false }), audioOnly: true, videoBitrate: 0 };
  const media = { providerFor: async id => { assert(id === 'audio', 'M4A 不应打开屏幕素材'); return { getFrameAt: async () => { throw new Error('M4A 不应取视频帧'); }, getAudioAt: (...args) => decoder.getAudioAt(...args) }; }, segmentsFor: async () => [] };
  const videoEncoder = window.VideoEncoder; window.VideoEncoder = class { constructor() { throw new Error('M4A 不应创建视频编码器'); } };
  let result;
  try { result = await exportProject({ project: p, profile, outputPath: 'tone.m4a', io, media }); }
  finally { window.VideoEncoder = videoEncoder; }
  assert(result.ok && result.verified && result.frames === 0, 'M4A 导出失败');
  const outputBytes = files.get('tone.m4a');
  const decoded = new VideoFrameSource({ readFile: async () => outputBytes, nodeFilePaths: false }, [{ path: 'tone.m4a', startTick: 0, durationTicks: S / 2 }]);
  await decoded.open(); const pcm = await decoded.getAudioAt({ start: S / 10, end: S / 5 }, { channels: 2 });
  assert(pcm?.hasData && pcm.channels[0].some(v => Math.abs(v) > 0.1), 'M4A 解码后没有声音'); decoded.close();
  const controller = new AbortController(); let cancelled = false;
  try {
    await exportProject({ project: p, profile, outputPath: 'cancel.m4a', io, media, signal: controller.signal,
      onProgress: progress => { if (progress.phase === 'finalizing') controller.abort(); } });
  } catch (error) { cancelled = error.code === 'E_EXPORT_CANCELLED'; }
  assert(cancelled && !files.has('cancel.m4a') && !files.has('cancel.m4a.partial'), 'M4A 取消未清理临时文件');
  const audio = new AudioContext({ sampleRate: sr }); await audio.resume();
  const startTime = audio.currentTime; const realtimeErrors = [];
  const realtime = new TimelineAudioMixer(plan, sources, { audioBufferFactory: audio, addAudio: async () => {} }, () => {}, new Map([['audio-clip', 2]]));
  const scheduler = new AudioPreviewScheduler(audio, realtime, plan.audioTotalSamples,
    () => (audio.currentTime - startTime) * S, error => realtimeErrors.push(String(error)));
  await scheduler.pump(); await new Promise(resolve => setTimeout(resolve, 100)); await scheduler.pump();
  scheduler.stop(); await audio.close(); assert(!realtimeErrors.length, '真实 AudioContext 调度失败');

  // 3D texture projection, including the source privacy mask, then actual AVC encoding.
  const source = new OffscreenCanvas(640, 360), ctx = source.getContext('2d');
  ctx.fillStyle = '#d43040'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#ffe040'; ctx.fillRect(80, 60, 140, 100);
  p.settings.canvas.camera.visible = false; p.settings.canvas.background = '#102030';
  p.settings.canvas.shadowOpacity = 0;
  p.effects.push({ id: '3d', kind: 'zoom', range: { start: 0, end: S / 2 }, origin: 'manual', locked: true,
    parameters: { scale: 1, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0, rotateX: 18, rotateY: -30, rotateZ: 8, perspective: 1.5 } });
  p.effects.push({ id: 'mask', kind: 'privacy', range: { start: 0, end: S / 2 }, origin: 'manual', locked: true,
    parameters: { x: 0.45, y: 0.45, width: 0.1, height: 0.1, style: 'solid', anchor: 'screen', confirmed: true } });
  const canvas = new OffscreenCanvas(640, 360), draw = canvas.getContext('2d');
  const scene = evaluateScene(p, S / 10, { outputWidth: 640, outputHeight: 360 });
  const resources = { screen: source, screenWidth: 640, screenHeight: 360, camera: null, cursor: null };
  drawScene(draw, scene, resources);
  const a = draw.getImageData(0, 0, 640, 360).data;
  drawScene(draw, { ...scene, screenMotion: undefined }, resources);
  const b = draw.getImageData(0, 0, 640, 360).data;
  let changed = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 30) changed++;
  assert(changed > 10000, '3D 未实际改变合成像素');
  drawScene(draw, scene, resources);
  const expected = draw.getImageData(0, 0, 640, 360).data;
  const center = sourceToOutput(scene, 0.5, 0.5), centerIndex = (Math.round(center.y) * 640 + Math.round(center.x)) * 4;
  assert(expected[centerIndex] < 5 && expected[centerIndex + 1] < 5, '3D 投影遗漏隐私遮挡');
  const motionPng = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const video = await exportProject({ project: p, profile: { ...profile, width: 640, height: 360, audioOnly: false, videoBitrate: 2_000_000 }, outputPath: '3d.mp4', io,
    media: { segmentsFor: async () => [], providerFor: async id => id === 'audio' ? media.providerFor(id) : { getFrameAt: async () => source } } });
  assert(video.ok && video.verified && video.frames === 15, '3D 视频导出失败');
  const videoDecoder = new VideoFrameSource({ readFile: async () => files.get('3d.mp4'), nodeFilePaths: false }, [{ path: '3d.mp4', startTick: 0, durationTicks: S / 2 }]);
  await videoDecoder.open(); const frame = await videoDecoder.getFrameAt(S / 10); draw.drawImage(frame, 0, 0);
  const actual = draw.getImageData(0, 0, 640, 360).data;
  let difference = 0; for (let i = 0; i < actual.length; i++) if (i % 4 !== 3) difference += Math.abs(actual[i] - expected[i]);
  difference /= 640 * 360 * 3;
  assert(difference < 10 && actual[centerIndex] < 10, '3D 导出与预览或隐私遮挡不一致'); videoDecoder.close();
  const white = new OffscreenCanvas(640, 360); white.getContext('2d').fillStyle = '#ffffff'; white.getContext('2d').fillRect(0, 0, 640, 360);
  const whiteScene = { ...scene, screenPrivacy: [], cursor: { ...scene.cursor, visible: false } };
  drawScene(draw, whiteScene, { ...resources, screen: white });
  const whitePixels = draw.getImageData(0, 0, 640, 360).data;
  let seams = 0;
  for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
    const point = unprojectScreenPoint(scene, { x: x + 0.5, y: y + 0.5 });
    const u = (point.x / 640 - scene.screenRect.x) / scene.screenRect.width;
    const v = (point.y / 360 - scene.screenRect.y) / scene.screenRect.height;
    if (u > 0.05 && u < 0.95 && v > 0.05 && v < 0.95 && whitePixels[(y * 640 + x) * 4] < 250) seams++;
  }
  assert(seams === 0, '白底 3D 网格出现暗色接缝：' + seams);
  decoder.close();
  return { m4a: { bytes: result.bytes, frames: result.frames, duration: result.durationTicks / S, checks: result.verifiedDetail.checks,
    nonSilentDecode: true, cancellationCleanup: true, noVideoEncoder: true }, audioPreview: { gain: peak(0), channels: 2, doubledToneCrossings: crossings,
    mute: true, realtimeContext: true }, motion3D: { changedPixels: changed, frames: video.frames, verified: video.verified,
      previewExportMeanError: difference, privacy: true, whiteMeshSeams: seams },
    artifacts: { 'remaining-tone.m4a': Array.from(outputBytes), 'remaining-3d.mp4': Array.from(files.get('3d.mp4')), 'remaining-3d.png': Array.from(motionPng) } };
}

async function windowProbe(win) {
  await win.loadURL('data:text/html,' + encodeURIComponent('<title>WCS Window Probe</title><style>body{background:#d43040;color:white;font:40px sans-serif}div{background:#30d460;width:180px;height:120px}</style><h1>Window capture</h1><div></div>'));
  win.showInactive(); await sleep(500);
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
  const exe = path.join(ROOT, 'dist', 'native', 'grabber.exe');
  const listed = JSON.parse((await promisify(execFile)(exe, ['--list-windows'], { windowsHide: true, encoding: 'utf8' })).stdout.replace(/^\uFEFF/, ''));
  assert(listed.some(item => item.id === `window:${hwnd}` && item.available), '原生窗口列表缺少测试窗口');
  const child = spawn(exe, ['640', '360', '0', '0', '88', '15', `--window=${hwnd}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let acc = Buffer.alloc(0), frames = 0, stderr = '', colorful = false;
  child.stdin.on('error', () => {});
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    acc = Buffer.concat([acc, data]);
    while (acc.length >= 12 && acc.length >= 12 + acc.readUInt32LE(0)) {
      const size = acc.readUInt32LE(0), jpeg = acc.subarray(12, 12 + size); acc = acc.subarray(12 + size); frames++;
      const bitmap = nativeImage.createFromBuffer(jpeg).toBitmap();
      for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2] > 150 && bitmap[i + 1] < 100) { colorful = true; break; }
      if (frames === 1) fs.writeFileSync(path.join(OUT, 'remaining-window.jpg'), jpeg);
    }
  });
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  try {
    await sleep(600); win.setBounds({ x: 120, y: 100, width: 780, height: 500 }); await sleep(600);
    assert(frames > 2 && colorful, '窗口采集无真实像素');
    const physical = screen.dipToScreenRect(win, win.getBounds());
    assert(stderr.includes(`WINDOW_BOUNDS ${physical.x} ${physical.y} ${physical.width} ${physical.height}`), '窗口移动缩放没有更新采集几何：' + JSON.stringify({ physical, stderr }));
    win.destroy(); await Promise.race([exit, sleep(3000)]);
    assert(exited && /SOURCE_CLOSED/.test(stderr), '窗口关闭后采集进程没有正确退出');
    return { enumerated: true, frames, colorful, followsMoveAndResize: true, sourceClosed: true };
  } finally { if (!exited) child.kill(); }
}

app.whenReady().then(async () => {
  let win, target, report;
  const watchdog = setTimeout(() => { console.error('[remaining] timeout'); app.exit(1); }, 120000);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const { build } = require('esbuild');
    const built = await build({ stdin: { contents: `
      import * as mb from 'mediabunny';
      import { configureMediabunny } from './src/media/decoder'; configureMediabunny(mb); export { mb };
      export { VideoFrameSource } from './src/media/decoder';
      export { createEmptyProject } from './src/domain/project';
      export { evaluateScene, sourceToOutput } from './src/domain/scene';
      export { unprojectScreenPoint } from './src/domain/projection';
      export { drawScene } from './src/media/compositor';
      export { createExportProfile } from './src/renderer/lib/exportSettings';
      export { exportProject, TimelineAudioMixer } from './src/media/exporter';
      export { buildExportPlan } from './src/domain/exportPlan';
      export { AudioPreviewScheduler } from './src/renderer/lib/audioPreview';
    `, resolveDir: ROOT }, bundle: true, format: 'iife', globalName: 'Features', platform: 'browser', write: false, logLevel: 'silent' });
    const entry = path.join(OUT, 'remaining-probe.html'); fs.writeFileSync(entry, '<!doctype html><meta charset="utf-8"><title>Remaining feature probe</title>');
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, backgroundThrottling: false } });
    await win.loadFile(entry);
    const browser = await win.webContents.executeJavaScript(built.outputFiles[0].text + ';(' + browserProbe.toString() + ')()');
    for (const [name, bytes] of Object.entries(browser.artifacts)) fs.writeFileSync(path.join(OUT, name), Buffer.from(bytes));
    delete browser.artifacts;
    target = new BrowserWindow({ show: false, x: 20, y: 20, width: 640, height: 360, webPreferences: { backgroundThrottling: false } });
    const windowCapture = await windowProbe(target); report = { ok: true, ...browser, windowCapture };
  } catch (error) { report = { ok: false, error: String(error.stack || error) }; }
  finally {
    clearTimeout(watchdog); if (target && !target.isDestroyed()) target.destroy(); win?.destroy();
    fs.writeFileSync(path.join(OUT, 'verify-remaining.json'), JSON.stringify(report, null, 2));
    console.log('[remaining] ' + JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
