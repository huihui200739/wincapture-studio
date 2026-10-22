// spike 7：只测「系统声音回环」是否可用（不含视频），带硬超时避免挂起
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setPath('userData', path.join(__dirname, '..', '.spike-data'));

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.audioLoopback = async () => {
  const r = {};
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms)), ms));
  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: false }),
      timeout(6000),
    ]);
    r.tracks = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    if (stream.getAudioTracks().length) {
      const ac = new AudioContext({ sampleRate: 48000 });
      const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize); let peak = 0;
      for (let i = 0; i < 10; i++) { await new Promise(r3 => setTimeout(r3, 80)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
      r.audioPeak = peak; r.rate = ac.sampleRate; await ac.close();
    }
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
window.micTest = async () => {
  const r = {};
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: 'default' } });
    r.tracks = s.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    s.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
</script></body></html>`;

app.whenReady().then(async () => {
  const results = {};
  try {
    const htmlPath = path.join(__dirname, 'probe-page.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);
    results.audioLoopback = await win.webContents.executeJavaScript('window.audioLoopback()');
    results.micTest = await win.webContents.executeJavaScript('window.micTest()');
    win.destroy();
  } catch (e) {
    results.fatal = String(e);
  }
  fs.writeFileSync(path.join(process.cwd(), 'spike7-result.json'), JSON.stringify(results, null, 2));
  console.log('SPIKE7 ' + JSON.stringify(results));
  app.exit(0);
});

setTimeout(() => {
  console.log('SPIKE7_FORCED_EXIT');
  app.exit(1);
}, 40000);
