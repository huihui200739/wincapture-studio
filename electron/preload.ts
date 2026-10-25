/**
 * preload：通过 contextBridge 暴露 window.wcs（严格匹配 src/shared/api.ts 的 WcsApi）
 *
 * 安全约定：
 *   - 渲染进程不直接接触 Node、文件系统、子进程
 *   - 只暴露白名单方法，参数与返回值都是可结构化克隆的普通对象
 */

import { contextBridge, ipcRenderer } from 'electron';

import { IPC } from '../src/shared/ipc';
import type { WcsApi } from '../src/shared/api';

/** 统一调用：返回 { ok, data, error }，不抛异常到渲染进程。 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await ipcRenderer.invoke(channel, ...args)) as T;
}

/** 订阅事件，返回取消函数。 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener as never);
  return () => {
    ipcRenderer.removeListener(channel, listener as never);
  };
}

const role: 'main' | 'overlay' | 'exporter' | 'recorder' | 'camera' = (() => {
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  if (hash.includes('overlay')) return 'overlay';
  if (hash.includes('exporter')) return 'exporter';
  if (hash.includes('camera')) return 'camera';
  if (hash.includes('recorder')) return 'recorder';
  return 'main';
})();

const api: WcsApi = {
  windowLayout: options => invoke(IPC.windowLayout, options),
  recorder: role === 'recorder' ? { onSegment: callback => subscribe(IPC.recorderSegment, callback), complete: reply => ipcRenderer.send(IPC.recorderResult, reply) } : undefined,
  desktop: location.hash.includes('camera-desktop') ? { frame: payload => ipcRenderer.send(IPC.captureDesktopFrame, payload) } : undefined,
  cameraPreview: (enabled, deviceId) => invoke(IPC.captureCameraPreview, enabled, deviceId),
  // ---- 采集 ----
  listSources: (options) => invoke(IPC.captureListSources, options),
  // 注意：listSources 返回 CaptureSourceInfo[]（含 display:0 临时 ID），
  // listDisplays 必须是独立的 DisplayInfo[]（id=显示器 id、含 bounds/scaleFactor）。
  listDisplays: () => invoke(IPC.captureListDisplays),
  listDevices: () => invoke(IPC.captureListDevices),
  qualityProfiles: async () => ({ ok: true, data: (await import('../src/shared/ipc')).QUALITY_PROFILES }),
  startCapture: (config) => invoke(IPC.captureStart, config),
  pauseCapture: () => invoke(IPC.capturePause),
  resumeCapture: () => invoke(IPC.captureResume),
  stopCapture: () => invoke(IPC.captureStop),
  cancelCapture: () => invoke(IPC.captureCancel),
  addMarker: (note) => invoke(IPC.captureMark, note),
  captureStatus: () => invoke(IPC.captureStatus),
  onCaptureStatus: (cb) => subscribe(IPC.captureStatus, cb),

  // ---- 工程 ----
  createProject: (name) => invoke(IPC.projectCreate, name),
  openProject: (p) => invoke(IPC.projectOpen, p),
  saveProject: (project) => invoke(IPC.projectSave, project),
  saveProjectAs: (project, targetPath) => invoke(IPC.projectSaveAs, project, targetPath),
  listRecentProjects: () => invoke(IPC.projectListRecent),
  removeRecentProject: (p) => invoke(IPC.projectRemoveRecent, p),
  deleteProject: (p) => invoke(IPC.projectDelete, p),
  revealProject: (p) => invoke(IPC.projectReveal, p),
  readMedia: (projectPath, relativePath) => invoke(IPC.projectReadMedia, projectPath, relativePath),
  readPointerLog: (projectPath) => invoke(IPC.projectReadPointerLog, projectPath),
  listMediaSegments: (projectPath, relativePath) => invoke(IPC.fileListSegments, projectPath, relativePath),
  exportPack: (projectPath) => invoke(IPC.projectExportPack, projectPath),
  importPack: () => invoke(IPC.projectImportPack),
  listRecoverable: () => invoke(IPC.projectRecoverable),
  recoverSession: (projectPath) => invoke(IPC.projectRecover, projectPath),
  discardRecovery: (projectPath) => invoke(IPC.projectDiscardRecovery, projectPath),

  // ---- 导出 ----
  startExport: (params) => invoke(IPC.exportStart, params),
  cancelExport: () => invoke(IPC.exportCancel),
  onExportProgress: (cb) => subscribe(IPC.exportProgress, cb),
  reportExportProgress: (progress) => {
    ipcRenderer.send(IPC.exportProgress, progress);
  },
  completeExport: (result) => {
    ipcRenderer.send(IPC.exportComplete, result);
  },

  // ---- 系统 ----
  systemInfo: () => invoke(IPC.systemInfo),
  pickSavePath: (defaultName, filters) => invoke(IPC.systemPickFile, defaultName, filters),
  pickDirectory: () => invoke(IPC.systemPickDirectory),
  openPath: (p) => invoke(IPC.systemOpenPath, p),
  showInFolder: (p) => invoke(IPC.systemShowInFolder, p),
  checkPath: (p) => invoke(IPC.systemCheckPath, p),
  writeDiagnostics: () => invoke(IPC.systemDiagnostics),

  // ---- 文件读写（导出/录制窗口专用）----
  writeExportFile: (p, data) => invoke(IPC.fileWrite, p, data),
  readExportFile: (p) => invoke(IPC.fileRead, p),
  renamePath: (from, to) => invoke(IPC.fileRename, from, to),
  removePath: (p) => invoke(IPC.fileRemove, p),
  makeDirectory: (p) => invoke(IPC.fileMkdir, p),

  // ---- 窗口 ----
  setAlwaysOnTop: (value) => invoke(IPC.windowSetAlwaysOnTop, value),
  minimize: () => invoke(IPC.windowMinimize),
  close: () => invoke(IPC.windowClose),

  // ---- 应用级事件 ----
  onAppEvent: (cb) => subscribe(IPC.captureEvent, cb),

  // ---- 录制悬浮窗 ----
  overlay:
    role === 'overlay'
      ? {
          // 走 invoke 而不是 send：主进程侧用 ipcMain.handle 注册了该通道，
          // 原来用 send 时消息永远到不了 handler（静默丢失）。
          update: (payload) => {
            void invoke(IPC.windowUpdateOverlay, payload);
          },
          onCommand: (cb) => subscribe(IPC.overlayCommand, cb),
          ready: () => {
            ipcRenderer.send(IPC.overlayReady);
          },
        }
      : null,

  role,
  platform: process.platform,
};

contextBridge.exposeInMainWorld('wcs', api);
