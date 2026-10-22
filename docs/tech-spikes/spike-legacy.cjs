// 能力探测 spike 3：对比 WGC / 传统 desktopCapturer getUserMedia / 摄像头 / 麦克风
const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const out = { steps: [] };
function log(name, value) {
  out.steps.push({ name, value });
  console.log(`[SPIKE] ${name}: ${JSON.stringify(value)}`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.legacyCapture = async (sourceId, withAudio) => {
  const r = {};
  try {
    const constraints = {
      audio: withAudio ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } : false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 60 } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    r.videoTracks = stream.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    r.audioTracks = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    const v = stream.getVideoTracks()[0];
    const proc = new MediaStreamTrackProcessor({ track: v });
    const reader = proc.readable.getReader();
    let frames = 0, first = 0, last = 0, loop = true; const sizes = new Set();
    (async () => {
      while (loop) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!first) first = performance.now();
        last = performance.now(); frames++;
        sizes.add(value.displayWidth + 'x' + value.displayHeight);
        value.close();
      }
    })();
    await new Promise(res => setTimeout(res, 1500));
    loop = false; try { await reader.cancel(); } catch {}
    r.frames = frames; r.fps = frames / ((last - first) / 1000 || 1); r.sizes = [...sizes];
    if (stream.getAudioTracks().length) {
      const ac = new AudioContext({ sampleRate: 48000 });
      const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize); let peak = 0;
      for (let i = 0; i < 12; i++) { await new Promise(res => setTimeout(res, 80)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
      r.audioPeak = peak;
      await ac.close();
    }
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
window.micTest = async () => {
  const r = {};
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    r.tracks = s.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    s.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
window.camTest = async () => {
  const r = {};
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    r.tracks = s.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    s.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
</script></body></html>`;

app.whenReady().then(async () => {
  try {
    log('flags', process.argv.slice(1).filter((a) => a.startsWith('--')));
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
    const screenSource = sources.find((s) => s.id.startsWith('screen:'));
    log('screenSource', screenSource?.id);

    const htmlPath = path.join(__dirname, 'probe-page.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);

    log('legacyScreenCapture', await win.webContents.executeJavaScript(`window.legacyCapture(${JSON.stringify(screenSource?.id)}, true)`));
    log('micTest', await win.webContents.executeJavaScript('window.micTest()'));
    log('camTest', await win.webContents.executeJavaScript('window.camTest()'));

    fs.writeFileSync(path.join(process.cwd(), 'spike3-result.json'), JSON.stringify(out, null, 2));
    console.log('SPIKE_DONE');
    win.destroy();
  } catch (e) {
    console.error('SPIKE_ERROR', e);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
