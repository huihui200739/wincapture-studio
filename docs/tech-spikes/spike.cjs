// 能力探测 spike：验证采集链路关键能力后再进入完整实现。
// 运行：node_modules/electron/dist/electron.exe scripts/spike.cjs
const { app, BrowserWindow, desktopCapturer, ipcMain, globalShortcut, screen, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const out = { steps: [] };
function log(name, value) {
  out.steps.push({ name, value });
  console.log(`[SPIKE] ${name}: ${JSON.stringify(value)}`);
}

void app;

app.whenReady().then(async () => {
  try {
    log('versions', {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    });
    log('platform', { platform: process.platform, arch: process.arch, osRelease: require('node:os').release() });

    // 1. 显示器拓扑
    const displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      rotation: d.rotation,
      internal: d.internal,
    }));
    log('displays', displays);

    // 2. 采集源枚举
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    log('sourceCount', sources.length);
    log(
      'sources',
      sources.slice(0, 12).map((s) => ({
        id: s.id,
        name: s.name,
        displayId: s.display_id,
        hasThumb: !!s.thumbnail?.isEmpty() === false,
        thumbSize: s.thumbnail?.getSize(),
      })),
    );

    // 3. 全局快捷键
    let hotkeyFired = false;
    const okRegister = globalShortcut.register('Control+Alt+F9', () => {
      hotkeyFired = true;
    });
    log('globalShortcutRegister', okRegister);
    log('globalShortcutRegistered', globalShortcut.isRegistered('Control+Alt+F9'));

    // 4. 创建隐藏渲染窗口，测试 getDisplayMedia（系统声音回环）+ WebCodecs
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        offscreen: false,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const html = `<!doctype html><html><body><script>
      window.__result = {};
      window.probe = async (sourceId, opts) => {
        const r = {};
        try {
          r.hasWebCodecs = typeof VideoEncoder !== 'undefined';
          if (r.hasWebCodecs) {
            const cfgs = [
              { codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 12000000, framerate: 60, hardwareAcceleration: 'prefer-hardware' },
              { codec: 'avc1.42E01E', width: 1280, height: 720, bitrate: 6000000, framerate: 30, hardwareAcceleration: 'prefer-software' },
              { codec: 'vp8', width: 1280, height: 720, bitrate: 6000000, framerate: 30 },
              { codec: 'vp09.00.10.08', width: 1920, height: 1080, bitrate: 8000000, framerate: 30 },
            ];
            r.encoderSupport = [];
            for (const c of cfgs) {
              try {
                const s = await VideoEncoder.isConfigSupported(c);
                r.encoderSupport.push({ codec: c.codec, hw: c.hardwareAcceleration, supported: s.supported, config: s.config && { codec: s.config.codec, width: s.config.width, height: s.config.height, hardwareAcceleration: s.config.hardwareAcceleration } });
              } catch (e) {
                r.encoderSupport.push({ codec: c.codec, error: String(e) });
              }
            }
            // 音频编码
            r.audioEncoderSupport = [];
            for (const c of [{ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }, { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }]) {
              try {
                const s = await AudioEncoder.isConfigSupported(c);
                r.audioEncoderSupport.push({ codec: c.codec, supported: s.supported });
              } catch (e) { r.audioEncoderSupport.push({ codec: c.codec, error: String(e) }); }
            }
          }
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: opts && opts.audio ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } : false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 60, maxWidth: 1920, maxHeight: 1080 } },
          });
          r.videoTracks = stream.getVideoTracks().map(t => ({ label: t.label, settings: t.getSettings(), state: t.readyState }));
          r.audioTracks = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings(), state: t.readyState }));
          // 采样 1.2 秒，统计实际帧率
          const v = stream.getVideoTracks()[0];
          let frames = 0; let first = 0; let last = 0;
          const vproc = new MediaStreamTrackProcessor({ track: v });
          const reader = vproc.readable.getReader();
          const t0 = performance.now();
          let loop = true;
          (async () => {
            while (loop) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!first) first = performance.now();
              last = performance.now();
              frames++;
              value.close();
            }
          })();
          await new Promise(res => setTimeout(res, 1200));
          loop = false; try { await reader.cancel(); } catch {}
          r.measuredFps = frames / ((last - first) / 1000 || 1);
          r.frames = frames;
          // 音频能量
          if (stream.getAudioTracks().length) {
            const ac = new AudioContext({ sampleRate: 48000 });
            const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
            const an = ac.createAnalyser(); an.fftSize = 512; src.connect(an);
            const buf = new Float32Array(an.fftSize);
            let peak = 0;
            for (let i = 0; i < 12; i++) {
              await new Promise(res => setTimeout(res, 80));
              an.getFloatTimeDomainData(buf);
              for (const x of buf) peak = Math.max(peak, Math.abs(x));
            }
            r.audioPeak = peak;
            r.audioSampleRate = ac.sampleRate;
            await ac.close();
          }
          stream.getTracks().forEach(t => t.stop());
        } catch (e) {
          r.error = String(e);
        }
        return r;
      };
    <\/script></body></html>`;

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    const screenSource = sources.find((s) => s.id.startsWith('screen:'));
    const result = await win.webContents.executeJavaScript(
      `window.probe(${JSON.stringify(screenSource?.id ?? '')}, { audio: true })`,
    );
    log('getDisplayMediaProbe', result);

    // 5. 内容保护（WDA_EXCLUDEFROMCAPTURE）
    const win2 = new BrowserWindow({ show: true, width: 400, height: 200, title: 'overlay-test' });
    await win2.loadURL('data:text/html,<body style="background:#0f0">overlay</body>');
    win2.setContentProtection(true);
    log('setContentProtection', { applied: true });

    // 6. 窗口是否被采集排除 —— 通过 desktopCapturer 缩略图无法直接验证，记录为待人工核验
    log('note', '内容保护需人工核验（截图后检查悬浮窗是否缺失）');

    win2.close();
    win.destroy();

    fs.writeFileSync(path.join(process.cwd(), 'spike-result.json'), JSON.stringify(out, null, 2));
    console.log('SPIKE_DONE');
  } catch (e) {
    console.error('SPIKE_ERROR', e);
    try {
      fs.writeFileSync(path.join(process.cwd(), 'spike-result.json'), JSON.stringify({ ...out, fatal: String(e) }, null, 2));
    } catch {}
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
