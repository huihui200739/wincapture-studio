/**
 * 进程间协议（开发文档 §14）
 *
 * - 带长度前缀的版本化消息由 Electron IPC 承载；正文为 JSON。
 * - 消息头含 protocolVersion、requestId、sessionId 与 type。
 * - 高频电平/进度事件最多每秒 10 次（§14.3），在发送端节流。
 */

export const PROTOCOL_VERSION = 1;

export type CaptureState =
  | 'Idle'
  | 'Preparing'
  | 'Countdown'
  | 'Recording'
  | 'Pausing'
  | 'Paused'
  | 'Resuming'
  | 'Stopping'
  | 'Finalizing'
  | 'ReadyToEdit'
  | 'RecoverableFailure'
  | 'RecoveryReady'
  | 'Cancelled';

/** 录制状态机允许的转移（§9.1）。 */
export const CAPTURE_TRANSITIONS: Record<CaptureState, readonly CaptureState[]> = {
  Idle: ['Preparing', 'RecoveryReady'],
  Preparing: ['Countdown', 'Cancelled', 'RecoverableFailure'],
  Countdown: ['Recording', 'Cancelled', 'RecoverableFailure'],
  Recording: ['Pausing', 'Stopping', 'RecoverableFailure'],
  Pausing: ['Paused', 'RecoverableFailure'],
  Paused: ['Resuming', 'Stopping', 'RecoverableFailure'],
  Resuming: ['Recording', 'RecoverableFailure'],
  Stopping: ['Finalizing', 'RecoverableFailure'],
  Finalizing: ['ReadyToEdit', 'RecoverableFailure'],
  ReadyToEdit: ['Idle'],
  RecoverableFailure: ['RecoveryReady', 'Idle'],
  RecoveryReady: ['Idle'],
  Cancelled: ['Idle'],
};

export function canTransition(from: CaptureState, to: CaptureState): boolean {
  return CAPTURE_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface CaptureSourceInfo {
  /** 临时来源 ID，仅在本次进程内有效 */
  id: string;
  kind: 'screen' | 'window';
  name: string;
  /** 缩略图 dataURL（可选，来源选择器使用） */
  thumbnail?: string;
  appIcon?: string;
  displayId?: string;
  width: number;
  height: number;
  available: boolean;
}

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
  rotation: number;
  refreshRate?: number;
}

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  isDefault: boolean;
}

export interface VideoDeviceInfo {
  deviceId: string;
  label: string;
}

export interface QualityProfile {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  hardwarePreferred: boolean;
}

export const QUALITY_PROFILES: QualityProfile[] = [
  { id: '1080p60', label: '1080p · 60 帧', width: 1920, height: 1080, fps: 60, videoBitrate: 20_000_000, audioBitrate: 192_000, hardwarePreferred: true },
  { id: '1080p30', label: '1080p · 30 帧', width: 1920, height: 1080, fps: 30, videoBitrate: 12_000_000, audioBitrate: 192_000, hardwarePreferred: true },
  { id: '720p30', label: '720p · 30 帧', width: 1280, height: 720, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000, hardwarePreferred: true },
];

export interface CaptureConfig {
  sourceId: string;
  sourceKind: 'screen' | 'window';
  qualityId: string;
  fps: { num: number; den: number };
  /**
   * 只录显示器上的一块矩形区域（§7.1 / R01）。
   * 坐标是**源显示器内的物理像素偏移**，不是屏幕全局坐标；
   * 省略表示整屏。宽高会自动对齐到偶数（H.264 要求）。
   */
  region?: { x: number; y: number; width: number; height: number };
  /** 系统声音 */
  systemAudioEnabled: boolean;
  microphoneEnabled: boolean;
  microphoneDeviceId?: string;
  cameraEnabled: boolean;
  cameraDeviceId?: string;
  /** 录制前倒计时秒数 */
  countdownSeconds: number;
  /** 是否为 30 秒自动停止的测试模式（诊断用） */
  testMode?: boolean;
}

export interface CaptureStatus {
  state: CaptureState;
  sessionId: string | null;
  /** 会话媒体时间（已扣除暂停） */
  mediaTick: number;
  /** 实际生效的配置（可能因设备能力降级） */
  effective: {
    width: number;
    height: number;
    fps: number;
    videoCodec: string;
    audioCodec: string;
    hardwareEncoding: boolean;
  } | null;
  /** 降级原因，界面必须显示真实生效档位与原因（§9.5） */
  degradation: string | null;
  /** 最近一次错误 */
  error: { code: string; message: string; retryable: boolean; preservedData: boolean } | null;
  segmentsCommitted: number;
  /**
   * 累计采集到的帧数（含已切段但尚未编码的）。
   * 与 segmentsCommitted 的区别：分段要等 2 秒窗口关闭才提交，
   * 所以刚开录时 segmentsCommitted 还是 0，但 framesArrived 已经有值。
   * 界面用它判断「是否已经真正出画面」，性能探针用它量首帧延迟。
   */
  framesArrived: number;
  bytesWritten: number;
  /** 磁盘剩余空间（字节） */
  freeDiskBytes: number;
  /** 麦克风/系统声音电平 0..1，界面用于电平表 */
  levels: { mic: number; system: number };
  /** 是否在标记中 */
  markerCount: number;
  startedAt: number | null;
}

export interface ExportProfile {
  /** 输出画幅：landscape / square / portrait */
  variantId: string;
  width: number;
  height: number;
  fps: { num: number; den: number };
  videoBitrate: number;
  audioBitrate: number;
  /** 是否仅导出 AAC 音频，使用 M4A 容器。 */
  audioOnly: boolean;
  /** 教程产物 */
  includeTutorial: boolean;
}

export interface ExportRequest {
  snapshotId: string;
  profile: ExportProfile;
  outputPath: string;
}

export interface ExportProgress {
  jobId: string;
  /** 0..1 */
  progress: number;
  phase: 'preparing' | 'rendering' | 'encoding' | 'muxing' | 'finalizing' | 'done' | 'cancelled' | 'failed';
  framesDone: number;
  framesTotal: number;
  message: string;
  /** 已完成字节数 */
  bytesWritten: number;
}

export interface ExportResult {
  jobId: string;
  ok: boolean;
  outputPath: string | null;
  /** 实际编码器（硬件/软件） */
  encoder: string;
  error: { code: string; message: string; retryable: boolean; preservedData: boolean } | null;
  durationTicks: number;
  frames: number;
  bytes: number;
  /** 完整性检查结果 */
  verified: boolean;
  /**
   * 非致命降级说明（素材缺失、音频解码失败、临时文件未删掉……）。
   * 导出成功但内容有降级时必须透出，不能只写进日志。
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// IPC 通道
// ---------------------------------------------------------------------------

export const IPC = {
  // 采集
  captureListSources: 'capture:list-sources',
  /** 显示器枚举（返回 DisplayInfo[]，含 bounds/scaleFactor），与来源列表是两件事 */
  captureListDisplays: 'capture:list-displays',
  captureListDevices: 'capture:list-devices',
  captureStart: 'capture:start',
  capturePause: 'capture:pause',
  captureResume: 'capture:resume',
  captureStop: 'capture:stop',
  captureCancel: 'capture:cancel',
  captureMark: 'capture:mark',
  captureStatus: 'capture:status',
  captureEvent: 'capture:event',

  // 工程
  projectCreate: 'project:create',
  projectOpen: 'project:open',
  projectSave: 'project:save',
  projectSaveAs: 'project:save-as',
  projectListRecent: 'project:list-recent',
  projectRemoveRecent: 'project:remove-recent',
  projectDelete: 'project:delete',
  projectReveal: 'project:reveal',
  projectImportPack: 'project:import-pack',
  projectExportPack: 'project:export-pack',
  projectReadMedia: 'project:read-media',
  /** 读取指针轨迹（预览/导出用；工程目录内的相对路径） */
  projectReadPointerLog: 'project:read-pointer-log',
  projectRecoverable: 'project:list-recoverable',
  projectRecover: 'project:recover',
  projectDiscardRecovery: 'project:discard-recovery',

  // 导出
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress',
  /** 导出渲染进程完成后回报（一次性事件，不是 invoke） */
  exportComplete: 'export:complete',

  // 文件读写（导出/录制窗口专用；渲染进程没有 node:fs）
  fileWrite: 'file:write',
  fileRead: 'file:read',
  fileRename: 'file:rename',
  fileRemove: 'file:remove',
  fileMkdir: 'file:mkdir',
  fileListSegments: 'file:list-segments',

  // 系统
  systemInfo: 'system:info',
  systemPickFile: 'system:pick-file',
  systemPickDirectory: 'system:pick-directory',
  systemOpenPath: 'system:open-path',
  systemShowInFolder: 'system:show-in-folder',
  systemDiagnostics: 'system:diagnostics',
  systemCheckPath: 'system:check-path',

  // 窗口
  windowSetAlwaysOnTop: 'window:set-always-on-top',
  windowMinimize: 'window:minimize',
  windowClose: 'window:close',
  windowOpenOverlay: 'window:open-overlay',
  windowCloseOverlay: 'window:close-overlay',
  windowUpdateOverlay: 'window:update-overlay',

  // 悬浮窗（录制控制条）
  /** 主进程 → 悬浮窗的命令（暂停/恢复/停止/标记）；悬浮窗就绪前发送会被丢弃 */
  overlayCommand: 'overlay:command',
  /** 悬浮窗 → 主进程：控制条已挂载，可接收命令 */
  overlayReady: 'overlay:ready',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface SystemInfo {
  platform: string;
  arch: string;
  osVersion: string;
  electronVersion: string;
  chromeVersion: string;
  appVersion: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  /** 应用数据目录 */
  userDataPath: string;
  /** 默认输出目录（视频文件夹） */
  videosPath: string;
  /** 是否有可用的硬件编码器 */
  hardwareEncoding: boolean;
  /** 录制能力探测结果 */
  captureCapabilities: {
    screen: boolean;
    window: boolean;
    systemAudio: boolean;
    microphone: boolean;
    camera: boolean;
    /** 指定应用声音（P1，Windows 11 24H2+ 且按接口激活结果检测） */
    applicationAudio: boolean;
  };
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
  durationTicks: number;
  thumbnail?: string;
  missingMedia: boolean;
  recoverable: boolean;
}

export interface RecoverableSession {
  projectPath: string;
  sessionId: string;
  name: string;
  createdAt: number;
  committedSegments: number;
  durationTicks: number;
  /** 可能损失的尾段时长 */
  estimatedLossTicks: number;
}

export interface OverlayUpdate {
  state: CaptureState;
  mediaTick: number;
  markerCount: number;
  levels: { mic: number; system: number };
  paused: boolean;
}

/** 请求/响应封装，统一错误结构（§14.3）。 */
export interface IpcResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean; preservedData: boolean };
}
