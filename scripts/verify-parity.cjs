// Real browser decoding/encoding for the new shared preview and export controls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'verify');
app.setPath('userData', path.join(ROOT, '.tmp', 'parity-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

async function probe() {
  const { mb, PreviewMediaCache, createEmptyProject, evaluateScene, drawScene, createExportProfile,
    exportProject, applyCommand, makeCommand, pointerForScene, createPointerLookup } = Parity;
  const S = 10_000_000;
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  const source = new OffscreenCanvas(640, 360);
  const ctx = source.getContext('2d');
  ctx.fillStyle = '#183c6e'; ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(320, 180, 70, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f05050'; ctx.fillRect(40, 40, 100, 80);
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const vs = new mb.CanvasSource(source, { codec: 'avc', bitrate: 2_000_000 });
  output.addVideoTrack(vs, { frameRate: 30 }); await output.start();
  for (let i = 0; i < 30; i++) await vs.add(i / 30, 1 / 30);
  await output.finalize(); vs.close();
  const bytes = new Uint8Array(output.target.buffer);
  const events = [{ tick: 0, kind: 'move', x: 0.8, y: 0.7 }, { tick: S / 10, kind: 'down', x: 0.8, y: 0.7 }];
  window.wcs = {
    readPointerLog: async () => ({ ok: true, data: { events } }),
    listMediaSegments: async () => ({ ok: true, data: [{ path: 'media/seg.mp4', startTick: 0, durationTicks: S }] }),
    readExportFile: async () => ({ ok: true, data: bytes }),
  };
  const p = createEmptyProject('parity', 'Parity');
  p.assets.push({ id: 'screen', kind: 'screen', path: 'media/seg.mp4', hash: 'test', durationTicks: S,
    width: 640, height: 360, sampleRate: 0, channels: 0, createdAt: 0 });
  p.tracks[0].clips.push({ id: 'clip', assetId: 'screen', sourceInTicks: 0, sourceDurationTicks: S,
    timelineInTicks: 0, rate: { num: 1, den: 1 }, linkGroupId: 'g' });
  p.settings.canvas.camera.visible = false;
  const cache = new PreviewMediaCache('C:\\parity.wcaproj');
  const results = [];
  try {
    for (const variantId of ['landscape', 'portrait', 'square']) {
      const profile = createExportProfile(p, { variantId, resolution: '720', fps: '30', quality: 'balanced', includeTutorial: false });
      const scene = evaluateScene(p, S / 5, { outputWidth: profile.width, outputHeight: profile.height, variantId });
      const resource = await cache.resolve(p, scene, S / 5, {});
      assert(resource?.status === 'ready' && resource.screen, '真实素材预览未解码');
      const pointer = pointerForScene(p, S / 5, createPointerLookup(events));
      assert(JSON.stringify(resource.pointer) === JSON.stringify(pointer), '预览和导出光标不一致');
      const canvas = new OffscreenCanvas(profile.width, profile.height);
      const draw = canvas.getContext('2d');
      drawScene(draw, scene, { ...resource, cursor: null });
      // A circle must remain circular across all aspect ratios; catches normalized-coordinate squashing.
      const pixels = draw.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (pixels[i] > 230 && pixels[i + 1] > 230 && pixels[i + 2] > 230) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      const ratio = (maxX - minX) / (maxY - minY);
      assert(Math.abs(ratio - 1) < 0.025, '画面比例失真 ' + variantId);
      results.push({ variantId, circleRatio: ratio, nativePreview: true, pointerMatches: true });
      canvas.width = 0; canvas.height = 0;
    }
    const thumbs = await Promise.all([0.1, 0.2, 0.3].map((t) => cache.resolve(p,
      evaluateScene(p, t * S, { outputWidth: 640, outputHeight: 360 }), t * S, {})));
    assert(thumbs.every((t) => t?.screen && t.status === 'ready'), '缩略图互相取消');

    const holder = document.createElement('div'); holder.style.cssText = 'width:240px;height:54px'; document.body.appendChild(holder);
    const mounted = Parity.mountThumbnail(holder, { project: p, clip: p.tracks[0].clips[0], width: 240, camera: false, media: cache });
    let realThumbnail = false;
    try {
      for (let i = 0; i < 80; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const canvas = holder.querySelector('canvas');
        if (canvas && canvas.width === 288) {
          const pixel = canvas.getContext('2d').getImageData(48, 27, 1, 1).data;
          if (pixel[0] > 220 && pixel[1] > 220 && pixel[2] > 220) { realThumbnail = true; break; }
        }
      }
      assert(realThumbnail, '时间线组件没有绘制真实解码缩略图');
    } finally { mounted.unmount(); holder.remove(); }

    const sped = applyCommand(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'clip', rate: { num: 2, den: 1 } })).project;
    sped.tracks[0].clips[0].sourceDurationTicks = S / 2; // 0.25 s output, 15 frames at 60 FPS.
    const profile = createExportProfile(sped, { variantId: 'landscape', resolution: '2160', fps: '60', quality: 'balanced', includeTutorial: false });
    const files = new Map();
    const fileIO = { writeFile: async (path, data) => files.set(path, data), readFile: async (path) => files.get(path),
      rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, removeFile: async (path) => files.delete(path) };
    const provider = { getFrameAt: async (tick) => (await cache.resolve(p,
      evaluateScene(p, tick, { outputWidth: 640, outputHeight: 360 }), tick))?.screen ?? null, close() {} };
    let exported;
    try {
      exported = await exportProject({ jobId: '4k60', project: sped, profile, outputPath: 'parity-4k60.mp4',
        io: fileIO, media: { providerFor: async () => provider, segmentsFor: async () => [] }, pointerAt: createPointerLookup(events) });
    } catch (error) { throw new Error(JSON.stringify({ message: error.message, detail: error.detail, code: error.code })); }
    assert(exported.ok && exported.verified && exported.frames === 15, '4K/60FPS/倍速导出校验失败');
    results.push({ export4K60: { ok: exported.ok, verified: exported.verified, frames: exported.frames,
      bytes: exported.bytes, encoder: exported.encoder, checks: exported.verifiedDetail?.checks }, thumbnails: thumbs.length, timelineThumbnailPixels: realThumbnail });
    return { ok: true, results };
  } finally { cache.dispose(); source.width = 0; source.height = 0; }
}

app.whenReady().then(async () => {
  let win;
  let report;
  const watchdog = setTimeout(() => { console.error('[parity] timeout'); app.exit(1); }, 120_000);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const { build } = require('esbuild');
    const built = await build({ stdin: { contents: `
      import * as mb from 'mediabunny';
      import { configureMediabunny } from './src/media/decoder'; configureMediabunny(mb);
      export { mb };
      export { PreviewMediaCache } from './src/renderer/lib/previewSource';
      export { createEmptyProject } from './src/domain/project';
      export { evaluateScene } from './src/domain/scene';
      export { drawScene } from './src/media/compositor';
      export { createExportProfile } from './src/renderer/lib/exportSettings';
      export { exportProject } from './src/media/exporter';
      export { applyCommand, makeCommand } from './src/domain/commands';
      export { pointerForScene, createPointerLookup } from './src/domain/pointer';
      import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
      import {VideoThumbnails} from './src/renderer/components/VideoThumbnails';
      export function mountThumbnail(element, props) { const root = createRoot(element); root.render(createElement(VideoThumbnails, props)); return root; }
    `, resolveDir: ROOT }, bundle: true, format: 'iife', globalName: 'Parity', platform: 'browser', write: false, logLevel: 'silent' });
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, backgroundThrottling: false } });
    const entry = path.join(OUT, 'parity-probe.html');
    fs.writeFileSync(entry, '<!doctype html><meta charset="utf-8"><title>Parity probe</title>');
    await win.loadFile(entry);
    report = await win.webContents.executeJavaScript(built.outputFiles[0].text + ';(' + probe.toString() + ')()');
  } catch (error) { report = { ok: false, error: String(error.stack || error) }; }
  finally {
    clearTimeout(watchdog); win?.destroy();
    fs.writeFileSync(path.join(OUT, 'verify-parity.json'), JSON.stringify(report, null, 2));
    console.log('[parity] ' + JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
