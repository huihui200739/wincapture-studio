#!/usr/bin/env node
/**
 * WP-F 界面验证脚本（R06 光标效果面板 + R12 录制备忘录）
 *
 * 用 Electron 加载 dist/renderer/index.html（mock 数据模式），只截两张图：
 *   dist/verify/screenshots/09-cursor.png      编辑器 · 属性面板「光标」页签
 *   dist/verify/screenshots/10-overlay-memo.png 悬浮控制条 · 备忘录展开
 * 并输出 JSON 结果（截图字节数 + 关键检查 + 控制台错误）。
 *
 * 运行：
 *   Remove-Item env:ELECTRON_RUN_AS_NODE
 *   .\node_modules\electron\dist\electron.exe --no-sandbox scripts\verify-wp-f.cjs
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'renderer', 'index.html');
const OUT = path.join(ROOT, 'dist', 'verify', 'screenshots');

app.setPath('userData', path.join(ROOT, '.verify-wpf-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('allow-file-access-from-files');

const consoleErrors = [];
const consoleAll = [];
const shots = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRender(win, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await win.webContents
      .executeJavaScript('document.documentElement.dataset.ready === "1" && !!document.querySelector("#root > *")')
      .catch(() => false);
    if (ready) return true;
    await wait(120);
  }
  return false;
}

async function settle(win, ms = 700) {
  await wait(ms);
  await win.webContents
    .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    .catch(() => {});
  await wait(160);
}

async function capture(win, name, label) {
  const image = await win.webContents.capturePage();
  if (image.isEmpty()) throw new Error(`截图 ${name} 为空`);
  const png = image.toPNG();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, png);
  const size = fs.statSync(file).size;
  shots.push({ name, label, file: path.relative(ROOT, file), bytes: size });
  console.log(`[WPF] captured ${name}.png (${size} bytes)`);
  return size;
}

function hookConsole(win, tag) {
  win.webContents.on('console-message', (event, level, message) => {
    const levelValue = typeof event === 'object' && event ? event.level : level;
    const text = typeof event === 'object' && event ? event.message : message;
    const entry = { level: levelValue, message: String(text), source: tag };
    consoleAll.push(entry);
    if (levelValue === 'error' || levelValue === 3) consoleErrors.push(entry);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    consoleErrors.push({ level: 'error', message: `render-process-gone: ${JSON.stringify(details)}`, source: tag });
  });
}

app.whenReady().then(async () => {
  const summary = { ok: true, shots: [], consoleErrors: [], checks: {}, notes: [] };
  try {
    if (!fs.existsSync(ENTRY)) throw new Error(`缺少构建产物：${path.relative(ROOT, ENTRY)}（先运行 npx vite build）`);
    fs.mkdirSync(OUT, { recursive: true });

    // ---------------- 编辑器 · 光标页签 ----------------
    const win = new BrowserWindow({
      width: 1560,
      height: 980,
      show: true,
      backgroundColor: '#0e1218',
      title: 'WinCapture Studio · WP-F 验证',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    hookConsole(win, 'main');
    await win.loadFile(ENTRY);
    if (!(await waitForRender(win))) throw new Error('界面在 20 秒内未完成首次渲染');

    await win.webContents.executeJavaScript(`location.hash = '#/editor'; true`);
    await settle(win, 1100);

    summary.checks.tabsBefore = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.inspector-tab')].map((t) => t.textContent.trim())`,
    );

    // 切到「光标」页签
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const tab = [...document.querySelectorAll('.inspector-tab')].find((t) => t.textContent.includes('光标'));
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    if (!clicked) throw new Error('属性面板没有「光标」页签');
    await settle(win, 500);

    summary.checks.cursorTab = await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.inspector-body');
      const text = body ? body.textContent.replace(/\\s+/g, ' ').trim() : '';
      return {
        hasBody: !!body,
        textHead: text.slice(0, 300),
        sliders: document.querySelectorAll('.inspector-body .wcs-slider').length,
        toggles: document.querySelectorAll('.inspector-body .wcs-switch').length,
        notes: document.querySelectorAll('.inspector-body .wcs-note').length,
        buttons: [...document.querySelectorAll('.inspector-body .wcs-btn')].map((b) => b.textContent.trim()),
        mentionsDualCursor: text.includes('双光标'),
      };
    })()`);

    // 若还没有 cursor effect，点「启用光标效果」创建，再验证滑杆出现
    const enableResult = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.inspector-body .wcs-btn')].find((b) => b.textContent.includes('启用光标效果'));
      if (!btn) return { enabled: false, reason: 'already exists or button missing' };
      btn.click();
      return { enabled: true };
    })()`);
    summary.checks.enableCursor = enableResult;
    await settle(win, 600);

    summary.checks.cursorAfterEnable = await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.inspector-body');
      const text = body ? body.textContent.replace(/\\s+/g, ' ').trim() : '';
      return {
        sliders: document.querySelectorAll('.inspector-body .wcs-slider').length,
        toggles: document.querySelectorAll('.inspector-body .wcs-switch').length,
        sliderLabels: [...document.querySelectorAll('.inspector-body .wcs-slider label')].map((l) => l.textContent.trim()),
        toggleLabels: [...document.querySelectorAll('.inspector-body .wcs-toggle-label')].map((l) => l.textContent.trim()),
        mentionsDualCursor: text.includes('双光标'),
        textHead: text.slice(0, 320),
      };
    })()`);

    // 验证烧录开关会禁用滑杆（真实交互，不只看 DOM）
    summary.checks.burnInBehaviour = await win.webContents.executeJavaScript(`(() => {
      const switches = [...document.querySelectorAll('.inspector-body .wcs-switch')];
      // 第二个开关是「烧录光标」
      const burn = switches[1];
      if (!burn) return { ok: false, reason: 'no burn-in switch' };
      const before = [...document.querySelectorAll('.inspector-body .wcs-slider input[type="range"]')].map((i) => i.disabled);
      burn.click();
      return { before };
    })()`);
    await settle(win, 500);
    summary.checks.burnInAfter = await win.webContents.executeJavaScript(`(() => {
      const ranges = [...document.querySelectorAll('.inspector-body .wcs-slider input[type="range"]')];
      const body = document.querySelector('.inspector-body');
      const text = body ? body.textContent.replace(/\\s+/g, ' ').trim() : '';
      return {
        disabled: ranges.map((i) => i.disabled),
        allDisabled: ranges.length > 0 && ranges.every((i) => i.disabled),
        disabledCount: ranges.filter((i) => i.disabled).length,
        total: ranges.length,
        textHasReason: text.includes('烧录模式已开启') || text.includes('不再叠加'),
      };
    })()`);

    // 撤销检查：Ctrl+Z 后应该回到烧录关闭状态（命令走 store，可撤销）
    await win.webContents.executeJavaScript(`(() => {
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return true;
    })()`);
    await settle(win, 500);
    summary.checks.undoAfterBurnIn = await win.webContents.executeJavaScript(`(() => {
      const ranges = [...document.querySelectorAll('.inspector-body .wcs-slider input[type="range"]')];
      return {
        disabled: ranges.map((i) => i.disabled),
        anyEnabled: ranges.some((i) => !i.disabled),
      };
    })()`);

    // 把烧录关掉、调一下大小，让截图里的数值更像真实配置
    await win.webContents.executeJavaScript(`(() => {
      const switches = [...document.querySelectorAll('.inspector-body .wcs-switch')];
      const burn = switches[1];
      if (burn && burn.getAttribute('aria-checked') === 'true') burn.click();
      return true;
    })()`);
    await settle(win, 400);

    await capture(win, '09-cursor', '编辑器 · 属性面板「光标」页签：大小 / 点击反馈 / 显示 / 烧录光标（避免双光标）');

    // ---------------- 悬浮条 · 备忘录 ----------------
    const overlayWin = new BrowserWindow({
      // 真实悬浮窗尺寸 460×132，验证不溢出
      width: 460,
      height: 132,
      show: true,
      frame: false,
      backgroundColor: '#12161c',
      title: 'WinCapture Studio · 备忘录验证',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    hookConsole(overlayWin, 'overlay');
    await overlayWin.loadFile(ENTRY, { hash: '/overlay' });
    await waitForRender(overlayWin).catch(() => false);
    await settle(overlayWin, 900);

    summary.checks.overlayBar = await overlayWin.webContents.executeJavaScript(`(() => ({
      hasBar: !!document.querySelector('.rec-bar'),
      buttons: [...document.querySelectorAll('.rec-btn')].map((b) => (b.getAttribute('aria-label') || '') + '|' + b.textContent.trim()),
      memoOpen: !!document.querySelector('.overlay-memo-popover'),
      barWidth: document.querySelector('.rec-bar') ? Math.round(document.querySelector('.rec-bar').getBoundingClientRect().width) : 0,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))()`);

    // 展开备忘录
    const expanded = await overlayWin.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.rec-btn')].find((b) => (b.getAttribute('aria-label') || '').includes('备忘录'));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!expanded) throw new Error('悬浮条没有备忘录按钮');
    await settle(overlayWin, 600);

    summary.checks.memoOpen = await overlayWin.webContents.executeJavaScript(`(() => {
      const pop = document.querySelector('.overlay-memo-popover');
      const ta = document.querySelector('.overlay-memo-popover textarea');
      const bar = document.querySelector('.rec-bar');
      const popRect = pop ? pop.getBoundingClientRect() : null;
      return {
        hasPopover: !!pop,
        hasTextarea: !!ta,
        textareaLabel: ta ? ta.getAttribute('aria-label') : '',
        placeholder: ta ? ta.getAttribute('placeholder') : '',
        popoverRect: popRect ? { x: Math.round(popRect.x), y: Math.round(popRect.y), w: Math.round(popRect.width), h: Math.round(popRect.height) } : null,
        // 关键：浮层不能撑开主布局（bar 高度应保持原样）
        barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        overflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth + 1,
        overflowsVertically: document.documentElement.scrollHeight > window.innerHeight + 1,
      };
    })()`);

    // 往备忘录里打字，确认可输入且写入 localStorage
    await overlayWin.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.overlay-memo-popover textarea');
      if (!ta) return false;
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '第一行：打开新建客户表单\\n第二行：填写联系人信息');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await settle(overlayWin, 500);

    summary.checks.memoTyping = await overlayWin.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.overlay-memo-popover textarea');
      return {
        value: ta ? ta.value : '',
        stored: (() => { try { return window.localStorage.getItem('wcs.overlay.memoText') || ''; } catch (e) { return 'ERR:' + e; } })(),
        storedOpen: (() => { try { return window.localStorage.getItem('wcs.overlay.memoOpen') || ''; } catch (e) { return 'ERR:' + e; } })(),
      };
    })()`);

    await capture(overlayWin, '10-overlay-memo', '录制悬浮条（460×132）· 备忘录展开：绝对定位浮层，不撑开主布局，内容只存本机');

    // 折叠后确认回到紧凑布局
    await overlayWin.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.rec-btn')].find((b) => (b.getAttribute('aria-label') || '').includes('收起备忘录'));
      if (btn) btn.click();
      return true;
    })()`);
    await settle(overlayWin, 400);
    summary.checks.memoCollapsed = await overlayWin.webContents.executeJavaScript(`(() => ({
      hasPopover: !!document.querySelector('.overlay-memo-popover'),
      barHeight: document.querySelector('.rec-bar') ? Math.round(document.querySelector('.rec-bar').getBoundingClientRect().height) : 0,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))()`);

    overlayWin.destroy();

    summary.shots = shots;
    summary.consoleErrors = consoleErrors;
    summary.consoleTotal = consoleAll.length;
    summary.ok = consoleErrors.length === 0;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error) + '\n' + (error && error.stack ? error.stack : '');
    console.error('[WPF] FATAL', summary.error);
  } finally {
    try {
      fs.writeFileSync(path.join(OUT, 'verify-wp-f-result.json'), JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error('[WPF] 写入结果失败', error);
    }
    console.log('[WPF] === SUMMARY ===');
    console.log('[WPF] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const shot of shots) console.log(`[WPF] shot ${shot.file} ${shot.bytes} bytes`);
    console.log(`[WPF] console messages=${consoleAll.length} errors=${consoleErrors.length}`);
    for (const err of consoleErrors.slice(0, 20)) console.log('[WPF] console-error: ' + err.message);
    if (summary.error) console.log('[WPF] error: ' + summary.error.split('\n')[0]);
    setTimeout(() => app.exit(summary.ok ? 0 : 1), 250);
  }
});
