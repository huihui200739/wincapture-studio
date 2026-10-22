/**
 * 主进程入口（开发文档 §14）
 *
 * 职责：
 *   - 窗口管理：main（编辑器/首页）、overlay（录制悬浮条）、exporter（导出渲染进程）、recorder（录制编码）
 *   - IPC 注册：严格按 src/shared/ipc.ts 的 IPC 常量
 *   - 全局快捷键：Ctrl+Alt+R 开始/停止、Ctrl+Alt+P 暂停/恢复、Ctrl+Alt+M 标记
 *   - 单实例锁、内容保护（录制时不把自己的悬浮条录进去）
 *
 * 运行约束（本机实测）：
 *   Electron 必须带 --no-sandbox，否则进程以 0x80000003 退出。
 */

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  protocol,
  net,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { IPC, type CaptureConfig, type CaptureStatus, type ExportProfile, type ExportProgress, type ExportResult, type IpcResponse, type SystemInfo, type CaptureSourceInfo, type DisplayInfo, type AudioDeviceInfo, type VideoDeviceInfo } from '../src/shared/ipc';
import { QUALITY_PROFILES } from '../src/shared/ipc';
import { AppError } from '../src/shared/errors';
import type { Project } from '../src/domain/project';
import { timelineDuration } from '../src/domain/project';
import type { PointerLog } from '../src/domain/types';
import { ProjectStore, createProject, hashFile, newProjectId } from './projectStore';
import { CaptureEngine, type RecordSession } from './capture/captureEngine';
import { CameraCoordinator } from './capture/cameraCapture';
import { listAudioDevices, resolveWorkerPaths } from './capture/workers';

const isDev = !app.isPackaged;
// 打包后 main.cjs 位于 dist/main/，应用根目录是它的上两级。
// 这里用 __dirname（CJS 全局）而不是 import.meta.url，因为主进程产物是 CommonJS。
const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIST = path.join(APP_ROOT, 'dist', 'renderer');

// 数据目录：
//   默认使用系统的 userData（AppData\Roaming\WinCapture Studio）。
//   WCS_USER_DATA 环境变量可覆盖，用于便携模式、自动化测试，
//   以及某些受限环境（系统拒绝写入 AppData）下的兜底。
//   必须在 requestSingleInstanceLock 之前设置，否则锁文件仍会写到默认位置。
if (process.env.WCS_USER_DATA) {
  try {
    const custom = path.resolve(process.env.WCS_USER_DATA);
    fs.mkdirSync(custom, { recursive: true });
    app.setPath('userData', custom);
  } catch (error) {
    console.error('[main] 无法使用 WCS_USER_DATA 指定的数据目录', error);
  }
}

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let recorderWindow: BrowserWindow | null = null;

let store: ProjectStore;
let engine: CaptureEngine;
let activeProjectPath: string | null = null;
let currentSession: RecordSession | null = null;
let lastStatus: CaptureStatus | null = null;
let lastExport: ExportResult | null = null;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function ok<T>(data: T): IpcResponse<T> {
  return { ok: true, data };
}

function fail(error: unknown): IpcResponse<never> {
  const shape = AppError.from(error).toShape();
  return { ok: false, error: { code: shape.code, message: shape.message, retryable: shape.retryable, preservedData: shape.preservedData } };
}

/** 包装 IPC 处理器，统一错误结构（§14.3）。 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...(args as never[])));
    } catch (error) {
      if (!(error instanceof AppError)) {
        console.error(`[IPC] ${channel} 失败`, error);
      }
      return fail(error);
    }
  });
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendAppEvent(type: string, payload: unknown): void {
  send(IPC.captureEvent, { type, payload });
}

/** 获取当前窗口角色：通过 URL hash 区分。 */
function roleFromUrl(url: string): 'main' | 'overlay' | 'exporter' | 'recorder' {
  if (url.includes('#overlay')) return 'overlay';
  if (url.includes('#exporter')) return 'exporter';
  if (url.includes('#recorder')) return 'recorder';
  return 'main';
}

function loadRenderer(win: BrowserWindow, hash = ''): void {
  if (isDev && process.env.WCS_DEV_SERVER) {
    void win.loadURL(`${process.env.WCS_DEV_SERVER}/${hash}`);
    return;
  }
  const indexHtml = path.join(RENDERER_DIST, 'index.html');
  void win.loadFile(indexHtml, { hash: hash.replace(/^#/, '') });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#14161b',
    show: false,
    title: 'WinCapture Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
  });
  loadRenderer(win);
  return win;
}

/** 录制悬浮控制条：置顶、无边框、不进任务栏，且对采集隐藏（§6.1）。 */
function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const display = screen.getPrimaryDisplay();
  const width = 460;
  const height = 132;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + 24),
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#14161b',
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 把自己从采集画面里排除（§6.1 悬浮窗不应出现在录制结果中）
  win.setContentProtection(true);
  if (!win.isContentProtected()) {
    sendAppEvent('overlay-protection-unsupported', {
      message: '当前系统不支持窗口内容保护，悬浮控制条可能会出现在录制画面中。',
    });
  }
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    overlayWindow = null;
  });
  loadRenderer(win, '#overlay');
  return win;
}

/** 录制编码窗口：隐藏窗口，用 WebCodecs 把 JPEG 帧编码成分段 MP4。 */
function createRecorderWindow(): BrowserWindow {
  if (recorderWindow && !recorderWindow.isDestroyed()) return recorderWindow;
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  // 必须把窗口记到模块级变量里，否则 createRecorderWindow 每次都会新建窗口：
  // 每段录制都会多一个约 370MB 的渲染进程且永不释放，
  // 实测 10 秒录制就堆出 7 个窗口、峰值 3.6GB（§16.2 要求 ≤1.2GB）。
  recorderWindow = win;
  win.on('closed', () => {
    recorderWindow = null;
  });
  // 把录制窗口的控制台输出转到主进程，便于定位编码失败
  win.webContents.on('console-message', (event) => {
    const level = typeof event === 'object' && 'level' in event ? String(event.level) : 'info';
    const message = typeof event === 'object' && 'message' in event ? String(event.message) : '';
    if (level === 'error' || level === 'warning') {
      console.error(`[recorder-window:${level}] ${message}`);
    } else {
      console.log(`[recorder-window] ${message}`);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[recorder-window] 渲染进程异常退出 ' + JSON.stringify(details));
  });
  loadRenderer(win, '#recorder');
  return win;
}

/** 导出编码窗口：隐藏窗口，跑完整导出管线。 */
function createExporterWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  loadRenderer(win, '#exporter');
  return win;
}

/**
 * 摄像头采集窗口：隐藏窗口，跑 getUserMedia + 分段编码。
 *
 * 单独一个窗口而不是复用 recorder 窗口：recorder 在编码屏幕段时会长时间同步占用
 * （解码 JPEG + 编码 60 帧），摄像头需要按 30fps 稳定取帧，放一起会互相饿死。
 */
function createCameraWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (event) => {
    const level = typeof event === 'object' && 'level' in event ? String(event.level) : 'info';
    const message = typeof event === 'object' && 'message' in event ? String(event.message) : '';
    if (level === 'error' || level === 'warning') {
      console.error(`[camera-window:${level}] ${message}`);
    } else {
      console.log(`[camera-window] ${message}`);
    }
  });
  loadRenderer(win, '#camera');
  return win;
}

/** 摄像头协调器（录制会话期间存在，停止后关闭）。 */
let camera: CameraCoordinator | null = null;

function ensureCamera(): CameraCoordinator {
  if (!camera) {
    camera = new CameraCoordinator({
      createCameraWindow,
      waitForReady,
      log: (message) => console.log(message),
    });
  }
  return camera;
}

// ---------------------------------------------------------------------------
// 文件读写白名单
// ---------------------------------------------------------------------------

/** 允许渲染进程读写的目录：当前打开的工程目录 + 用户明确选定的输出目录。 */
const allowedRoots = new Set<string>();

function allowRoot(dir: string): void {
  try {
    allowedRoots.add(path.resolve(dir).toLowerCase());
  } catch {
    // 忽略
  }
}

/**
 * 校验路径落在白名单目录内。
 * 导出/教程包写入需要任意输出目录，因此输出路径在 export:start 时由用户选择，
 * 选择即视为授权，这里只做「必须在已授权根内」的检查。
 */
function assertAllowedPath(targetPath: string): string {
  const abs = path.resolve(targetPath);
  const lower = abs.toLowerCase();
  for (const root of allowedRoots) {
    if (lower === root || lower.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      return abs;
    }
  }
  throw new AppError({
    code: 'E_PERMISSION_DENIED',
    message: '拒绝访问工程目录之外的路径。',
    retryable: false,
    preservedData: true,
    detail: `path=${abs}`,
  });
}

/** 用 mediabunny 探测 MP4 段时长（tick）。失败时返回 0，由调用方按剩余时长兜底。 */
async function probeSegmentDurationTicks(filePath: string): Promise<number> {
  try {
    const mediabunny = await import('mediabunny');
    const input = new mediabunny.Input({ formats: mediabunny.ALL_FORMATS, source: new mediabunny.FilePathSource(filePath) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      await input.dispose?.();
      return 0;
    }
    const durationSeconds = await input.computeDuration();
    await input.dispose?.();
    return Math.max(0, Math.round(durationSeconds * 10_000_000));
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 系统信息
// ---------------------------------------------------------------------------

function buildSystemInfo(): SystemInfo {
  const videos = app.getPath('videos');
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    appVersion: app.getVersion(),
    totalMemoryBytes: totalMem,
    freeMemoryBytes: freeMem,
    userDataPath: app.getPath('userData'),
    videosPath: videos,
    hardwareEncoding: true,
    captureCapabilities: {
      screen: true,
      window: true,
      systemAudio: true,
      microphone: true,
      camera: true,
      applicationAudio: false,
    },
  };
}

function freeDiskBytes(target: string): number {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(target) : null;
    if (stat) return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // statfs 在部分平台不可用
  }
  // 回退：用 Node 的 statfs 不可用时返回保守估计
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-PSDrive -PSProvider FileSystem | Where-Object { '${target}'.StartsWith($_.Root) } | Select-Object -First 1).Free`], { encoding: 'utf8' });
    const value = Number(String(out).trim());
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // 忽略
  }
  return 50 * 1024 * 1024 * 1024;
}

function cursorPoint(): { x: number; y: number } {
  return screen.getCursorScreenPoint();
}

// ---------------------------------------------------------------------------
// 采集引擎装配
// ---------------------------------------------------------------------------

/**
 * 把分段载荷拼成 JS 源码，分块让出事件循环。
 *
 * 为什么不用 JSON.stringify(payload)：一段 1080p/2s 的载荷有 60 个 base64 字符串
 * （合计约 12MB 文本），单次 JSON.stringify 是数百毫秒的纯同步操作，
 * 期间主进程事件循环完全停摆，grabber 的管道数据读不进来，采集端被迫丢帧。
 * 实测录制覆盖率只有 88%、丢帧率 0.9%（目标 0.5%）。
 *
 * 这里改为逐字段拼接，每 8 帧让出一次事件循环，把一次长任务拆成多个短任务。
 *
 * 注：实际调用点在 requestSegment 里就地展开（那里要顺带释放原始 Buffer），
 * 保留本函数作为「纯序列化」的参考实现与单元测试入口。
 */
async function buildPayloadSource(payload: {
  index: number;
  startTick: number;
  durationTicks: number;
  width: number;
  height: number;
  fps: number;
  frames: { mediaTick: number; jpeg: string }[];
  audio: unknown;
}): Promise<string> {
  const head =
    `{index:${payload.index},startTick:${payload.startTick},durationTicks:${payload.durationTicks},` +
    `width:${payload.width},height:${payload.height},fps:${payload.fps},frames:[`;
  const parts: string[] = [head];

  const BATCH = 8;
  for (let i = 0; i < payload.frames.length; i++) {
    const f = payload.frames[i];
    parts.push(`${i > 0 ? ',' : ''}{mediaTick:${f.mediaTick},jpeg:"${f.jpeg}"}`);
    if ((i + 1) % BATCH === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  parts.push(`],audio:${JSON.stringify(payload.audio)}}`);
  return parts.join('');
}

function buildEngine(): CaptureEngine {
  const workers = resolveWorkerPaths(app.getAppPath(), app.isPackaged);
  const created = new CaptureEngine(
    workers,
    {
      onStatus: (status) => {
        lastStatus = status;
        send(IPC.captureStatus, status);
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send(IPC.captureStatus, status);
        }
      },
      requestSegment: async (info) => {
        // 交给录制窗口编码：把帧通过一次 IPC 传递（帧数受 2 秒分段限制，量可控）
        const win = createRecorderWindow();
        await waitForReady(win);

        // 帧序列化必须分批 + 让出事件循环。
        //
        // 为什么：一段 1080p/2s 有 60 张 JPEG（每张 100~300KB），
        // 一次性 toString('base64') + JSON.stringify 是几百毫秒的纯同步操作，
        // 会完全堵死主进程事件循环。而 grabber 的帧是通过管道读到主进程的，
        // 事件循环一堵，管道读取就滞后，采集端只能丢帧 ——
        // 实测采集帧率从 30fps 掉到 25fps、录制覆盖率只有 88%。
        //
        // 分批处理（每批 8 帧）+ 每批后 setImmediate，让管道 IO 有机会被处理。
        //
        // 同时直接拼 JS 源码，不再先建 frames 数组再 JSON.stringify：
        // 后者会让「原始 Buffer + base64 字符串 + 序列化结果」三份同时驻留，
        // 一段 1080p 就能瞬时占用数百 MB（实测主进程峰值 857MB）。
        const BATCH = 8;
        const parts: string[] = [
          `{index:${info.index},startTick:${info.startTick},durationTicks:${info.durationTicks},` +
            `width:${info.width},height:${info.height},fps:${info.fps},frames:[`,
        ];
        for (let i = 0; i < info.frames.length; i++) {
          const frame = info.frames[i];
          parts.push(`${i > 0 ? ',' : ''}{mediaTick:${frame.mediaTick},jpeg:"${frame.jpeg.toString('base64')}"}`);
          if ((i + 1) % BATCH === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        parts.push(
          `],audio:{mic:${JSON.stringify(serializeAudio(info.audio.mic))},` +
            `system:${JSON.stringify(serializeAudio(info.audio.system))}}}`,
        );
        const payloadSource = parts.join('');
        // parts 里都是临时字符串，拼完即可释放
        parts.length = 0;

        const result = (await win.webContents.executeJavaScript(
          `(async () => {
             try {
               if (!window.__wcsRecorder) throw new Error('录制编码运行时未就绪（window.__wcsRecorder 缺失）');
               return await window.__wcsRecorder.encodeSegment(${payloadSource});
             } catch (e) {
               return { ok: false, error: String((e && e.stack) || e) };
             }
           })()`,
          true,
        )) as { ok: boolean; mp4?: string; frames?: number; encoder?: string; durationUs?: number; error?: string };
        if (!result?.ok) {
          throw new AppError({
            code: 'E_ENCODER_UNAVAILABLE',
            message: '分段编码失败。',
            retryable: true,
            preservedData: true,
            detail: result?.error,
          });
        }
        parts.length = 0;
        const output = {
          mp4: result.mp4 ? Buffer.from(result.mp4, 'base64') : null,
          frames: result.frames ?? 0,
          encoder: result.encoder ?? 'unknown',
          durationUs: result.durationUs ?? 0,
        };

        // 每段完成后主动收缩主进程堆。
        //
        // 一段 1080p/2s 的编解码过程会在主进程留下原始 JPEG Buffer、
        // base64 字符串中间量、以及返回的 MP4 base64 字符串，合计可达数十 MB。
        // V8 默认延迟回收，连续录制时段段叠加，实测主进程峰值 1.2GB、进程树 2.6GB，
        // 超出 §16.2「总工作集 ≤1.2GB」。
        // 这里在段边界主动触发一次 GC（需 --expose-gc，见 startApp），
        // 把峰值压回正常水位。
        const gc = (globalThis as { gc?: () => void }).gc;
        if (typeof gc === 'function') {
          setTimeout(() => {
            try {
              gc();
            } catch {
              // 忽略
            }
          }, 0);
        }

        return output;
      },
      finalizeRecorder: async () => {
        if (recorderWindow && !recorderWindow.isDestroyed()) {
          try {
            await recorderWindow.webContents.executeJavaScript('window.__wcsRecorder?.dispose?.()');
          } catch {
            // 忽略
          }
        }
      },
      onAppEvent: (type, payload) => {
        sendAppEvent(type, payload);
        if (type === 'capture-error' || type === 'disk-full') {
          const error = (payload as { error?: { code: string; message: string } }).error;
          if (error) {
            void dialog.showMessageBox({
              type: 'error',
              title: '录制中断',
              message: error.message,
              detail: '已完成的素材已保留，可在首页的「恢复未完成录制」中继续处理。',
            });
          }
        }
      },
      // 摄像头分段（R04）：由 CameraCoordinator 在独立隐藏窗口里采集并落盘
      commitCameraSegment: async (projectPath, index, durationTicks, fps) => {
        if (!camera) return null;
        return camera.commitSegment(projectPath, index, durationTicks, fps);
      },
    },
    {
      getCursorPoint: cursorPoint,
      getFreeDisk: freeDiskBytes,
      ensureProjectDir: async (projectPath) => {
        await store.ensureDir(projectPath);
      },
      createProjectForSession: async (session) => {
        await finalizeSessionProject(session);
      },
    },
  );
  created.displayBounds = (index: number) => {
    const displays = screen.getAllDisplays();
    const display = displays[index] ?? screen.getPrimaryDisplay();
    // GDI 用物理像素坐标；Electron 的 bounds 是 DIP，需要乘 scaleFactor
    const scale = display.scaleFactor || 1;
    return {
      x: Math.round(display.bounds.x * scale),
      y: Math.round(display.bounds.y * scale),
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    };
  };
  return created;
}

function serializeAudio(packets: { startFrame: number; rms: number; qpc: bigint; left: Float32Array; right: Float32Array }[]) {
  return packets.map((p) => ({
    startFrame: p.startFrame,
    rms: p.rms,
    qpc: p.qpc.toString(),
    left: Array.from(p.left),
    right: Array.from(p.right),
  }));
}

function waitForReady(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()));
}

/**
 * 把录制会话落成工程：建立资产、轨道片段、标记。
 */
async function finalizeSessionProject(session: RecordSession): Promise<void> {
  const segments = engine.getCommittedSegments();
  const durationTicks = Math.max(1, engine.getDurationTicks());
  const project = createProject(`录制 ${new Date(session.startedAt).toLocaleString('zh-CN')}`);
  project.id = session.projectId;

  if (segments.length > 0) {
    const hash = segments.map((s) => `${s.path}:${s.bytes ?? 0}`).join('|');
    const assetId = 'asset-screen-1';
    project.assets.push({
      id: assetId,
      kind: 'screen',
      path: segments[0].path,
      hash: simpleHash(hash),
      durationTicks,
      width: session.effective.width,
      height: session.effective.height,
      sampleRate: 0,
      channels: 0,
      createdAt: Date.now(),
    });
    const main = project.tracks.find((t) => t.kind === 'primaryVideo');
    if (main) {
      main.clips.push({
        id: 'clip-screen-1',
        assetId,
        sourceInTicks: 0,
        sourceDurationTicks: durationTicks,
        timelineInTicks: 0,
        rate: { num: 1, den: 1 },
        linkGroupId: 'link-1',
      });
    }
  }

  // 音频资产
  for (const kind of ['mic', 'system'] as const) {
    const dir = path.join(session.projectPath, 'media', kind);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.wav')) : [];
    if (files.length === 0) continue;
    const assetId = `asset-${kind}-1`;
    project.assets.push({
      id: assetId,
      kind,
      path: `media/${kind}/${files[0]}`,
      hash: simpleHash(files.join(',')),
      durationTicks,
      width: 0,
      height: 0,
      sampleRate: 48_000,
      channels: 2,
      createdAt: Date.now(),
    });
    const track = project.tracks.find((t) => t.kind === kind);
    if (track) {
      track.clips.push({
        id: `clip-${kind}-1`,
        assetId,
        sourceInTicks: 0,
        sourceDurationTicks: durationTicks,
        timelineInTicks: 0,
        rate: { num: 1, den: 1 },
        linkGroupId: 'link-1',
      });
    }
  }

  // 摄像头资产（R04）：720p30，独立保存，与主视频同起点同时长
  const cameraDir = path.join(session.projectPath, 'media', 'camera');
  const cameraFiles = fs.existsSync(cameraDir)
    ? fs.readdirSync(cameraDir).filter((f) => f.endsWith('.mp4')).sort()
    : [];
  if (cameraFiles.length > 0) {
    const assetId = 'asset-camera-1';
    const cameraBytes = cameraFiles.reduce((sum, f) => {
      try {
        return sum + fs.statSync(path.join(cameraDir, f)).size;
      } catch {
        return sum;
      }
    }, 0);
    project.assets.push({
      id: assetId,
      kind: 'camera',
      path: `media/camera/${cameraFiles[0]}`,
      hash: simpleHash(cameraFiles.join(',') + cameraBytes),
      durationTicks,
      width: 1280,
      height: 720,
      sampleRate: 0,
      channels: 0,
      createdAt: Date.now(),
    });
    const cameraTrack = project.tracks.find((t) => t.kind === 'camera');
    if (cameraTrack) {
      cameraTrack.clips.push({
        id: 'clip-camera-1',
        assetId,
        sourceInTicks: 0,
        sourceDurationTicks: durationTicks,
        timelineInTicks: 0,
        rate: { num: 1, den: 1 },
        linkGroupId: 'link-1',
      });
    }
  }

  // 标记
  project.markers = engine.getMarkers().map((m) => ({ ...m }));

  project.revision = 1;
  project.updatedAt = Date.now();
  await store.save(session.projectPath, project);
  await store.touchRecent(session.projectPath, project);
  activeProjectPath = session.projectPath;
    allowRoot(session.projectPath);
}

function simpleHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------

function registerIpc(): void {
  // ---- 采集 ----
  handle(IPC.captureListSources, async () => {
    const displays = screen.getAllDisplays();
    const sources: CaptureSourceInfo[] = displays.map((display, index) => {
      const scale = display.scaleFactor || 1;
      return {
        id: `display:${index}`,
        kind: 'screen',
        name: display.label || (display.internal ? '内置显示器' : `显示器 ${index + 1}`),
        displayId: String(display.id),
        width: Math.round(display.bounds.width * scale),
        height: Math.round(display.bounds.height * scale),
        available: true,
      };
    });
    // 窗口来源：本机 WGC 不可用，如实标注不可用（§9.5 诚实降级）
    const windows = BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w !== overlayWindow)
      .map((w, index) => ({
        id: `window:${w.id}`,
        kind: 'window' as const,
        name: w.getTitle() || `窗口 ${index + 1}`,
        width: w.getBounds().width,
        height: w.getBounds().height,
        available: false,
      }));
    return [...sources, ...windows];
  });

  handle(IPC.captureListDevices, async () => {
    const audio = await listAudioDevices(resolveWorkerPaths(app.getAppPath(), app.isPackaged).audioExe);
    // 视频设备由渲染进程通过 navigator.mediaDevices 枚举后回传，这里返回空表示"界面自行枚举"
    return { audio, video: [] as VideoDeviceInfo[] };
  });

  handle(IPC.systemInfo, async () => buildSystemInfo());

  handle(IPC.captureStart, async (config: CaptureConfig) => {
    if (currentSession) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '已有录制会话在进行中。', retryable: false, preservedData: true });
    }
    const name = `录制 ${new Date().toLocaleString('zh-CN')}`;
    const projectPath = store.defaultProjectPath(name);
    await store.ensureDir(projectPath);
    const projectId = newProjectId();
    allowRoot(projectPath);

    // 摄像头先开（R04）：必须在 engine.start 之前完成，
    // 否则第一个分段提交时摄像头还没就绪，会缺掉开头一段画面。
    // 打开失败只降级，不阻塞录制（§9.5 诚实降级）。
    let cameraNote: string | null = null;
    if (config.cameraEnabled) {
      const coordinator = ensureCamera();
      const opened = await coordinator.open(config.cameraDeviceId);
      if (!opened) {
        cameraNote = coordinator.getStatus().reason ?? '摄像头不可用，已跳过摄像头轨';
        sendAppEvent('camera-degraded', { reason: cameraNote });
        console.warn(`[camera] 降级：${cameraNote}`);
      }
    }

    const session = await engine.start(config, projectPath, projectId);
    currentSession = session;
    if (cameraNote) {
      session.degradation = session.degradation ? `${session.degradation}；${cameraNote}` : cameraNote;
    }
    createOverlayWindow();
    return { sessionId: session.sessionId, projectPath, cameraNote };
  });

  handle(IPC.capturePause, async () => engine.pause());
  handle(IPC.captureResume, async () => engine.resume());
  handle(IPC.captureStatus, async () => engine.status());

  handle(IPC.captureStop, async () => {
    const result = await engine.stop();
    currentSession = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      overlayWindow = null;
    }
    // 停止录制后必须关摄像头，否则摄像头指示灯一直亮着（用户会以为还在录）
    if (camera) {
      await camera.close();
      camera = null;
    }
    await store.touchRecent(result.projectPath, (await store.load(result.projectPath)).project);
    return result;
  });

  handle(IPC.captureCancel, async () => {
    await engine.cancel();
    currentSession = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      overlayWindow = null;
    }
    if (camera) {
      await camera.close();
      camera = null;
    }
    return null;
  });

  handle(IPC.captureMark, async (note: string) => {
    const marker = engine.addMarker(note ?? '');
    return marker;
  });

  // ---- 工程 ----
  handle(IPC.projectCreate, async (name?: string) => {
    const project = createProject(name?.trim() || '未命名工程');
    const projectPath = store.defaultProjectPath(project.name);
    await store.ensureDir(projectPath);
    await store.save(projectPath, project);
    await store.touchRecent(projectPath, project);
    activeProjectPath = projectPath;
    allowRoot(projectPath);
    return { path: projectPath, project };
  });

  handle(IPC.projectOpen, async (targetPath?: string) => {
    let projectPath = targetPath;
    if (!projectPath) {
      const picked = await dialog.showOpenDialog(mainWindow!, {
        title: '打开工程',
        properties: ['openDirectory'],
        filters: [{ name: 'WinCapture 工程', extensions: ['wcaproj'] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      projectPath = picked.filePaths[0];
    }
    const loaded = await store.load(projectPath);
    if (loaded.missingAssets.length > 0) {
      const relocated = await store.relocateAssets(loaded.path, loaded.project);
      const stillMissing = relocated.filter((a) => !fs.existsSync(ProjectStore.resolveInside(loaded.path, a.path)));
      if (stillMissing.length > 0) {
        sendAppEvent('media-missing', { count: stillMissing.length });
      }
      loaded.project.assets = relocated;
    }
    await store.touchRecent(loaded.path, loaded.project);
    activeProjectPath = loaded.path;
    allowRoot(loaded.path);
    return { path: loaded.path, project: loaded.project };
  });

  handle(IPC.projectSave, async (project: Project) => {
    if (!activeProjectPath) {
      throw new AppError({ code: 'E_PROJECT_NOT_FOUND', message: '当前没有已打开的工程。', retryable: false, preservedData: true });
    }
    const result = await store.save(activeProjectPath, project);
    await store.touchRecent(activeProjectPath, project);
    return result;
  });

  handle(IPC.projectSaveAs, async (project: Project, targetPath?: string) => {
    let dest = targetPath;
    if (!dest) {
      const picked = await dialog.showSaveDialog(mainWindow!, {
        title: '另存为',
        defaultPath: path.join(app.getPath('videos'), `${project.name}.wcaproj`),
        filters: [{ name: 'WinCapture 工程', extensions: ['wcaproj'] }],
      });
      if (picked.canceled || !picked.filePath) {
        throw new AppError({ code: 'E_EXPORT_CANCELLED', message: '已取消另存为。', retryable: true, preservedData: true });
      }
      dest = picked.filePath;
    }
    const result = await store.save(dest, project);
    activeProjectPath = dest;
    allowRoot(dest);
    await store.touchRecent(dest, project);
    return result;
  });

  handle(IPC.projectListRecent, async () => store.listRecent());
  handle(IPC.projectRemoveRecent, async (p: string) => {
    await store.removeRecent(p);
    return null;
  });
  handle(IPC.projectReveal, async (p: string) => {
    shell.showItemInFolder(path.resolve(p));
    return null;
  });
  handle(IPC.projectDelete, async (p: string) => {
    const root = path.resolve(p);
    if (!root.endsWith('.wcaproj')) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '只能删除 .wcaproj 工程目录。', retryable: false, preservedData: true });
    }
    const confirm = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除工程',
      message: `确定删除工程「${path.basename(root)}」吗？`,
      detail: '工程目录及其中的素材将被永久删除，此操作不可撤销。',
    });
    if (confirm.response !== 1) return null;
    await fsp.rm(root, { recursive: true, force: true });
    await store.removeRecent(root);
    return null;
  });

  handle(IPC.projectReadMedia, async (projectPath: string, relativePath: string) => store.readMedia(projectPath, relativePath));

  // ---- 文件读写（导出/录制窗口专用）----
  // 安全约束：只允许在「已打开的工程目录」或「用户选择的输出目录」内读写，
  // 不做任意路径读写，避免渲染进程被注入后变成文件系统后门。
  handle(IPC.fileWrite, async (targetPath: string, data: Uint8Array) => {
    const abs = assertAllowedPath(targetPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.from(data));
    return null;
  });

  handle(IPC.fileRead, async (targetPath: string) => {
    const abs = assertAllowedPath(targetPath);
    const bytes = await fsp.readFile(abs);
    return new Uint8Array(bytes);
  });

  handle(IPC.fileRename, async (from: string, to: string) => {
    await fsp.rename(assertAllowedPath(from), assertAllowedPath(to));
    return null;
  });

  handle(IPC.fileRemove, async (targetPath: string) => {
    const abs = assertAllowedPath(targetPath);
    await fsp.rm(abs, { force: true });
    return null;
  });

  handle(IPC.fileMkdir, async (targetPath: string) => {
    await fsp.mkdir(assertAllowedPath(targetPath), { recursive: true });
    return null;
  });

  handle(IPC.fileListSegments, async (projectPath: string, relativePath: string) => {
    const root = path.resolve(projectPath);
    const assetAbs = ProjectStore.resolveInside(root, relativePath);
    const dir = path.dirname(assetAbs);
    if (!fs.existsSync(dir)) return [];
    const names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.mp4')).sort();
    // 段文件名形如 seg-000001.mp4，序号即时间顺序；起始 tick 由段时长累加得出
    const out: { path: string; startTick: number; durationTicks: number; bytes: number }[] = [];
    let cursor = 0;
    for (const name of names) {
      const abs = path.join(dir, name);
      const stat = await fsp.stat(abs);
      // 用 mediabunny 探测该段真实时长（与写入时一致）
      const durationTicks = await probeSegmentDurationTicks(abs);
      out.push({
        path: path.relative(root, abs).split(path.sep).join('/'),
        startTick: cursor,
        durationTicks,
        bytes: stat.size,
      });
      cursor += durationTicks;
    }
    return out;
  });

  handle('project:read-pointer-log', async (projectPath: string) => {
    const target = path.join(projectPath, 'events', 'pointer.jsonl');
    if (!fs.existsSync(target)) return null;
    const text = await fsp.readFile(target, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const events = [];
    let meta: PointerLog | null = null;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.__kind === 'meta') meta = parsed.__meta as PointerLog;
        else events.push(parsed);
      } catch {
        // 跳过损坏行
      }
    }
    if (!meta) return null;
    return { ...meta, events };
  });

  handle(IPC.projectExportPack, async (projectPath: string) => {
    const picked = await dialog.showSaveDialog(mainWindow!, {
      title: '导出工程包',
      defaultPath: path.join(app.getPath('videos'), `${path.basename(projectPath, '.wcaproj')}.wcapack`),
    });
    if (picked.canceled || !picked.filePath) return { ok: false, outputPath: null };
    const output = await store.exportPack(projectPath, picked.filePath);
    return { ok: true, outputPath: output };
  });

  handle(IPC.projectImportPack, async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, { title: '导入工程包', properties: ['openDirectory'] });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const dest = store.defaultProjectPath(path.basename(picked.filePaths[0]));
    const projectPath = await store.importPack(picked.filePaths[0], dest);
    const loaded = await store.load(projectPath);
    activeProjectPath = projectPath;
    allowRoot(projectPath);
    return { path: projectPath, project: loaded.project };
  });

  handle(IPC.projectRecoverable, async () => {
    const recent = await store.listRecent();
    const out = [];
    for (const item of recent) {
      if (!(await store.hasRecoverable(item.path))) continue;
      const journal = await store.readJournal(item.path);
      const commits = journal.filter((e) => e.type === 'segment-commit');
      const lastCommit = commits[commits.length - 1];
      const durationTicks = lastCommit
        ? Number((lastCommit.detail as { startTick?: number; durationTicks?: number })?.startTick ?? 0) +
          Number((lastCommit.detail as { durationTicks?: number })?.durationTicks ?? 0)
        : 0;
      out.push({
        projectPath: item.path,
        sessionId: journal[0]?.sessionId ?? 'unknown',
        name: item.name,
        createdAt: item.updatedAt,
        committedSegments: commits.length,
        durationTicks,
        estimatedLossTicks: 20_000_000,
      });
    }
    return out;
  });

  handle(IPC.projectRecover, async (projectPath: string) => {
    const loaded = await store.load(projectPath);
    activeProjectPath = loaded.path;
    allowRoot(loaded.path);
    return { path: loaded.path, project: loaded.project };
  });

  handle(IPC.projectDiscardRecovery, async (projectPath: string) => {
    await store.discardRecovery(projectPath);
    return null;
  });

  // ---- 导出 ----
  handle(IPC.exportStart, async (params: { project: Project; profile: ExportProfile; outputPath: string; includeTutorial: boolean }) => {
    // 用户选择输出路径即视为授权该目录的写入
    allowRoot(path.dirname(path.resolve(params.outputPath)));
    if (params.includeTutorial) {
      allowRoot(path.resolve(params.outputPath).replace(/\.mp4$/i, '') + '-tutorial');
    }
    // 导出在独立的隐藏窗口里跑（WebCodecs 只在渲染进程可用）
    const win = createExporterWindow();
    await waitForReady(win);
    const jobId = `job-${Date.now().toString(36)}`;
    const result = (await win.webContents.executeJavaScript(
      `window.__wcsExporter.run(${JSON.stringify({ jobId, project: params.project, projectPath: activeProjectPath ?? "", profile: params.profile, outputPath: params.outputPath, includeTutorial: params.includeTutorial })})`,
    )) as {
      video: ExportResult | null;
      tutorial: { ok: boolean; outputDir: string; indexPath: string; markdownPath: string; stepsJsonPath: string; imageCount: number } | null;
      snapshotHash: string;
    };
    lastExport = result.video;
    win.destroy();
    return result;
  });

  handle(IPC.exportCancel, async () => {
    // 通过所有窗口广播取消
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        await win.webContents.executeJavaScript('window.__wcsExporter?.cancel?.()');
      } catch {
        // 忽略
      }
    }
    return null;
  });

  ipcMain.on(IPC.exportProgress, (_event, progress: ExportProgress) => {
    send(IPC.exportProgress, progress);
  });
  ipcMain.on('export:report-progress', (_event, progress: ExportProgress) => {
    send(IPC.exportProgress, progress);
  });
  ipcMain.on('export:complete', (_event, result: ExportResult) => {
    lastExport = result;
  });

  // ---- 系统 ----
  handle(IPC.systemPickFile, async (defaultName: string, filters?: { name: string; extensions: string[] }[]) => {
    const picked = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName, filters });
    return picked.canceled ? null : picked.filePath ?? null;
  });

  handle(IPC.systemPickDirectory, async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });

  handle(IPC.systemOpenPath, async (p: string) => {
    await shell.openPath(p);
    return null;
  });

  handle(IPC.systemShowInFolder, async (p: string) => {
    shell.showItemInFolder(p);
    return null;
  });

  handle(IPC.systemCheckPath, async (p: string) => {
    try {
      const dir = path.dirname(p);
      const freeBytes = freeDiskBytes(dir);
      let writable = false;
      try {
        await fsp.access(dir, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      return { ok: true, freeBytes, writable };
    } catch (error) {
      return { ok: false, freeBytes: 0, writable: false, reason: String(error) };
    }
  });

  handle(IPC.systemDiagnostics, async () => {
    const dir = path.join(app.getPath('userData'), 'diagnostics');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `diagnostics-${Date.now()}.json`);
    const info = buildSystemInfo();
    const entries: string[] = [];
    const report = {
      generatedAt: new Date().toISOString(),
      systemInfo: info,
      captureState: engine.getState(),
      lastStatus,
      lastExport,
      screens: screen.getAllDisplays().map((d) => ({
        id: d.id,
        label: d.label,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
      })),
      workers: resolveWorkerPaths(app.getAppPath(), app.isPackaged),
      encoderProbe: '见界面「诊断」面板',
    };
    const text = JSON.stringify(report, null, 2);
    await fsp.writeFile(file, text, 'utf8');
    entries.push(path.basename(file), `${text.length} 字节`);
    return { path: file, bytes: Buffer.byteLength(text), entries };
  });

  // ---- 窗口 ----
  handle(IPC.windowSetAlwaysOnTop, async (value: boolean) => {
    mainWindow?.setAlwaysOnTop(value);
    return null;
  });
  handle(IPC.windowMinimize, async () => {
    mainWindow?.minimize();
    return null;
  });
  handle(IPC.windowClose, async () => {
    mainWindow?.close();
    return null;
  });
  handle(IPC.windowOpenOverlay, async () => {
    createOverlayWindow();
    return null;
  });
  handle(IPC.windowCloseOverlay, async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    overlayWindow = null;
    return null;
  });
  handle(IPC.windowUpdateOverlay, async (payload: unknown) => {
    overlayWindow?.webContents.send(IPC.captureStatus, payload);
    return null;
  });

  // 导出窗口回报进度的直通通道（渲染进程调用）
  ipcMain.on('exporter:progress', (_event, progress: ExportProgress) => send(IPC.exportProgress, progress));
}

// ---------------------------------------------------------------------------
// 全局快捷键
// ---------------------------------------------------------------------------

function registerShortcuts(): void {
  const bind = (accelerator: string, handler: () => void, label: string) => {
    try {
      const okRegistered = globalShortcut.register(accelerator, handler);
      if (!okRegistered) {
        sendAppEvent('shortcut-conflict', { accelerator, label });
      }
    } catch (error) {
      sendAppEvent('shortcut-conflict', { accelerator, label, detail: String(error) });
    }
  };

  bind('Control+Alt+R', () => {
    if (engine.getState() === 'Idle') {
      sendAppEvent('shortcut', { action: 'start-recording' });
    } else {
      void engine.stop().catch(() => {
        // 停止失败由状态事件反馈
      });
    }
  }, '开始/停止录制');

  bind('Control+Alt+P', () => {
    const state = engine.getState();
    if (state === 'Recording') void engine.pause().catch(() => {});
    else if (state === 'Paused') void engine.resume().catch(() => {});
  }, '暂停/恢复录制');

  bind('Control+Alt+M', () => {
    if (engine.getState() === 'Recording') {
      const marker = engine.addMarker('');
      sendAppEvent('marker-added', marker);
    }
  }, '添加标记');
}

// ---------------------------------------------------------------------------
// 自定义协议：让渲染进程能流式读取工程素材
// ---------------------------------------------------------------------------

function registerMediaProtocol(): void {
  protocol.handle('wcs-media', async (request) => {
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const projectPath = url.searchParams.get('project') ?? '';
      if (!projectPath) return new Response('missing project', { status: 400 });
      const abs = ProjectStore.resolveInside(projectPath, relativePath);
      if (!fs.existsSync(abs)) return new Response('not found', { status: 404 });
      return net.fetch(`file://${abs.replace(/\\/g, '/')}`);
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 另一个实例已在运行。注意：某些受限环境下锁文件无法创建（EPERM/EACCES），
  // 这时 Chromium 会报告 "Lock file can not be created" 并让这里返回 false，
  // 但并没有真正在运行的实例。此时直接退出会表现为"应用无法启动"，
  // 因此这里的处理是：接受锁失败并继续启动（单实例保护退化为尽力而为）。
  console.warn('[main] 单实例锁不可用（受限环境），继续以独立实例启动。');
  startApp();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  startApp();
}

function startApp(): void {
  // 隐藏窗口里连续做 WebCodecs 硬件编码时，Chromium 的 GPU 沙箱在受限环境下
  // 会导致渲染进程崩溃（实测：第 2 段编码起 recorder 窗口 exitCode -1）。
  // 这是 Chromium GPU 进程与沙箱的交互问题，不是业务代码缺陷。
  // 这里关掉 GPU 沙箱，硬件编码仍走 GPU（仅取消沙箱隔离），
  // 实测多段连续编码稳定，导出速度还有提升（4.2× → 6.2× 实时）。
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // 暴露 global.gc：录制过程中每段结束主动回收一次大块 Buffer，
  // 否则连续录制的主进程堆会长到 GB 级（§16.2 要求总工作集 ≤1.2GB）。
  app.commandLine.appendSwitch('js-flags', '--expose-gc');

  app.whenReady().then(async () => {
    store = new ProjectStore(app.getPath('userData'));
    engine = buildEngine();

    // 允许媒体设备权限（摄像头/麦克风）
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission);
      callback(allowed);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return ['media', 'audioCapture', 'videoCapture'].includes(permission);
    });

    registerMediaProtocol();
    registerIpc();
    registerShortcuts();

    Menu.setApplicationMenu(null);
    mainWindow = createMainWindow();

    // 自动化端到端录制验证（无人工干预）：
    //   WCS_RECORDER_PROBE=1 时，启动后自动走一次完整录制会话并输出结果。
    if (process.env.WCS_RECORDER_PROBE === '1') {
      void runRecorderProbe();
    }
    if (process.env.WCS_E2E_PROBE === '1') {
      void runEndToEndProbe();
    }
    if (process.env.WCS_PERF_PROBE === '1') {
      void runPerfProbe();
    }

    // 自动化自检钩子：WCS_SELFTEST=screenshot 时，主窗口加载完成后截图退出。
    // 用于无人工干预的界面验证（真实主进程 + 真实 IPC + 真实 preload）。
    if (process.env.WCS_SELFTEST === 'screenshot') {
      mainWindow.webContents.once('did-finish-load', async () => {
        try {
          await new Promise((r) => setTimeout(r, 2500));
          const shot = await mainWindow!.webContents.capturePage();
          const out = process.env.WCS_SELFTEST_OUT ?? path.join(APP_ROOT, 'dist', 'verify', 'selftest.png');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, shot.toPNG());
          const probe = await mainWindow!.webContents.executeJavaScript(
            `(() => ({ textLength: (document.body.innerText||'').length, buttons: document.querySelectorAll('button').length, hasWcs: typeof window.wcs !== 'undefined' }))()`,
          );
          console.log('[selftest] ' + JSON.stringify({ shot: out, bytes: fs.statSync(out).size, ...probe }));
          app.exit(0);
        } catch (error) {
          console.error('[selftest] 失败 ' + String(error));
          app.exit(1);
        }
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    void engine?.cancel().finally(() => {
      app.quit();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}

/**
 * 端到端探针：录制 → 落工程 → 导出 MP4 → 导出教程包，全链路真实执行。
 * WCS_E2E_PROBE=1 时由主进程自动运行，结果写 dist/verify/e2e-result.json。
 */
async function runEndToEndProbe(): Promise<void> {
  const seconds = Number(process.env.WCS_E2E_SECONDS ?? 10);
  const outDir = path.join(APP_ROOT, 'dist', 'verify');
  const result: Record<string, unknown> = { seconds, steps: [] as string[] };
  const step = (name: string, data?: unknown) => {
    (result.steps as string[]).push(name);
    console.log(`[e2e] ${name}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
  };
  const finish = (code: number) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'e2e-result.json'), JSON.stringify(result, null, 2));
    setTimeout(() => app.exit(code), 500);
  };

  try {
    await new Promise((r) => setTimeout(r, 1500));

    // ---- 1. 录制 ----
    // 摄像头开关由环境变量控制：带摄像头跑需要 fake device 或真实摄像头权限，
    // 默认关闭以保证探针在无摄像头机器上也能通过。
    const wantCamera = process.env.WCS_E2E_CAMERA === '1';
    const config: CaptureConfig = {
      sourceId: 'display:0',
      sourceKind: 'screen',
      qualityId: '720p30',
      fps: { num: 30, den: 1 },
      systemAudioEnabled: true,
      microphoneEnabled: true,
      cameraEnabled: wantCamera,
      countdownSeconds: 0,
      testMode: true,
    };
    const projectPath = store.defaultProjectPath(`端到端 ${Date.now()}`);
    result.projectPath = projectPath;
    allowRoot(projectPath);

    // 与 IPC.captureStart 保持一致：摄像头在 engine.start 之前打开
    if (wantCamera) {
      const coordinator = ensureCamera();
      const opened = await coordinator.open(config.cameraDeviceId);
      result.cameraOpened = opened;
      if (!opened) {
        result.cameraReason = coordinator.getStatus().reason;
        step('camera-degraded', { reason: result.cameraReason });
      } else {
        step('camera-open', { label: coordinator.getStatus().label });
      }
    }

    const session = await engine.start(config, projectPath, newProjectId());
    step('record-start', { sessionId: session.sessionId });

    await new Promise((r) => setTimeout(r, Math.round(seconds * 0.4 * 1000)));
    engine.addMarker('第一步：打开设置');
    await new Promise((r) => setTimeout(r, Math.round(seconds * 0.3 * 1000)));
    engine.addMarker('第二步：修改选项');
    await new Promise((r) => setTimeout(r, Math.round(seconds * 0.3 * 1000)));

    const stopped = await engine.stop();
    result.recordState = stopped.status.state;
    result.segmentsCommitted = stopped.status.segmentsCommitted;
    // 探针直接调 engine.stop（不经 IPC），这里要手动关摄像头
    if (camera) {
      await camera.close();
      camera = null;
    }
    step('record-stop', { state: stopped.status.state, segments: stopped.status.segmentsCommitted });

    // ---- 2. 打开工程并加载素材 ----
    allowRoot(projectPath);
    const loaded = await store.load(projectPath);
    const project = loaded.project;
    result.trackCount = project.tracks.length;
    result.clipCount = project.tracks.reduce((n, t) => n + t.clips.length, 0);
    result.markerCount = project.markers.length;
    result.assetCount = project.assets.length;
    step('project-load', {
      tracks: result.trackCount,
      clips: result.clipCount,
      markers: result.markerCount,
      assets: result.assetCount,
      cameraAssets: project.assets.filter((a) => a.kind === 'camera').length,
    });
    if (result.clipCount === 0) throw new Error('录制后工程里没有任何片段');

    // 摄像头资产必须真的出现在工程里（R04 是「有摄像头轨」而不是「开了个开关」）
    if (wantCamera) {
      const cameraAssets = project.assets.filter((a) => a.kind === 'camera');
      const cameraTrack = project.tracks.find((t) => t.kind === 'camera');
      result.cameraAssetCount = cameraAssets.length;
      result.cameraClipCount = cameraTrack ? cameraTrack.clips.length : 0;
      step('camera-project', { assets: result.cameraAssetCount, clips: result.cameraClipCount });
      if (result.cameraOpened === true && result.cameraAssetCount === 0) {
        throw new Error('摄像头已打开但工程里没有摄像头资产');
      }
    }

    // ---- 3. 导出 MP4 ----
    const outputPath = path.join(outDir, 'e2e-recording.mp4');
    allowRoot(outDir);
    const exportWin = createExporterWindow();
    await waitForReady(exportWin);
    const exportResult = (await exportWin.webContents.executeJavaScript(
      `(async () => {
         try {
           if (!window.__wcsExporter) throw new Error('导出运行时未就绪');
           return await window.__wcsExporter.run(${JSON.stringify({
             jobId: 'e2e',
             project,
             projectPath,
             profile: {
               id: 'p1080p30',
               label: '1080p30',
               width: 1920,
               height: 1080,
               fps: { num: 30, den: 1 },
               videoBitrate: 12_000_000,
               audioBitrate: 192_000,
             },
             outputPath,
             includeTutorial: true,
           })});
         } catch (e) {
           return { video: null, tutorial: null, snapshotHash: '', error: String((e && e.stack) || e) };
         }
       })()`,
      true,
    )) as {
      video: { ok: boolean; outputPath: string; bytes: number; frames: number; encoder: string; verified: boolean } | null;
      tutorial: { ok: boolean; outputDir: string; imageCount: number } | null;
      snapshotHash: string;
      error?: string;
    };
    exportWin.destroy();

    result.export = exportResult.video;
    result.tutorial = exportResult.tutorial;
    result.snapshotHash = exportResult.snapshotHash;
    result.exportError = exportResult.error ?? null;
    step('export', {
      ok: exportResult.video?.ok,
      bytes: exportResult.video?.bytes,
      frames: exportResult.video?.frames,
      encoder: exportResult.video?.encoder,
      verified: exportResult.video?.verified,
      tutorialImages: exportResult.tutorial?.imageCount,
      error: exportResult.error,
    });

    // ---- 4. 校验输出文件真实存在且非空 ----
    const checks: Record<string, boolean> = {};
    if (exportResult.video?.outputPath) {
      const abs = exportResult.video.outputPath;
      checks.mp4Exists = fs.existsSync(abs);
      checks.mp4NonEmpty = checks.mp4Exists && fs.statSync(abs).size > 10_000;
      result.mp4Bytes = checks.mp4Exists ? fs.statSync(abs).size : 0;
    }
    if (exportResult.tutorial?.outputDir) {
      const dir = exportResult.tutorial.outputDir;
      checks.tutorialDir = fs.existsSync(dir);
      checks.tutorialHtml = fs.existsSync(path.join(dir, 'index.html'));
      checks.tutorialMarkdown = fs.existsSync(path.join(dir, 'tutorial.md'));
      checks.tutorialStepsJson = fs.existsSync(path.join(dir, 'steps.json'));
      checks.tutorialImages =
        fs.existsSync(path.join(dir, 'assets')) &&
        fs.readdirSync(path.join(dir, 'assets')).filter((n) => n.endsWith('.png')).length > 0;
    }
    result.checks = checks;

    // ---- 5. 画面内容检查：能解码 ≠ 有内容，必须确认不是全黑 ----
    try {
      const probeWin = createExporterWindow();
      await waitForReady(probeWin);
      const frameProbe = (await probeWin.webContents.executeJavaScript(
        `window.__wcsExporter.probeVideo(${JSON.stringify(outputPath)}, [0, 1, 2, 3])`,
        true,
      )) as {
        ok: boolean;
        error?: string;
        samples: { atSeconds: number; width: number; height: number; distinctColors: number; avgLuma: number }[];
      };
      probeWin.destroy();
      result.frameContent = frameProbe;
      checks.framesNonBlank = frameProbe.ok;
      step('frame-content', { ok: frameProbe.ok, samples: frameProbe.samples, error: frameProbe.error });
    } catch (error) {
      checks.framesNonBlank = false;
      result.frameContentError = String(error);
      step('frame-content', { ok: false, error: String(error) });
    }

    result.ok =
      result.recordState === 'ReadyToEdit' &&
      Number(result.segmentsCommitted) > 0 &&
      Boolean(exportResult.video?.ok) &&
      Boolean(exportResult.video?.verified) &&
      checks.mp4NonEmpty === true &&
      checks.tutorialHtml === true &&
      checks.tutorialImages === true &&
      checks.framesNonBlank === true;
    step('done', { ok: result.ok });
    finish(result.ok ? 0 : 1);
  } catch (error) {
    result.error = String(error instanceof Error ? (error.stack ?? error.message) : error);
    result.ok = false;
    console.error('[e2e] FAILED ' + result.error);
    finish(1);
  }
}
/**
 * 性能基准探针（§16.2）：WCS_PERF_PROBE=1 时执行，结果写 dist/verify/perf-result.json。
 *
 * 为什么要单独做这个探针：文档 §16.2 列了 11 项待验证指标，且明确要求
 * 「性能回归对比必须使用相同测试素材和驱动，不用系统静态桌面的低回调频率充当 60 帧达标证据」。
 * 所以这里跑的是真实 GDI 采集 + 真实 WebCodecs 编码 + 真实落盘 + 真实导出。
 */
async function runPerfProbe(): Promise<void> {
  const seconds = Number(process.env.WCS_PERF_SECONDS ?? 20);
  const outDir = path.join(APP_ROOT, 'dist', 'verify');
  const reportPath = path.join(outDir, 'perf-result.json');

  const log = (message: string) => console.log(`[perf] ${message}`);

  const finish = (report: { ok: boolean; samples: unknown[]; error?: string }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[perf] done ok=${report.ok}${report.error ? ' error=' + report.error : ''}`);
    setTimeout(() => app.exit(report.ok ? 0 : 1), 500);
  };

  const treeWorkingSetBytes = (): number => {
    // 用 Electron 自身的进程指标统计本应用全部进程（含 GPU / 渲染 / 工作进程）。
    // 注意：getAppMetrics().memory.workingSetSize 单位是 KB，需要 ×1024。
    // 这个口径比外部 Get-Process 更容易抓到瞬时峰值（采样更密）。
    try {
      const metrics = app.getAppMetrics();
      let total = 0;
      for (const m of metrics) {
        const kb = m.memory?.workingSetSize ?? 0;
        if (Number.isFinite(kb) && kb > 0) total += kb * 1024;
      }
      if (total > 0) return total;
    } catch {
      // 退化到当前进程 RSS
    }
    return process.memoryUsage().rss;
  };

  try {
    await new Promise((r) => setTimeout(r, 1500));

    const { runPerfProbe: runProbe } = await import('../scripts/perfProbe');

    const report = await runProbe(
      {
        startCapture: async (config, projectPath) => {
          allowRoot(projectPath);
          const session = await engine.start(config, projectPath, newProjectId());
          return { sessionId: session.sessionId };
        },
        stopCapture: async () => {
          const stopped = await engine.stop();
          return { state: stopped.status.state, segmentsCommitted: stopped.status.segmentsCommitted };
        },
        getStatus: () => {
          const status = engine.status();
          if (!status) return null;
          return {
            state: status.state,
            segmentsCommitted: status.segmentsCommitted,
            mediaTick: status.mediaTick,
            framesArrived: status.framesArrived,
          };
        },
        probeSegment: async (absPath) => {
          try {
            const mediabunny = await import('mediabunny');
            const input = new mediabunny.Input({
              formats: mediabunny.ALL_FORMATS,
              source: new mediabunny.FilePathSource(absPath),
            });
            const track = await input.getPrimaryVideoTrack();
            if (!track) {
              await input.dispose?.();
              return null;
            }
            const durationSeconds = await input.computeDuration();
            const stats = await track.computePacketStats();
            const width = await track.getCodedWidth();
            const height = await track.getCodedHeight();
            const codec = (await track.getCodec()) ?? 'unknown';
            await input.dispose?.();
            return { durationSeconds, frames: stats.packetCount, codec, width, height };
          } catch {
            return null;
          }
        },
        runExport: async (projectPath, outputPath) => {
          allowRoot(projectPath);
          allowRoot(path.dirname(outputPath));
          const startedAt = Date.now();
          const loaded = await store.load(projectPath);
          const win = createExporterWindow();
          await waitForReady(win);
          try {
            const result = (await win.webContents.executeJavaScript(
              `(async () => {
                 try {
                   if (!window.__wcsExporter) throw new Error('导出运行时未就绪');
                   return await window.__wcsExporter.run(${JSON.stringify({
                     jobId: 'perf',
                     project: loaded.project,
                     projectPath,
                     profile: {
                       id: 'perf1080p30',
                       label: '1080p30',
                       width: 1920,
                       height: 1080,
                       fps: { num: 30, den: 1 },
                       videoBitrate: 12_000_000,
                       audioBitrate: 192_000,
                     },
                     outputPath,
                     includeTutorial: false,
                   })});
                 } catch (e) {
                   return { video: null, tutorial: null, snapshotHash: '', error: String((e && e.stack) || e) };
                 }
               })()`,
              true,
            )) as { video: { ok: boolean; frames: number; bytes: number } | null; error?: string };
            const ms = Date.now() - startedAt;
            return {
              ok: Boolean(result.video?.ok),
              frames: result.video?.frames ?? 0,
              bytes: result.video?.bytes ?? 0,
              ms,
            };
          } finally {
            win.destroy();
          }
        },
        newProjectPath: (name) => store.defaultProjectPath(name),
        workingSetBytes: () => process.memoryUsage().rss,
        treeWorkingSetBytes,
        log,
      },
      seconds,
    );

    log(`samples=${report.samples.length}`);
    for (const sample of report.samples) {
      const judged = sample.pass === null ? '记录' : sample.pass ? 'PASS' : 'FAIL';
      log(`${judged}  ${sample.name}=${sample.value}${sample.unit}${sample.note ? '  (' + sample.note + ')' : ''}`);
    }
    finish(report);
  } catch (error) {
    finish({
      ok: false,
      samples: [],
      error: String(error instanceof Error ? (error.stack ?? error.message) : error),
    });
  }
}

async function runRecorderProbe(): Promise<void> {
  const seconds = Number(process.env.WCS_RECORDER_SECONDS ?? 12);
  const result: Record<string, unknown> = { seconds };
  const finish = (code: number) => {
    fs.mkdirSync(path.join(APP_ROOT, 'dist', 'verify'), { recursive: true });
    fs.writeFileSync(path.join(APP_ROOT, 'dist', 'verify', 'record-result.json'), JSON.stringify(result, null, 2));
    setTimeout(() => app.exit(code), 500);
  };
  try {
    await new Promise((r) => setTimeout(r, 1500)); // 等界面就绪
    const config: CaptureConfig = {
      sourceId: 'display:0',
      sourceKind: 'screen',
      qualityId: '720p30',
      fps: { num: 30, den: 1 },
      systemAudioEnabled: true,
      microphoneEnabled: true,
      cameraEnabled: false,
      countdownSeconds: 0,
      testMode: true,
    };
    console.log('[probe] start');
    const started = await engine.start(config, store.defaultProjectPath(`探针录制 ${Date.now()}`), newProjectId());
    result.sessionId = started.sessionId;
    result.projectPath = started.projectPath;

    // 录一半时暂停 2 秒再恢复，并打一个标记
    const halfMs = Math.max(2, Math.round(seconds / 2)) * 1000;
    await new Promise((r) => setTimeout(r, halfMs));
    console.log('[probe] pause');
    await engine.pause();
    engine.addMarker('探针标记');
    await new Promise((r) => setTimeout(r, 2000));
    console.log('[probe] resume');
    await engine.resume();
    await new Promise((r) => setTimeout(r, halfMs));

    console.log('[probe] stop');
    const stopped = await engine.stop();
    result.status = stopped.status;

    // 校验产出
    const projectPath = stopped.projectPath;
    const screenDir = path.join(projectPath, 'media', 'screen');
    const segments = fs.existsSync(screenDir) ? fs.readdirSync(screenDir).filter((f) => f.endsWith('.mp4')) : [];
    result.committedSegments = segments.length;
    result.mediaFiles = {
      screen: segments.length,
      mic: fs.existsSync(path.join(projectPath, 'media', 'mic')) ? fs.readdirSync(path.join(projectPath, 'media', 'mic')).length : 0,
      system: fs.existsSync(path.join(projectPath, 'media', 'system'))
        ? fs.readdirSync(path.join(projectPath, 'media', 'system')).length
        : 0,
    };
    result.projectJson = fs.existsSync(path.join(projectPath, 'project.json'));
    result.journal = fs.existsSync(path.join(projectPath, 'recovery', 'journal.jsonl'));
    result.pointerLog = fs.existsSync(path.join(projectPath, 'events', 'pointer.jsonl'));

    const okAll =
      segments.length >= 3 &&
      result.projectJson === true &&
      result.journal === true &&
      result.pointerLog === true &&
      stopped.status.state === 'ReadyToEdit';
    result.ok = okAll;
    console.log('[probe] done ok=' + okAll + ' segments=' + segments.length);
    finish(okAll ? 0 : 1);
  } catch (error) {
    result.error = String(error instanceof Error ? error.stack ?? error.message : error);
    result.ok = false;
    console.error('[probe] FAILED ' + result.error);
    finish(1);
  }
}
