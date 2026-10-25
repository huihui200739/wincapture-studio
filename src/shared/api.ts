/**
 * 界面层可用的 API 契约（preload 通过 contextBridge 暴露为 window.wcs）
 *
 * 这是主进程与渲染进程之间唯一的调用面：界面不直接接触 Node、文件系统或子进程。
 */

import type {
  AudioDeviceInfo,
  CaptureConfig,
  CaptureSourceInfo,
  CaptureStatus,
  DisplayInfo,
  ExportProfile,
  ExportProgress,
  ExportResult,
  IpcResponse,
  OverlayUpdate,
  QualityProfile,
  RecentProject,
  RecoverableSession,
  SystemInfo,
  VideoDeviceInfo,
} from './ipc';
import type { Project } from '../domain/project';
import type { PointerLog, RecordingMarker } from '../domain/types';

export interface MediaInfo {
  /** 相对工程路径 */
  path: string;
  /** 可直接用于 <video>/<audio> 的 URL */
  url: string;
  durationSeconds: number;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
}

export interface ProjectHandle {
  path: string;
  project: Project;
}

export interface SaveResult {
  path: string;
  revision: number;
  savedAt: number;
}

export interface TutorialExportResult {
  ok: boolean;
  /** 教程包目录 */
  outputDir: string;
  indexPath: string;
  markdownPath: string;
  stepsJsonPath: string;
  imageCount: number;
  error?: { code: string; message: string; retryable: boolean; preservedData: boolean };
}

export interface ExportBundleResult {
  video: ExportResult | null;
  tutorial: TutorialExportResult | null;
  /** 导出的工程快照哈希，用于追溯（§11.4） */
  snapshotHash: string;
}

export interface DiagnosticsReport {
  path: string;
  bytes: number;
  entries: string[];
}

export interface OverlayApi {
  /** 与主进程共享同一份 OverlayUpdate 结构，避免两处字段漂移 */
  update(payload: OverlayUpdate): void;
  onCommand(cb: (command: 'pause' | 'resume' | 'stop' | 'mark') => void): () => void;
  ready(): void;
}

export interface WcsApi {
  windowLayout(options: { mode: 'launcher' | 'editor' | 'selection' | 'maximize'; height?: number; sourceId?: string }): Promise<IpcResponse<{ width: number; height: number; target?: { x: number; y: number; width: number; height: number } }>>;
  desktop?: { frame(payload: unknown): void };
  recorder?: { onSegment(callback: (request: unknown) => void): () => void; complete(reply: unknown): void };
  // ---- 采集 ----
  listSources(options?: { kind?: 'screen' | 'window'; thumbnails?: boolean }): Promise<IpcResponse<CaptureSourceInfo[]>>;
  listDisplays(): Promise<IpcResponse<DisplayInfo[]>>;
  listDevices(): Promise<IpcResponse<{ audio: AudioDeviceInfo[]; video: VideoDeviceInfo[] }>>;
  qualityProfiles(): Promise<IpcResponse<QualityProfile[]>>;
  cameraPreview(enabled: boolean, deviceId?: string): Promise<IpcResponse<{ ok: boolean; png?: string; error?: string }>>;
  startCapture(config: CaptureConfig): Promise<IpcResponse<{ sessionId: string; projectPath: string; cameraNote?: string | null }>>;
  pauseCapture(): Promise<IpcResponse<CaptureStatus>>;
  resumeCapture(): Promise<IpcResponse<CaptureStatus>>;
  stopCapture(): Promise<IpcResponse<{ projectPath: string; status: CaptureStatus }>>;
  cancelCapture(): Promise<IpcResponse<null>>;
  addMarker(note: string): Promise<IpcResponse<RecordingMarker>>;
  captureStatus(): Promise<IpcResponse<CaptureStatus>>;
  onCaptureStatus(cb: (status: CaptureStatus) => void): () => void;

  // ---- 工程 ----
  createProject(name?: string): Promise<IpcResponse<ProjectHandle>>;
  /** 打开工程；用户在系统对话框取消时 data 为 null（不是错误）。 */
  openProject(path?: string): Promise<IpcResponse<ProjectHandle | null>>;
  saveProject(project: Project): Promise<IpcResponse<SaveResult>>;
  saveProjectAs(project: Project, targetPath?: string): Promise<IpcResponse<SaveResult>>;
  listRecentProjects(): Promise<IpcResponse<RecentProject[]>>;
  removeRecentProject(path: string): Promise<IpcResponse<null>>;
  deleteProject(path: string): Promise<IpcResponse<null>>;
  revealProject(path: string): Promise<IpcResponse<null>>;
  readMedia(projectPath: string, relativePath: string): Promise<IpcResponse<MediaInfo>>;
  readPointerLog(projectPath: string): Promise<IpcResponse<PointerLog | null>>;
  /**
   * 列出某个素材的全部录制分段（按时间排序）。
   * 录制时素材被切成多个自包含 MP4，导出/预览需要知道每段的起始时间。
   */
  listMediaSegments(
    projectPath: string,
    relativePath: string,
  ): Promise<IpcResponse<{ path: string; startTick: number; durationTicks: number; bytes: number }[]>>;
  exportPack(projectPath: string): Promise<IpcResponse<{ ok: boolean; outputPath: string | null }>>;
  importPack(): Promise<IpcResponse<ProjectHandle | null>>;
  listRecoverable(): Promise<IpcResponse<RecoverableSession[]>>;
  recoverSession(projectPath: string): Promise<IpcResponse<ProjectHandle>>;
  discardRecovery(projectPath: string): Promise<IpcResponse<null>>;

  // ---- 导出 ----
  startExport(params: {
    project: Project;
    profile: ExportProfile;
    outputPath: string;
    includeTutorial: boolean;
  }): Promise<IpcResponse<ExportBundleResult>>;
  cancelExport(): Promise<IpcResponse<null>>;
  onExportProgress(cb: (progress: ExportProgress) => void): () => void;
  /** 由导出渲染进程回报进度 */
  reportExportProgress(progress: ExportProgress): void;
  /** 导出渲染进程完成后回报 */
  completeExport(result: ExportResult): void;

  // ---- 系统 ----
  systemInfo(): Promise<IpcResponse<SystemInfo>>;
  pickSavePath(defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<IpcResponse<string | null>>;
  pickDirectory(): Promise<IpcResponse<string | null>>;
  openPath(path: string): Promise<IpcResponse<null>>;
  showInFolder(path: string): Promise<IpcResponse<null>>;
  checkPath(path: string): Promise<IpcResponse<{ ok: boolean; freeBytes: number; writable: boolean; reason?: string }>>;
  writeDiagnostics(): Promise<IpcResponse<DiagnosticsReport>>;

  // ---- 导出窗口专用的文件读写（渲染进程没有 node:fs）----
  /** 写文件（父目录自动创建）。用于导出 .partial、教程包图片与文档。 */
  writeExportFile(path: string, data: Uint8Array): Promise<IpcResponse<null>>;
  /** 读文件字节。用于解码素材、校验导出结果。 */
  readExportFile(path: string): Promise<IpcResponse<Uint8Array>>;
  /** 同卷原子改名（.partial → 最终文件）。 */
  renamePath(from: string, to: string): Promise<IpcResponse<null>>;
  /** 删除文件（不存在视为成功）。 */
  removePath(path: string): Promise<IpcResponse<null>>;
  /** 创建目录（递归）。 */
  makeDirectory(path: string): Promise<IpcResponse<null>>;

  // ---- 窗口 ----
  setAlwaysOnTop(value: boolean): Promise<IpcResponse<null>>;
  minimize(): Promise<IpcResponse<null>>;
  close(): Promise<IpcResponse<null>>;

  // ---- 应用级事件 ----
  onAppEvent(cb: (event: { type: string; payload: unknown }) => void): () => void;
  /** 录制悬浮窗 */
  overlay: OverlayApi | null;
  /** 当前窗口角色：main | overlay | exporter | recorder | camera */
  role: 'main' | 'overlay' | 'exporter' | 'recorder' | 'camera';
  platform: string;
}

declare global {
  interface Window {
    wcs: WcsApi;
  }
}
