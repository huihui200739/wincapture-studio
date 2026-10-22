#!/usr/bin/env node
/**
 * 界面验证脚本（WP-D 交付物）
 *
 * 作用：
 *   1. 用 Electron 加载构建产物 dist/renderer/index.html（与主进程同样的加载方式）；
 *   2. 逐个视图截图到 docs/screenshots/；
 *   3. 通过 win.webContents.on('console-message') 捕获 console 报错与页面未捕获异常；
 *   4. 输出 JSON 结果（截图路径 + 字节数 + 控制台错误）。
 *
 * 运行：
 *   node_modules\electron\dist\electron.exe --no-sandbox scripts/verify-ui.cjs
 *   或  npm run verify:ui
 *
 * 说明：
 *   - 只验证渲染层，不依赖主进程 preload。未注入 window.wcs 时界面自动进入
 *     「示例数据模式」，预览用 syntheticMedia 的合成画面，走的仍是真实
 *     evaluateScene + drawScene 路径。
 *   - 必须 --no-sandbox 启动；若环境里设置了 ELECTRON_RUN_AS_NODE，需先清除。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'renderer', 'index.html');
const OUT = path.join(ROOT, 'docs', 'screenshots');

app.setPath('userData', path.join(ROOT, '.verify-ui-data'));
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

/** 等待视图内容真正画出来（元素数量 + 两帧稳定）。 */
async function settle(win, ms = 700) {
  await wait(ms);
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
  ).catch(() => {});
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
  console.log(`[UI] captured ${name}.png (${size} bytes)`);
  return size;
}

/** 通过 hash 路由切换视图，并做一次可见性校验。 */
async function goView(win, view, probeSelector) {
  await win.webContents.executeJavaScript(`location.hash = '#/${view}'; true`);
  await settle(win, 620);
  const probe = await win.webContents
    .executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(probeSelector)});
        if (!el) return { ok: false, reason: 'missing selector' };
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          ok: r.width > 20 && r.height > 20 && style.visibility !== 'hidden' && style.display !== 'none',
          width: Math.round(r.width),
          height: Math.round(r.height),
          text: (el.textContent || '').trim().slice(0, 80),
        };
      })()`,
    )
    .catch((error) => ({ ok: false, reason: String(error) }));
  if (!probe.ok) throw new Error(`视图 ${view} 未渲染：${JSON.stringify(probe)}`);
  return probe;
}

/** 视图内的交互冒烟：点几个关键控件，确认状态真的变化。 */
async function interactions(win) {
  const results = {};

  // 编辑器：播放/暂停 + 分割 + 撤销
  await win.webContents.executeJavaScript(`location.hash = '#/editor'; true`);
  await settle(win, 800);
  results.editorBaseline = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('canvas.stage-canvas');
    return {
      hasCanvas: !!canvas,
      canvasW: canvas ? canvas.width : 0,
      canvasH: canvas ? canvas.height : 0,
      clipCount: document.querySelectorAll('.tl-clip').length,
      rows: document.querySelectorAll('.timeline-row').length,
      text: document.querySelector('.transport-time') ? document.querySelector('.transport-time').textContent.trim() : '',
    };
  })()`);

  // 点播放，等 600ms，检查时间码是否推进
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.stage-toolbar button')].find((b) => (b.getAttribute('aria-label') || '').includes('播放'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await wait(700);
  const afterPlay = await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('.transport-time');
    const btn = [...document.querySelectorAll('.stage-toolbar button')].find((b) => (b.getAttribute('aria-label') || '').includes('暂停'));
    if (btn) btn.click();
    return t ? t.textContent.trim() : '';
  })()`);
  results.afterPlay = afterPlay;

  // 高级轨道展开
  results.advancedTracks = await win.webContents.executeJavaScript(`(() => {
    const before = document.querySelectorAll('.timeline-row').length;
    const btn = document.querySelector('.advanced-tracks-toggle');
    if (btn) btn.click();
    return { before };
  })()`);
  await settle(win, 400);
  results.advancedTracksAfter = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.timeline-row').length`,
  );

  // 点击一个遮挡效果（在遮挡轨道上）
  results.effectClicks = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.tl-effect.is-privacy')];
    if (!items.length) return { count: 0 };
    items[0].click();
    return { count: items.length };
  })()`);
  await settle(win, 350);

  // 属性面板切到遮挡页签，检查是否显示确认状态文案
  results.privacyPanel = await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.inspector-tab')];
    const tab = tabs.find((t) => t.textContent.includes('遮挡'));
    if (tab) tab.click();
    return tabs.map((t) => t.textContent.trim());
  })()`);
  await settle(win, 350);
  results.privacyPanelText = await win.webContents.executeJavaScript(
    `(document.querySelector('.inspector-body') || {}).textContent ? document.querySelector('.inspector-body').textContent.replace(/\\s+/g, ' ').slice(0, 240) : ''`,
  );

  return results;
}

/** 输入框聚焦时快捷键不应抢走文字输入（§6.3）。 */
async function shortcutGuard(win) {
  return win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#step-title, .wcs-input');
    if (!input) return { ok: false, reason: 'no input found' };
    input.focus();
    const before = input.value;
    // 派发一个空格 + Delete 键，模拟在输入框里打字
    for (const key of [' ', 'Delete']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    return {
      ok: document.activeElement === input,
      focusedTag: document.activeElement ? document.activeElement.tagName : '',
      valueUnchanged: input.value === before,
      before,
    };
  })()`);
}

app.whenReady().then(async () => {
  const summary = { ok: true, shots: [], consoleErrors: [], checks: {}, notes: [] };
  try {
    if (!fs.existsSync(ENTRY)) throw new Error(`缺少构建产物：${path.relative(ROOT, ENTRY)}（先运行 npx vite build）`);
    fs.mkdirSync(OUT, { recursive: true });

    const win = new BrowserWindow({
      width: 1560,
      height: 980,
      show: true,
      backgroundColor: '#0e1218',
      title: 'WinCapture Studio · 界面验证',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        offscreen: false,
      },
    });

    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      // Electron 45 起第一个参数是事件对象
      const levelValue = typeof event === 'object' && event ? event.level : level;
      const text = typeof event === 'object' && event ? event.message : message;
      const src = typeof event === 'object' && event ? event.sourceId : sourceId;
      const entry = { level: levelValue, message: String(text), source: src ? path.basename(String(src)) : '' };
      consoleAll.push(entry);
      // level: 0=verbose 1=info 2=warning 3=error
      if (levelValue === 'error' || levelValue === 3) consoleErrors.push(entry);
    });

    win.webContents.on('render-process-gone', (_event, details) => {
      consoleErrors.push({ level: 'error', message: `render-process-gone: ${JSON.stringify(details)}` });
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      consoleErrors.push({ level: 'error', message: `preload-error: ${preloadPath} ${error}` });
    });

    await win.loadFile(ENTRY);
    const rendered = await waitForRender(win);
    if (!rendered) throw new Error('界面在 20 秒内未完成首次渲染');

    // ---- 首页 ----
    await goView(win, 'home', '.home-hero');
    await settle(win, 900);
    await capture(win, '01-home', '首页：最近工程 / 新建录制 / 恢复未完成录制 / 教程入口');

    // ---- 录制设置 ----
    await goView(win, 'record', '.record-layout');
    await settle(win, 1100);
    summary.checks.record = await win.webContents.executeJavaScript(`(() => ({
      sources: document.querySelectorAll('.source-card').length,
      meters: document.querySelectorAll('.wcs-meter').length,
      qualityCards: document.querySelectorAll('.quality-card').length,
      capabilityRows: document.querySelectorAll('.capability-table tbody tr').length,
      cameraPreview: !!document.querySelector('.camera-preview canvas'),
      diskRows: document.querySelectorAll('.disk-row').length,
      hasSourceResolution: [...document.querySelectorAll('.source-res')].map((e) => e.textContent.trim()).slice(0, 3),
    }))()`);
    await capture(win, '02-record', '录制设置：来源缩略图与真实分辨率 / 电平表 / 摄像头 / 质量档位 / 磁盘');

    // ---- 编辑器 ----
    await goView(win, 'editor', '.editor');
    await settle(win, 1200);
    summary.checks.editor = await interactions(win);
    await settle(win, 500);
    await capture(win, '03-editor', '编辑器：预览 canvas + 时间线 + 属性面板');

    // ---- 编辑器 · 画布属性 ----
    await win.webContents.executeJavaScript(`(() => {
      const tabs = [...document.querySelectorAll('.inspector-tab')];
      const tab = tabs.find((t) => t.textContent.includes('画布'));
      if (tab) tab.click();
      return true;
    })()`);
    await settle(win, 500);
    summary.checks.canvasTab = await win.webContents.executeJavaScript(`(() => ({
      variantCards: document.querySelectorAll('.variant-card').length,
      swatches: document.querySelectorAll('.swatch').length,
      sliders: document.querySelectorAll('.wcs-slider').length,
    }))()`);
    await capture(win, '04-editor-canvas', '编辑器 · 画布属性：画幅 16:9/1:1/9:16、背景、圆角、阴影、摄像头布局');

    // ---- 导出 ----
    await goView(win, 'export', '.export-layout');
    await settle(win, 800);
    summary.checks.export = await win.webContents.executeJavaScript(`(() => ({
      kindCards: document.querySelectorAll('.kind-card').length,
      variantCards: document.querySelectorAll('.variant-card').length,
      summaryRows: document.querySelectorAll('.kv-row').length,
      outputPath: (document.querySelector('#export-path') || {}).value || '',
    }))()`);
    await capture(win, '05-export', '导出面板：产物类型 / 输出路径 / 画幅 / 预计体积 / 进度与结果区');

    // ---- 教程 ----
    await goView(win, 'tutorial', '.tutorial-layout');
    await settle(win, 900);
    summary.checks.tutorial = await win.webContents.executeJavaScript(`(() => ({
      stepCards: document.querySelectorAll('.step-card').length,
      previewCanvas: !!document.querySelector('.step-editor-preview canvas'),
      previewPixels: (() => {
        const c = document.querySelector('.step-editor-preview canvas');
        if (!c) return 0;
        try {
          const ctx = c.getContext('2d');
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 24) n++;
          return n;
        } catch (e) { return -1; }
      })(),
    }))()`);
    await capture(win, '06-tutorial', '教程页：步骤列表 / 标题说明编辑 / 截图预览 / 合并拆分');

    // ---- 设置 ----
    await goView(win, 'settings', '.settings-grid');
    await settle(win, 700);
    await capture(win, '07-settings', '设置页：系统信息 / 采集能力 / 快捷键 / 诊断');

    // ---- 快捷键守卫：输入框内不抢文字 ----
    await goView(win, 'tutorial', '.tutorial-layout');
    await settle(win, 600);
    summary.checks.shortcutGuard = await shortcutGuard(win);

    // ---- 录制悬浮控制条（独立窗口角色：main.tsx 按 hash 判定 overlay） ----
    const overlayWin = new BrowserWindow({
      width: 760,
      height: 200,
      show: true,
      backgroundColor: '#0e1218',
      title: 'WinCapture Studio · 录制控制条',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    overlayWin.webContents.on('console-message', (event, level, message) => {
      const levelValue = typeof event === 'object' && event ? event.level : level;
      const text = typeof event === 'object' && event ? event.message : message;
      consoleAll.push({ level: levelValue, message: String(text), source: 'overlay' });
      if (levelValue === 'error' || levelValue === 3) consoleErrors.push({ level: 'error', message: String(text) });
    });
    await overlayWin.loadFile(ENTRY, { hash: '/overlay' });
    await waitForRender(overlayWin).catch(() => false);
    await wait(700);
    const overlayImage = await overlayWin.webContents.capturePage();
    const overlayPng = overlayImage.toPNG();
    const overlayFile = path.join(OUT, '08-overlay-bar.png');
    fs.writeFileSync(overlayFile, overlayPng);
    shots.push({
      name: '08-overlay-bar',
      label: '录制悬浮控制条：状态文字 + 图标 + 计时 + 暂停 / 标记 / 停止',
      file: path.relative(ROOT, overlayFile),
      bytes: fs.statSync(overlayFile).size,
    });
    console.log(`[UI] captured 08-overlay-bar.png (${fs.statSync(overlayFile).size} bytes)`);
    summary.checks.overlayBar = await overlayWin.webContents.executeJavaScript(`(() => ({
      bar: !!document.querySelector('.rec-bar'),
      stateText: (document.querySelector('.rec-state-text') || {}).textContent || '',
      buttons: [...document.querySelectorAll('.rec-btn')].map((b) => b.textContent.trim()),
      time: (document.querySelector('.rec-time') || {}).textContent || '',
    }))()`);
    overlayWin.destroy();

    // ---- 校验截图非空白（回到编辑器取预览像素） ----
    await goView(win, 'editor', '.editor');
    await settle(win, 900);
    const nonBlank = await win.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('canvas.stage-canvas');
      if (!canvas) return { ok: false, reason: 'no canvas' };
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 401) {
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return { ok: seen.size > 12, distinctColors: seen.size, width: canvas.width, height: canvas.height };
    })()`).catch((error) => ({ ok: false, reason: String(error) }));
    summary.checks.previewPixels = nonBlank;

    if (!nonBlank.ok) throw new Error(`编辑器预览疑似空白：${JSON.stringify(nonBlank)}`);

    summary.shots = shots;
    summary.consoleErrors = consoleErrors;
    summary.consoleTotal = consoleAll.length;
    summary.ok = consoleErrors.length === 0;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error) + '\n' + (error && error.stack ? error.stack : '');
    console.error('[UI] FATAL', summary.error);
  } finally {
    try {
      fs.writeFileSync(path.join(OUT, 'verify-ui-result.json'), JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error('[UI] 写入结果失败', error);
    }
    console.log('[UI] === SUMMARY ===');
    console.log('[UI] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const shot of shots) console.log(`[UI] shot ${shot.file} ${shot.bytes} bytes`);
    console.log(`[UI] console messages=${consoleAll.length} errors=${consoleErrors.length}`);
    for (const err of consoleErrors.slice(0, 20)) console.log('[UI] console-error: ' + err.message);
    if (summary.error) console.log('[UI] error: ' + summary.error.split('\n')[0]);
    setTimeout(() => app.exit(summary.ok ? 0 : 1), 250);
  }
});
