// spike 5：验证 WGC 采集在正确 userData 路径 + 沙箱下是否可用
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setPath('userData', path.join(__dirname, '..', '.spike-data'));
app.setPath('sessionData', path.join(__dirname, '..', '.spike-data'));

const out = { steps: [] };
function log(name, value) {
  out.steps.push({ name, value });
  console.log(`[SPIKE] ${name}: ${JSON.stringify(value)}`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.probeDm = async () => {
  const r = {};
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    r.video = stream.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    r.audio = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    const v = stream.getVideoTracks()[0];
    const proc = new MediaStreamTrackProcessor({ track: v });
    const reader = proc.readable.getReader();
    let n = 0, first = 0, last = 0, loop = true;
    (async () => { while (loop) { const { value, done } = await reader.read(); if (done) break; if (!first) first = performance.now(); last = performance.now(); n++; value.close(); } })();
    await new Promise(r2 => setTimeout(r2, 1200));
    loop = false; try { await reader.cancel(); } catch {}
    r.frames = n; r.fps = n / ((last - first) / 1000 || 1);
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
window.probeLegacy = async (id) => {
  const r = {};
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 30 } },
    });
    r.video = stream.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    r.audio = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }));
    const v = stream.getVideoTracks()[0];
    const proc = new MediaStreamTrackProcessor({ track: v });
    const reader = proc.readable.getReader();
    let n = 0, first = 0, last = 0, loop = true;
    (async () => { while (loop) { const { value, done } = await reader.read(); if (done) break; if (!first) first = performance.now(); last = performance.now(); n++; value.close(); } })();
    await new Promise(r2 => setTimeout(r2, 1200));
    loop = false; try { await reader.cancel(); } catch {}
    r.frames = n; r.fps = n / ((last - first) / 1000 || 1);
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
</script></body></html>`;

app.whenReady().then(async () => {
  try {
    log('userData', app.getPath('userData'));
    log('sandboxEnabled', app.isSandboxed !== undefined ? 'n/a' : 'n/a');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
    const screenSource = sources.find((s) => s.id.startsWith('screen:'));
    log('screenSource', screenSource?.id);
    log('thumbEmpty', screenSource?.thumbnail?.isEmpty());

    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => callback({ video: screenSource, audio: 'loopback' }),
      { useSystemPicker: false },
    );

    const htmlPath = path.join(__dirname, 'probe-page.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
    await win.loadFile(htmlPath);

    log('getDisplayMedia', await win.webContents.executeJavaScript('window.probeDm()'));
    log('legacyCapture', await win.webContents.executeJavaScript(`window.probeLegacy(${JSON.stringify(screenSource?.id)})`));
    console.log('SPIKE_DONE');
    win.destroy();
  } catch (e) {
    console.error('SPIKE_ERROR', e);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
