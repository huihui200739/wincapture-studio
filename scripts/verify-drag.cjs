#!/usr/bin/env node
/**
 * 无边框窗口拖拽链路验证
 *
 * 背景：主窗口/悬浮条是 frameless+transparent+resizable:false 组合，
 * -webkit-app-region: drag 实测拖不动，已改为「渲染层 pointer capture 采样 +
 * IPC window:move-by 主进程移动窗口」。本探针加载真实 dist 渲染层（#overlay 角色）
 * 与真实 preload，在悬浮条真实把手上派发带受控 screenX/screenY 的 PointerEvent，
 * 断言窗口按增量移动。
 *
 * 说明：OS 真实指针 → Chromium screenX 的映射是标准行为，不在本探针范围；
 * 这里覆盖 React 接线 → windowDrag 钩子 → IPC → 主进程移动窗口的完整链路。
 *
 * 运行：node scripts/run-electron.mjs scripts/verify-drag.cjs
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'verify', 'drag-result.json');
const geometryFile = path.join(ROOT, 'dist', 'verify', 'floating-geometry.cjs');
buildSync({ entryPoints: [path.join(ROOT, 'electron', 'floatingWindowGeometry.ts')], outfile: geometryFile,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const { moveFloatingWindow, rememberFloatingSize, resizeFloatingWindow } = require(geometryFile);

app.setPath('userData', path.join(ROOT, '.verify-ui-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

// 本探针自己决定退出时机（中间会出现零窗口瞬间）
app.on('window-all-closed', () => {});

const result = { checks: [] };
const check = (ok, label) => {
  result.checks.push({ ok: !!ok, label });
  console.log(`[drag] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) throw new Error(label);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 electron/main.ts 的 window:move-by 相同语义的最小实现（探针独立进程）。
 *  渲染层按 rAF 合并增量：一次拖拽可能到达 1~多次 IPC，断言按累计值。 */
let movedSum = { dx: 0, dy: 0 };
let movedCalls = 0;
ipcMain.handle('capture:status', () => ({ ok: true, data: null }));
ipcMain.handle('window:update-overlay', () => ({ ok: true, data: null }));
ipcMain.handle('window:move-by', (_event, dx, dy) => {
  movedSum.dx += Number(dx) || 0;
  movedSum.dy += Number(dy) || 0;
  movedCalls += 1;
  const win = captured;
  if (!win || win.isDestroyed()) return null;
  moveFloatingWindow(win, Number(dx) || 0, Number(dy) || 0);
  return null;
});

let captured = null;
async function main() {
  const win = new BrowserWindow({
    width: 460,
    height: 64,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  captured = win;
  rememberFloatingSize(win, 460, 64);
  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'), { hash: 'overlay' });

  // 等渲染层挂载出真实悬浮条的把手
  const until = async (expr, timeout = 15_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await win.webContents.executeJavaScript(expr, true)) return;
      await wait(150);
    }
    throw new Error(`超时：${expr}`);
  };
  await until(`!!document.querySelector('.rec-drag')`);
  const before = win.getBounds();

  // 在真实把手上派发受控指针序列：pointerdown → 多步 move → up
  // screenX/screenY 由探针指定（合成事件的语义与真实指针一致：渲染层只读增量）
  const dispatch = `(() => {
    const grip = document.querySelector('.rec-drag');
    const r = grip.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    const sx = ${before.x + 100}, sy = ${before.y + 40};
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...base, screenX: sx, screenY: sy }));
    const steps = [[40, 18], [80, 36], [120, 54]];
    for (const [dx, dy] of steps) {
      grip.dispatchEvent(new PointerEvent('pointermove', { ...base, screenX: sx + dx, screenY: sy + dy }));
    }
    grip.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, screenX: sx + 120, screenY: sy + 54 }));
    return true;
  })()`;
  await win.webContents.executeJavaScript(dispatch, true);
  await wait(300);

  check(Math.round(movedSum.dx) === 120 && Math.round(movedSum.dy) === 54 && movedCalls >= 1,
    `把手的位移按增量累计到达主进程（${JSON.stringify(movedSum)}，${movedCalls} 次 IPC）`);
  const after = win.getBounds();
  check(after.x - before.x === 120 && after.y - before.y === 54,
    `窗口位置按增量移动（before ${before.x},${before.y} → after ${after.x},${after.y}）`);

  // 拖拽结束后把手仍可再次拖动（监听器正确清理，不会重复绑定）
  await win.webContents.executeJavaScript(`(() => {
    const grip = document.querySelector('.rec-drag');
    const r = grip.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1, clientX: r.x, clientY: r.y };
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...base, screenX: 0, screenY: 0 }));
    grip.dispatchEvent(new PointerEvent('pointermove', { ...base, screenX: -30, screenY: -10 }));
    grip.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, screenX: -30, screenY: -10 }));
    return true;
  })()`, true);
  await wait(300);
  const final = win.getBounds();
  check(final.x - after.x === -30 && final.y - after.y === -10 && Math.round(movedSum.dx) === 90 && Math.round(movedSum.dy) === 44,
    `第二次拖拽同样生效且无重复步进（after ${after.x},${after.y} → final ${final.x},${final.y}，累计 ${JSON.stringify(movedSum)}）`);

  // Hidden windows do not reproduce the Windows 150% DPI growth bug. Exercise
  // the production helper with visible native windows and odd DIP positions.
  win.show();
  for (const [width, height] of [[460,64], [460,196], [620,96], [620,610]]) {
    resizeFloatingWindow(win, width, height);
    const samples = [];
    for (let i = 0; i < 120; i++) {
      moveFloatingWindow(win, i % 2 ? -1 : 1, i % 4 < 2 ? 1 : -1);
      await wait(8);
      samples.push(win.getBounds());
    }
    check(samples.every(b => Math.abs(b.width - width) <= 2 && Math.abs(b.height - height) <= 2),
      `可见窗口 ${width}×${height} 连续移动 120 次尺寸不累计增长`);
    result.visibleSizes ??= [];
    result.visibleSizes.push({ requested: { width, height }, final: samples.at(-1) });
  }

  result.ok = true;
} 

void app.whenReady().then(() => main()).then(() => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('[drag] overall=PASS');
  setTimeout(() => app.exit(0), 300);
}).catch((error) => {
  result.ok = false;
  result.error = String(error instanceof Error ? error.message : error);
  console.error('[drag]', result.error);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  setTimeout(() => app.exit(1), 300);
});
