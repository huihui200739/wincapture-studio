import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectHandle } from '../src/shared/api';

/** 真实主进程 / preload / React / 采集 / WAV / MP4 回归。独立 userData 运行。
 *  overlayRef：录制中必须返回悬浮条窗口——回归「悬浮条被误销毁导致无处点停止」。
 *  reviewRef：停止后必须返回完成卡片窗口——回归「停止后无完成卡片/不弹编辑器」。 */
export async function runStudioProbe(win: BrowserWindow, root: string, overlayClosed: () => boolean, overlayRef: () => BrowserWindow | null, reviewRef: () => BrowserWindow | null, authorize: (root: string) => void): Promise<void> {
  const out = path.join(root, 'dist', 'verify', 'studio');
  const report: Record<string, unknown> = {};
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const until = async (expression: string, timeout = 25_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await js<boolean>(expression)) return; await wait(150); }
    throw new Error(`超时：${expression}`);
  };
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)})?.click()`); await wait(300); };
  const shot = async (name: string) => { await wait(400); await fs.writeFile(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); console.log('[studio] ' + label); };
  const watchdog = setTimeout(() => { console.error('[studio] timeout'); app.exit(1); }, 180_000);
  try {
    await fs.mkdir(out, { recursive: true });
    await until(`!!document.querySelector('.capture-capsule') && !document.querySelector('.capsule-record').disabled`);
    report.launcher = win.getBounds(); check(win.getBounds().height === 96, '启动胶囊高度正确');
    await shot('01-launcher');
    await click('.capsule-more'); await until(`!!document.querySelector('.preparation-popover')`); await shot('02-preparation');
    await js(`(() => { for (const [label,value] of [['分辨率与帧率','720p30'],['开始倒计时','0']]) {
      const el=document.querySelector('select[aria-label="'+label+'"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value); el.dispatchEvent(new Event('change',{bubbles:true}));
    } if(document.querySelector('[aria-label="摄像头开启"]'))document.querySelector('[aria-label="摄像头开启"]').click(); })()`);
    await click('.capture-source-trigger'); await until(`document.querySelectorAll('.source-modes button').length===4`); await shot('03-sources');
    await js(`document.querySelectorAll('.source-modes button')[1].click()`); await wait(400);
    await click('.launcher-next'); await until(`!!document.querySelector('.capture-selection.is-region')`); await shot('04-region');
    check(win.getBounds().width > 900, '区域选择使用桌面确认层');
    const before = await js<{ x: number; y: number; width: number; height: number }>(`document.querySelector('.source-outline').getBoundingClientRect().toJSON()`);
    const start = { x: Math.round(before.x + before.width / 2), y: Math.round(before.y + before.height / 2) };
    win.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: start.x + 40, y: start.y + 25, movementX: 40, movementY: 25 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: start.x + 40, y: start.y + 25, button: 'left', clickCount: 1 });
    await wait(300);
    const moved = await js<{ x: number; y: number; width: number }>(`document.querySelector('.source-outline').getBoundingClientRect().toJSON()`);
    check(Math.abs(moved.width - before.width) < 3 && moved.x > before.x + 25, '区域框支持拖动移动');
    await click('.selection-actions button:not(.selection-start)');
    await click('.capture-source-trigger'); await js(`document.querySelectorAll('.source-modes button')[3].click()`); await wait(500);
    await click('.launcher-next'); await until(`!!document.querySelector('.selection-start')`); await shot('05-confirm');
    await click('.selection-start');
    await until(`window.wcs.captureStatus().then(r=>r.data?.state==='Recording')`, 35_000);
    await wait(4500);
    // 悬浮条回归（本轮修复的缺陷：悬浮条创建后未保存窗口引用，刚就绪就被销毁，
    // 用户录制中找不到「停止」按钮）。旧探针只查「停止后已关闭」，悬浮条从未存在时恒真。
    const overlayStopReady = async (): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const overlay = overlayRef();
        if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
          try {
            const ready = await overlay.webContents.executeJavaScript(`(() => {
              const btn = [...document.querySelectorAll('.rec-bar button')].find((b) => b.getAttribute('aria-label') === '停止录制');
              return !!btn && !btn.disabled;
            })()`, true);
            if (ready) return true;
          } catch { /* 窗口可能在重建，重试 */ }
        }
        await wait(200);
      }
      return false;
    };
    check(await overlayStopReady(), '录制中悬浮控制条可见且停止按钮可用');
    const stopped = await js<{ data?: { projectPath: string; status: { state: string } }; ok: boolean }>(`window.wcs.stopCapture()`);
    check(stopped.ok && stopped.data?.status.state === 'ReadyToEdit', '从胶囊完成真实录制');
    const projectPath = stopped.data!.projectPath; report.projectPath = projectPath;
    // 完成卡片回归（本轮交互改动）：停止后右下角弹卡片，主窗口不自动进编辑器，
    // 点卡片「进入编辑」才打开剪辑台。旧探针断言「停止后直接显示编辑器」已不成立。
    const reviewReady = async (): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const card = reviewRef();
        if (card && !card.isDestroyed() && card.isVisible()) return true;
        await wait(200);
      }
      return false;
    };
    check(await reviewReady(), '停止后右下角弹出录制完成卡片');
    check(await js(`!document.querySelector('.studio-shell.is-editing')`), '停止后不自动跳转编辑器');
    // 缩略图必须真的解码出首帧（readMedia 的 wcs-media:// 流式 URL + <video> 首帧）
    const thumbReady = async (): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < 8_000) {
        const card = reviewRef();
        if (!card || card.isDestroyed()) return false;
        try {
          const state = await card.webContents.executeJavaScript(`(() => {
            const v = document.querySelector('.review-thumb video');
            return v ? v.readyState : -1;
          })()`, true);
          if (typeof state === 'number' && state >= 2) return true;
        } catch { /* 窗口创建中，重试 */ }
        await wait(200);
      }
      return false;
    };
    check(await thumbReady(), '完成卡片缩略图已解码出视频首帧');
    const review = reviewRef()!;
    try {
      await fs.writeFile(path.join(out, '06-review-card.png'), (await review.webContents.capturePage()).toPNG());
    } catch { /* 卡片截图失败不阻塞验收 */ }
    const editClicked = await review.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '进入编辑');
      if (!btn) return false;
      btn.click();
      return true;
    })()`, true);
    check(editClicked === true, '完成卡片上存在可点击的「进入编辑」按钮');
    await until(`!!document.querySelector('.studio-shell.is-editing')`); await wait(1200);
    check(win.isVisible() && win.getBounds().width >= 1000 && overlayClosed(), '进入编辑后显示编辑器并关闭悬浮条');
    check(!reviewRef(), '进入编辑后完成卡片已关闭');
    await shot('06-editor');
    const handle = await js<{ data: ProjectHandle }>(`window.wcs.openProject(${JSON.stringify(projectPath)})`);
    const audio = [];
    for (const asset of handle.data.project.assets.filter(a => a.kind === 'mic' || a.kind === 'system')) {
      const segments = await js<{ data: unknown[] }>(`window.wcs.listMediaSegments(${JSON.stringify(projectPath)},${JSON.stringify(asset.path)})`);
      check(segments.data?.length > 0, `${asset.kind} WAV 分段可读`); audio.push({ kind: asset.kind, segments: segments.data.length });
    }
    check(audio.length === 2, '两条音轨均进入正式工程'); report.audio = audio;
    if (process.env.WCS_STUDIO_DEVICE === '1') {
      await click('.studio-text-action'); await until(`!!document.querySelector('.capture-capsule') && !document.querySelector('.capsule-record').disabled`);
      await click('.capture-source-trigger'); await js(`document.querySelectorAll('.source-modes button')[2].click()`); await wait(700);
      await shot('07-devices');
      check(await js(`document.querySelectorAll('.source-choice').length > 0`), '真实视频设备可选');
      await click('.launcher-next'); await until(`!!document.querySelector('.capture-selection.is-device')`);
      await shot('08-device-confirm'); await click('.selection-start');
      await until(`window.wcs.captureStatus().then(r=>r.data?.state==='Recording')`, 35_000); await wait(2500);
      const deviceStop = await js<{ ok: boolean; data?: { projectPath: string; status: { state: string } } }>(`window.wcs.stopCapture()`);
      check(deviceStop.ok && deviceStop.data?.status.state === 'ReadyToEdit', '设备模式完成真实摄像头直录');
      report.deviceProject = deviceStop.data?.projectPath; await until(`!!document.querySelector('.studio-shell.is-editing')`);
    }
    const oldPath = process.env.WCS_STUDIO_PROJECT;
    let exportHandle = handle.data;
    if (oldPath) { authorize(oldPath); exportHandle = (await js<{ data: ProjectHandle }>(`window.wcs.openProject(${JSON.stringify(oldPath)})`)).data; }
    const outputPath = path.join(out, oldPath ? 'audio-restored.mp4' : 'studio-export.mp4'); authorize(out);
    const result = await js<{ data?: { video?: { ok: boolean; warnings?: string[]; frames: number; bytes: number } }; ok: boolean }>(`window.wcs.startExport(${JSON.stringify({
      project: exportHandle.project, profile: { variantId: exportHandle.project.settings.activeVariantId, width: oldPath ? 1920 : 1280, height: oldPath ? 1080 : 720, fps: { num: 30, den: 1 }, videoBitrate: 12_000_000, audioBitrate: 192_000, audioOnly: false, includeTutorial: false },
      outputPath, includeTutorial: false,
    })})`);
    report.exportResponse = result;
    check(result.ok && result.data?.video?.ok, '正式工程 MP4 导出成功');
    check(!(result.data?.video?.warnings ?? []).some(w => /audio|音频|音轨|asset-mic|asset-system/i.test(w)), '导出没有音轨误判缺失警告');
    report.export = result.data?.video; report.exportedProject = exportHandle.path;
    const mb = await import('mediabunny'); const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.FilePathSource(outputPath) });
    try { check(await input.getPrimaryAudioTrack(), '导出 MP4 包含真实 AAC 音轨'); report.hasAudioTrack = true; }
    finally { input.dispose(); }
    report.ok = true;
  } catch (e) { report.ok = false; report.error = String(e instanceof Error ? e.stack : e); console.error('[studio]', report.error); }
  finally { clearTimeout(watchdog); await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1); }
}
