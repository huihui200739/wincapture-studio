// 能力探测 spike 2：安全上下文 + setDisplayMediaRequestHandler + WebCodecs
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const out = { steps: [] };
function log(name, value) {
  out.steps.push({ name, value });
  console.log(`[SPIKE] ${name}: ${JSON.stringify(value)}`);
}

const probeHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.probe = async () => {
  const r = { secure: window.isSecureContext, hasMediaDevices: !!navigator.mediaDevices, hasWebCodecs: typeof VideoEncoder !== 'undefined' };
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: true });
    r.videoTracks = stream.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings(), state: t.readyState }));
    r.audioTracks = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings(), state: t.readyState }));
    const v = stream.getVideoTracks()[0];
    const vproc = new MediaStreamTrackProcessor({ track: v });
    const reader = vproc.readable.getReader();
    let frames = 0, first = 0, last = 0, loop = true;
    const sizes = new Set();
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
    r.frames = frames; r.measuredFps = frames / ((last - first) / 1000 || 1); r.frameSizes = [...sizes];
    if (stream.getAudioTracks().length) {
      const ac = new AudioContext({ sampleRate: 48000 });
      const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize); let peak = 0;
      for (let i = 0; i < 15; i++) { await new Promise(res => setTimeout(res, 80)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
      r.audioPeak = peak; r.audioContextRate = ac.sampleRate;
      await ac.close();
    }
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { r.error = String(e); }
  return r;
};
</script></body></html>`;

app.whenReady().then(async () => {
  try {
    log('versions', { electron: process.versions.electron, chrome: process.versions.chrome });
    log('displays', screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })));

    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    const screenSource = sources.find((s) => s.id.startsWith('screen:'));
    log('screenSources', sources.filter((s) => s.id.startsWith('screen:')).map((s) => ({ id: s.id, name: s.name, displayId: s.display_id })));

    let requested = false;
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        requested = true;
        callback({ video: screenSource, audio: 'loopback' });
      },
      { useSystemPicker: false },
    );

    const htmlPath = path.join(__dirname, 'probe-page.html');
    fs.writeFileSync(htmlPath, probeHtml, 'utf8');

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 600,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(htmlPath);

    log('displayMediaProbe', await win.webContents.executeJavaScript('window.probe()'));
    log('handlerInvoked', requested);

    const devices = await win.webContents.executeJavaScript(
      `navigator.mediaDevices.enumerateDevices().then(ds => ds.map(d => ({ kind: d.kind, label: d.label })))`,
    );
    log('devices', devices);

    fs.writeFileSync(path.join(process.cwd(), 'spike-result.json'), JSON.stringify(out, null, 2));
    console.log('SPIKE_DONE');
    win.destroy();
  } catch (e) {
    console.error('SPIKE_ERROR', e);
    fs.writeFileSync(path.join(process.cwd(), 'spike-result.json'), JSON.stringify({ ...out, fatal: String(e) }, null, 2));
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
