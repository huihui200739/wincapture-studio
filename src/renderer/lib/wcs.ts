/**
 * window.wcs 薄封装层（唯一允许直接访问 window.wcs 的文件）
 *
 * 优先使用 preload 注入的真实实现；不存在时回退到内置 mock，
 * 这样界面层可以独立跑起来验证，wp-a-capture 就绪后无需改动业务代码即可切换。
 *
 * 约定：
 * - 业务代码只从 `wcs()` / `apiStatus()` 取能力，不直接读 window.wcs。
 * - mock 与真实实现的签名完全一致（严格满足 src/shared/api.ts 的 WcsApi）。
 */

import type {
  DiagnosticsReport,
  ExportBundleResult,
  MediaInfo,
  ProjectHandle,
  SaveResult,
  WcsApi,
} from '@shared/api';
import type {
  AudioDeviceInfo,
  CaptureConfig,
  CaptureSourceInfo,
  CaptureStatus,
  DisplayInfo,
  ExportProgress,
  IpcResponse,
  QualityProfile,
  RecentProject,
  RecoverableSession,
  SystemInfo,
  VideoDeviceInfo,
} from '@shared/ipc';
import { QUALITY_PROFILES } from '@shared/ipc';
import { AppError } from '@shared/errors';
import type { Project } from '@domain/project';
import { createEmptyProject } from '@domain/project';
import type { RecordingMarker } from '@domain/types';
import { TICKS_PER_SECOND } from '@domain/timebase';
import {
  MOCK_PROJECT_PATH,
  createMockProject,
  mockDevices,
  mockDisplays,
  mockQualityProfiles,
  mockRecentProjects,
  mockRecoverable,
  mockSources,
  mockSystemInfo,
} from './mockData';

const S = TICKS_PER_SECOND;

export type ApiMode = 'native' | 'mock';

/**
 * 非交互型 IPC 的超时预算（毫秒）。
 * 打开工程/选择路径/导出这类「用户会一直看着」的操作不设短超时：
 * 它们本身就是长任务，超时会把正常的慢操作误报为失败。
 */
export const IPC_TIMEOUT = {
  save: 30_000,
  list: 15_000,
  system: 20_000,
  diagnostics: 60_000,
  recovery: 60_000,
} as const;

/**
 * 给 IPC 调用加超时。主进程无响应（进程卡死/通道未注册）时，
 * 渲染层原本会永远停在「保存中…」并且按钮一直禁用；加上超时后至少能报错重试。
 *
 * 注意：超时只影响本次调用的等待，底层 IPC 请求无法撤销；
 * 调用方必须用「序号/工程快照比较」丢弃迟到的结果（见 store.openProject / save）。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, action: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AppError({
          code: 'E_UNKNOWN',
          message: `「${action}」超时（超过 ${Math.round(ms / 1000)} 秒），主进程可能无响应。请重试；若反复超时，可在设置页导出诊断日志。`,
          retryable: true,
          preservedData: true,
          detail: `ipc timeout: ${action} > ${ms}ms`,
        }),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function detectApiMode(): ApiMode {
  return typeof window !== 'undefined' && window.wcs ? 'native' : 'mock';
}

// ---------------------------------------------------------------------------
// mock 实现
// ---------------------------------------------------------------------------

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(value: T): void {
    for (const cb of this.listeners) {
      try {
        cb(value);
      } catch (error) {
        console.error('[mock] listener error', error);
      }
    }
  }
}

interface MockSession {
  config: CaptureConfig;
  projectPath: string;
  project: Project;
  sessionId: string;
  state: CaptureStatus['state'];
  mediaTick: number;
  pausedAccum: number;
  lastRealTick: number;
  paused: boolean;
  markerCount: number;
  freeDiskBytes: number;
  bytesWritten: number;
  effective: NonNullable<CaptureStatus['effective']>;
  degradation: string | null;
  timer: number | null;
}

function ok<T>(data: T): IpcResponse<T> {
  return { ok: true, data };
}

function fail<T>(code: string, message: string, retryable = true, preservedData = true): IpcResponse<T> {
  return { ok: false, error: { code, message, retryable, preservedData } } as IpcResponse<T>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockWcs implements WcsApi {
  async cameraPreview(): Promise<IpcResponse<{ ok: boolean; error?: string }>> { return ok({ ok: false, error: '示例模式不打开摄像头' }); }
  readonly role = 'main' as const;
  readonly platform = 'win32';
  readonly overlay = null;

  private statusEmitter = new Emitter<CaptureStatus>();
  private exportEmitter = new Emitter<ExportProgress>();
  private appEmitter = new Emitter<{ type: string; payload: unknown }>();

  private session: MockSession | null = null;
  private project = createMockProject();
  private recents: RecentProject[] = mockRecentProjects();
  private recoverables: RecoverableSession[] = mockRecoverable();
  private exportTimer: number | null = null;
  private exportJob: { cancelled: boolean; progress: number } | null = null;

  // ---- 采集 ----

  async listSources(): Promise<IpcResponse<CaptureSourceInfo[]>> {
    await delay(90);
    return ok(mockSources());
  }

  async listDisplays(): Promise<IpcResponse<DisplayInfo[]>> {
    await delay(40);
    return ok(mockDisplays());
  }

  async listDevices(): Promise<IpcResponse<{ audio: AudioDeviceInfo[]; video: VideoDeviceInfo[] }>> {
    await delay(60);
    return ok(mockDevices());
  }

  async qualityProfiles(): Promise<IpcResponse<QualityProfile[]>> {
    return ok(mockQualityProfiles());
  }

  async startCapture(config: CaptureConfig): Promise<IpcResponse<{ sessionId: string; projectPath: string }>> {
    if (this.session) return fail('E_UNKNOWN', '已有录制会话在进行中。');
    const quality = QUALITY_PROFILES.find((q) => q.id === config.qualityId) ?? QUALITY_PROFILES[1];
    const source = mockSources().find((s) => s.id === config.sourceId);
    if (source && !source.available) {
      return fail('E_SOURCE_CLOSED', '该窗口受系统保护，无法采集。请换一个窗口，或改用显示器录制。', false);
    }
    const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`;
    const projectPath = MOCK_PROJECT_PATH;
    const degradation =
      source && source.width > quality.width
        ? `来源分辨率 ${source.width} × ${source.height} 高于输出档位，已按 ${quality.width} × ${quality.height} 缩放输出。`
        : null;
    const session: MockSession = {
      config,
      projectPath,
      project: createMockProject(),
      sessionId,
      state: 'Preparing',
      mediaTick: 0,
      pausedAccum: 0,
      lastRealTick: performance.now(),
      paused: false,
      markerCount: 0,
      freeDiskBytes: 78 * 1024 ** 3,
      bytesWritten: 0,
      effective: {
        width: quality.width,
        height: quality.height,
        fps: quality.fps,
        videoCodec: 'H.264 (Media Foundation)',
        audioCodec: 'AAC 48 kHz',
        hardwareEncoding: true,
      },
      degradation,
      timer: null,
    };
    this.session = session;
    this.emitStatus();
    this.startTicker();

    void (async () => {
      await delay(420);
      if (this.session !== session) return;
      session.state = 'Countdown';
      this.emitStatus();
      await delay(Math.max(0, config.countdownSeconds) * 1000);
      if (this.session !== session) return;
      session.state = 'Recording';
      session.lastRealTick = performance.now();
      this.emitStatus();
      this.appEmitter.emit({ type: 'capture:recording-started', payload: { sessionId } });
    })();

    return ok({ sessionId, projectPath });
  }

  async pauseCapture(): Promise<IpcResponse<CaptureStatus>> {
    const s = this.session;
    if (!s) return fail('E_UNKNOWN', '当前没有录制会话。');
    if (s.state !== 'Recording') return fail('E_UNKNOWN', '当前状态不能暂停。');
    s.state = 'Pausing';
    this.emitStatus();
    await delay(220);
    if (this.session !== s) return fail('E_UNKNOWN', '录制会话已结束。');
    s.state = 'Paused';
    s.paused = true;
    this.emitStatus();
    return ok(this.snapshot());
  }

  async resumeCapture(): Promise<IpcResponse<CaptureStatus>> {
    const s = this.session;
    if (!s) return fail('E_UNKNOWN', '当前没有录制会话。');
    if (s.state !== 'Paused') return fail('E_UNKNOWN', '当前状态不能恢复。');
    s.state = 'Resuming';
    this.emitStatus();
    await delay(200);
    if (this.session !== s) return fail('E_UNKNOWN', '录制会话已结束。');
    s.state = 'Recording';
    s.paused = false;
    s.lastRealTick = performance.now();
    this.emitStatus();
    return ok(this.snapshot());
  }

  async stopCapture(): Promise<IpcResponse<{ projectPath: string; status: CaptureStatus }>> {
    const s = this.session;
    if (!s) return fail('E_UNKNOWN', '当前没有录制会话。');
    if (s.state === 'Stopping' || s.state === 'Finalizing') {
      return ok({ projectPath: s.projectPath, status: this.snapshot() });
    }
    s.state = 'Stopping';
    this.emitStatus();
    await delay(380);
    if (this.session !== s) return fail('E_UNKNOWN', '录制会话已结束。');
    s.state = 'Finalizing';
    this.emitStatus();
    await delay(620);
    if (this.session !== s) return fail('E_UNKNOWN', '录制会话已结束。');
    s.state = 'ReadyToEdit';
    this.stopTicker();
    const status = this.snapshot();
    // 用录制时长修正示例工程时长
    const duration = Math.max(4 * S, s.mediaTick);
    const project = createMockProject();
    project.name = `录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    project.assets = project.assets.map((a) => ({ ...a, durationTicks: duration }));
    const main = project.tracks.find((t) => t.kind === 'primaryVideo');
    if (main) {
      const half = Math.round(duration * 0.42);
      main.clips = [
        { ...main.clips[0], sourceDurationTicks: half },
        { ...main.clips[1], sourceInTicks: half, sourceDurationTicks: duration - half, timelineInTicks: half },
      ];
    }
    const camera = project.tracks.find((t) => t.kind === 'camera');
    if (camera) {
      const half = Math.round(duration * 0.42);
      camera.clips = [
        { ...camera.clips[0], sourceDurationTicks: half },
        { ...camera.clips[1], sourceInTicks: half, sourceDurationTicks: duration - half, timelineInTicks: half },
      ];
    }
    for (const track of project.tracks) {
      if (track.kind === 'mic' || track.kind === 'system') {
        track.clips = track.clips.map((c) => ({ ...c, sourceDurationTicks: duration }));
      }
    }
    project.markers = s.project.markers.slice();
    this.project = project;
    this.recents = [
      {
        id: project.id,
        name: project.name,
        path: s.projectPath,
        updatedAt: Date.now(),
        durationTicks: duration,
        thumbnail: undefined,
        missingMedia: false,
        recoverable: false,
      },
      ...this.recents.filter((r) => r.path !== s.projectPath),
    ];
    const finalStatus: CaptureStatus = { ...status, state: 'ReadyToEdit', mediaTick: duration };
    this.session = null;
    this.statusEmitter.emit(finalStatus);
    this.appEmitter.emit({ type: 'capture:ready-to-edit', payload: { projectPath: s.projectPath } });
    return ok({ projectPath: s.projectPath, status: finalStatus });
  }

  async cancelCapture(): Promise<IpcResponse<null>> {
    const s = this.session;
    if (!s) return ok(null);
    this.stopTicker();
    s.state = 'Cancelled';
    this.emitStatus();
    this.session = null;
    return ok(null);
  }

  async addMarker(note: string): Promise<IpcResponse<RecordingMarker>> {
    const s = this.session;
    if (!s) return fail('E_UNKNOWN', '当前没有录制会话，无法添加标记。');
    const marker: RecordingMarker = {
      id: `marker-${Date.now().toString(36)}`,
      mediaTick: s.mediaTick,
      note,
      createdAt: Date.now(),
    };
    s.project.markers.push(marker);
    s.markerCount += 1;
    this.emitStatus();
    return ok(marker);
  }

  async captureStatus(): Promise<IpcResponse<CaptureStatus>> {
    return ok(this.snapshot());
  }

  onCaptureStatus(cb: (status: CaptureStatus) => void): () => void {
    return this.statusEmitter.on(cb);
  }

  // ---- 工程 ----

  async createProject(name?: string): Promise<IpcResponse<ProjectHandle>> {
    await delay(60);
    const project = createEmptyProject(`project-${Date.now().toString(36)}`, name?.trim() || '未命名工程');
    return ok({ path: `C:\\Users\\huihui\\Documents\\WinCapture\\${project.name}.wcaproj`, project });
  }

  async openProject(path?: string): Promise<IpcResponse<ProjectHandle>> {
    await delay(120);
    const project = this.project;
    return ok({ path: path ?? MOCK_PROJECT_PATH, project: structuredClone(project) });
  }

  async saveProject(project: Project): Promise<IpcResponse<SaveResult>> {
    await delay(90);
    this.project = structuredClone(project);
    return ok({ path: MOCK_PROJECT_PATH, revision: project.revision, savedAt: Date.now() });
  }

  async saveProjectAs(project: Project, targetPath?: string): Promise<IpcResponse<SaveResult>> {
    await delay(90);
    this.project = structuredClone(project);
    return ok({ path: targetPath ?? MOCK_PROJECT_PATH, revision: project.revision, savedAt: Date.now() });
  }

  async listRecentProjects(): Promise<IpcResponse<RecentProject[]>> {
    await delay(80);
    return ok(this.recents.slice());
  }

  async removeRecentProject(path: string): Promise<IpcResponse<null>> {
    this.recents = this.recents.filter((r) => r.path !== path);
    return ok(null);
  }

  async deleteProject(path: string): Promise<IpcResponse<null>> {
    await delay(120);
    // mock 里没有磁盘可删，但「最近工程」必须同步移除，否则界面出现假成功
    this.recents = this.recents.filter((item) => item.path !== path);
    return ok(null);
  }

  async revealProject(_path: string): Promise<IpcResponse<null>> {
    return ok(null);
  }

  async readMedia(_projectPath: string, relativePath: string): Promise<IpcResponse<MediaInfo>> {
    const asset = this.project.assets.find((a) => a.path === relativePath);
    return ok({
      path: relativePath,
      url: '',
      durationSeconds: (asset?.durationTicks ?? 0) / S,
      width: asset?.width ?? 0,
      height: asset?.height ?? 0,
      sampleRate: asset?.sampleRate ?? 0,
      channels: asset?.channels ?? 0,
    });
  }

  async readPointerLog(): Promise<IpcResponse<null>> {
    return ok(null);
  }

  async exportPack(_projectPath: string): Promise<IpcResponse<{ ok: boolean; outputPath: string | null }>> {
    await delay(500);
    return ok({ ok: true, outputPath: 'C:\\Users\\huihui\\Documents\\WinCapture\\演示工程.wcapack' });
  }

  async importPack(): Promise<IpcResponse<ProjectHandle | null>> {
    await delay(300);
    return ok({ path: MOCK_PROJECT_PATH, project: structuredClone(this.project) });
  }

  async listRecoverable(): Promise<IpcResponse<RecoverableSession[]>> {
    await delay(70);
    return ok(this.recoverables.slice());
  }

  async recoverSession(projectPath: string): Promise<IpcResponse<ProjectHandle>> {
    await delay(420);
    this.recoverables = this.recoverables.filter((r) => r.projectPath !== projectPath);
    return ok({ path: projectPath, project: createMockProject() });
  }

  async discardRecovery(projectPath: string): Promise<IpcResponse<null>> {
    this.recoverables = this.recoverables.filter((r) => r.projectPath !== projectPath);
    return ok(null);
  }

  // ---- 导出 ----

  async startExport(params: {
    project: Project;
    profile: { variantId: string; width: number; height: number; fps: { num: number; den: number }; videoBitrate: number; audioBitrate: number; audioOnly: boolean; includeTutorial: boolean };
    outputPath: string;
    includeTutorial: boolean;
  }): Promise<IpcResponse<ExportBundleResult>> {
    if (this.exportJob) return fail('E_EXPORT_FAILED', '已有导出任务在进行中，请等待完成或取消。');
    // 示例数据模式下没有真实导出管线：绝不返回「成功」的假结果，
    // 否则用户会以为视频已落盘（实际一个字节都没写）。这里显式失败。
    this.exportEmitter.emit({
      jobId: `mock-${Date.now().toString(36)}`,
      progress: 0,
      phase: 'failed',
      framesDone: 0,
      framesTotal: 0,
      message: '示例数据模式无法导出',
      bytesWritten: 0,
    });
    return fail(
      'E_EXPORT_FAILED',
      '示例数据模式无法导出视频：当前没有连接主进程，不会写出任何文件。请用 npm start 启动完整应用后再导出。',
      false,
    );
  }

  async cancelExport(): Promise<IpcResponse<null>> {
    if (this.exportJob) this.exportJob.cancelled = true;
    if (this.exportTimer !== null) {
      window.clearTimeout(this.exportTimer);
      this.exportTimer = null;
    }
    return ok(null);
  }

  onExportProgress(cb: (progress: ExportProgress) => void): () => void {
    return this.exportEmitter.on(cb);
  }

  reportExportProgress(): void {
    /* mock 不需要 */
  }

  completeExport(): void {
    /* mock 不需要 */
  }

  // ---- 系统 ----

  async systemInfo(): Promise<IpcResponse<SystemInfo>> {
    await delay(50);
    return ok(mockSystemInfo());
  }

  async pickSavePath(defaultName: string): Promise<IpcResponse<string | null>> {
    await delay(120);
    const base = 'C:\\Users\\huihui\\Videos\\WinCapture Studio';
    return ok(`${base}\\${defaultName.replace(/\.mp4$/i, '')}.mp4`);
  }

  async pickDirectory(): Promise<IpcResponse<string | null>> {
    await delay(120);
    return ok('C:\\Users\\huihui\\Videos\\WinCapture Studio');
  }

  async openPath(_path: string): Promise<IpcResponse<null>> {
    return ok(null);
  }

  async showInFolder(_path: string): Promise<IpcResponse<null>> {
    return ok(null);
  }

  async checkPath(_path: string): Promise<IpcResponse<{ ok: boolean; freeBytes: number; writable: boolean; reason?: string }>> {
    await delay(80);
    return ok({ ok: true, freeBytes: 78 * 1024 ** 3, writable: true });
  }

  async writeDiagnostics(): Promise<IpcResponse<DiagnosticsReport>> {
    await delay(400);
    return ok({
      path: 'C:\\Users\\huihui\\AppData\\Roaming\\WinCapture Studio\\diagnostics-20261021.zip',
      bytes: 1_248_512,
      entries: ['system.json', 'capture.log', 'renderer.log', 'project-summary.json'],
    });
  }

  // ---- 文件读写（导出/录制窗口专用；mock 模式不落盘）----

  async listMediaSegments(
    _projectPath: string,
    relativePath: string,
  ): Promise<IpcResponse<{ path: string; startTick: number; durationTicks: number; bytes: number }[]>> {
    await delay(60);
    // mock：把单个素材当作一个完整分段
    return ok([{ path: relativePath, startTick: 0, durationTicks: 60_000_000, bytes: 4_000_000 }]);
  }

  async writeExportFile(_path: string, _data: Uint8Array): Promise<IpcResponse<null>> {
    await delay(40);
    return ok(null);
  }

  async readExportFile(path: string): Promise<IpcResponse<Uint8Array>> {
    await delay(40);
    return fail('E_MEDIA_MISSING', `mock 模式无法读取真实文件：${path}`);
  }

  async renamePath(_from: string, _to: string): Promise<IpcResponse<null>> {
    await delay(40);
    return ok(null);
  }

  async removePath(_path: string): Promise<IpcResponse<null>> {
    await delay(40);
    return ok(null);
  }

  async makeDirectory(_path: string): Promise<IpcResponse<null>> {
    await delay(40);
    return ok(null);
  }

  // ---- 窗口 ----

  async setAlwaysOnTop(_value: boolean): Promise<IpcResponse<null>> {
    return ok(null);
  }

  async windowLayout(options: { mode: 'launcher' | 'editor' | 'selection' | 'maximize'; height?: number; sourceId?: string }): Promise<IpcResponse<{ width: number; height: number }>> {
    return ok({ width: window.innerWidth, height: options.height ?? window.innerHeight });
  }

  async minimize(): Promise<IpcResponse<null>> {
    return ok(null);
  }

  async close(): Promise<IpcResponse<null>> {
    return ok(null);
  }

  onAppEvent(cb: (event: { type: string; payload: unknown }) => void): () => void {
    return this.appEmitter.on(cb);
  }

  // ---- 内部 ----

  private snapshot(): CaptureStatus {
    const s = this.session;
    if (!s) {
      return {
        state: 'Idle',
        sessionId: null,
        mediaTick: 0,
        effective: null,
        degradation: null,
        error: null,
        segmentsCommitted: 0,
        framesArrived: 0,
        bytesWritten: 0,
        freeDiskBytes: 78 * 1024 ** 3,
        levels: { mic: 0, system: 0 },
        markerCount: 0,
        startedAt: null,
      };
    }
    return {
      state: s.state,
      sessionId: s.sessionId,
      mediaTick: s.mediaTick,
      effective: s.effective,
      degradation: s.degradation,
      error: null,
      segmentsCommitted: Math.floor(s.mediaTick / (2 * S)),
      // mock 里按 30fps 推算已到达帧数，让界面上的「首帧已到」判断也有值
      framesArrived: Math.floor(s.mediaTick / (10_000_000 / 30)),
      bytesWritten: s.bytesWritten,
      freeDiskBytes: s.freeDiskBytes,
      levels: this.levels(),
      markerCount: s.markerCount,
      startedAt: Date.now() - Math.round(s.mediaTick / 10_000),
    };
  }

  private emitStatus(): void {
    this.statusEmitter.emit(this.snapshot());
  }

  private levels(): { mic: number; system: number } {
    const t = performance.now() / 1000;
    const s = this.session;
    if (!s || s.state === 'Paused' || s.state === 'Idle') return { mic: 0, system: 0 };
    const mic = Math.max(0, 0.34 + Math.sin(t * 5.1) * 0.22 + Math.sin(t * 11.7) * 0.1);
    const system = Math.max(0, 0.18 + Math.sin(t * 3.3 + 1.2) * 0.14 + Math.sin(t * 9.1) * 0.06);
    return { mic: Math.min(1, mic), system: Math.min(1, system) };
  }

  private startTicker(): void {
    this.stopTicker();
    const s = this.session;
    if (!s) return;
    const step = () => {
      if (this.session !== s) return;
      const now = performance.now();
      const dt = now - s.lastRealTick;
      s.lastRealTick = now;
      if (s.state === 'Recording' && !s.paused) {
        s.mediaTick += dt * 10_000;
        const quality = QUALITY_PROFILES.find((q) => q.id === s.config.qualityId) ?? QUALITY_PROFILES[1];
        s.bytesWritten += ((quality.videoBitrate + quality.audioBitrate) / 8) * (dt / 1000);
        s.freeDiskBytes = Math.max(0, s.freeDiskBytes - ((quality.videoBitrate + quality.audioBitrate) / 8) * (dt / 1000));
      }
      this.emitStatus();
      s.timer = window.setTimeout(step, 100);
    };
    s.timer = window.setTimeout(step, 100);
  }

  private stopTicker(): void {
    const s = this.session;
    if (s?.timer != null) {
      window.clearTimeout(s.timer);
      s.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

let cached: WcsApi | null = null;
let cachedMode: ApiMode = 'mock';

/**
 * 取得可用的 API 实现（真实优先，其次 mock）。
 *
 * mock 回退是**演示与自动化探针（scripts/verify-ui.cjs 不注入 preload）**的
 * 既定能力，不是生产数据源。使用它的代码必须遵守：
 * - 任何「写」操作都不能假装成功：MockWcs.startExport 直接失败，
 *   store.save 会明确提示“仅内存、未写入磁盘”；
 * - mock 工程/最近工程只存在于内存，绝不写真实工程目录；
 * - 界面必须显示「示例数据模式」标识（见 App / Home / Settings）。
 */
export function wcs(): WcsApi {
  if (!cached) {
    if (typeof window !== 'undefined' && window.wcs) {
      cached = window.wcs;
      cachedMode = 'native';
    } else {
      cached = new MockWcs();
      cachedMode = 'mock';
    }
  }
  return cached;
}

/** 当前实际使用的实现模式。 */
export function apiMode(): ApiMode {
  wcs();
  return cachedMode;
}

export function isMockMode(): boolean {
  return apiMode() === 'mock';
}

/** 测试/调试用：强制重新探测（例如 preload 延迟注入时）。 */
export function resetApiProbe(): void {
  cached = null;
  cachedMode = 'mock';
}
