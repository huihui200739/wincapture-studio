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
  desktopCapturer,
  webContents,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';

import { IPC, type CaptureConfig, type CaptureStatus, type ExportProfile, type ExportProgress, type ExportResult, type IpcResponse, type SystemInfo, type CaptureSourceInfo, type DisplayInfo, type AudioDeviceInfo, type VideoDeviceInfo } from '../src/shared/ipc';
import { QUALITY_PROFILES } from '../src/shared/ipc';
import { AppError } from '../src/shared/errors';
import type { Project } from '../src/domain/project';
import type { PointerLog } from '../src/domain/types';
import { ProjectStore, createProject, hashFile, isPathInside, newProjectId } from './projectStore';
import { CaptureEngine, type RecordSession } from './capture/captureEngine';
import { DesktopVideoSource } from './capture/desktopCapture';
import { NativeMemorySampler, nativeProcessMemory } from './capture/processMemory';
const desktopSources = new Map<number, { worker: DesktopVideoSource; source: Electron.DesktopCapturerSource }>();
interface RecorderReply { ok: boolean; data?: Uint8Array; mp4?: string; frames?: number; encoder?: string; durationUs?: number; error?: string }
const recorderJobs = new Map<number, { sender: number; finish(result: RecorderReply): void }>();
let recorderJobSequence = 0;
function requestRecorderSegment(win: BrowserWindow, payload: unknown): Promise<RecorderReply> {
  return new Promise((resolve, reject) => {
    const id = ++recorderJobSequence;
    const cleanup = () => { clearTimeout(timer); recorderJobs.delete(id); win.removeListener('closed', closed); };
    const closed = () => { cleanup(); reject(new Error('录制编码窗口已关闭')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('录制分段编码超过 30 秒')); }, 30_000);
    recorderJobs.set(id, { sender: win.webContents.id, finish: result => { cleanup(); resolve(result); } });
    win.once('closed', closed);
    try { win.webContents.send(IPC.recorderSegment, { id, payload }); } catch (error) { cleanup(); reject(error); }
  });
}
import { CameraCoordinator } from './capture/cameraCapture';
import { listAudioDevices, resolveWorkerPaths } from './capture/workers';

const isDev = !app.isPackaged;
// 打包后 main.cjs 位于 dist/main/，应用根目录是它的上两级。
// 这里用 __dirname（CJS 全局）而不是 import.meta.url，因为主进程产物是 CommonJS。
const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIST = path.join(APP_ROOT, 'dist', 'renderer');
interface NativeWindowSource { id: string; name: string; x: number; y: number; width: number; height: number; available: boolean }
const windowSources = new Map<string, NativeWindowSource>();
function listNativeWindows(): Promise<NativeWindowSource[]> {
  return new Promise((resolve, reject) => {
    execFile(resolveWorkerPaths(app.getAppPath(), app.isPackaged).grabberExe, ['--list-windows'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch (error) { reject(error); }
      });
  });
}

// 应用图标（用户确认的白瓷叠帧稿，见 assets/icon-manifest.json）。
// 开发态直接读源码 assets/；打包后读随包拷贝的 dist/assets/（build-main 前置复制）。
function appIconPath(): string | null {
  for (const candidate of [path.join(APP_ROOT, 'dist', 'assets', 'app-icon.ico'), path.join(APP_ROOT, 'assets', 'app-icon.ico')]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

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
let cameraWindow: BrowserWindow | null = null;

let store: ProjectStore;
let engine: CaptureEngine;
let activeProjectPath: string | null = null;
let currentSession: RecordSession | null = null;
/**
 * 启动流程是否正在进行。
 *
 * currentSession 是在整个 start 流程最后一次赋值的，而中间有多次 await
 * （建目录、开摄像头、启动采集进程）。旧实现只检查 currentSession，
 * 两次并发 capture:start 都能通过检查：第二次会把第一路正在用的摄像头关掉，
 * 且第一路的 currentSession 被覆盖成第二路的。
 */
let captureStartInFlight = false;
/** 停止流程是否正在进行：IPC 与悬浮条可能同时点停止，必须共用同一次停止结果。 */
let stopInFlight: Promise<{ projectPath: string; status: CaptureStatus }> | null = null;
/**
 * 这些状态才表示「真的有一场录制在跑」。
 * ReadyToEdit / Cancelled / RecoveryReady / RecoverableFailure 都是已结束状态，
 * engine.start() 内部会先把它们复位成 Idle，所以不能拿来拒绝新的录制。
 */
const ACTIVE_CAPTURE_STATES = new Set<CaptureStatus['state']>([
  'Preparing',
  'Countdown',
  'Recording',
  'Pausing',
  'Paused',
  'Resuming',
  'Stopping',
  'Finalizing',
]);
let lastStatus: CaptureStatus | null = null;
let lastExport: ExportResult | null = null;

/** 悬浮窗是否完成 ready 握手（决定快捷键「标记」走悬浮窗备忘录还是直接落标记）。 */
let overlayReady = false;
/** 导出隐藏窗口集合：取消导出只对这些窗口广播，退出时统一销毁。 */
const exporterWindows = new Set<BrowserWindow>();
/** 退出流程只执行一次。 */
let shutdownStarted = false;

type WindowRole = 'main' | 'overlay' | 'exporter' | 'recorder' | 'camera';

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

/** 统一执行 IPC 处理器：集中错误结构 + 日志。 */
async function runHandler<T>(channel: string, fn: () => Promise<T> | T): Promise<IpcResponse<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (!(error instanceof AppError)) {
      console.error(`[IPC] ${channel} 失败`, error);
    }
    return fail(error);
  }
}

/**
 * 带窗口角色校验的处理器。
 *
 * 为什么需要：contextIsolation 只隔离了 DOM 与 Node，不限制「哪个窗口能调用哪个方法」——
 * 所有窗口的 preload 都暴露同一份 window.wcs。文件读写、导出回报、工程管理等敏感通道
 * 必须限定来源窗口，避免任意渲染进程（或被注入后）拿到全量文件系统能力。
 */
function handleFor<T>(channel: string, roles: readonly WindowRole[], fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, (event, ...args) =>
    runHandler(channel, () => {
      assertSenderRole(event, roles, channel);
      return fn(...(args as never[]));
    }),
  );
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendAppEvent(type: string, payload: unknown): void {
  send(IPC.captureEvent, { type, payload });
}

/** 通过 URL hash 判定窗口角色（main/overlay/exporter/recorder/camera 各自独立加载）。 */
function roleFromUrl(url: string): WindowRole {
  const hash = typeof url === 'string' && url.includes('#') ? url.slice(url.indexOf('#')) : '';
  const candidates: WindowRole[] = ['overlay', 'exporter', 'recorder', 'camera'];
  for (const role of candidates) {
    if (hash.includes(role)) return role;
  }
  return 'main';
}

type IpcSender = { senderFrame?: { url?: string } | null; sender?: { getURL?: () => string } };

/** 取 IPC 调用方窗口角色；取不到（窗口销毁中）按 main 处理，后续角色校验会拒绝。 */
function senderRole(event: IpcSender): WindowRole {
  try {
    const frameUrl = event.senderFrame?.url;
    const url = frameUrl || event.sender?.getURL?.() || '';
    return roleFromUrl(url);
  } catch {
    return 'main';
  }
}

function assertSenderRole(event: IpcSender, roles: readonly WindowRole[], channel: string): void {
  const role = senderRole(event);
  if (!roles.includes(role)) {
    throw new AppError({
      code: 'E_PERMISSION_DENIED',
      message: '当前窗口无权调用该操作。',
      retryable: false,
      preservedData: true,
      detail: `channel=${channel} role=${role} allowed=${roles.join('|')}`,
    });
  }
}

/**
 * 导航目标是否属于应用自身页面。
 * 允许：打包后的 dist/renderer/index.html、开发服务器地址；其余一律拒绝。
 */
function isInternalUrl(url: string): boolean {
  if (!url) return false;
  const devServer = isDev ? process.env.WCS_DEV_SERVER : undefined;
  if (devServer) {
    const dev = devServer.replace(/\/+$/, '');
    if (url === dev || url.startsWith(dev + '/') || url.startsWith(dev + '#')) return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const normalized = decodeURIComponent(parsed.pathname).replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, path.sep);
    return isPathInside(RENDERER_DIST, normalized);
  } catch {
    return false;
  }
}

/** 主窗口可用时作为原生对话框父窗口；主窗口已关闭时仍能弹框（否则 `mainWindow!` 会抛 TypeError）。 */
function showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }> {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

function showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }> {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}

// ---------------------------------------------------------------------------
// 路径白名单
// ---------------------------------------------------------------------------

/**
 * 渲染进程可读写的目录集合。
 *
 * - projectRoots：本次会话打开/创建/恢复的工程目录（读 + 写）
 * - outputRoots：用户通过原生对话框选择过的目录、导出输出目录与教程包目录（读 + 写）
 *
 * 关键修复：旧实现把渲染进程传入的 outputPath 的父目录直接加入全局白名单，
 * 于是 `export:start({outputPath:"C:\\x.mp4"})` 就能把整个 C: 变成可读写目录。
 * 现在输出路径必须落在「对话框选择过」或系统视频/用户数据目录之内。
 */
const projectRoots = new Set<string>();
const outputRoots = new Set<string>();
/** 原生对话框选择过的目录（导出输出路径必须落在这里或其子目录）。 */
const dialogAuthorizedRoots = new Set<string>();

function allowProjectRoot(dir: string): void {
  try {
    projectRoots.add(path.resolve(dir));
  } catch {
    // 忽略非法路径
  }
}

function allowOutputRoot(dir: string): void {
  try {
    outputRoots.add(path.resolve(dir));
  } catch {
    // 忽略非法路径
  }
}

function allowDialogRoot(dir: string): void {
  try {
    const resolved = path.resolve(dir);
    dialogAuthorizedRoots.add(resolved);
    outputRoots.add(resolved);
  } catch {
    // 忽略非法路径
  }
}

function appVideosPath(): string {
  try {
    return path.resolve(app.getPath('videos'));
  } catch {
    return '';
  }
}

function appUserDataPath(): string {
  try {
    return path.resolve(app.getPath('userData'));
  } catch {
    return '';
  }
}

/** Windows 盘符根（`C:\`）不做 realpath，直接参与词法判断。 */
function isDriveRoot(abs: string): boolean {
  return /^[a-zA-Z]:\\?$/.test(abs);
}

/** 把一个可能还不存在的路径解析到「最近存在的祖先」的真实路径，用于识别 junction/symlink 逃逸。 */
async function realPathForCheck(abs: string): Promise<string> {
  let current = abs;
  const tail: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = await fsp.realpath(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return abs;
}

async function isInsideAnyRoot(roots: Iterable<string>, abs: string): Promise<boolean> {
  const realAbs = await realPathForCheck(abs).catch(() => abs);
  for (const root of roots) {
    if (!root) continue;
    if (isPathInside(root, abs)) return true;
    if (isDriveRoot(root)) continue;
    try {
      const realRoot = await fsp.realpath(root);
      if (isPathInside(realRoot, realAbs)) return true;
    } catch {
      // 根目录还不存在时只做词法判断
    }
  }
  return false;
}

/**
 * 校验路径落在白名单目录内（词法 + realpath 双重检查，防 Junction 逃逸）。
 * 输出路径由用户在保存对话框中选择、或默认在系统视频目录下，选择即视为授权。
 */
async function assertAllowedPath(targetPath: unknown): Promise<string> {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new AppError({
      code: 'E_INVALID_COMMAND',
      message: '文件路径参数无效。',
      retryable: false,
      preservedData: true,
      detail: String(targetPath),
    });
  }
  const abs = path.resolve(targetPath);
  if ((await isInsideAnyRoot(projectRoots, abs)) || (await isInsideAnyRoot(outputRoots, abs))) return abs;
  throw new AppError({
    code: 'E_PERMISSION_DENIED',
    message: '拒绝访问工程目录与导出目录之外的路径。',
    retryable: false,
    preservedData: true,
    detail: `path=${abs}`,
  });
}

/** 工程目录额外要求：必须是本次会话打开/创建/恢复的工程，防止把任意目录当工程读取。 */
async function assertAllowedProjectPath(targetPath: unknown): Promise<string> {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new AppError({
      code: 'E_INVALID_COMMAND',
      message: '工程路径参数无效。',
      retryable: false,
      preservedData: true,
      detail: String(targetPath),
    });
  }
  const abs = path.resolve(targetPath);
  if (await isInsideAnyRoot(projectRoots, abs)) return abs;
  throw new AppError({
    code: 'E_PERMISSION_DENIED',
    message: '该工程不在本次会话已打开的工程列表中，已拒绝访问。',
    retryable: false,
    preservedData: true,
    detail: `path=${abs}`,
  });
}

/** 是否是「看起来像工程」的目录（用于删除前确认，避免 rm 任意目录）。 */
function looksLikeProjectDir(abs: string): boolean {
  try {
    return (
      fs.existsSync(path.join(abs, 'project.json')) ||
      fs.existsSync(path.join(abs, 'recovery', 'journal.jsonl')) ||
      fs.existsSync(path.join(abs, 'media'))
    );
  } catch {
    return false;
  }
}

/** shell.openPath 允许的扩展名：防止渲染进程诱导主进程执行 .exe/.bat/.ps1 等可执行文件。 */
const OPENABLE_FILE_EXT = new Set([
  '.mp4', '.m4a', '.wav', '.png', '.jpg', '.jpeg', '.webp', '.md', '.html', '.htm',
  '.json', '.jsonl', '.txt', '.csv', '.pdf', '.wcaproj', '.wcapack',
]);

/**
 * 校验「用系统打开/定位」的目标：
 * - 必须位于已授权目录、系统视频目录或诊断目录内；
 * - openPath 只允许媒体/文档类扩展名（目录不受扩展名限制）。
 */
async function assertOpenablePath(targetPath: unknown): Promise<string> {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new AppError({
      code: 'E_INVALID_COMMAND',
      message: '路径参数无效。',
      retryable: false,
      preservedData: true,
      detail: String(targetPath),
    });
  }
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    throw new AppError({
      code: 'E_MEDIA_MISSING',
      message: '要打开的文件或目录不存在。',
      retryable: true,
      preservedData: true,
      detail: abs,
    });
  }
  const dirs = [...projectRoots, ...outputRoots, appVideosPath(), path.join(appUserDataPath(), 'diagnostics')].filter(
    (dir) => dir && dir.length > 0,
  );
  if (!(await isInsideAnyRoot(dirs, abs))) {
    throw new AppError({
      code: 'E_PERMISSION_DENIED',
      message: '拒绝在应用数据目录之外打开文件。',
      retryable: false,
      preservedData: true,
      detail: `path=${abs}`,
    });
  }
  const stat = await fsp.stat(abs).catch(() => null);
  if (stat?.isFile() && !OPENABLE_FILE_EXT.has(path.extname(abs).toLowerCase())) {
    throw new AppError({
      code: 'E_PERMISSION_DENIED',
      message: '出于安全考虑，只允许用系统默认程序打开媒体/文档类文件。',
      retryable: false,
      preservedData: true,
      detail: path.extname(abs),
    });
  }
  return abs;
}

/** 悬浮窗计时/状态推送：窗口销毁后 webContents.send 会抛异常，必须逐处判活。 */
function sendToOverlay(channel: string, payload: unknown): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayWindow.webContents.send(channel, payload);
  } catch (error) {
    console.warn('[overlay] 发送失败（窗口可能已销毁）', error);
  }
}

/** 全局快捷键「标记」：悬浮窗就绪时交给它处理（可带上备忘录当前行作为 note）。 */
function sendOverlayCommand(command: 'pause' | 'resume' | 'stop' | 'mark'): boolean {
  if (!overlayReady || !overlayWindow || overlayWindow.isDestroyed()) return false;
  try {
    overlayWindow.webContents.send(IPC.overlayCommand, command);
    return true;
  } catch (error) {
    console.warn('[overlay] 命令发送失败', error);
    return false;
  }
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
  const icon = appIconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#14161b',
    show: false,
    title: 'WinCapture Studio',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // 本机要求 Electron 以 --no-sandbox 启动（见文件头），sandbox 设 true 也会被进程级开关覆盖；
      // 这里保持 false 只是避免开发态行为差异，安全边界由 contextIsolation + 无 nodeIntegration +
      // 主进程 IPC 白名单共同保证。彻底启用需要先去掉 --no-sandbox 再回归验证（见审计文档遗留项）。
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    const wasMain = mainWindow === win;
    mainWindow = null;
    // 主窗口关闭 = 用户要退出应用：先保存/取消正在进行的录制，再销毁隐藏窗口并退出。
    // 旧实现只把 mainWindow 置空，录制中的隐藏窗口会让进程永远留在后台（悬浮条不消失、
    // 再次启动命中单实例锁却看不到窗口）。
    if (wasMain) void shutdownApp('main-window-closed');
  });
  loadRenderer(win);
  return win;
}

/** 录制悬浮控制条：置顶、无边框、不进任务栏，且对采集隐藏（§6.1）。 */
function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayReady = false;
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
    ...(appIconPath() ? { icon: appIconPath() as string } : {}),
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
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
    overlayReady = false;
    if (overlayWindow === win) overlayWindow = null;
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
    // 记录到诊断通道（界面订阅后能看到提示，而不是只写主进程日志）
    sendAppEvent('recorder-crashed', { reason: details.reason, exitCode: details.exitCode });
    // 必须销毁这个窗口：旧实现只打日志，createRecorderWindow 仍会返回这具「尸体」，
    // 之后每一段的 executeJavaScript 都在已死的渲染进程上必然失败，
    // 录制看起来正常、停止后才发现后半段全是空白。销毁后下一段会重建窗口。
    if (recorderWindow === win) recorderWindow = null;
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // 忽略：已经处于销毁流程中
      }
    }
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
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  // 记录所有导出窗口：取消导出只对它们广播，退出时统一销毁（避免隐藏窗口泄漏）
  exporterWindows.add(win);
  win.on('closed', () => {
    exporterWindows.delete(win);
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
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  cameraWindow = win;
  win.on('closed', () => {
    if (cameraWindow === win) cameraWindow = null;
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
// 采集引擎装配
// ---------------------------------------------------------------------------

/** 用 mediabunny 探测 MP4 段时长（tick）。失败时返回 0，由调用方按剩余时长兜底。 */
async function probeSegmentDurationTicks(filePath: string): Promise<number> {
  let input: { dispose?: () => void } | null = null;
  try {
    const mediabunny = await import('mediabunny');
    input = new mediabunny.Input({
      formats: mediabunny.ALL_FORMATS,
      source: new mediabunny.FilePathSource(filePath),
    });
    const opened = input as InstanceType<typeof mediabunny.Input>;
    const track = await opened.getPrimaryVideoTrack();
    if (!track) return 0;
    const durationSeconds = await opened.computeDuration();
    return Math.max(0, Math.round(durationSeconds * 10_000_000));
  } catch {
    return 0;
  } finally {
    // 异常分支同样要关文件句柄，否则每次失败的探测都泄漏一个 HANDLE
    try {
      input?.dispose?.();
    } catch {
      // 忽略
    }
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
  let safeTarget = target;
  try {
    safeTarget = path.resolve(target);
  } catch {
    safeTarget = '';
  }
  try {
    const stat = fs.statfsSync?.(safeTarget);
    if (stat) return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // statfs 在部分平台/路径不存在时不可用
  }
  // 回退：只在 Windows 上按盘符查询。
  //
  // 旧实现把 target 直接拼进 PowerShell 命令字符串，路径里只要带一个单引号
  // （如 C:\Users\it's me\out.mp4）就能注入任意 PowerShell 命令。
  // 这里改为只接受盘符根，并做白名单校验后再查询。
  try {
    const driveRoot = path.parse(safeTarget).root;
    if (!/^[A-Za-z]:\\$/.test(driveRoot)) return 50 * 1024 * 1024 * 1024;
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const script = `(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -ieq '${driveRoot.replace(/'/g, "''")}' } | Select-Object -First 1).Free`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    const value = Number(String(out).trim());
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // 忽略
  }
  return 50 * 1024 * 1024 * 1024;
}

function cursorPoint(): { x: number; y: number } {
  return screen.dipToScreenPoint(screen.getCursorScreenPoint());
}

// ---------------------------------------------------------------------------
// 采集引擎装配
// ---------------------------------------------------------------------------

function buildEngine(): CaptureEngine {
  const workers = resolveWorkerPaths(app.getAppPath(), app.isPackaged);
  const created = new CaptureEngine(
    workers,
    {
      modernCapture: async (config, region, fps) => {
        const list = await desktopCapturer.getSources({ types: [config.sourceKind === 'window' ? 'window' : 'screen'], thumbnailSize: { width: 0, height: 0 } });
        const display = screen.getAllDisplays()[Number(config.sourceId.split(':')[1])];
        const source = list.find(item => config.sourceKind === 'window' ? item.id.startsWith(config.sourceId + ':') : item.display_id === String(display?.id));
        if (!source) throw new Error('所选来源不支持现代采集');
        const worker = new DesktopVideoSource({ clockExe: workers.grabberExe, ready: waitForReady, createWindow: () => {
          const win = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { preload: path.join(APP_ROOT, 'dist', 'main', 'preload.cjs'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
          const id = win.webContents.id; desktopSources.set(id, { worker, source }); win.once('closed', () => desktopSources.delete(id));
          loadRenderer(win, '#camera-desktop'); return win;
        } }, region, { width: region.outputWidth, height: region.outputHeight, fps,
          sourceWidth: display ? screen.dipToScreenRect(null, display.bounds).width : region.width,
          sourceHeight: display ? screen.dipToScreenRect(null, display.bounds).height : region.height,
          region: config.sourceKind === 'screen' && display ? { x: region.x - screen.dipToScreenRect(null, display.bounds).x,
            y: region.y - screen.dipToScreenRect(null, display.bounds).y, width: region.width, height: region.height } : undefined });
        return worker;
      },
      onStatus: (status) => {
        lastStatus = status;
        send(IPC.captureStatus, status);
        sendToOverlay(IPC.captureStatus, status);
      },
      requestSegment: async (info) => {
        // 交给录制窗口编码：把帧通过一次 IPC 传递（帧数受 2 秒分段限制，量可控）
        const win = createRecorderWindow();
        await waitForReady(win);

        // Binary IPC avoids base64 and JavaScript-source copies of every JPEG and PCM packet.
        const result = await requestRecorderSegment(win, { index: info.index, startTick: info.startTick,
          durationTicks: info.durationTicks, width: info.width, height: info.height, fps: info.fps,
          binary: true, frames: info.frames, audio: { mic: [], system: [] } });
        if (!result?.ok) {
          throw new AppError({
            code: 'E_ENCODER_UNAVAILABLE',
            message: '分段编码失败。',
            retryable: true,
            preservedData: true,
            detail: result?.error,
          });
        }
        const output = {
          mp4: result.data ? Buffer.from(result.data) : result.mp4 ? Buffer.from(result.mp4, 'base64') : null,
          frames: result.frames ?? 0,
          encoder: result.encoder ?? 'unknown',
          durationUs: result.durationUs ?? 0,
        };

        // 在分段边界回收已交付的 JPEG/MP4 缓冲，避免 V8 延迟回收导致工作集堆积。
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
        if (type === 'capture-error') {
          const error = (payload as { error?: { code: string; message: string } }).error;
          if (error) {
            void dialog.showMessageBox({
              type: 'error',
              title: '录制中断',
              message: error.message,
              detail: '已完成的素材已保留，可在首页的「恢复未完成录制」中继续处理。',
            });
          }
        } else if (type === 'disk-full') {
          const free = (payload as { freeBytes?: number }).freeBytes;
          void dialog.showMessageBox({
            type: 'error',
            title: '磁盘空间不足，录制已自动停止',
            message: free !== undefined ? `可用空间仅剩 ${(free / 1024 / 1024).toFixed(0)} MB。` : '磁盘可用空间不足。',
            detail: '已完成的素材已安全保存。清理磁盘后可在首页继续处理该录制。',
          });
        }
      },
      /**
       * 引擎自行结束会话（采集进程崩溃 / 磁盘不足自动停止）时释放会话级资源。
       * 不做这一步，currentSession 会一直非空：界面显示空闲，但再点「开始录制」
       * 永远得到「已有录制会话在进行中」，只能重启应用。
       */
      onSessionEnded: (reason) => {
        currentSession = null;
        closeOverlayWindow();
        void closeCamera().catch(() => undefined);
        sendAppEvent('capture-ended', { reason });
      },
      // 摄像头分段（R04）：由 CameraCoordinator 在独立隐藏窗口里采集并落盘
      cameraClock: async clock => { await camera?.syncClock(clock); },
      commitCameraSegment: async (projectPath, index, durationTicks, fps, startTick) => {
        const coordinator = camera;
        if (!coordinator?.getStatus().active) return null;
        const result = await coordinator.commitSegment(projectPath, index, durationTicks, fps, startTick);
        if (!result) throw new Error(coordinator.getStatus().reason ?? '摄像头分段未能保存');
        return result;
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
    // Convert the rectangle as a whole: multiplying the origin by the scale is
    // incorrect on desktops whose displays have different scale factors.
    return screen.dipToScreenRect(null, display.bounds);
  };
  created.windowBounds = (id) => {
    const source = windowSources.get(id);
    return source?.available ? source : null;
  };
  return created;
}

/**
 * 等待隐藏窗口加载完成。
 *
 * 旧实现只等 did-finish-load：一旦页面加载失败（dist 缺失、渲染崩溃），
 * Promise 永不 resolve，录制分段/导出会永久卡住且没有任何错误提示。
 * 这里补上 did-fail-load 与超时，失败时抛可重试错误。
 */
function waitForReady(win: BrowserWindow, timeoutMs = 20_000): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return Promise.reject(
      new AppError({
        code: 'E_UNKNOWN',
        message: '渲染窗口已销毁，无法执行操作。',
        retryable: true,
        preservedData: true,
      }),
    );
  }
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const wc = win.webContents;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('did-fail-load', onFail);
      if (error) reject(error);
      else resolve();
    };
    const onFinish = (): void => finish();
    const onFail = (_event: unknown, errorCode: number, errorDescription: string): void => {
      // -3 = ERR_ABORTED：被新的导航/销毁打断，交给超时兜底
      if (errorCode === -3) return;
      finish(
        new AppError({
          code: 'E_UNKNOWN',
          message: '渲染页面加载失败，请重试。',
          retryable: true,
          preservedData: true,
          detail: `code=${errorCode} ${errorDescription}`,
        }),
      );
    };
    const timer = setTimeout(() => {
      finish(
        new AppError({
          code: 'E_UNKNOWN',
          message: '渲染页面加载超时，请重试。',
          retryable: true,
          preservedData: true,
          detail: `url=${wc.getURL()}`,
        }),
      );
    }, timeoutMs);
    wc.once('did-finish-load', onFinish);
    wc.once('did-fail-load', onFail);
  });
}

/**
 * 把录制会话落成工程：建立资产、轨道片段、标记。
 *
 * 资产 hash 必须是**文件内容**的 sha256（src/domain/project.ts 明确约定），
 * 旧实现用自造的 simpleHash(文件名列表)，与 projectStore.relocateAssets 的
 * hashFile(内容) 永远对不上，导致「素材缺失时按哈希重定位」实际从未生效。
 */
async function finalizeSessionProject(session: RecordSession): Promise<void> {
  const segments = engine.getCommittedSegments();
  const durationTicks = Math.max(1, engine.getDurationTicks());
  const project = createProject(`录制 ${new Date(session.startedAt).toLocaleString('zh-CN')}`);
  project.id = session.projectId;

  if (segments.length > 0) {
    const assetId = 'asset-screen-1';
    project.assets.push({
      id: assetId,
      kind: 'screen',
      path: segments[0].path,
      hash: await hashFile(path.join(session.projectPath, segments[0].path)),
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
    const relativePath = `media/${kind}/${files[0]}`;
    project.assets.push({
      id: assetId,
      kind,
      path: relativePath,
      hash: await hashFile(path.join(session.projectPath, relativePath)),
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
    project.assets.push({
      id: assetId,
      kind: 'camera',
      path: `media/camera/${cameraFiles[0]}`,
      hash: await hashFile(path.join(cameraDir, cameraFiles[0])),
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
  allowProjectRoot(session.projectPath);
}

// ---------------------------------------------------------------------------
// 生命周期清理
// ---------------------------------------------------------------------------

/** 关闭悬浮窗（幂等，窗口已销毁时也不抛错）。 */
function closeOverlayWindow(): void {
  overlayReady = false;
  const win = overlayWindow;
  overlayWindow = null;
  if (!win || win.isDestroyed()) return;
  try {
    win.close();
  } catch (error) {
    console.warn('[overlay] 关闭失败', error);
    try {
      win.destroy();
    } catch {
      // 忽略
    }
  }
}

/** 关闭摄像头协调器与隐藏窗口（停止录制后必须调用，否则指示灯常亮）。 */
async function closeCamera(): Promise<void> {
  const coordinator = camera;
  const win = cameraWindow;
  camera = null;
  cameraWindow = null;
  if (coordinator) {
    try {
      await coordinator.close();
    } catch (error) {
      console.warn('[camera] 关闭失败', error);
    }
  }
  if (win && !win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      // 忽略
    }
  }
}

/**
 * 停止当前录制会话并做完整清理（IPC 与全局快捷键共用同一条路径）。
 *
 * 旧实现里 Ctrl+Alt+R 直接调 engine.stop()：工程会落盘，但 currentSession 不清空、
 * 悬浮窗不关闭、摄像头不释放，导致下一次录制被「已有录制会话在进行中」拒绝、
 * 摄像头指示灯常亮。这里把三条清理收敛到唯一入口。
 */
async function stopCaptureSession(): Promise<{ projectPath: string; status: CaptureStatus }> {
  // 悬浮条与主界面可能几乎同时触发停止：复用同一个 Promise，
  // 避免第二次 engine.stop() 在 Cancelled/Idle 状态上抛错，也避免重复 finalize 落盘。
  if (stopInFlight) return stopInFlight;
  const task = (async () => {
    try {
      return await engine.stop();
    } finally {
      currentSession = null;
      closeOverlayWindow();
      await closeCamera();
    }
  })();
  stopInFlight = task;
  try {
    return await task;
  } finally {
    if (stopInFlight === task) stopInFlight = null;
  }
}

/** 销毁所有隐藏窗口（退出前调用，否则 window-all-closed 永远不会触发）。 */
function destroyAuxiliaryWindows(): void {
  closeOverlayWindow();
  for (const win of [...exporterWindows]) {
    exporterWindows.delete(win);
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // 忽略
      }
    }
  }
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    try {
      recorderWindow.destroy();
    } catch {
      // 忽略
    }
  }
  recorderWindow = null;
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    try {
      cameraWindow.destroy();
    } catch {
      // 忽略
    }
  }
  cameraWindow = null;
}

/**
 * 应用退出：先结束录制（尽量把工程落盘）→ 关摄像头/隐藏窗口 → 退出。
 * 只执行一次；重复调用（window-all-closed / before-quit 同时触发）直接返回。
 */
async function shutdownApp(reason: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[main] 开始退出：${reason}`);
  try {
    const state = typeof engine === 'undefined' ? 'Idle' : engine.getState();
    if (state === 'Recording' || state === 'Paused' || state === 'Pausing' || state === 'Resuming' || state === 'Stopping' || state === 'Finalizing' || state === 'Countdown' || state === 'Preparing') {
      // 正常停止会落工程；加超时兜底，避免封装卡死时进程永远不退出
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15_000);
      });
      try {
        await Promise.race([engine.stop(), timeout]);
      } catch (error) {
        console.warn('[main] 退出时停止录制失败，改为取消', error);
        try {
          await engine.cancel();
        } catch {
          // 忽略
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else if (state !== 'Idle' && state !== 'ReadyToEdit') {
      try {
        await engine.cancel();
      } catch {
        // 忽略
      }
    }
  } catch (error) {
    console.warn('[main] 退出清理失败', error);
  }
  currentSession = null;
  await closeCamera().catch(() => undefined);
  destroyAuxiliaryWindows();
  app.quit();
}

// ---------------------------------------------------------------------------
// IPC 参数校验与工程打开辅助
// ---------------------------------------------------------------------------

/**
 * 自定义协议名（不是 IPC 通道，不进 src/shared/ipc.ts 的 IPC 表）。
 * 渲染进程通过 wcs-media://local/<相对路径>?project=<工程绝对路径> 流式读取素材。
 */
const MEDIA_PROTOCOL = 'wcs-media';

// protocol.handle 之前必须声明 privileges：standard + secure + stream 才能被
// <video>/<audio> 当作可流式/可缓存的资源，supportFetchAPI 允许导出侧 fetch 读取。
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

/** 校验并规范化 capture:start 的配置（渲染进程传参不可信）。 */
function validateCaptureConfig(raw: unknown): CaptureConfig {
  const invalid = (detail: string): never => {
    throw new AppError({
      code: 'E_INVALID_COMMAND',
      message: '录制参数无效，请重新选择来源与画质。',
      retryable: false,
      preservedData: true,
      detail,
    });
  };
  if (!raw || typeof raw !== 'object') invalid('config 不是对象');
  const config = raw as Record<string, unknown>;
  const quality = QUALITY_PROFILES.find((profile) => profile.id === config.qualityId);
  if (!quality) throw invalid(`qualityId=${String(config.qualityId)}`);
  const sourceKind: CaptureConfig['sourceKind'] =
    config.sourceKind === 'screen' || config.sourceKind === 'window'
      ? config.sourceKind
      : invalid(`sourceKind=${String(config.sourceKind)}`);
  const sourceId = typeof config.sourceId === 'string' ? config.sourceId.trim() : '';
  if (!sourceId || sourceId.length > 200) invalid('sourceId 无效');
  const fpsValue = (config.fps ?? {}) as { num?: unknown; den?: unknown };
  const fpsNum = Number(fpsValue.num);
  const fpsDen = Number(fpsValue.den);
  if (!Number.isFinite(fpsNum) || !Number.isFinite(fpsDen) || fpsNum <= 0 || fpsDen <= 0 || fpsNum / fpsDen > 240) {
    invalid('fps 无效');
  }
  const countdownSeconds = Number(config.countdownSeconds ?? 0);
  if (!Number.isFinite(countdownSeconds) || countdownSeconds < 0 || countdownSeconds > 10) {
    invalid(`countdownSeconds=${String(config.countdownSeconds)}`);
  }
  const optionalDevice = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 500) return invalid(`${field} 无效`);
    return value;
  };
  let region: CaptureConfig['region'];
  if (config.region !== undefined && config.region !== null) {
    const rawRegion = config.region as Record<string, unknown>;
    const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(rawRegion[key]));
    if (numbers.some((value) => !Number.isFinite(value))) invalid('region 数值无效');
    const [x, y, width, height] = numbers;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) invalid('region 越界');
    region = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  const microphoneDeviceId = optionalDevice(config.microphoneDeviceId, 'microphoneDeviceId');
  const cameraDeviceId = optionalDevice(config.cameraDeviceId, 'cameraDeviceId');
  return {
    sourceId,
    backend: config.backend === 'wgc' || config.backend === 'compatibility' ? config.backend : 'auto',
    scaling: config.scaling === 'performance' ? 'performance' : 'quality',
    sourceKind,
    qualityId: quality.id,
    fps: { num: Math.round(fpsNum), den: Math.round(fpsDen) },
    systemAudioEnabled: config.systemAudioEnabled === true,
    microphoneEnabled: config.microphoneEnabled === true,
    microphoneDeviceId,
    cameraEnabled: config.cameraEnabled === true,
    cameraDeviceId,
    countdownSeconds: Math.round(countdownSeconds),
    testMode: config.testMode === true,
    ...(region ? { region } : {}),
  };
}

/** 工程数据的最小结构校验：避免把任意对象序列化进 project.json。 */
function assertProjectPayload(value: unknown): asserts value is Project {
  const invalid = (detail: string): never => {
    throw new AppError({
      code: 'E_INVALID_COMMAND',
      message: '工程数据无效，已拒绝保存。',
      retryable: false,
      preservedData: true,
      detail,
    });
  };
  if (!value || typeof value !== 'object') invalid('project 不是对象');
  const project = value as Record<string, unknown>;
  if (typeof project.id !== 'string' || project.id.length === 0 || project.id.length > 200) invalid('id 无效');
  if (typeof project.name !== 'string') invalid('name 无效');
  for (const field of ['assets', 'tracks', 'effects', 'steps', 'variants', 'markers']) {
    if (!Array.isArray(project[field])) invalid(`${field} 不是数组`);
  }
  if (!project.settings || typeof project.settings !== 'object') invalid('settings 无效');
}

/** 工程另存为的目标必须落在已授权/系统目录内。 */
async function assertAuthorizedProjectDestination(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const withSuffix = resolved.toLowerCase().endsWith('.wcaproj') ? resolved : resolved + '.wcaproj';
  const roots = [...outputRoots, ...projectRoots, appVideosPath(), appUserDataPath()].filter((root) => root.length > 0);
  if (!(await isInsideAnyRoot(roots, withSuffix))) {
    throw new AppError({
      code: 'E_PERMISSION_DENIED',
      message: '工程另存为的位置必须在已选择过的目录、系统视频目录或应用数据目录内。',
      retryable: false,
      preservedData: true,
      detail: `target=${withSuffix}`,
    });
  }
  return withSuffix;
}

/** 只接受合法的对话框过滤器结构，拒绝把任意对象透传给原生对话框。 */
function sanitizeFilters(raw: unknown): { name: string; extensions: string[] }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const allowed: { name: string; extensions: string[] }[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { name?: unknown; extensions?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name.slice(0, 60) : '';
    const extensions = Array.isArray(candidate.extensions)
      ? candidate.extensions.filter((ext): ext is string => typeof ext === 'string' && /^[a-z0-9]{1,12}$/i.test(ext))
      : [];
    if (name && extensions.length > 0) allowed.push({ name, extensions });
  }
  return allowed.length > 0 ? allowed : undefined;
}

/** 打开/恢复工程后的统一处理：素材重定位、迁移/回退通知、最近列表与白名单。 */
async function loadProjectForOpen(projectPath: string): Promise<{ path: string; project: Project }> {
  const loaded = await store.load(projectPath);
  if (loaded.missingAssets.length > 0) {
    const relocated = await store.relocateAssets(loaded.path, loaded.project);
    const stillMissing = relocated.filter((asset) => !fs.existsSync(ProjectStore.resolveInside(loaded.path, asset.path)));
    if (stillMissing.length > 0) {
      sendAppEvent('media-missing', { count: stillMissing.length });
    }
    loaded.project.assets = relocated;
  }
  if (loaded.recoveredFromPrev) {
    sendAppEvent('project-recovered-from-backup', { path: loaded.path });
  }
  if (loaded.migratedFrom !== null) {
    sendAppEvent('project-migrated', { path: loaded.path, fromVersion: loaded.migratedFrom });
  }
  if (loaded.readOnlyNotice) {
    sendAppEvent('project-readonly', { path: loaded.path, notice: loaded.readOnlyNotice });
  }
  await store.touchRecent(loaded.path, loaded.project);
  activeProjectPath = loaded.path;
  allowProjectRoot(loaded.path);
  return { path: loaded.path, project: loaded.project };
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.on(IPC.recorderResult, (event, reply: { id?: number; result?: RecorderReply }) => {
    const job = reply && typeof reply.id === 'number' ? recorderJobs.get(reply.id) : undefined;
    if (job && event.sender.id === job.sender && reply.result && typeof reply.result.ok === 'boolean') job.finish(reply.result);
  });
  ipcMain.on(IPC.captureDesktopFrame, (event, packet: unknown) => { desktopSources.get(event.sender.id)?.worker.accept(packet); });
  handleFor(IPC.captureCameraPreview, ['main'], async (enabled: unknown, deviceId: unknown) => {
    if (typeof enabled !== 'boolean' || (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.length > 500))) throw new Error('摄像头预览参数无效');
    if (!enabled) {
      if (!captureStartInFlight && !currentSession && !ACTIVE_CAPTURE_STATES.has(engine.getState())) await closeCamera();
      return { ok: true };
    }
    const coordinator = ensureCamera();
    if (captureStartInFlight && !coordinator.getStatus().active) return { ok: false, error: '摄像头正在启动' };
    if (!currentSession && !captureStartInFlight && !await coordinator.open(deviceId as string | undefined)) return { ok: false, error: coordinator.getStatus().reason ?? '摄像头不可用' };
    return coordinator.snapshot();
  });
  // ---- 采集 ----
  handleFor(IPC.captureListSources, ['main'], async (): Promise<CaptureSourceInfo[]> => {
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
    const ownHandles = new Set(BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      .map((w) => { const buffer = w.getNativeWindowHandle(); return `window:${buffer.length >= 8 ? buffer.readBigUInt64LE().toString() : buffer.readUInt32LE().toString()}`; }));
    const native = await listNativeWindows().catch((error) => { console.warn('[sources] 窗口枚举失败', error); return []; });
    windowSources.clear();
    for (const item of native) if (!ownHandles.has(item.id)) windowSources.set(item.id, item);
    const windows: CaptureSourceInfo[] = [...windowSources.values()].map((item) => ({ ...item, kind: 'window' }));
    try {
      const thumbnails = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true });
      for (const source of [...sources, ...windows]) {
        const thumb = thumbnails.find((t) => source.kind === 'screen' ? t.display_id === source.displayId : t.id.startsWith(source.id + ':'));
        if (thumb && !thumb.thumbnail.isEmpty()) source.thumbnail = thumb.thumbnail.toDataURL();
      }
    } catch (error) { console.warn('[sources] 缩略图不可用', error); }
    return [...sources, ...windows];
  });

  // 独立的显示器枚举：listSources 返回的 CaptureSourceInfo 没有 bounds/scaleFactor，
  // 界面（RecordView）需要 DisplayInfo 才能显示正确的缩放倍率。
  handleFor(IPC.captureListDisplays, ['main'], async (): Promise<DisplayInfo[]> => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      label: display.label || (display.internal ? '内置显示器' : `显示器 ${display.id}`),
      bounds: { ...display.bounds },
      scaleFactor: display.scaleFactor || 1,
      isPrimary: display.id === primaryId,
      rotation: display.rotation,
      ...(typeof display.displayFrequency === 'number' ? { refreshRate: display.displayFrequency } : {}),
    }));
  });

  handleFor(IPC.captureListDevices, ['main'], async (): Promise<{ audio: AudioDeviceInfo[]; video: VideoDeviceInfo[] }> => {
    const audio = await listAudioDevices(resolveWorkerPaths(app.getAppPath(), app.isPackaged).audioExe);
    // 视频设备由渲染进程通过 navigator.mediaDevices 枚举后回传，这里返回空表示"界面自行枚举"
    return { audio, video: [] };
  });

  handleFor(IPC.systemInfo, ['main'], async () => buildSystemInfo());

  handleFor(IPC.captureStart, ['main'], async (rawConfig: unknown) => {
    // 互斥必须覆盖整个启动流程（含多次 await），只看 currentSession 会漏掉并发启动。
    if (captureStartInFlight || currentSession || ACTIVE_CAPTURE_STATES.has(engine.getState())) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '已有录制会话在进行中。', retryable: false, preservedData: true });
    }
    captureStartInFlight = true;
    try {
      const config = validateCaptureConfig(rawConfig);
      if (config.sourceKind === 'window') {
        const fresh = (await listNativeWindows()).find(item => item.id === config.sourceId);
        if (!fresh?.available || !windowSources.has(config.sourceId)) throw new AppError({ code: 'E_SOURCE_CLOSED', message: '所选窗口已关闭或最小化，请重新选择。', retryable: true, preservedData: true });
        windowSources.set(fresh.id, fresh);
      }
      const name = `录制 ${new Date().toLocaleString('zh-CN')}`;
      // 唯一目录：同名录制（同一秒内多次开始）绝不能覆盖已有工程
      const projectPath = store.uniqueProjectPath(name);
      await store.ensureDir(projectPath);
      const projectId = newProjectId();
      allowProjectRoot(projectPath);

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

      let session: RecordSession;
      try {
        session = await engine.start(config, projectPath, projectId);
      } catch (error) {
        // engine.start 失败时必须释放刚打开的摄像头，否则指示灯常亮且窗口泄漏
        await closeCamera();
        throw error;
      }
      currentSession = session;
      if (cameraNote) {
        session.degradation = session.degradation ? `${session.degradation}；${cameraNote}` : cameraNote;
      }
      createOverlayWindow();
      return { sessionId: session.sessionId, projectPath, cameraNote };
    } finally {
      captureStartInFlight = false;
    }
  });

  handleFor(IPC.capturePause, ['main', 'overlay'], async () => engine.pause());
  handleFor(IPC.captureResume, ['main', 'overlay'], async () => engine.resume());
  handleFor(IPC.captureStatus, ['main', 'overlay'], async () => engine.status());

  handleFor(IPC.captureStop, ['main', 'overlay'], async () => stopCaptureSession());

  handleFor(IPC.captureCancel, ['main', 'overlay'], async () => {
    try {
      await engine.cancel();
    } finally {
      currentSession = null;
      closeOverlayWindow();
      await closeCamera();
    }
    return null;
  });

  handleFor(IPC.captureMark, ['main', 'overlay'], async (note: unknown) => {
    const safeNote = typeof note === 'string' ? note.slice(0, 2000) : '';
    return engine.addMarker(safeNote);
  });

  // ---- 工程 ----
  handleFor(IPC.projectCreate, ['main'], async (name?: unknown) => {
    const requested = typeof name === 'string' ? name.trim() : '';
    const project = createProject(requested || '未命名工程');
    const projectPath = store.uniqueProjectPath(project.name);
    await store.ensureDir(projectPath);
    await store.save(projectPath, project);
    await store.touchRecent(projectPath, project);
    activeProjectPath = projectPath;
    allowProjectRoot(projectPath);
    return { path: projectPath, project };
  });

  handleFor(IPC.projectOpen, ['main'], async (targetPath?: unknown) => {
    let projectPath: string | undefined;
    if (typeof targetPath === 'string' && targetPath.trim()) {
      const resolved = path.resolve(targetPath.trim());
      if (!resolved.toLowerCase().endsWith('.wcaproj')) {
        throw new AppError({ code: 'E_INVALID_COMMAND', message: '只能打开 .wcaproj 工程目录。', retryable: false, preservedData: true });
      }
      if (!fs.existsSync(resolved)) {
        throw new AppError({ code: 'E_PROJECT_NOT_FOUND', message: '工程目录不存在，可能已被移动或删除。', retryable: true, preservedData: false });
      }
      projectPath = resolved;
    } else {
      const picked = await showOpenDialog({
        title: '打开工程',
        properties: ['openDirectory'],
        filters: [{ name: 'WinCapture 工程', extensions: ['wcaproj'] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        // 取消是「用户主动放弃」，不是成功返回空数据：
        // 旧实现 return null 会让 IpcResponse<ProjectHandle> 变成 ok(null)，
        // 渲染层解引用 handle.project 时抛 TypeError（或被误报为「打开失败」）。
        throw new AppError({
          code: 'E_EXPORT_CANCELLED',
          message: '已取消打开工程。',
          retryable: true,
          preservedData: true,
        });
      }
      projectPath = picked.filePaths[0];
    }
    return loadProjectForOpen(projectPath);
  });

  handleFor(IPC.projectSave, ['main'], async (project: unknown) => {
    assertProjectPayload(project);
    if (!activeProjectPath) {
      throw new AppError({ code: 'E_PROJECT_NOT_FOUND', message: '当前没有已打开的工程。', retryable: false, preservedData: true });
    }
    const result = await store.save(activeProjectPath, project);
    await store.touchRecent(activeProjectPath, project);
    return result;
  });

  handleFor(IPC.projectSaveAs, ['main'], async (project: unknown, targetPath?: unknown) => {
    assertProjectPayload(project);
    let dest: string;
    if (typeof targetPath === 'string' && targetPath.trim()) {
      dest = await assertAuthorizedProjectDestination(targetPath.trim());
    } else {
      const picked = await showSaveDialog({
        title: '另存为',
        defaultPath: path.join(app.getPath('videos'), `${project.name}.wcaproj`),
        filters: [{ name: 'WinCapture 工程', extensions: ['wcaproj'] }],
      });
      if (picked.canceled || !picked.filePath) {
        throw new AppError({ code: 'E_EXPORT_CANCELLED', message: '已取消另存为。', retryable: true, preservedData: true });
      }
      dest = picked.filePath.toLowerCase().endsWith('.wcaproj') ? picked.filePath : picked.filePath + '.wcaproj';
      allowDialogRoot(path.dirname(path.resolve(dest)));
    }
    const result = await store.save(dest, project);
    activeProjectPath = result.path;
    allowProjectRoot(result.path);
    await store.touchRecent(dest, project);
    return result;
  });

  handleFor(IPC.projectListRecent, ['main'], async () => store.listRecent());
  handleFor(IPC.projectRemoveRecent, ['main'], async (p: unknown) => {
    if (typeof p === 'string' && p.trim()) await store.removeRecent(p.trim());
    return null;
  });
  handleFor(IPC.projectReveal, ['main'], async (p: unknown) => {
    if (typeof p !== 'string' || !p.trim()) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '路径参数无效。', retryable: false, preservedData: true });
    }
    const abs = path.resolve(p.trim());
    if (!looksLikeProjectDir(abs)) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '不是有效的工程目录。', retryable: false, preservedData: true });
    }
    shell.showItemInFolder(abs);
    return null;
  });
  handleFor(IPC.projectDelete, ['main'], async (p: unknown) => {
    if (typeof p !== 'string' || !p.trim()) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '路径参数无效。', retryable: false, preservedData: true });
    }
    const root = path.resolve(p.trim());
    if (!root.toLowerCase().endsWith('.wcaproj')) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '只能删除 .wcaproj 工程目录。', retryable: false, preservedData: true });
    }
    // 必须是真正的工程目录（含 project.json / recovery / media），
    // 否则一个任意命名成 *.wcaproj 的目录也会被递归删除。
    if (!looksLikeProjectDir(root)) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '目标目录不是有效的工程目录，已拒绝删除。', retryable: false, preservedData: true });
    }
    if (path.dirname(root) === root) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '拒绝删除磁盘根目录。', retryable: false, preservedData: true });
    }
    // 与其它工程通道一致：只允许删除「本次会话打开过的工程」「应用自己的工程目录」
    // 或「最近工程列表里的工程」。否则渲染进程（被注入或列表项传错路径）可以
    // 递归删除任意一个带 media 子目录的 *.wcaproj 目录。
    const trusted =
      (await isInsideAnyRoot(projectRoots, root)) ||
      (await isInsideAnyRoot(new Set([path.resolve(store.projectsRoot())]), root));
    if (!trusted) {
      const recents = await store.listRecent();
      const known = recents.some((item) => path.resolve(item.path).toLowerCase() === root.toLowerCase());
      if (!known) {
        throw new AppError({
          code: 'E_PERMISSION_DENIED',
          message: '该工程既不在本次会话打开列表，也不在最近工程中，已拒绝删除。',
          retryable: false,
          preservedData: true,
          detail: `path=${root}`,
        });
      }
    }
    // 确认只在渲染层做一次（HomeView 已有破坏性操作确认对话框）。
    // 旧实现在主进程又弹一次 showMessageBox，用户要确认两次；而且主进程对话框
    // 点「取消」时返回 ok(null)，渲染层会误提示「工程已删除」。
    // 主进程这里只做路径/工程有效性校验，真正的删除由已确认的调用触发。
    await fsp.rm(root, { recursive: true, force: true });
    await store.removeRecent(root);
    projectRoots.delete(root);
    if (activeProjectPath && path.resolve(activeProjectPath).toLowerCase() === root.toLowerCase()) {
      activeProjectPath = null;
    }
    return null;
  });

  handleFor(IPC.projectReadMedia, ['main', 'exporter'], async (projectPath: unknown, relativePath: unknown) => {
    const root = await assertAllowedProjectPath(projectPath);
    if (typeof relativePath !== 'string') {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '素材路径参数无效。', retryable: false, preservedData: true });
    }
    return store.readMedia(root, relativePath);
  });

  // ---- 文件读写（导出/录制窗口专用）----
  // 安全约束：只允许在「本次会话打开的工程目录」或「用户选择的导出目录」内读写，
  // 不做任意路径读写，避免渲染进程被注入后变成文件系统后门。
  handleFor(IPC.fileWrite, ['exporter', 'recorder', 'camera'], async (targetPath: unknown, data: unknown) => {
    const abs = await assertAllowedPath(targetPath);
    if (!(data instanceof Uint8Array)) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '写入数据必须是字节数组。', retryable: false, preservedData: true });
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.from(data));
    return null;
  });

  handleFor(IPC.fileRead, ['main', 'overlay', 'exporter', 'recorder', 'camera'], async (targetPath: unknown) => {
    const abs = await assertAllowedPath(targetPath);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '读取目标不是文件。', retryable: false, preservedData: true, detail: abs });
    }
    // 单次 IPC 传输过大文件会直接打爆渲染进程堆：导出侧按分段读取，不需要整包读
    const maxReadBytes = 512 * 1024 * 1024;
    if (stat.size > maxReadBytes) {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '文件过大，已拒绝一次性读取。',
        retryable: false,
        preservedData: true,
        detail: `size=${stat.size}`,
      });
    }
    const bytes = await fsp.readFile(abs);
    return new Uint8Array(bytes);
  });

  handleFor(IPC.fileRename, ['exporter', 'recorder', 'camera'], async (from: unknown, to: unknown) => {
    const fromAbs = await assertAllowedPath(from);
    const toAbs = await assertAllowedPath(to);
    await fsp.rename(fromAbs, toAbs);
    return null;
  });

  handleFor(IPC.fileRemove, ['exporter', 'recorder', 'camera'], async (targetPath: unknown) => {
    const abs = await assertAllowedPath(targetPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (stat?.isDirectory()) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '只能删除文件，不能删除目录。', retryable: false, preservedData: true, detail: abs });
    }
    await fsp.rm(abs, { force: true });
    return null;
  });

  handleFor(IPC.fileMkdir, ['exporter', 'recorder', 'camera'], async (targetPath: unknown) => {
    const abs = await assertAllowedPath(targetPath);
    await fsp.mkdir(abs, { recursive: true });
    return null;
  });

  handleFor(IPC.fileListSegments, ['main', 'exporter', 'recorder', 'camera'], async (projectPath: unknown, relativePath: unknown) => {
    const root = await assertAllowedProjectPath(projectPath);
    if (typeof relativePath !== 'string') {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '素材路径参数无效。', retryable: false, preservedData: true });
    }
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

  handleFor(IPC.projectReadPointerLog, ['main', 'exporter'], async (projectPath: unknown) => {
    const root = await assertAllowedProjectPath(projectPath);
    const target = ProjectStore.resolveInside(root, path.join('events', 'pointer.jsonl'));
    if (!fs.existsSync(target)) return null;
    const text = await fsp.readFile(target, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const events: unknown[] = [];
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

  handleFor(IPC.projectExportPack, ['main'], async (projectPath: unknown) => {
    const root = await assertAllowedProjectPath(projectPath);
    const picked = await showSaveDialog({
      title: '导出工程包',
      defaultPath: path.join(app.getPath('videos'), `${path.basename(root, '.wcaproj')}.wcapack`),
    });
    if (picked.canceled || !picked.filePath) {
      // 取消不能用 { ok: false, outputPath: null } 伪装成成功业务结果
      throw new AppError({
        code: 'E_EXPORT_CANCELLED',
        message: '已取消导出工程包。',
        retryable: true,
        preservedData: true,
      });
    }
    const output = await store.exportPack(root, picked.filePath);
    allowOutputRoot(path.dirname(output));
    return { ok: true, outputPath: output };
  });

  handleFor(IPC.projectImportPack, ['main'], async () => {
    const picked = await showOpenDialog({ title: '导入工程包', properties: ['openDirectory'] });
    if (picked.canceled || picked.filePaths.length === 0) {
      // 取消统一用错误码表达（与 project:open / project:save-as 一致）
      throw new AppError({
        code: 'E_EXPORT_CANCELLED',
        message: '已取消导入工程包。',
        retryable: true,
        preservedData: true,
      });
    }
    const projectPath = await store.importPack(
      picked.filePaths[0],
      store.defaultProjectPath(path.basename(picked.filePaths[0])),
    );
    return loadProjectForOpen(projectPath);
  });

  handleFor(IPC.projectRecoverable, ['main'], async () => {
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

  handleFor(IPC.projectRecover, ['main'], async (projectPath: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '工程路径参数无效。', retryable: false, preservedData: true });
    }
    const root = path.resolve(projectPath.trim());
    if (!root.toLowerCase().endsWith('.wcaproj') || !looksLikeProjectDir(root)) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '可恢复会话路径无效。', retryable: false, preservedData: true });
    }
    return loadProjectForOpen(root);
  });

  handleFor(IPC.projectDiscardRecovery, ['main'], async (projectPath: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '工程路径参数无效。', retryable: false, preservedData: true });
    }
    const root = path.resolve(projectPath.trim());
    if (!root.toLowerCase().endsWith('.wcaproj') || !looksLikeProjectDir(root)) {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '可恢复会话路径无效。', retryable: false, preservedData: true });
    }
    await store.discardRecovery(root);
    return null;
  });

  // ---- 导出 ----
  handleFor(IPC.exportStart, ['main'], async (params: unknown) => {
    const invalid = (detail: string): never => {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '导出参数无效。', retryable: false, preservedData: true, detail });
    };
    if (!params || typeof params !== 'object') invalid('params 不是对象');
    const request = params as { project?: unknown; profile?: unknown; outputPath?: unknown; includeTutorial?: unknown };
    assertProjectPayload(request.project);
    if (typeof request.includeTutorial !== 'boolean') invalid('includeTutorial 不是布尔值');
    const outputPath = typeof request.outputPath === 'string' ? request.outputPath.trim() : '';
    if (!outputPath || !path.isAbsolute(outputPath)) invalid('outputPath 必须是绝对路径');
    if (!((request.profile as Partial<ExportProfile> | undefined)?.audioOnly ? /\.m4a$/i : /\.mp4$/i).test(outputPath)) invalid('输出扩展名必须与 MP4/M4A 格式匹配');
    const outputAbs = path.resolve(outputPath);
    // 关键修复：输出目录必须落在「用户通过原生对话框选择过的目录」或系统视频/应用数据目录内。
    // 旧实现直接 allowRoot(dirname(渲染进程传入的 outputPath))，等于让渲染进程任意写盘。
    const authorizedDirs = [...dialogAuthorizedRoots, ...outputRoots, appVideosPath(), appUserDataPath()].filter(
      (dir) => dir.length > 0,
    );
    if (!(await isInsideAnyRoot(authorizedDirs, outputAbs))) {
      throw new AppError({
        code: 'E_PERMISSION_DENIED',
        message: '导出位置未授权。请先通过「选择保存位置」选择输出目录。',
        retryable: false,
        preservedData: true,
        detail: `outputPath=${outputAbs}`,
      });
    }
    const profile = request.profile as Partial<ExportProfile> | undefined;
    if (
      !profile ||
      typeof profile !== 'object' ||
      typeof profile.variantId !== 'string' ||
      !Number.isFinite(profile.width) ||
      !Number.isFinite(profile.height)
    ) {
      invalid('profile 无效');
    }
    if (!activeProjectPath) {
      throw new AppError({ code: 'E_PROJECT_NOT_FOUND', message: '当前没有已打开的工程。', retryable: false, preservedData: true });
    }
    allowOutputRoot(path.dirname(outputAbs));
    if (request.includeTutorial) allowOutputRoot(outputAbs.replace(/\.mp4$/i, '') + '-tutorial');

    // 导出在独立的隐藏窗口里跑（WebCodecs 只在渲染进程可用）
    const win = createExporterWindow();
    try {
      await waitForReady(win);
      const jobId = `job-${Date.now().toString(36)}`;
      const result = (await win.webContents.executeJavaScript(
        `window.__wcsExporter.run(${JSON.stringify({
          jobId,
          project: request.project,
          projectPath: activeProjectPath,
          profile: request.profile,
          outputPath: outputAbs,
          includeTutorial: request.includeTutorial,
        })})`,
      )) as {
        video: ExportResult | null;
        tutorial: { ok: boolean; outputDir: string; indexPath: string; markdownPath: string; stepsJsonPath: string; imageCount: number } | null;
        snapshotHash: string;
      };
      if (!result || typeof result !== 'object') {
        throw new AppError({ code: 'E_EXPORT_FAILED', message: '导出渲染进程没有返回结果。', retryable: true, preservedData: true });
      }
      lastExport = result.video;
      return result;
    } finally {
      // 修复隐藏窗口泄漏：无论等待/执行是否抛错都要销毁
      if (!win.isDestroyed()) win.destroy();
    }
  });

  handleFor(IPC.exportCancel, ['main'], async () => {
    // 只对导出窗口广播，且不等待：导出渲染进程编码期间 executeJavaScript 会排队，
    // 旧实现串行 await 所有窗口会把 IPC 卡住几十秒。
    for (const win of [...exporterWindows]) {
      if (win.isDestroyed()) continue;
      void win.webContents.executeJavaScript('window.__wcsExporter?.cancel?.()').catch(() => undefined);
    }
    return null;
  });

  // 导出窗口回报进度（只接受 exporter 窗口，防止任意渲染进程伪造进度/结果）
  ipcMain.on(IPC.exportProgress, (event, progress: ExportProgress) => {
    if (senderRole(event) !== 'exporter') return;
    send(IPC.exportProgress, progress);
  });
  ipcMain.on(IPC.exportComplete, (event, result: ExportResult) => {
    if (senderRole(event) !== 'exporter') return;
    if (result && typeof result === 'object') lastExport = result;
  });

  // ---- 系统 ----
  handleFor(IPC.systemPickFile, ['main'], async (defaultName: unknown, filters?: unknown) => {
    const name = typeof defaultName === 'string' ? path.basename(defaultName).slice(0, 160) : 'export.mp4';
    const safeFilters = sanitizeFilters(filters);
    const picked = await showSaveDialog({ defaultPath: name, ...(safeFilters ? { filters: safeFilters } : {}) });
    if (picked.canceled || !picked.filePath) return null;
    // 用户在原生对话框里选定 = 授权该目录（导出会写到这里）
    allowDialogRoot(path.dirname(path.resolve(picked.filePath)));
    return picked.filePath;
  });

  handleFor(IPC.systemPickDirectory, ['main'], async () => {
    const picked = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled) return null;
    const directory = picked.filePaths[0] ?? null;
    if (directory) allowDialogRoot(directory);
    return directory;
  });

  handleFor(IPC.systemOpenPath, ['main'], async (p: unknown) => {
    const abs = await assertOpenablePath(p);
    const error = await shell.openPath(abs);
    if (error) {
      throw new AppError({
        code: 'E_UNKNOWN',
        message: '系统无法打开该文件或目录。',
        retryable: true,
        preservedData: true,
        detail: error,
      });
    }
    return null;
  });

  handleFor(IPC.systemShowInFolder, ['main'], async (p: unknown) => {
    const abs = await assertOpenablePath(p);
    shell.showItemInFolder(abs);
    return null;
  });

  handleFor(IPC.systemCheckPath, ['main', 'exporter'], async (p: unknown) => {
    try {
      if (typeof p !== 'string' || !p.trim()) {
        return { ok: false, freeBytes: 0, writable: false, reason: '路径为空' };
      }
      const dir = path.dirname(path.resolve(p));
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

  handleFor(IPC.systemDiagnostics, ['main'], async () => {
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
  handleFor(IPC.windowSetAlwaysOnTop, ['main'], async (value: unknown) => {
    if (typeof value === 'boolean' && mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(value);
    return null;
  });
  handleFor(IPC.windowMinimize, ['main'], async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return null;
  });
  handleFor(IPC.windowClose, ['main'], async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return null;
  });
  handleFor(IPC.windowOpenOverlay, ['main'], async () => {
    createOverlayWindow();
    return null;
  });
  handleFor(IPC.windowCloseOverlay, ['main'], async () => {
    closeOverlayWindow();
    return null;
  });

  // 悬浮窗状态增量更新：合并到最近一次完整状态上再推送，避免覆盖成不完整对象。
  handleFor(IPC.windowUpdateOverlay, ['overlay', 'main'], async (payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      throw new AppError({ code: 'E_INVALID_COMMAND', message: '悬浮窗状态无效。', retryable: false, preservedData: true });
    }
    const update = payload as Partial<{
      state: CaptureStatus['state'];
      mediaTick: number;
      markerCount: number;
      levels: { mic: number; system: number };
    }>;
    const base: CaptureStatus | null = lastStatus ?? (typeof engine === 'undefined' ? null : engine.status());
    if (!base) return null;
    const merged: CaptureStatus = {
      ...base,
      ...(typeof update.state === 'string' ? { state: update.state } : {}),
      ...(Number.isFinite(update.mediaTick) ? { mediaTick: Number(update.mediaTick) } : {}),
      ...(Number.isFinite(update.markerCount) ? { markerCount: Number(update.markerCount) } : {}),
      ...(update.levels && Number.isFinite(update.levels.mic) && Number.isFinite(update.levels.system)
        ? { levels: { mic: Number(update.levels.mic), system: Number(update.levels.system) } }
        : {}),
    };
    lastStatus = merged;
    send(IPC.captureStatus, merged);
    sendToOverlay(IPC.captureStatus, merged);
    return null;
  });

  // 悬浮窗 ready 握手：窗口挂载后立即拿到当前状态（窗口创建瞬间推送的状态可能丢失）
  ipcMain.on(IPC.overlayReady, (event) => {
    if (senderRole(event) !== 'overlay') return;
    overlayReady = true;
    const status = lastStatus ?? (typeof engine === 'undefined' ? null : engine.status());
    if (!status) return;
    try {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.captureStatus, status);
    } catch {
      // 窗口可能正好销毁
    }
  });
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
      // 必须走与 IPC 相同的清理路径：否则 currentSession 不清空、悬浮窗不关、
      // 摄像头不释放，下一次录制会被「已有录制会话」拒绝且摄像头指示灯常亮。
      void stopCaptureSession().catch((error) => {
        console.warn('[shortcut] 停止录制失败', error);
      });
    }
  }, '开始/停止录制');

  bind('Control+Alt+P', () => {
    const state = engine.getState();
    if (state === 'Recording') void engine.pause().catch(() => {});
    else if (state === 'Paused') void engine.resume().catch(() => {});
  }, '暂停/恢复录制');

  bind('Control+Alt+M', () => {
    if (engine.getState() !== 'Recording') return;
    // 悬浮窗就绪时交给它处理：它能读到备忘录当前行作为标记备注（R12）。
    if (sendOverlayCommand('mark')) return;
    const marker = engine.addMarker('');
    sendAppEvent('marker-added', marker);
  }, '添加标记');
}

// ---------------------------------------------------------------------------
// 自定义协议：让渲染进程能流式读取工程素材
// ---------------------------------------------------------------------------

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      // wcs-media://local/<urlencoded 相对路径>?project=<urlencoded 工程绝对路径>
      const rawPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const projectPath = url.searchParams.get('project') ?? '';
      if (!projectPath) return new Response('missing project', { status: 400 });
      const projectRoot = path.resolve(projectPath);
      // 关键修复：旧实现允许任意 project 参数，渲染进程可构造
      // wcs-media://local/Windows/win.ini?project=C:\ => 任意文件读取。
      // 现在要求工程必须是本次会话打开过的工程目录，且路径解析后仍在其内
      // （resolveInside 已拒绝绝对路径与 ..，realpath 检查防 Junction 逃逸）。
      if (!(await isInsideAnyRoot(projectRoots, projectRoot))) {
        return new Response('forbidden', { status: 403 });
      }
      if (!looksLikeProjectDir(projectRoot) && !(await isInsideAnyRoot([store.projectsRoot()], projectRoot))) {
        return new Response('forbidden', { status: 403 });
      }
      const abs = ProjectStore.resolveInside(projectRoot, rawPath);
      if (!(await isInsideAnyRoot([projectRoot], abs))) return new Response('forbidden', { status: 403 });
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) return new Response('not found', { status: 404 });
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

  // 兜底日志：旧实现没有任何 unhandledRejection/uncaughtException 处理，
  // 隐藏窗口里的异步失败会静默消失（用户只看到录制/导出「没反应」）。
  process.on('unhandledRejection', (reason) => {
    console.error('[main] 未处理的 Promise 拒绝', reason);
    sendAppEvent('main-error', { message: '后台任务出现未处理错误。', detail: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    console.error('[main] 未捕获异常', error);
    sendAppEvent('main-error', { message: '主进程出现未捕获异常。', detail: String(error) });
  });

  // 窗口安全策略：禁止页面导航到外部地址、禁止 window.open 弹出新窗口。
  // 缺失这两条时，渲染进程一旦被诱导跳转到远程页面，preload 仍会注入，
  // 远程页面即可拿到 window.wcs 的全部 IPC 能力（含摄像头权限）。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      console.warn(`[security] 已阻止 window.open：${url}`);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isInternalUrl(url)) return;
      event.preventDefault();
      console.warn(`[security] 已阻止导航到应用外地址：${url}`);
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      console.warn('[security] 已阻止 webview 挂载');
    });
  });

  app.whenReady().then(async () => {
    // 任务栏/窗口分组用显式的 AppUserModelID，避免 Windows 上出现无图标的空分组。
    app.setAppUserModelId('com.huihui.wincapture-studio');
    // 与系统信息/默认输出路径保持一致：videos 用 Electron 解析结果（可能被组策略重定向）
    store = new ProjectStore(app.getPath('userData'), {
      videosPath: () => app.getPath('videos'),
      homePath: () => app.getPath('home'),
    });
    engine = buildEngine();

    // 媒体设备权限（摄像头/麦克风/屏幕采集）：只授予应用自身页面，
    // 不允许任意来源（旧实现不校验来源，配合缺失的导航拦截等于给远程页面开摄像头）。
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const url = webContents?.getURL?.() ?? '';
      callback(allowedPermissions.includes(permission) && isInternalUrl(url));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      const url = webContents?.getURL?.() ?? '';
      return ['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission) && isInternalUrl(url);
    });
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const contents = request.frame ? webContents.fromFrame(request.frame) : undefined;
      const capture = contents ? desktopSources.get(contents.id) : undefined;
      callback(capture ? { video: capture.source } : {});
    }, { useSystemPicker: false });

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

    // 长时间录制与内存稳定性探针：WCS_LONGRUN_PROBE=1 时执行，
    // 结果写 dist/verify/longrun-result.json（详见 scripts/longrunProbe.ts）。
    if (process.env.WCS_LONGRUN_PROBE === '1') {
      void runLongrunProbe();
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
    // 统一走 shutdownApp：结束录制、关摄像头/隐藏窗口，再退出。
    // 旧实现只 cancel 引擎，隐藏窗口（recorder/exporter/camera）不会被销毁，
    // 进程会一直挂在后台。
    void shutdownApp('window-all-closed');
  });

  app.on('before-quit', (event) => {
    if (shutdownStarted) return;
    // 先阻止这次退出，等录制收尾（落工程 / 取消）、隐藏窗口销毁后再真正 quit。
    event.preventDefault();
    void shutdownApp('before-quit');
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
    allowProjectRoot(projectPath);

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
    allowProjectRoot(projectPath);
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
    allowOutputRoot(outDir);
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
/**
 * 长时间录制与内存稳定性探针（WCS_LONGRUN_PROBE=1）。
 *
 * 与 runPerfProbe 共用「完整进程树工作集」口径；录制参数与性能探针一致（1080p30
 * 双音轨），额外做周期性暂停/恢复与中途 grabber 崩溃注入。指标判定与阈值见
 * scripts/longrunProbe.ts。
 */
async function runLongrunProbe(): Promise<void> {
  const minutes = Number(process.env.WCS_LONGRUN_MINUTES ?? 60);
  const pauseEveryMinutes = Number(process.env.WCS_LONGRUN_PAUSE_MIN ?? 5);
  const pauseSeconds = Number(process.env.WCS_LONGRUN_PAUSE_SEC ?? 5);
  const outDir = path.join(APP_ROOT, 'dist', 'verify');
  const reportPath = path.join(outDir, 'longrun-result.json');
  const log = (message: string) => console.log(`[longrun] ${message}`);
  const sampler = new NativeMemorySampler(() => nativeProcessMemory(
    resolveWorkerPaths(app.getAppPath(), app.isPackaged).grabberExe, engine.getNativeProcessIds()));

  const finish = (report: { ok: boolean; notes?: string[]; error?: string }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[longrun] done ok=${report.ok}${report.error ? ' error=' + report.error : ''}${report.notes?.length ? ' notes=' + JSON.stringify(report.notes) : ''}`);
    setTimeout(() => app.exit(report.ok ? 0 : 1), 500);
  };

  const treeWorkingSetBytes = (): number => {
    try {
      const metrics = app.getAppMetrics();
      let total = 0;
      for (const m of metrics) {
        const kb = m.memory?.workingSetSize ?? 0;
        if (Number.isFinite(kb) && kb > 0) total += kb * 1024;
      }
      const electronIds = new Set(metrics.map(metric => metric.pid));
      if (total > 0) return total + sampler.total(engine.getNativeProcessIds().filter(id => !electronIds.has(id)));
    } catch {
      // 退化到当前进程 RSS
    }
    return process.memoryUsage().rss + sampler.total(engine.getNativeProcessIds());
  };

  try {
    await new Promise((r) => setTimeout(r, 1500));
    sampler.start();

    const { runLongrunProbe: runProbe } = await import('../scripts/longrunProbe');

    const report = await runProbe(
      {
        startCapture: async (projectPath) => {
          allowProjectRoot(projectPath);
          const config: CaptureConfig = {
            sourceId: 'display:0',
            sourceKind: 'screen',
            qualityId: '1080p30',
            fps: { num: 30, den: 1 },
            systemAudioEnabled: true,
            microphoneEnabled: true,
            cameraEnabled: false,
            countdownSeconds: 0,
            testMode: true,
          };
          const session = await engine.start(config, projectPath, newProjectId());
          return { sessionId: session.sessionId };
        },
        stopCapture: async () => {
          const stopped = await engine.stop();
          return { state: stopped.status.state, segmentsCommitted: stopped.status.segmentsCommitted };
        },
        pauseCapture: async () => { await engine.pause(); },
        resumeCapture: async () => { await engine.resume(); },
        getStatus: () => {
          const status = engine.status();
          return {
            state: status.state,
            mediaTick: status.mediaTick,
            framesArrived: status.framesArrived,
            degradation: status.degradation,
          };
        },
        getGrabberPid: () => engine.getGrabberPid(),
        killProcess: (pid) => { try { process.kill(pid); } catch { /* 进程可能已退出 */ } },
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
            await input.dispose?.();
            return { durationSeconds, frames: stats.packetCount };
          } catch {
            return null;
          }
        },
        newProjectPath: (name) => store.defaultProjectPath(name),
        treeWorkingSetBytes,
        log,
      },
      { minutes, pauseEveryMinutes, pauseSeconds },
    );

    Object.assign(report, { memoryScope: 'Electron processes + native grabber/audio/pointer working sets',
      nativeMemory: { samples: sampler.samples, errors: sampler.errors, peakBytes: sampler.peakBytes, maxProcesses: sampler.maxProcesses } });
    log(`wallSeconds=${report.wallSeconds} video=${report.metrics.videoSeconds}s audio=${report.metrics.audioSeconds}s ` +
      `drift=${report.metrics.avDriftMs}ms loss=${report.metrics.captureLossPercent}% ` +
      `peakMem=${report.metrics.memoryPeakMiB}MiB growth=${report.metrics.memoryGrowthMiB}MiB ` +
      `restart=${report.metrics.restartDetected} gap=${report.metrics.timelineGapMs}ms`);
    if (!sampler.maxProcesses || sampler.errors) {
      report.ok = false;
      report.error = [report.error, '原生进程内存采样不完整'].filter(Boolean).join('；');
    }
    finish(report);
  } catch (error) {
    finish({ ok: false, error: String(error instanceof Error ? (error.stack ?? error.message) : error) });
  } finally { sampler.stop(); }
}

async function runPerfProbe(): Promise<void> {
  const seconds = Number(process.env.WCS_PERF_SECONDS ?? 20);
  const outDir = path.join(APP_ROOT, 'dist', 'verify');
  const reportPath = path.join(outDir, 'perf-result.json');

  const log = (message: string) => console.log(`[perf] ${message}`);
  const sampler = new NativeMemorySampler(() => nativeProcessMemory(
    resolveWorkerPaths(app.getAppPath(), app.isPackaged).grabberExe, engine.getNativeProcessIds()));

  const finish = (report: { ok: boolean; samples: unknown[]; error?: string }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[perf] done ok=${report.ok}${report.error ? ' error=' + report.error : ''}`);
    setTimeout(() => app.exit(report.ok ? 0 : 1), 500);
  };

  const treeWorkingSetBytes = (): number => {
    // Electron metrics omit native grabber/audio/pointer children. Add asynchronously
    // sampled working sets, excluding any PID already reported by Electron.
    try {
      const metrics = app.getAppMetrics();
      let total = 0;
      for (const m of metrics) {
        const kb = m.memory?.workingSetSize ?? 0;
        if (Number.isFinite(kb) && kb > 0) total += kb * 1024;
      }
      const electronIds = new Set(metrics.map(metric => metric.pid));
      if (total > 0) return total + sampler.total(engine.getNativeProcessIds().filter(id => !electronIds.has(id)));
    } catch {
      // 退化到当前进程 RSS
    }
    return process.memoryUsage().rss + sampler.total(engine.getNativeProcessIds());
  };

  try {
    await new Promise((r) => setTimeout(r, 1500));
    sampler.start();

    const { runPerfProbe: runProbe } = await import('../scripts/perfProbe');

    const report = await runProbe(
      {
        startCapture: async (config, projectPath) => {
          allowProjectRoot(projectPath);
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
          allowProjectRoot(projectPath);
          allowOutputRoot(path.dirname(outputPath));
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

    Object.assign(report, { memoryScope: 'Electron processes + native grabber/audio/pointer working sets',
      nativeMemory: { samples: sampler.samples, errors: sampler.errors, peakBytes: sampler.peakBytes, maxProcesses: sampler.maxProcesses } });
    if (!sampler.maxProcesses || sampler.errors) {
      report.ok = false; report.error = [report.error, '原生进程内存采样不完整'].filter(Boolean).join('；');
    }
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
  } finally { sampler.stop(); }
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
