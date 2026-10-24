/**
 * 摄像头采集验证（R04）
 *
 * 真机跑一遍：枚举设备 → 打开 → 取快照 → 编码 2 秒分段 → 用 mediabunny 独立校验。
 * 结果写 dist/verify/camera-result.json。
 *
 * 用法：Electron --no-sandbox scripts/verify-camera.cjs
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session } = require('electron');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'verify');
app.setPath('userData', path.join(ROOT, '.tmp', 'camera-device-data'));

function log(message) {
  console.log(`[camera-verify] ${message}`);
}

async function main() {
  const result = { startedAt: new Date().toISOString(), steps: [], ok: false };
  const watchdog = setTimeout(() => {
    result.reason = '摄像头验证超过 60 秒，已停止并释放设备';
    finish(1);
  }, 60_000);
  const step = (name, data) => {
    result.steps.push(name);
    log(`${name}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
  };

  try {
    await app.whenReady();

    // 与正式应用一样，只给本地应用页面授予媒体权限。
    const rendererUrl = pathToFileURL(path.join(ROOT, 'dist', 'renderer', 'index.html')).href;
    const allowed = (contents, permission) => permission === 'media' && contents?.getURL().split('#')[0] === rendererUrl;
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
    session.defaultSession.setPermissionCheckHandler(allowed);

    const win = new BrowserWindow({
      width: 640,
      height: 480,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'dist', 'main', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    });

    win.webContents.on('console-message', (event) => {
      const message = typeof event === 'object' && 'message' in event ? String(event.message) : '';
      log(`[window] ${message}`);
    });

    await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'), { hash: 'camera' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const ready = await win.webContents.executeJavaScript('!!window.__wcsCamera', true);
    step('runtime-ready', { ready });
    if (!ready) throw new Error('window.__wcsCamera 未安装');

    // ---- 1. 枚举设备 ----
    const devices = await win.webContents.executeJavaScript('window.__wcsCamera.listDevices()', true);
    result.devices = devices;
    step('list-devices', { count: devices.length, names: devices.map((d) => d.label) });
    if (devices.length === 0) {
      result.ok = false;
      result.reason = '本机没有摄像头设备';
      finish(1);
      return;
    }

    // 逐个精确打开，保留原始错误；默认设备可能是不可用的虚拟摄像头。
    result.deviceChecks = [];
    for (const device of devices) {
      const check = await win.webContents.executeJavaScript(`(async () => {
        let media;
        try {
          const request = navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:${JSON.stringify(device.deviceId)}}},audio:false});
          let expired = false, timer;
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('设备打开超时')); }, 8000); });
          request.then(value => { if (expired) value.getTracks().forEach(track => track.stop()); }, () => {});
          try { media = await Promise.race([request, timeout]); } finally { clearTimeout(timer); }
          const track = media.getVideoTracks()[0];
          return {ok:true, label:track.label, settings:track.getSettings()};
        } catch(error) { return {ok:false, name:error.name, error:error.message}; }
        finally { media?.getTracks().forEach(track => track.stop()); }
      })()`, true);
      result.deviceChecks.push({ deviceId: device.deviceId, label: device.label, ...check });
      step('device-check', { label: device.label, ...check });
    }

    // 默认优先验证内置设备。虚拟摄像头可用不能替代物理设备验收。
    const selector = process.env.WCS_CAMERA_DEVICE?.trim().toLowerCase();
    const matches = selector ? devices.filter(device => device.deviceId.toLowerCase() === selector || device.label.toLowerCase().includes(selector)) : [];
    if (selector && matches.length !== 1) throw new Error('WCS_CAMERA_DEVICE 必须唯一匹配一个设备名称或 ID');
    const selected = selector ? matches[0] : devices.find(device => /integrated|built.in|内置/i.test(device.label)) ?? devices[0];
    result.targetDevice = selected;
    const deviceCheck = result.deviceChecks.find(check => check.deviceId === selected.deviceId);
    if (!deviceCheck.ok) {
      result.reason = `${selected.label}: ${deviceCheck.name}: ${deviceCheck.error}`;
      finish(1);
      return;
    }

    // ---- 2. 打开目标摄像头，确认运行时没有悄悄回退到其它设备 ----
    const opened = await win.webContents.executeJavaScript(`window.__wcsCamera.open(${JSON.stringify(selected.deviceId)})`, true);
    result.opened = opened;
    step('open', { ok: opened.ok, label: opened.label, error: opened.error });
    if (!opened.ok || opened.deviceId !== selected.deviceId) {
      result.ok = false;
      result.reason = opened.error ?? '摄像头运行时回退到了其它设备';
      finish(1);
      return;
    }

    await win.webContents.executeJavaScript(`window.__wcsCamera.setClock({state:'recording',mediaTick:0,wallTimeMs:performance.timeOrigin+performance.now()})`);
    await new Promise(resolve => setTimeout(resolve, 2100));
    await win.webContents.executeJavaScript(`window.__wcsCamera.setClock({state:'paused',mediaTick:20000000,wallTimeMs:performance.timeOrigin+performance.now()})`);
    // ---- 3. 取快照并检查不是全黑 ----
    const snapshot = await win.webContents.executeJavaScript('window.__wcsCamera.snapshot()', true);
    if (snapshot.ok && snapshot.png) {
      const bytes = Buffer.from(snapshot.png, 'base64');
      const shotPath = path.join(OUT_DIR, 'camera-snapshot.png');
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(shotPath, bytes);
      result.snapshotBytes = bytes.length;
      result.snapshotPath = shotPath;

      // 用 Electron 的解码能力统计颜色，确认不是全黑/全白。
      // 注意：不能用 data: URL + fetch（CSP 的 connect-src 'self' 会拦掉），
      // 改为把 PNG 以 ArrayBuffer 直接传给 createImageBitmap。
      const pngBase64 = snapshot.png;
      const stats = await win.webContents.executeJavaScript(
        `(async () => {
           try {
             const b64 = ${JSON.stringify(pngBase64)};
             const raw = atob(b64);
             const bytes = new Uint8Array(raw.length);
             for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
             const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
             const c = new OffscreenCanvas(bitmap.width, bitmap.height);
             const ctx = c.getContext('2d');
             ctx.drawImage(bitmap, 0, 0);
             const data = ctx.getImageData(0, 0, c.width, c.height).data;
             const colors = new Set();
             let sum = 0, count = 0;
             for (let i = 0; i + 3 < data.length; i += 4 * 53) {
               colors.add(((data[i] >> 3) << 10) | ((data[i+1] >> 3) << 5) | (data[i+2] >> 3));
               sum += data[i] + data[i+1] + data[i+2];
               count++;
             }
             return { width: c.width, height: c.height, distinctColors: colors.size, avgLuma: Math.round(sum / (count * 3)) };
           } catch (e) { return { error: String(e) }; }
         })()`,
        true,
      );
      result.snapshotStats = stats;
      step('snapshot', stats);
      // 判定「非单色」而不是「颜色丰富」：
      // Chromium 的 fake device 输出绿底 + 时间码 + 旋转三角，只有十几种颜色是正常的。
      // 真正要排除的是全黑/全白/纯色（采集根本没出帧）。
      result.snapshotNonBlank = (stats.distinctColors ?? 0) > 2;
    } else {
      result.snapshotError = snapshot.error;
      step('snapshot', { ok: false, error: snapshot.error });
    }

    // ---- 4. 编码一个 2 秒分段 ----
    const encoded = await win.webContents.executeJavaScript(
      `window.__wcsCamera.encodeSegment(${JSON.stringify({
        index: 1,
        durationTicks: 20_000_000,
        fps: 30,
        width: 1280,
        height: 720,
        sampleTimesMs: [],
      })})`,
      true,
    );
    result.encode = {
      ok: encoded.ok,
      frames: encoded.frames,
      bytes: encoded.bytes,
      encoder: encoded.encoder,
      error: encoded.error,
    };
    step('encode', result.encode);
    if (!encoded.ok) throw new Error('分段编码失败：' + encoded.error);

    // ---- 5. 落盘并用 mediabunny 独立校验 ----
    const segPath = path.join(OUT_DIR, 'camera-seg-000001.mp4');
    fs.writeFileSync(segPath, Buffer.from(encoded.mp4, 'base64'));
    result.segmentPath = segPath;
    result.segmentBytes = fs.statSync(segPath).size;

    const mb = require(path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs'));
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.FilePathSource(segPath) });
    const track = await input.getPrimaryVideoTrack();
    const duration = await input.computeDuration();
    const stats = await track.computePacketStats();
    const codec = await track.getCodec();
    const width = await track.getCodedWidth();
    const height = await track.getCodedHeight();
    await input.dispose?.();

    result.demux = {
      codec,
      width,
      height,
      durationSeconds: Number(duration.toFixed(3)),
      packets: stats.packetCount,
      fps: stats.averagePacketRate,
    };
    step('demux', result.demux);

    result.ok =
      opened.ok === true &&
      result.snapshotNonBlank === true &&
      encoded.ok === true &&
      (encoded.frames ?? 0) > 10 &&
      stats.packetCount > 10 &&
      width === 1280 &&
      height === 720;

    await win.webContents.executeJavaScript('window.__wcsCamera.close()', true);
    finish(result.ok ? 0 : 1);
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    log(`FAILED ${result.error}`);
    finish(1);
  }

  function finish(code) {
    clearTimeout(watchdog);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'camera-result.json'), JSON.stringify(result, null, 2));
    log(`done ok=${result.ok}`);
    setTimeout(() => app.exit(code), 300);
  }
}

void main();
