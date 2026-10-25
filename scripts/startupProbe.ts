import { app, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 正式入口验收：冷启动、空闲不卡顿、重复启动、默认摄像头和正常退出。 */
export async function runStartupProbe(win: BrowserWindow, root: string, scans: { sources: number; audio: number }, cameraStatus: () => unknown) {
  const report: Record<string, unknown> = {};
  const output = path.join(root, 'dist', 'verify', 'startup-camera-result.json');
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); console.log('[startup] ' + message); };
  const until = async (code: string, limit = 30_000) => {
    const start = Date.now();
    while (Date.now() - start < limit) { if (await js(code)) return; await wait(50); }
    throw new Error(`等待超时：${code}`);
  };
  try {
    await until(`!!document.querySelector('.capture-capsule') && document.querySelector('.capture-source-trigger')?.title !== '选择录制来源'`);
    report.readyMs = Math.round(process.uptime() * 1000); console.log('[startup] 胶囊可用 ' + report.readyMs + 'ms');
    await wait(1000);
    report.startupScans = { ...scans };
    check(scans.sources === 0 && scans.audio === 0, '启动不抓窗口缩略图、不启动音频设备扫描');
    report.eventLoop = await js(`new Promise(resolve => { let previous=performance.now(), worst=0, count=0; const timer=setInterval(()=>{
      const now=performance.now(); worst=Math.max(worst, now-previous-20); previous=now;
      if(++count===50){clearInterval(timer);resolve({samples:count,maxDelayMs:Math.round(worst)});}
    },20); })`);
    const originalWindow = win.id;
    const duplicateStarted = Date.now();
    report.duplicateExit = await new Promise<number | null>((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.WCS_STARTUP_PROBE;
      const child = spawn(process.execPath, ['--no-sandbox', root], { env, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('重复启动未退出')); }, 7000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    report.duplicateMs = Date.now() - duplicateStarted;
    check(report.duplicateExit === 0 && win.id === originalWindow, '重复启动唤醒当前窗口并退出，不建立第二个采集实例');
    await js(`document.querySelector('.capture-source-trigger').click()`);
    await until(`document.querySelectorAll('.source-choice').length>0 && !document.querySelector('.source-popover .popover-heading button').disabled`);
    const beforeChoice = scans.sources;
    await js(`document.querySelector('.source-choice').click()`); await wait(500);
    check(scans.sources === beforeChoice, '选中来源不会重复抓取窗口缩略图');
    await js(`document.querySelector('.capture-source-trigger').click()`);
    report.recordings = [];
    for (let round = 0; round < 2; round++) {
      const start = Date.now();
      // 故意不传 cameraDeviceId，覆盖胶囊默认设备误选 Smart Connect 的原问题。
      const started = await js<{ ok: boolean; data?: { projectPath: string; cameraNote?: string } }>(`window.wcs.startCapture({
        sourceId:'display:0',sourceKind:'screen',qualityId:'720p30',fps:{num:30,den:1},backend:'auto',
        scaling:'performance',systemAudioEnabled:true,microphoneEnabled:true,cameraEnabled:true,countdownSeconds:0,testMode:false
      })`);
      check(started.ok && !started.data?.cameraNote, `第 ${round + 1} 次默认摄像头正常打开`);
      const startMs = Date.now() - start;
      report.camera = cameraStatus();
      await wait(4000);
      const stop = await js<{ ok: boolean; data?: { projectPath: string; status: { state: string } } }>(`window.wcs.stopCapture()`);
      check(stop.ok && stop.data?.status.state === 'ReadyToEdit', `第 ${round + 1} 次录制正常停止`);
      const cameras = await fs.readdir(path.join(stop.data!.projectPath, 'media', 'camera'));
      check(cameras.some(file => file.endsWith('.mp4')), `第 ${round + 1} 次摄像头画面实际落盘`);
      (report.recordings as unknown[]).push({ startMs, path: stop.data!.projectPath, cameraSegments: cameras.filter(file => file.endsWith('.mp4')).length });
    }
    report.ok = true;
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log('[startup] 正常关闭主窗口，验证后台退出');
    win.close();
  } catch (error) {
    report.ok = false; report.error = String(error instanceof Error ? error.stack : error);
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.error('[startup]', report.error); win.close(); process.exitCode = 1;
  }
}
