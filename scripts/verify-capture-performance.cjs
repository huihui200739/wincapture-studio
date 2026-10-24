// Measure actual native callback pacing against an animated, numbered desktop source.
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'dist', 'verify');
app.setPath('userData', path.join(ROOT, '.tmp', 'capture-performance-data'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw Error(message); };

async function capture(exe, bounds, fps, label, fast = false) {
  const child = spawn(exe, [String(bounds.width), String(bounds.height), String(bounds.x), String(bounds.y), '88', String(fps), '--output=1920x1080', ...(fast ? ['--fast-scale'] : [])],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let pending = Buffer.alloc(0), stderr = '', frames = 0, first = null, last = null, frequency = 10000000, failure;
  let peakBytes = 0, querying = false, lastSample = 0;
  const ids = [], intervals = [];
  child.stderr.on('data', chunk => { stderr += chunk; const match = /QPCFREQ (\d+)/.exec(stderr); if (match) frequency = Number(match[1]); });
  child.stdout.on('data', chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 12) {
      const length = pending.readUInt32LE(0);
      if (length < 2 || length > 16777216) { failure = 'Bad native frame size'; child.kill(); return; }
      if (pending.length < length + 12) return;
      const qpc = Number(pending.readBigInt64LE(4)), jpeg = pending.subarray(12, 12 + length);
      pending = pending.subarray(12 + length);
      if (last !== null) intervals.push((qpc - last) / frequency * 1000);
      if (first === null) first = qpc; last = qpc; frames++;
      if (Date.now() - lastSample >= 350) {
        lastSample = Date.now();
        const image = nativeImage.createFromBuffer(jpeg), size = image.getSize(), pixels = image.toBitmap();
        if (size.width !== 1920 || size.height !== 1080) failure = 'Native output dimensions changed';
        let magic = 0, id = 0;
        for (let bit = 0; bit < 24; bit++) {
          const x = Math.floor((bit + 0.5) * size.width / 24), y = Math.floor(size.height * 0.08), index = (y * size.width + x) * 4;
          const value = pixels[index] + pixels[index + 1] + pixels[index + 2] > 384 ? 1 : 0;
          if (bit < 8) magic |= value << bit; else id |= value << (bit - 8);
        }
        if (magic === 0xd3) ids.push(id);
      }
    }
  });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  const memory = setInterval(() => {
    if (querying) return; querying = true;
    execFile(path.join(ROOT, 'dist', 'native', 'grabber.exe'), [`--process-memory=${child.pid}`], { windowsHide: true, timeout: 2000 }, (error, stdout) => {
      querying = false; if (!error) try { for (const row of JSON.parse(stdout)) peakBytes = Math.max(peakBytes, row.workingSetBytes); } catch {}
    });
  }, 500);
  try {
    await sleep(5000); child.stdin.write('q\n');
    const code = await Promise.race([exit, sleep(2000).then(() => 'timeout')]);
    assert(code === 0 && !failure, failure || 'Native source failed to stop: ' + stderr);
    const actualFps = (frames - 1) / ((last - first) / frequency);
    const uniqueSourceFrames = new Set(ids).size;
    assert(frames > 5 && uniqueSourceFrames >= 3, 'Animated frame IDs were not captured: ' + JSON.stringify({ frames, ids, stderr }));
    intervals.sort((a, b) => a - b);
    return { label, scaling: fast ? 'performance' : 'quality', requestedFps: fps, frames, actualFps: Number(actualFps.toFixed(2)), targetMet: actualFps >= fps * 0.995,
      p95IntervalMs: Number(intervals[Math.floor(intervals.length * 0.95)].toFixed(2)), sampledSourceIds: ids, uniqueSourceFrames,
      peakNativeMiB: Number((peakBytes / 1048576).toFixed(1)), dimensions: '1920x1080' };
  } finally { clearInterval(memory); if (child.exitCode === null) child.kill(); }
}

app.whenReady().then(async () => {
  let win, report; const watchdog = setTimeout(() => app.exit(1), 45000);
  try {
    fs.mkdirSync(OUT, { recursive: true }); const display = screen.getPrimaryDisplay();
    win = new BrowserWindow({ ...display.bounds, frame: false, show: false, alwaysOnTop: true, webPreferences: { backgroundThrottling: false } });
    await win.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><title>Numbered capture benchmark</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:100%;height:100%}</style><canvas></canvas><script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');canvas.width=innerWidth*devicePixelRatio;canvas.height=innerHeight*devicePixelRatio;
      const start=performance.now();setInterval(()=>{const id=Math.floor((performance.now()-start)*60/1000)&65535,w=canvas.width,h=canvas.height;
      ctx.fillStyle='hsl('+id%360+',70%,40%)';ctx.fillRect(0,0,w,h);
      for(let i=0;i<24;i++){const value=i<8?(0xd3>>i)&1:(id>>(i-8))&1;ctx.fillStyle=value?'white':'black';ctx.fillRect(i*w/24,0,Math.ceil(w/24),h*.16)}
      ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText('Capture frame '+id,40,h/2)},16);
      </script>`));
    win.showInactive(); await sleep(600);
    const bounds = screen.dipToScreenRect(win, win.getBounds()), results = [];
    if (process.env.WCS_BASELINE_GRABBER) results.push(await capture(path.resolve(process.env.WCS_BASELINE_GRABBER), bounds, 30, 'baseline'));
    const current = path.join(ROOT, 'dist', 'native', 'grabber.exe');
    results.push(await capture(current, bounds, 30, 'current'));
    results.push(await capture(current, bounds, 30, 'current', true));
    results.push(await capture(current, bounds, 60, 'current', true));
    report = { ok: true, source: { ...bounds, animated: true, numberedAtFps: 60 }, results,
      note: 'ok verifies capture content, dimensions and cleanup; targetMet separately reports pacing. Sampled IDs prove changing content, not zero-loss capture of every source frame.' };
  } catch (error) { report = { ok: false, error: String(error.stack || error) }; }
  finally { clearTimeout(watchdog); if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(OUT, 'capture-performance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1); }
});
