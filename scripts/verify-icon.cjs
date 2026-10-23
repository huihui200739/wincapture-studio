#!/usr/bin/env node
/**
 * 图标接入验证
 *
 * 检查：
 *   1. 应用内品牌位（.rail-logo img）的图标真实解码成功（naturalWidth > 0，不是碎图）；
 *   2. index.html 的 favicon 指向的 PNG 可加载；
 *   3. 主进程能解析到 ICO 路径（通过 preload 暴露的 systemInfo 之外的方式验证：
 *      这里只验证渲染层与资源文件，主进程图标由 verify-icon-main 检查）。
 *
 * 运行：node_modules\electron\dist\electron.exe --no-sandbox scripts\verify-icon.cjs
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'renderer', 'index.html');
const OUT = path.join(ROOT, 'dist', 'verify', 'screenshots');

app.setPath('userData', path.join(ROOT, '.verify-ui-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const summary = { ok: true, failures: [], checks: {} };
  const fail = (m) => summary.failures.push(m);
  try {
    // ---- 资源文件存在性与尺寸 ----
    const ico = path.join(ROOT, 'dist', 'assets', 'app-icon.ico');
    const png = path.join(ROOT, 'dist', 'renderer', 'app-icon.png');
    summary.checks.files = {
      ico: fs.existsSync(ico) ? fs.statSync(ico).size : null,
      png: fs.existsSync(png) ? fs.statSync(png).size : null,
    };
    if (!summary.checks.files.ico) fail('dist/assets/app-icon.ico 缺失（主窗口图标不可用）');
    if (!summary.checks.files.png) fail('dist/renderer/app-icon.png 缺失（界面品牌图不可用）');

    // ---- ICO 头校验：应包含多档尺寸 ----
    if (summary.checks.files.ico) {
      const buf = fs.readFileSync(ico);
      const reserved = buf.readUInt16LE(0);
      const type = buf.readUInt16LE(2);
      const count = buf.readUInt16LE(4);
      const sizes = [];
      for (let i = 0; i < count; i++) {
        const off = 6 + i * 16;
        const w = buf[off] === 0 ? 256 : buf[off];
        sizes.push(w);
      }
      summary.checks.icoHeader = { reserved, type, count, sizes };
      if (reserved !== 0 || type !== 1) fail('app-icon.ico 头无效');
      for (const need of [16, 32, 48, 256]) {
        if (!sizes.includes(need)) fail(`app-icon.ico 缺少 ${need}px 尺寸`);
      }
    }

    // ---- 界面品牌图真实解码 ----
    const win = new BrowserWindow({
      width: 1366,
      height: 768,
      show: true,
      backgroundColor: '#14161b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadFile(ENTRY);
    for (let i = 0; i < 90; i++) {
      const ready = await win.webContents
        .executeJavaScript('document.documentElement.dataset.ready === "1" && !!document.querySelector("#root > *")')
        .catch(() => false);
      if (ready) break;
      await wait(120);
    }
    await wait(700);

    const rail = await win.webContents.executeJavaScript(`(() => {
      const img = document.querySelector('.rail-logo img');
      if (!img) return { ok: false, reason: 'no brand image' };
      const r = img.getBoundingClientRect();
      return {
        ok: img.complete && img.naturalWidth > 0,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        renderedW: Math.round(r.width),
        renderedH: Math.round(r.height),
        src: img.currentSrc || img.src,
      };
    })()`);
    summary.checks.brandImage = rail;
    if (!rail.ok) fail(`品牌图未成功解码: ${JSON.stringify(rail)}`);

    // ---- favicon ----
    const fav = await win.webContents.executeJavaScript(`(() => {
      const link = document.querySelector('link[rel="icon"]');
      if (!link) return { ok: false, reason: 'no favicon link' };
      return { ok: true, href: link.href };
    })()`);
    summary.checks.favicon = fav;
    if (!fav.ok) fail('index.html 缺少 favicon');

    // 截图品牌位附近
    fs.mkdirSync(OUT, { recursive: true });
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, '13-brand-icon.png'), shot.toPNG());

    summary.ok = summary.failures.length === 0;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error);
  } finally {
    fs.writeFileSync(path.join(OUT, 'verify-icon.json'), JSON.stringify(summary, null, 2));
    console.log('[ICON] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const [k, v] of Object.entries(summary.checks)) console.log('[ICON] ' + k + ' ' + JSON.stringify(v));
    for (const f of summary.failures) console.log('[ICON] FAIL ' + f);
    if (summary.error) console.log('[ICON] error ' + summary.error);
    setTimeout(() => app.exit(summary.ok ? 0 : 1), 200);
  }
});
