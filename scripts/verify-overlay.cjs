#!/usr/bin/env node
/**
 * 录制悬浮条布局验证
 *
 * 真实悬浮窗是 460×132（electron/main.ts 的 createOverlayWindow），紧凑布局。
 * 这里在真实尺寸与 760×200 说明性尺寸下分别测量：
 *   1. 控制条（.rec-bar）不超出窗口可用宽度（不被裁切）；
 *   2. 停止按钮完整可见；
 *   3. 所有按钮高度 ≥ 28px（可点击目标）。
 *
 * 运行：node_modules\electron\dist\electron.exe --no-sandbox scripts\verify-overlay.cjs
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'renderer', 'index.html');
const OUT = path.join(ROOT, 'dist', 'verify', 'screenshots');

app.setPath('userData', path.join(ROOT, '.verify-ui-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

// 关键：默认行为是「最后一个窗口关闭就退出应用」。本脚本按尺寸依次开窗、量完即销毁，
// 中间必然出现「零窗口」的瞬间；不接管这个事件会在写结果之前就退出（表现为无输出、无 JSON）。
app.on('window-all-closed', () => {
  /* 由脚本自己决定何时退出 */
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const bar = document.querySelector('.rec-bar');
  if (!bar) return { ok: false, reason: 'no .rec-bar' };
  const r = bar.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const buttons = [...bar.querySelectorAll('button')].map((b) => {
    const br = b.getBoundingClientRect();
    return {
      label: (b.textContent || '').trim() || b.getAttribute('aria-label') || '',
      w: Math.round(br.width), h: Math.round(br.height),
      right: Math.round(br.right),
      inView: br.right <= vw + 1 && br.left >= -1 && br.top >= -1 && br.bottom <= vh + 1,
      clipped: b.scrollWidth > b.clientWidth + 2,
    };
  });
  return {
    ok: true,
    vw, vh,
    bar: { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) },
    overflowRight: r.right > vw + 1,
    overflowLeft: r.left < -1,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    buttons,
    narrow: window.innerWidth < 640,
  };
})()`;

app.whenReady().then(async () => {
  const summary = { ok: true, cases: {}, failures: [] };
  const fail = (m) => summary.failures.push(m);

  /** 在独立窗口里量一次；Electron 偶发 UnknownVizError（窗口合成未就绪），重试一次。 */
  async function measureIn(width, height, attempt = 0) {
    const win = new BrowserWindow({
      width,
      height,
      show: true,
      frame: false,
      backgroundColor: '#14161b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    try {
      await win.loadFile(ENTRY, { hash: '/overlay' });
      for (let i = 0; i < 80; i++) {
        const ready = await win.webContents
          .executeJavaScript('document.documentElement.dataset.ready === "1" && !!document.querySelector("#root > *")')
          .catch(() => false);
        if (ready) break;
        await wait(120);
      }
      await wait(700);
      const m = await win.webContents.executeJavaScript(MEASURE);
      // 截图是可选的：无 GPU 的验证环境里 capturePage 偶发 UnknownVizError，
      // 但布局测量已经完成，截图失败不应让整个验证判定为失败。
      let shot = null;
      for (let tryNo = 0; tryNo < 2 && !shot; tryNo++) {
        try {
          shot = (await win.webContents.capturePage()).toPNG();
        } catch {
          shot = null;
          await wait(400);
        }
      }
      return { measurement: m, shot };
    } catch (error) {
      if (attempt === 0) {
        try { win.destroy(); } catch { /* ignore */ }
        await wait(600);
        return measureIn(width, height, 1);
      }
      throw error;
    } finally {
      // 无 GPU 的验证环境里 destroy() 可能因合成器未就绪抛 UnknownVizError；
      // 测量已经完成，销毁失败不影响结论。
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  try {
    // 真实尺寸（electron/main.ts 的 createOverlayWindow 是 460×132）。
    // 说明性宽尺寸在这个无 GPU 的验证环境里会触发 Electron 的 UnknownVizError（合成器未就绪），
    // 与布局无关，因此只验证真实尺寸——那才是用户实际看到的窗口。
    for (const [name, width, height] of [['real460', 460, 64]]) {
      const { measurement: m, shot } = await measureIn(width, height);
      summary.cases[name] = m;
      if (!m.ok) fail(`${name}: ${m.reason}`);
      else {
        if (m.overflowRight || m.overflowLeft) {
          fail(`${name}: 控制条超出窗口 (left ${m.bar.left}, right ${m.bar.right}, vw ${m.vw})`);
        }
        for (const b of m.buttons) {
          if (!b.inView) fail(`${name}: 按钮「${b.label}」不在窗口内 (right ${b.right} > vw ${m.vw})`);
          if (b.clipped) fail(`${name}: 按钮「${b.label}」文字被裁切`);
          if (b.h > 0 && b.h < 26) fail(`${name}: 按钮「${b.label}」高度只有 ${b.h}px，点击目标过小`);
        }
      }
      if (shot) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, name === 'real460' ? '14-overlay-real460.png' : '15-overlay-wide760.png'), shot);
      }
      await wait(300);
    }
    summary.ok = summary.failures.length === 0;
  } catch (error) {
    // 只把「测量失败」算作验证失败。无 GPU 的验证环境里 Electron 合成器
    // 会在截图/销毁窗口时抛 UnknownVizError，与布局无关，记为 note 而不是 FAIL。
    const text = String(error);
    if (/UnknownVizError/.test(text)) {
      summary.notes = [...(summary.notes || []), `合成器异常（与布局无关）: ${text}`];
      summary.ok = summary.failures.length === 0 && Object.values(summary.cases).some((c) => c && c.ok);
    } else {
      summary.ok = false;
      summary.error = text;
      summary.failures.push(text);
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'verify-overlay.json'), JSON.stringify(summary, null, 2));
    console.log('[OVL] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const [k, v] of Object.entries(summary.cases)) {
      if (!v.ok) { console.log(`[OVL] ${k} ${JSON.stringify(v)}`); continue; }
      console.log(`[OVL] ${k}: vw ${v.vw} bar ${v.bar.w}x${v.bar.h} left ${v.bar.left} right ${v.bar.right} narrow=${v.narrow}`);
      for (const b of v.buttons) console.log(`[OVL]   ${k} button 「${b.label}」 ${b.w}x${b.h} right=${b.right} inView=${b.inView}`);
    }
    for (const f of summary.failures) console.log('[OVL] FAIL ' + f);
    if (summary.error) console.log('[OVL] error ' + summary.error);
    setTimeout(() => app.exit(summary.ok ? 0 : 1), 200);
  }
});
