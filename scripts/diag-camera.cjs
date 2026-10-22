/**
 * 摄像头 getUserMedia 单配置诊断
 *
 * 一次进程只测一种配置（多个窗口连续创建会崩），由外部脚本循环调用。
 * 用法：electron --no-sandbox scripts/diag-camera.cjs <mode>
 *   mode: offscreen | onscreen | sandbox | protocol
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session, protocol, net } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'dist', 'renderer');
const MODE = process.argv.find((a) => ['offscreen', 'onscreen', 'sandbox', 'protocol'].includes(a)) ?? 'offscreen';
const OUT = path.join(ROOT, 'dist', 'verify', `camera-diag-${MODE}.json`);

function log(message) {
  console.log(`[diag:${MODE}] ${message}`);
}

async function main() {
  await app.whenReady();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    log(`permission-request ${permission}`);
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    log(`permission-check ${permission}`);
    return true;
  });

  let win;
  const webPreferences = {
    preload: path.join(ROOT, 'dist', 'main', 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false,
    sandbox: MODE === 'sandbox',
    offscreen: MODE === 'offscreen',
  };

  win = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences });

  if (MODE === 'protocol') {
    if (!protocol.isProtocolHandled('wcs-app')) {
      protocol.handle('wcs-app', (request) => {
        const url = new URL(request.url);
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        return net.fetch(`file:///${path.join(RENDERER, rel).replace(/\\/g, '/')}`);
      });
    }
    await win.loadURL('wcs-app://app/index.html#camera');
  } else {
    await win.loadFile(path.join(RENDERER, 'index.html'), { hash: 'camera' });
  }
  await new Promise((r) => setTimeout(r, 800));

  const data = await win.webContents.executeJavaScript(
    `(async () => {
       const out = {
         isSecureContext: window.isSecureContext,
         origin: window.location.origin,
         hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
       };
       try {
         const stream = await navigator.mediaDevices.getUserMedia({
           video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
         });
         const track = stream.getVideoTracks()[0];
         out.ok = true;
         out.label = track ? track.label : '';
         out.settings = track ? track.getSettings() : null;
         stream.getTracks().forEach((t) => t.stop());
       } catch (e) {
         out.ok = false;
         out.errorName = e && e.name;
         out.errorMessage = e && e.message;
         out.errorConstraint = e && e.constraint;
       }
       return out;
     })()`,
    true,
  );

  const result = { mode: MODE, ...data };
  log(JSON.stringify(result));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  setTimeout(() => app.exit(data.ok ? 0 : 1), 200);
}

void main().catch((error) => {
  const result = { mode: MODE, fatal: String(error && error.stack ? error.stack : error) };
  log(JSON.stringify(result));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  setTimeout(() => app.exit(1), 200);
});
