#!/usr/bin/env node
/**
 * 窗口尺寸与文字缩放验收（UI 改进建议的验收列）
 *
 * 检查：
 *   1. 1366×768 窗口下，录制页「开始录制」按钮无需滚动即可见（P0 验收）；
 *   2. 首页第一屏能看到主按钮与最近工程（P1 验收）；
 *   3. 长中文快捷卡片文案不重叠（改用块级两行后应无粘连）；
 *   4. 200% 文字缩放下关键按钮不被裁切（P1 验收）。
 *
 * 运行：node_modules\electron\dist\electron.exe --no-sandbox scripts\verify-layout.cjs
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'renderer', 'index.html');
const OUT = path.join(ROOT, 'docs', 'screenshots');

app.setPath('userData', path.join(ROOT, '.verify-ui-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const IN_VIEWPORT = (selector, label) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, reason: 'missing ${label || selector}' };
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight, vw = window.innerWidth;
  const visible = r.width > 4 && r.height > 4 && r.bottom <= vh + 1 && r.top >= -1 && r.right <= vw + 1;
  return { ok: visible, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }, vh, vw };
})()`;

async function boot(win) {
  await win.loadFile(ENTRY);
  for (let i = 0; i < 90; i++) {
    const ready = await win.webContents
      .executeJavaScript('document.documentElement.dataset.ready === "1" && !!document.querySelector("#root > *")')
      .catch(() => false);
    if (ready) return true;
    await wait(120);
  }
  return false;
}

app.whenReady().then(async () => {
  const summary = { ok: true, cases: {}, failures: [] };
  const fail = (m) => summary.failures.push(m);
  try {
    const win = new BrowserWindow({
      width: 1366,
      height: 768,
      show: true,
      backgroundColor: '#14161b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    const booted = await boot(win);
    summary.cases.boot = { ok: booted };
    if (!booted) fail('页面未就绪');

    // ---- 录制页：开始录制按钮在首屏可见 ----
    await win.webContents.executeJavaScript(`location.hash = '#/record'; true`);
    await wait(1200);
    const startBtn = await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('.view-head button')];
      const b = btns.find((x) => (x.textContent || '').includes('开始录制'));
      if (!b) return { ok: false, reason: 'no start button' };
      const r = b.getBoundingClientRect();
      return { ok: r.bottom <= window.innerHeight + 1 && r.width > 20, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }, vh: window.innerHeight };
    })()`);
    summary.cases.recordStartVisible = startBtn;
    if (!startBtn.ok) fail(`1366×768 录制页「开始录制」不在首屏: ${JSON.stringify(startBtn)}`);

    // 重复开关检查：录制页不应有两个同名切换开关
    const toggleDup = await win.webContents.executeJavaScript(`(() => {
      const labels = [...document.querySelectorAll('.wcs-toggle-label')].map((n) => (n.textContent || '').trim());
      const counts = {};
      for (const l of labels) counts[l] = (counts[l] || 0) + 1;
      return { labels, duplicates: Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k) };
    })()`);
    summary.cases.recordToggles = toggleDup;
    if (toggleDup.duplicates.length) fail(`录制页存在重复开关: ${toggleDup.duplicates.join(', ')}`);

    // ---- 首页：主按钮 + 最近工程首屏可见 ----
    await win.webContents.executeJavaScript(`location.hash = '#/home'; true`);
    await wait(1200);
    summary.cases.homePrimary = await win.webContents.executeJavaScript(IN_VIEWPORT('.home-hero-actions button', '主按钮'));
    summary.cases.homeRecent = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.recent-item, .wcs-empty');
      if (!el) return { ok: false, reason: 'no recent section' };
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      return { ok: r.top < vh - 40 && r.height > 10, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }, vh };
    })()`);
    if (!summary.cases.homePrimary.ok) fail(`首页主按钮不在首屏: ${JSON.stringify(summary.cases.homePrimary)}`);
    if (!summary.cases.homeRecent.ok) fail(`首页最近工程不在首屏: ${JSON.stringify(summary.cases.homeRecent)}`);

    // 重复入口检查：首页不应重复出现「新建录制」
    const homeDup = await win.webContents.executeJavaScript(`(() => {
      const texts = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
      const count = texts.filter((t) => t === '新建录制').length;
      return { newRecordCount: count };
    })()`);
    summary.cases.homeNewRecordCount = homeDup;
    if (homeDup.newRecordCount > 1) fail(`首页「新建录制」出现 ${homeDup.newRecordCount} 次（应只保留一处主入口 + 空态引导）`);

    // ---- 长文案不重叠：快捷卡片 / 提示条 ----
    const overlap = await win.webContents.executeJavaScript(`(() => {
      const problems = [];
      const pairs = [
        ['.quick-action-title', '.quick-action-desc'],
        ['.recent-name', '.recent-meta'],
      ];
      for (const [a, b] of pairs) {
        const ea = document.querySelector(a), eb = document.querySelector(b);
        if (!ea || !eb) continue;
        const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
        if (ra.bottom > rb.top + 2) problems.push(a + ' 与 ' + b + ' 重叠 ' + Math.round(ra.bottom - rb.top) + 'px');
        const sa = getComputedStyle(ea), sb = getComputedStyle(eb);
        if (sa.display !== 'block' && sa.display !== 'flex') problems.push(a + ' 不是块级 (' + sa.display + ')');
        if (sb.display !== 'block' && sb.display !== 'flex') problems.push(b + ' 不是块级 (' + sb.display + ')');
      }
      // 潜在横向溢出：元素 scrollWidth 明显大于 clientWidth 且没有省略号处理
      const overflowX = [...document.querySelectorAll('.view *')].filter((el) => {
        const st = getComputedStyle(el);
        return el.scrollWidth > el.clientWidth + 4 && st.overflow !== 'hidden' && st.textOverflow !== 'ellipsis' && st.overflowX === 'visible';
      }).slice(0, 5).map((el) => el.className + ' +' + (el.scrollWidth - el.clientWidth));
      return { problems, overflowX };
    })()`);
    summary.cases.overlap = overlap;
    for (const p of overlap.problems) fail(p);

    // ---- 200% 文字缩放：关键按钮不被裁切 ----
    await win.webContents.setZoomFactor(2);
    await win.webContents.executeJavaScript(`location.hash = '#/record'; true`);
    await wait(1400);
    const zoomed = await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('.view-head button')].find((x) => (x.textContent || '').includes('开始录制'));
      if (!b) return { ok: false, reason: 'no start button at 200%' };
      const r = b.getBoundingClientRect();
      // 文字是否溢出按钮盒子
      const overflow = b.scrollWidth > b.clientWidth + 2 || b.scrollHeight > b.clientHeight + 2;
      return { ok: !overflow, rect: { w: Math.round(r.width), h: Math.round(r.height) }, scroll: { w: b.scrollWidth, h: b.scrollHeight }, client: { w: b.clientWidth, h: b.clientHeight } };
    })()`);
    summary.cases.zoom200StartButton = zoomed;
    if (!zoomed.ok) fail(`200% 缩放下「开始录制」按钮被裁切: ${JSON.stringify(zoomed)}`);

    // 200% 截图留档
    fs.mkdirSync(OUT, { recursive: true });
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, '12-zoom200-record.png'), shot.toPNG());
    await win.webContents.setZoomFactor(1);

    summary.ok = summary.failures.length === 0;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error);
  } finally {
    fs.writeFileSync(path.join(OUT, 'verify-layout.json'), JSON.stringify(summary, null, 2));
    console.log('[LAYOUT] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const [k, v] of Object.entries(summary.cases)) console.log('[LAYOUT] ' + k + ' ' + JSON.stringify(v));
    for (const f of summary.failures) console.log('[LAYOUT] FAIL ' + f);
    if (summary.error) console.log('[LAYOUT] error ' + summary.error);
    setTimeout(() => app.exit(summary.ok ? 0 : 1), 200);
  }
});
