#!/usr/bin/env node
/**
 * 预览适配验证（§P0 验收）
 *
 * 检查编辑器预览是否「contain 完整显示」：
 *   1. canvas 显示矩形严格等于遮挡层容器（.stage-canvas-inner）矩形；
 *   2. canvas 完整落在预览容器（.stage-canvas-wrap）内，不被裁切；
 *   3. 上下/左右留白对称（居中），且没有被撑出容器；
 *   4. 横屏 16:9、方形 1:1、竖屏 9:16 三种画幅都成立；
 *   5. 折叠/展开时间线后仍然居中且完整。
 *
 * 运行：node_modules\electron\dist\electron.exe --no-sandbox scripts/verify-stage-fit.cjs
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

const MEASURE = `(() => {
  const wrap = document.querySelector('.stage-canvas-wrap');
  const inner = document.querySelector('.stage-canvas-inner');
  const canvas = document.querySelector('canvas.stage-canvas');
  if (!wrap || !inner || !canvas) return { ok: false, reason: 'missing node' };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const W = r(wrap), I = r(inner), C = r(canvas);
  const style = getComputedStyle(wrap);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const round = (n) => Math.round(n * 10) / 10;
  return {
    ok: true,
    wrap: { w: round(W.w), h: round(W.h) },
    avail: { w: round(W.w - padX), h: round(W.h - padY) },
    pad: { x: round(padX / 2), y: round(padY / 2) },
    inner: { x: round(I.x - W.x), y: round(I.y - W.y), w: round(I.w), h: round(I.h) },
    canvas: { x: round(C.x - W.x), y: round(C.y - W.y), w: round(C.w), h: round(C.h) },
    canvasIntrinsic: { w: canvas.width, h: canvas.height },
    // 未取整的比例，用于精确判定
    exactAspect: C.h > 0 ? C.w / C.h : 0,
    intrinsicAspect: canvas.height > 0 ? canvas.width / canvas.height : 0,
    // 左右留白差、上下留白差（扣除 padding 后越接近 0 越居中）
    gapLeft: round(I.x - W.x),
    gapRight: round(W.x + W.w - (I.x + I.w)),
    gapTop: round(I.y - W.y),
    gapBottom: round(W.y + W.h - (I.y + I.h)),
    // 是否被裁：inner 超出 wrap 任何一边都算裁切
    clipped:
      I.x < W.x - 1 || I.y < W.y - 1 ||
      I.x + I.w > W.x + W.w + 1 || I.y + I.h > W.y + W.h + 1,
    // canvas 与遮挡层容器是否同矩形
    innerCanvasMismatch: Math.abs(I.w - C.w) > 1 || Math.abs(I.h - C.h) > 1 || Math.abs(I.x - C.x) > 1 || Math.abs(I.y - C.y) > 1,
    // 是否超出可用区域（扣 padding 后）
    overflowsAvail: I.w > W.w - padX + 1 || I.h > W.h - padY + 1,
  };
})()`;

async function setVariant(win, variantId) {
  // 通过画布属性页签切画幅（与用户操作一致，走真实命令层）
  await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.inspector-tab')];
    const tab = document.getElementById('inspector-tab-canvas');
    if (tab) tab.click();
    [...document.querySelectorAll('.studio-canvas-tabs button')].find(b => b.textContent === '布局')?.click();
    return !!tab;
  })()`);
  await wait(350);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.studio-canvas-tabs button')].find(b=>b.textContent==='布局')?.click()`);
  await wait(150);
  return win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.variant-card')];
    const card = cards.find((c) => (c.getAttribute('aria-label') || c.textContent || '').includes(${JSON.stringify(variantId)}));
    if (!card) return { clicked: false, labels: cards.map((c) => (c.getAttribute('aria-label') || c.textContent || '').trim()) };
    card.click();
    return { clicked: true };
  })()`);
}

app.whenReady().then(async () => {
  const summary = { ok: true, cases: {}, consoleErrors: [] };
  try {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      backgroundColor: '#14161b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    win.webContents.on('console-message', (event, level, message) => {
      const lv = typeof event === 'object' && event ? event.level : level;
      const msg = typeof event === 'object' && event ? event.message : message;
      if (lv === 'error' || lv === 3) summary.consoleErrors.push(String(msg));
    });

    await win.loadFile(ENTRY);
    for (let i = 0; i < 80; i++) {
      const ready = await win.webContents
        .executeJavaScript('document.documentElement.dataset.ready === "1" && !!document.querySelector("#root > *")')
        .catch(() => false);
      if (ready) break;
      await wait(120);
    }
    await win.webContents.executeJavaScript(`location.hash = '#/editor'; true`);
    await wait(1400);

    // 1) 默认画幅（16:9）
    summary.cases.landscape = await win.webContents.executeJavaScript(MEASURE);

    // 2) 切方形
    const square = await setVariant(win, '1:1');
    await wait(900);
    summary.cases.squarePick = square;
    summary.cases.square = await win.webContents.executeJavaScript(MEASURE);

    // 3) 切竖屏
    const portrait = await setVariant(win, '9:16');
    await wait(900);
    summary.cases.portraitPick = portrait;
    summary.cases.portrait = await win.webContents.executeJavaScript(MEASURE);

    // 4) 回到横屏，折叠时间线后再量一次
    await setVariant(win, '16:9');
    await wait(900);
    await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.timeline-toolbar button')].find((b) => (b.getAttribute('aria-label') || '').includes('时间线'));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await wait(900);
    summary.cases.landscapeCollapsed = await win.webContents.executeJavaScript(MEASURE);

    // 截图留档
    fs.mkdirSync(OUT, { recursive: true });
    const shot = await win.webContents.capturePage();
    const file = path.join(OUT, '11-stage-fit.png');
    fs.writeFileSync(file, shot.toPNG());
    summary.shot = path.relative(ROOT, file);

    // 判定
    const checks = [];
    for (const [name, m] of Object.entries(summary.cases)) {
      if (!m || typeof m !== 'object' || !('ok' in m)) continue;
      if (!m.ok) { checks.push(`${name}: 测量失败 ${m.reason}`); continue; }
      if (m.clipped) checks.push(`${name}: 预览被容器裁切`);
      if (m.innerCanvasMismatch) checks.push(`${name}: 遮挡层与画面矩形不一致`);
      if (m.overflowsAvail) checks.push(`${name}: 预览超出可用区域`);
      // 居中：两侧留白（已含 padding）应对称
      if (Math.abs(m.gapLeft - m.gapRight) > 2) checks.push(`${name}: 水平未居中 (${m.gapLeft} vs ${m.gapRight})`);
      if (Math.abs(m.gapTop - m.gapBottom) > 2) checks.push(`${name}: 垂直未居中 (${m.gapTop} vs ${m.gapBottom})`);
      // contain 语义：扣掉 padding 后应贴着某一对边（左右或上下）
      const leftInset = m.gapLeft - m.pad.x;
      const rightInset = m.gapRight - m.pad.x;
      const topInset = m.gapTop - m.pad.y;
      const bottomInset = m.gapBottom - m.pad.y;
      const fillsOneAxis =
        Math.abs(leftInset) <= 2 || Math.abs(rightInset) <= 2 || Math.abs(topInset) <= 2 || Math.abs(bottomInset) <= 2;
      if (!fillsOneAxis) checks.push(`${name}: 没有贴边，未充分利用可用区域`);
      // 显示比例应与画布固有比例一致
      if (m.intrinsicAspect > 0 && Math.abs(m.exactAspect - m.intrinsicAspect) > 0.02) {
        checks.push(`${name}: 显示比例 ${m.exactAspect.toFixed(3)} ≠ 画布 ${m.intrinsicAspect.toFixed(3)}`);
      }
    }
    summary.failures = checks;
    summary.ok = checks.length === 0 && summary.consoleErrors.length === 0;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error) + '\n' + (error && error.stack ? error.stack : '');
  } finally {
    fs.writeFileSync(path.join(OUT, 'verify-stage-fit.json'), JSON.stringify(summary, null, 2));
    console.log('[FIT] === SUMMARY ===');
    console.log('[FIT] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const [name, m] of Object.entries(summary.cases)) {
      if (m && typeof m === 'object' && 'ok' in m && m.ok) {
        console.log(`[FIT] ${name}: 可用 ${m.avail.w}x${m.avail.h} → 显示 ${m.inner.w}x${m.inner.h} (比例 ${m.exactAspect.toFixed(3)}, 画布 ${m.intrinsicAspect.toFixed(3)}) 留白 L${m.gapLeft} R${m.gapRight} T${m.gapTop} B${m.gapBottom}`);
      } else {
        console.log(`[FIT] ${name}: ${JSON.stringify(m)}`);
      }
    }
    for (const f of summary.failures || []) console.log('[FIT] FAIL ' + f);
    for (const e of summary.consoleErrors) console.log('[FIT] console-error ' + e);
    if (summary.error) console.log('[FIT] error: ' + summary.error.split('\n')[0]);
    setTimeout(() => app.exit(summary.ok ? 0 : 1), 200);
  }
});
