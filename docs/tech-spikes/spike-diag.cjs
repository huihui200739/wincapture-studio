// spike 6：WGC 失败根因排查（GPU 进程/沙箱/会话）+ 系统声音独立回环测试
const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setPath('userData', path.join(__dirname, '..', '.spike-data'));

const out = [];
function log(name, value) {
  out.push({ name, value });
  console.log(`[SPIKE] ${name}: ${JSON.stringify(value)}`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.tryLegacy = async (id) => {
  const r = {};
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 30 } },
    });
    r.video = stream.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    r.audio = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
window.tryAudioOnly = async () => {
  const r = {};
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: false });
    r.audio = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    if (stream.getAudioTracks().length) {
      const ac = new AudioContext({ sampleRate: 48000 });
      const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize); let peak = 0;
      for (let i = 0; i < 10; i++) { await new Promise(r3 => setTimeout(r3, 80)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
      r.audioPeak = peak; await ac.close();
    }
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
window.gpuInfo = async () => {
  const r = { gpu: null };
  try {
    const adapter = await navigator.gpu?.requestAdapter?.();
    r.webgpu = !!adapter;
    if (adapter) { const info = adapter.info || {}; r.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device }; }
  } catch (e) { r.webgpuError = String(e); }
  return r;
};
</script></body></html>`;

app.whenReady().then(async () => {
  try {
    log('argv', process.argv.slice(1));
    log('gpuFeatureStatus', app.getGPUFeatureStatus());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 90 } });
    const screenSource = sources[0];
    log('screenSource', screenSource?.id);

    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => cb({ video: screenSource, audio: 'loopback' }), { useSystemPicker: false });

    const htmlPath = path.join(__dirname, 'probe-page.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);

    log('gpuInfo', await win.webContents.executeJavaScript('window.gpuInfo()'));
    log('audioOnlyLoopback', await win.webContents.executeJavaScript('window.tryAudioOnly()'));
    log('legacyCapture', await win.webContents.executeJavaScript(`window.tryLegacy(${JSON.stringify(screenSource?.id)})`));
    console.log('SPIKE_DONE');
    win.destroy();
  } catch (e) {
    console.error('SPIKE_ERROR', e);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
