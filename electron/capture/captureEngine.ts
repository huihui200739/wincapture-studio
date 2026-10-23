/**
 * 录制引擎（开发文档 §9 / §13.1 / §15.1）
 *
 * 职责：
 *   - 驱动原生采集进程，把 JPEG 帧与 PCM 音频写入工程目录
 *   - 状态机严格按 CAPTURE_TRANSITIONS 校验
 *   - 分段提交严格按 §15.1 的七步顺序
 *   - 指针事件采集与压缩
 *   - 崩溃恢复日志（journal.jsonl）
 *
 * 关键设计：
 *   视频帧不在主进程编码，而是通过 HTTP 提供给录制渲染窗口，
 *   由渲染窗口用 WebCodecs 编码成 H.264 分段 MP4（主进程没有 WebCodecs）。
 *   主进程负责的是：采集、时间戳、分段调度、落盘、校验、提交。
 */

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  canTransition,
  type CaptureConfig,
  type CaptureState,
  type CaptureStatus,
  type QualityProfile,
  QUALITY_PROFILES,
} from '../../src/shared/ipc';
import { AppError } from '../../src/shared/errors';
import type { PointerEventLike, PointerLog, RecoveryJournalEntry, SegmentRecord } from '../../src/domain/types';
import type { RecordingMarker } from '../../src/domain/project';
import { secondsToTicks } from '../../src/domain/timebase';
import { SessionClock } from '../../src/domain/sessionClock';
import { AudioWorker, GrabberWorker, type AudioPacket, type VideoFramePacket, type WorkerPaths } from './workers';
import { QpcClock } from './qpcClock';
import { SegmentGrid, type SegmentSlice } from './segmentPlanner';
import { audioBufferFrames, audioOffsetFrames, writePcmInto, type PlacedPcmPacket } from './audioAlign';

/**
 * 目标分段时长：1.6 秒一段（§9.5 崩溃恢复损失上限 4 秒，1.6s 远低于上限）。
 *
 * 为什么不是 2 秒：分段 MP4 的音视频两轨必须严格等长，否则逐段累计出音画偏差。
 *   - 视频轨按 fps 切帧：时长必须是 1/fps 的整数倍 → 1.6s = 48 帧 @30fps ✓
 *   - 音频轨按 AAC 帧（固定 1024 采样）切包：时长必须是 1024/48000 的整数倍
 *     → 1.6s @48kHz = 76800 采样 = 恰好 75 个 AAC 帧 ✓
 *   而 2 秒 = 96000 采样 = 93.75 个 AAC 帧，编码器补齐到 94 帧后音频轨比视频轨
 *   长 5.333ms；30 段累计 160ms，实测正好让「音画偏差 ≤80ms」超标。
 * 1.6s 是同时满足两者且离 2s 最近的值。
 */
const SEGMENT_TARGET_TICKS = secondsToTicks(1.6);
/** 指针采样上限约 120Hz（§9.4）。 */
const POINTER_INTERVAL_MS = 1000 / 120;
/** 静止点压缩：位置变化小于该阈值且非点击/形态改变时不记录。 */
const POINTER_MOVE_EPSILON = 0.0015;
/** 磁盘安全检查间隔。 */
const DISK_CHECK_INTERVAL_MS = 2000;
/** 低于该剩余空间时安全停止（200 MB）。 */
const DISK_MIN_FREE_BYTES = 200 * 1024 * 1024;
/**
 * 待编码队列上限。每段 1080p 持有 60 张 JPEG（约 12MB）+ 序列化副本，
 * 队列一堆积就是几百 MB 内存。正常情况编码快于分段不会积压；
 * 只有在磁盘卡顿或编码降级时才可能排队，此时宁可丢中间段也不能让内存无限涨
 * （§16.2 总工作集 ≤1.2GB 优先于「一段不丢」）。
 */
const MAX_PENDING_SEGMENTS = 2;

export interface RecordSession {
  sessionId: string;
  projectPath: string;
  projectId: string;
  config: CaptureConfig;
  quality: QualityProfile;
  /** 实际生效的配置（可能降级） */
  effective: {
    width: number;
    height: number;
    fps: number;
    videoCodec: string;
    audioCodec: string;
    hardwareEncoding: boolean;
  };
  degradation: string | null;
  startedAt: number;
}

export interface RecorderHooks {
  /** 状态变化通知（主进程 → 界面） */
  onStatus: (status: CaptureStatus) => void;
  /** 请求录制渲染窗口开始一段编码 */
  requestSegment: (info: SegmentRequest) => Promise<SegmentCommit>;
  /** 请求录制渲染窗口停止（flush 最后一段） */
  finalizeRecorder: () => Promise<void>;
  /** 应用级事件（错误提示、快捷键反馈等） */
  onAppEvent: (type: string, payload: unknown) => void;
  /**
   * 会话由引擎自己结束时回调（进程崩溃 → RecoverableFailure、磁盘不足 → 自动 stop）。
   * 主进程必须靠它清理 currentSession / 悬浮条 / 摄像头，否则界面会一直认为
   * 「已有录制会话在进行中」，用户既不能停止也不能重新开始。
   */
  onSessionEnded?: (reason: 'error' | 'disk-full') => void;
  /**
   * 摄像头分段提交（R04）。未启用摄像头时该钩子不存在。
   * 失败返回 null，且不得抛出——摄像头失败不能影响主录制（§9.5）。
   */
  commitCameraSegment?: (
    projectPath: string,
    index: number,
    durationTicks: number,
    fps: number,
  ) => Promise<{ path: string; bytes: number; frames: number } | null>;
}

export interface SegmentRequest {
  index: number;
  /** 该段在会话媒体时间轴上的起点 */
  startTick: number;
  /** 期望时长 */
  durationTicks: number;
  width: number;
  height: number;
  fps: number;
  /** 帧序列：每帧的媒体时间与 JPEG 数据来源 */
  frames: { mediaTick: number; jpeg: Buffer }[];
  audio: { mic: AudioPacket[]; system: AudioPacket[] };
}

export interface SegmentCommit {
  /** 渲染窗口编码出的 MP4 字节 */
  mp4: Uint8Array | null;
  frames: number;
  encoder: string;
  durationUs: number;
}

/**
 * 已切好、等待编码的分段。
 *
 * 帧在切分瞬间就被移出采集缓冲，因此这段包含哪些帧在触发时刻就固定下来，
 * 后面无论编码花多久都不会改变段时长（§16.2 故障尾部损失 ≤4s 的前提）。
 *
 * 音频包的 `startFrame` 在切段时已被改写为「段内 48kHz 帧偏移」
 * （见 alignAudioPackets），这样录制窗口不需要知道会话零点/暂停表就能对齐两路音频。
 */
interface PendingSegment {
  index: number;
  startTick: number;
  durationTicks: number;
  frames: { mediaTick: number; jpeg: Buffer; qpc: bigint }[];
  mic: AudioPacket[];
  system: AudioPacket[];
}

/** 采集引擎：一个进程内只允许一个活动会话。 */
export class CaptureEngine {
  private state: CaptureState = 'Idle';
  private session: RecordSession | null = null;
  private clock = new SessionClock();
  private qpcClock = new QpcClock();
  private grabber: GrabberWorker | null = null;
  private audio: AudioWorker | null = null;

  private frames: { mediaTick: number; jpeg: Buffer; qpc: bigint }[] = [];
  private micPackets: AudioPacket[] = [];
  private systemPackets: AudioPacket[] = [];
  private segments: SegmentRecord[] = [];
  private journal: RecoveryJournalEntry[] = [];
  private journalSeq = 0;
  private markers: RecordingMarker[] = [];
  private pointerEvents: PointerEventLike[] = [];
  private pointerClicks: { tick: number; x: number; y: number }[] = [];
  private lastPointer: { x: number; y: number; tick: number } | null = null;

  private segmentTimer: NodeJS.Timeout | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private pointerTimer: NodeJS.Timeout | null = null;
  /** 分段栅格：决定段起点/结束边界，并在暂停 flush 后重新对齐（见 segmentPlanner.ts） */
  private grid = new SegmentGrid(Number(SEGMENT_TARGET_TICKS));
  /** 已按固定节拍切好、等待编码的分段队列（保证段时长与编码耗时解耦） */
  private pendingSegments: PendingSegment[] = [];
  /** 是否有编码循环在跑（串行，避免并发创建多个编码器） */
  private draining = false;
  /** 当前这一轮 drain 的完成信号（供并发调用方等待，而不是轮询） */
  private drainSignal: Promise<void> = Promise.resolve();
  /** 累计采集到的帧数（性能探针用，不受分段边界影响） */
  private framesArrived = 0;
  /** 下一个分段编号（从 1 开始，不依赖入队顺序） */
  private nextSegmentNumber = 1;
  /** 摄像头分段提交任务链（串行，避免同一隐藏窗口并发编码） */
  private cameraChain: Promise<void> = Promise.resolve();
  /** 尚未完成的摄像头分段数（停止时要等它们落盘，工程才能扫描到完整摄像头轨） */
  private cameraJobsPending = 0;
  private stopResult: { projectPath: string; status: CaptureStatus } | null = null;
  private stopPromise: Promise<{ projectPath: string; status: CaptureStatus }> | null = null;
  private bytesWritten = 0;
  private levels = { mic: 0, system: 0 };
  private lastStatusAt = 0;
  private stopping = false;

  constructor(
    private readonly workerPaths: WorkerPaths,
    private readonly hooks: RecorderHooks,
    private readonly deps: {
      /** 屏幕指针位置读取（主进程用 screen.getCursorScreenPoint） */
      getCursorPoint: () => { x: number; y: number };
      /** 可用磁盘空间 */
      getFreeDisk: (dir: string) => number;
      /** 工程目录创建 */
      ensureProjectDir: (projectPath: string) => Promise<void>;
      /** 创建工程文件（含初始轨道） */
      createProjectForSession: (session: RecordSession) => Promise<void>;
    },
  ) {}

  getState(): CaptureState {
    return this.state;
  }

  getSession(): RecordSession | null {
    return this.session;
  }

  getMarkers(): RecordingMarker[] {
    return this.markers.slice();
  }

  /** 状态转移：非法转移拒绝并抛错（§9.1）。 */
  private transition(to: CaptureState): void {
    if (this.state === to) return;
    if (!canTransition(this.state, to)) {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: `不允许的录制状态转移：${this.state} → ${to}`,
        retryable: false,
        preservedData: true,
        detail: `from=${this.state} to=${to}`,
      });
    }
    this.state = to;
    this.emitStatus();
  }

  private emitStatus(force = false): void {
    const now = Date.now();
    // 高频事件节流：最多每秒 10 次（§14.3）
    if (!force && now - this.lastStatusAt < 100) return;
    this.lastStatusAt = now;
    this.hooks.onStatus(this.status());
  }

  status(): CaptureStatus {
    const session = this.session;
    const mediaTick = this.clock.hasZero ? Math.max(0, this.clock.durationTicks(this.nowQpc())) : 0;
    const freeDiskBytes = session ? this.deps.getFreeDisk(session.projectPath) : 0;
    return {
      state: this.state,
      sessionId: session?.sessionId ?? null,
      mediaTick,
      effective: session?.effective ?? null,
      degradation: session?.degradation ?? null,
      error: null,
      segmentsCommitted: this.segments.filter((s) => s.state === 'committed').length,
      /**
       * 累计采集到的帧数（含已切段、未编码的）。
       * 性能探针用它量「首次有效画面延迟」和采集层实际帧率；
       * 不能用 segmentsCommitted 代替，因为分段要等 2 秒窗口关闭。
       */
      framesArrived: this.framesArrived,
      bytesWritten: this.bytesWritten,
      freeDiskBytes,
      levels: { ...this.levels },
      markerCount: this.markers.length,
      startedAt: session?.startedAt ?? null,
    };
  }

  /** 当前 QPC 时刻，换算到 100ns tick（与 SessionClock 的基准一致）。 */
  private nowQpc(): number {
    // 用锚定时钟把主进程 perfNow 换算到采集子进程的 QPC 时间轴，
    // 保证暂停/停止边界与帧时间戳同源（§9.2）。
    return this.qpcClock.tickNow(performance.now());
  }

  /** 把采集进程的 QPC 计数换算为 100ns tick。 */
  private qpcToTick(qpc: bigint, freq: bigint): number {
    return this.qpcClock.qpcToTick(qpc) || Math.round((Number(qpc) * 10_000_000) / Number(freq));
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  async start(config: CaptureConfig, projectPath: string, projectId: string): Promise<RecordSession> {
    // 上一次会话取消时可能还有摄像头分段/屏幕段在编码：等它们收尾，
    // 否则新会话的 drain 会和旧 drain 并发（两个编码器同时写盘、pendingSegments 互相踩）。
    if (this.cameraJobsPending > 0) await this.drainCameraJobs().catch(() => {});
    if (this.draining) await this.drainSignal.catch(() => {});
    // 上一场会话可能停在 ReadyToEdit / Cancelled / RecoverableFailure。
    // 这些状态都允许回到 Idle，但此前没有任何代码做这一步：
    // 结果是「录完第一场后第二场永远报 E_INVALID_COMMAND，必须重启应用」。
    await this.resetFinishedSession();
    if (this.state !== 'Idle') {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '已有录制会话在进行中。',
        retryable: false,
        preservedData: true,
      });
    }

    const quality = QUALITY_PROFILES.find((q) => q.id === config.qualityId) ?? QUALITY_PROFILES[1];
    this.transition('Preparing');

    const degradationParts: string[] = [];
    let width = quality.width;
    let height = quality.height;
    let fps = quality.fps;

    // ---- 采集区域（§7.1 / R01）----
    // region 是「源显示器内的物理像素矩形」。整屏时用显示器原点。
    const display = this.resolveDisplayBounds(config.sourceId);
    const region = this.normalizeRegion(config.region, display, degradationParts);

    await this.deps.ensureProjectDir(projectPath);

    // 输出尺寸：区域录制按区域原生像素输出，保证「选择结果与预览一致」(R01)。
    // 不做二次缩放——缩放会让文字变糊，而录屏的主要用途恰恰是看清文字。
    if (region.width !== display.width || region.height !== display.height) {
      width = region.width;
      height = region.height;
      degradationParts.push(`区域录制 ${region.width}×${region.height}，按原生像素输出`);
    }

    const session: RecordSession = {
      sessionId: `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectPath,
      projectId,
      config,
      quality,
      effective: {
        width,
        height,
        fps,
        videoCodec: 'avc',
        audioCodec: 'aac',
        hardwareEncoding: quality.hardwarePreferred,
      },
      degradation: null,
      startedAt: Date.now(),
    };
    this.session = session;

    // 录制目录结构（§13.1）
    //
    // 这一段过去没有 try/catch：Preparing 阶段创建目录失败（磁盘写满、杀软锁定、
    // 权限被拒）会让 engine.start 抛错，但 state 停在 Preparing、session 仍非空。
    // 之后用户再点「开始录制」只会得到「已有录制会话在进行中」，界面却显示空闲。
    try {
      await fsp.mkdir(path.join(projectPath, 'media', 'screen'), { recursive: true });
      await fsp.mkdir(path.join(projectPath, 'media', 'mic'), { recursive: true });
      await fsp.mkdir(path.join(projectPath, 'media', 'system'), { recursive: true });
      await fsp.mkdir(path.join(projectPath, 'events'), { recursive: true });
      await fsp.mkdir(path.join(projectPath, 'recovery'), { recursive: true });

      this.resetSessionState();
      await this.appendJournal('session-start', { config, qualityId: quality.id });
    } catch (error) {
      this.stopTimers();
      await this.grabber?.stop().catch(() => {});
      await this.audio?.stop().catch(() => {});
      this.grabber = null;
      this.audio = null;
      this.session = null;
      this.stopping = false;
      try {
        if (canTransition(this.state, 'Cancelled')) this.transition('Cancelled');
        if (canTransition(this.state, 'Idle')) this.transition('Idle');
        else this.state = 'Idle';
      } catch {
        this.state = 'Idle';
      }
      const reason = (error as NodeJS.ErrnoException)?.code;
      const code = reason === 'ENOSPC' ? 'E_DISK_FULL' : reason === 'EACCES' || reason === 'EPERM' ? 'E_PERMISSION_DENIED' : 'E_UNKNOWN';
      throw new AppError({
        code,
        message: '无法创建录制目录，请检查磁盘空间与目录权限。',
        retryable: true,
        preservedData: true,
        detail: String(error),
      });
    }

    // 启动屏幕采集
    const grabber = new GrabberWorker(this.workerPaths.grabberExe, {
      width: region.width,
      height: region.height,
      offsetX: region.x,
      offsetY: region.y,
      quality: 88,
      fps,
    });
    this.grabber = grabber;

    try {
      await grabber.start();
    } catch (error) {
      this.transition('RecoverableFailure');
      // 启动失败（含 3 秒超时）必须把可能已经半启动的子进程收掉：
      // worker 自己在失败路径会 kill，这里再兜底 stop 并断开引用，
      // 避免下一次会话/重试时残留一个持续抓屏的孤儿进程。
      await grabber.stop().catch(() => {});
      this.grabber = null;
      throw new AppError({
        code: 'E_CAPTURE_UNSUPPORTED',
        message: '无法启动屏幕采集。请检查显示器是否被其他程序独占。',
        retryable: true,
        preservedData: true,
        detail: String(error),
      });
    }
    // 先把 QPC 频率同步给主进程时钟：音频包可能早于首帧到达，
    // 若等到首帧才 setFrequency，早期音频会被按错误的频率换算。
    this.qpcClock.setFrequency(grabber.frequency);

    grabber.onFrame((frame) => this.handleVideoFrame(frame));
    grabber.onExit((reason) => {
      // 暂停/倒计时阶段的崩溃同样致命：恢复后不会再有画面，必须进入可恢复失败
      if (!this.stopping && (this.state === 'Recording' || this.state === 'Paused' || this.state === 'Pausing' || this.state === 'Resuming' || this.state === 'Countdown')) {
        this.failSession('E_SOURCE_CLOSED', '屏幕采集进程意外退出。', reason.stderr);
      }
    });

    // 启动音频采集
    if (config.microphoneEnabled || config.systemAudioEnabled) {
      const audio = new AudioWorker(this.workerPaths.audioExe, {
        enableSystem: config.systemAudioEnabled,
        enableMic: config.microphoneEnabled,
        micDeviceId: config.microphoneDeviceId,
      });
      this.audio = audio;
      audio.onAudio((packet) => this.handleAudioPacket(packet));
      audio.onError((error) => {
        // 单路音频失败不终止录制，但必须如实报告降级（§9.5）
        const label = error.streamId === 0 ? '系统声音' : '麦克风';
        degradationParts.push(`${label}采集失败：${error.message}`);
        session.degradation = degradationParts.join('；');
        this.emitStatus(true);
        void this.appendJournal('heartbeat', { audioError: error });
      });
      audio.onExit((reason) => {
        if (!this.stopping && this.state === 'Recording') {
          degradationParts.push('音频采集进程退出');
          session.degradation = degradationParts.join('；');
          this.emitStatus(true);
          void reason;
        }
      });
      try {
        await audio.start();
      } catch (error) {
        // 音频失败不阻止录制，但要报告
        degradationParts.push(`音频采集不可用：${String(error)}`);
        session.degradation = degradationParts.join('；');
        await audio.stop().catch(() => {});
        this.audio = null;
      }
    }

    // 倒计时（§6.1 开始前 3 秒倒计时）
    // 注意：倒计时为 0 时状态机必须经过 Countdown 才能从 Preparing 到 Recording
    // （CAPTURE_TRANSITIONS 里 Preparing 不允许直接跳 Recording），
    // 因此这里始终进入 Countdown，只是时长为 0 时立即通过。
    this.transition('Countdown');
    if (config.countdownSeconds > 0) {
      await this.countdown(config.countdownSeconds);
    }
    // 倒计时期间用户可能取消，取消后不再进入录制
    if ((this.state as CaptureState) !== 'Countdown') return session;

    this.transition('Recording');
    session.startedAt = Date.now();
    this.scheduleSegment();
    this.startDiskMonitor();
    this.startPointerSampling();

    await this.appendJournal('resume', { at: this.nowQpc() });
    return session;
  }

  private async countdown(seconds: number): Promise<void> {
    for (let i = seconds; i > 0; i--) {
      this.hooks.onAppEvent('countdown', { remaining: i });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private resolveDisplayBounds(sourceId: string): { x: number; y: number; width: number; height: number } {
    // sourceId 形如 "display:0" 或 "window:12345"
    const index = Number((/display:(\d+)/.exec(sourceId) ?? [])[1] ?? 0);
    return this.displayBounds(index);
  }

  /**
   * 把用户选的区域规整成可采集的矩形（§7.1 / R01）。
   *
   * 规则：
   *  - 区域必须完全落在选定的显示器内，超出部分裁掉（R01「区域不超出选定单屏」）
   *  - 宽高对齐到偶数，H.264 的 4:2:0 色度采样要求偶数尺寸
   *  - 区域太小时退回整屏，并写入降级说明（不静默给一个 1px 的废片）
   */
  private normalizeRegion(
    region: { x: number; y: number; width: number; height: number } | undefined,
    display: { x: number; y: number; width: number; height: number },
    degradationParts: string[],
  ): { x: number; y: number; width: number; height: number } {
    const whole = { x: display.x, y: display.y, width: display.width, height: display.height };
    if (!region) return whole;

    // region 是显示器内偏移 → 转成屏幕全局坐标
    let x = Math.round(display.x + region.x);
    let y = Math.round(display.y + region.y);
    let width = Math.round(region.width);
    let height = Math.round(region.height);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      degradationParts.push('区域参数无效，已改为整屏录制');
      return whole;
    }

    // 裁到显示器范围内
    const left = Math.max(x, display.x);
    const top = Math.max(y, display.y);
    const right = Math.min(x + width, display.x + display.width);
    const bottom = Math.min(y + height, display.y + display.height);
    if (right <= left || bottom <= top) {
      degradationParts.push('所选区域不在该显示器范围内，已改为整屏录制');
      return whole;
    }
    if (left !== x || top !== y || right !== x + width || bottom !== y + height) {
      degradationParts.push('所选区域超出显示器边界，已裁切到屏幕内');
    }
    x = left;
    y = top;
    width = right - left;
    height = bottom - top;

    // 偶数对齐（向下取偶，保证不越界）
    width -= width % 2;
    height -= height % 2;

    const MIN_SIDE = 64;
    if (width < MIN_SIDE || height < MIN_SIDE) {
      degradationParts.push(`所选区域过小（小于 ${MIN_SIDE}px），已改为整屏录制`);
      return whole;
    }
    return { x, y, width, height };
  }

  /** 由 main.ts 注入的真实显示器几何。 */
  displayBounds: (index: number) => { x: number; y: number; width: number; height: number } = () => ({
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
  });

  // -------------------------------------------------------------------------
  // 帧与音频处理
  // -------------------------------------------------------------------------

  private handleVideoFrame(frame: VideoFramePacket): void {
    // 停止过程中仍必须收帧。
    //
    // 为什么：管道里通常还压着 1~2 秒已采集、尚未被主进程读走的帧。
    // doStop 会 transition('Stopping') 之后再等 grabber 把 stdout 排空；
    // 如果这里只认 'Recording'，这些「停止前已经采集」的帧会被全部丢掉，
    // 恰好复现文档里记录的「20 秒只成片 18 秒」缺陷（注释声称已修，实际被状态守卫吃掉）。
    const accepting =
      this.state === 'Recording' || (this.state === 'Stopping' && this.stopping);
    if (!accepting) return;

    const freq = this.grabber?.frequency ?? 10_000_000n;
    // 记录锚点，让主进程的 perfNow 能换算到采集进程的 QPC 时间轴
    this.qpcClock.setFrequency(freq);
    this.qpcClock.observe(frame.qpc, performance.now());
    const qpcTick = this.qpcToTick(frame.qpc, freq);

    // 首帧确定会话零点（§9.2）
    if (!this.clock.hasZero) {
      this.clock.setZero(qpcTick);
      void this.appendJournal('heartbeat', { zero: qpcTick });
    }
    // 停止命令之后才采集到的画面不属于本次会话（停止瞬间到进程退出之间最多还会有几十毫秒）。
    const stopQpc = this.clock.stopQpc;
    if (stopQpc !== null && qpcTick > stopQpc) return;
    if (this.clock.isDuringPause(qpcTick)) return;

    const mediaTick = this.clock.mediaTickAt(qpcTick);
    if (mediaTick < 0) return;

    this.frames.push({ mediaTick, jpeg: frame.jpeg, qpc: frame.qpc });
    this.framesArrived += 1;
    this.emitStatus();

    // 由帧到达驱动切段，而不是靠定时器。
    //
    // 为什么：编码是 CPU/GPU 密集的同步工作（解码 JPEG + H.264），
    // 它会占满主进程事件循环，导致 setTimeout 回调被延迟。
    // 实测 20 秒录制只录到 16 秒、采集帧率虚高到 33.8fps，
    // 根因就是定时器切片时刻漂移，段边界与实际帧时间对不上。
    //
    // 改成在帧到达时按媒体时间边界切分：只要当前帧已经越过「本段理论结束时刻」，
    // 就立刻把之前累积的帧切走。这样段边界由帧时间决定，与事件循环压力无关。
    this.sliceFramesIfDue(mediaTick);
  }

  /**
   * 按媒体时间栅格切段（栅格逻辑见 segmentPlanner.ts）。
   *
   * 边界用「绝对时间栅格」而不是「相对上一段累加」：
   * 相对累加会让边界逐段被推后最多一帧，实测 11 段合计 17.68s，而真实录制时长是 20.05s。
   * 栅格起点取第一个有效帧的媒体时间，段时长严格等于栅格步长。
   *
   * @param currentTick 刚到达帧的媒体时间
   */
  private sliceFramesIfDue(currentTick: number): void {
    if (!this.session) return;
    if (this.frames.length === 0) return;
    const slice = this.grid.observe(currentTick);
    if (!slice) return;
    this.enqueueSlice(slice);
    this.enforceBackpressure();
    void this.drainSegmentQueue();
  }

  /** 把当前缓冲里的帧/音频切进待编码队列。切段时就把音频包对齐到段内偏移。 */
  private enqueueSlice(slice: SegmentSlice): PendingSegment {
    const takeFrames = this.frames;
    // 音频包按媒体时间分到「本段」与「下一段」：
    // 主进程事件循环忙时，切段之后才被读到的音频包可能反而是边界之前采集的。
    // 若把它们塞进本段之外的下一个缓冲、再按下一段起点算偏移，偏移会变成负数而被裁掉，
    // 每个段边界都会丢 20~40ms 音频（听感是周期性咔哒）。
    const micSplit = this.splitAudioPackets(this.micPackets, slice);
    const systemSplit = this.splitAudioPackets(this.systemPackets, slice);

    this.frames = [];
    this.micPackets = micSplit.carry;
    this.systemPackets = systemSplit.carry;

    const segment: PendingSegment = {
      index: this.nextSegmentNumber,
      startTick: slice.startTick,
      durationTicks: slice.durationTicks,
      frames: takeFrames,
      mic: micSplit.inside,
      system: systemSplit.inside,
    };
    this.nextSegmentNumber += 1;
    this.pendingSegments.push(segment);
    // 摄像头是实时源：必须在切段瞬间（而不是屏幕段编码完之后）开始采集，
    // 否则每个摄像头段都会比对应屏幕段晚「屏幕编码耗时」，累积后声画/画中画错位。
    // 同时不能在这个串行编码循环里 await 它：摄像头段要录满 durationTicks 实时时间，
    // await 会让队列以 >1.6s/段 的速度堆积，触发背压丢屏幕段。
    this.scheduleCameraSegment(segment.index, segment.durationTicks);
    return segment;
  }

  /** 背压：待编码队列超限时丢最旧的（已编码的更早）。 */
  private enforceBackpressure(): void {
    while (this.pendingSegments.length > MAX_PENDING_SEGMENTS) {
      const dropped = this.pendingSegments.shift()!;
      void this.appendJournal('segment-dropped', {
        index: dropped.index,
        reason: 'encoder-backpressure',
        frames: dropped.frames.length,
      });
      this.hooks.onAppEvent('segment-dropped', { index: dropped.index, reason: '编码积压' });
    }
  }

  /**
   * 把音频包时间对齐到段内偏移，并把落在段结束后的包交给下一段。
   *
   * 原生进程给的是「该流自身」的累计采样序号，两路设备启动时刻不同（实测回环晚约 0.9s），
   * 且暂停期间设备仍在计数。必须用包携带的 QPC 经 SessionClock 换算成会话媒体时间，
   * 再减去段起点，否则两路音频都会整体前移一个设备启动延迟、暂停后继续漂移。
   */
  private splitAudioPackets(
    packets: AudioPacket[],
    slice: SegmentSlice,
  ): { inside: AudioPacket[]; carry: AudioPacket[] } {
    const freq = this.grabber?.frequency ?? this.audio?.frequency ?? 10_000_000n;
    const inside: AudioPacket[] = [];
    const carry: AudioPacket[] = [];
    const segmentEnd = slice.startTick + slice.durationTicks;
    for (const packet of packets) {
      if (packet.qpc <= 0n) {
        // 没有有效 QPC（理论上不会发生）：保留原始序号，至少不会把数据丢掉
        inside.push(packet);
        continue;
      }
      if (!this.clock.hasZero) {
        inside.push(packet);
        continue;
      }
      const qpcTick = this.qpcToTick(packet.qpc, freq);
      const stopQpc = this.clock.stopQpc;
      if (stopQpc !== null && qpcTick > stopQpc) continue;
      if (this.clock.isDuringPause(qpcTick)) continue;
      const mediaTick = this.clock.mediaTickAt(qpcTick);
      if (mediaTick < 0) continue;
      if (mediaTick >= segmentEnd) {
        carry.push(packet);
        continue;
      }
      inside.push({ ...packet, startFrame: audioOffsetFrames(mediaTick, slice.startTick) });
    }
    return { inside, carry };
  }

  private handleAudioPacket(packet: AudioPacket): void {
    // 与视频同理：停止排空阶段到达的音频包属于停止前已采集的内容，不能丢。
    const accepting =
      this.state === 'Recording' || (this.state === 'Stopping' && this.stopping);
    if (!accepting) return;
    if (packet.streamId === 0) {
      this.levels.system = packet.rms;
      this.systemPackets.push(packet);
    } else {
      this.levels.mic = packet.rms;
      this.micPackets.push(packet);
    }
    // 电平事件节流由 emitStatus 内部处理
    this.emitStatus();
  }

  // -------------------------------------------------------------------------
  // 分段提交（§15.1）
  // -------------------------------------------------------------------------

  private scheduleSegment(): void {
    // 切段已改为「帧到达时按媒体时间边界驱动」（见 sliceFramesIfDue）。
    // 定时器只作为兜底：万一长时间没有新帧（例如画面完全静止且采集端停发），
    // 也要把已累积的段落盘，避免数据一直压在内存里。
    if (this.segmentTimer) clearTimeout(this.segmentTimer);
    const intervalMs = Math.max(500, Number(SEGMENT_TARGET_TICKS) / 10_000);
    this.segmentTimer = setTimeout(() => {
      if (this.state === 'Recording' || this.state === 'Paused' || this.state === 'Stopping') {
        void this.drainSegmentQueue();
        this.scheduleSegment();
      }
    }, intervalMs);
  }

  /**
   * 把剩余帧切为最后一段并定稿入队（停止/暂停时调用）。
   *
   * 最后一段的起点取「当前栅格段起点」，时长取「实际结束时刻 - 起点」。
   * 切完之后栅格从实际结束时刻重新开始：暂停场景下这一点是必需的——
   * 旧实现让栅格停留在暂停前的边界，恢复后下一段起点被算回上一格起点，
   * 导致同一段媒体时间被编码两次（实测暂停一次就重叠约 1 秒）。
   *
   * 若最后一段只剩极少帧（例如刚切完段就停止），也要保留：
   * 它承载的是「最后这段时间确实录了」这个事实，丢掉的正是 §16.2 说的尾部损失。
   */
  private flushRemainingFrames(endTick?: number): void {
    if (!this.session) return;
    if (this.frames.length === 0) {
      // 没有帧就没有可提交的内容（音频会随下一段/丢弃，不会单独成段）
      this.micPackets = [];
      this.systemPackets = [];
      return;
    }
    const fps = this.session.effective.fps || 30;
    const frameIntervalTick = Math.round(10_000_000 / Math.max(1, fps));
    const lastFrame = this.frames[this.frames.length - 1];
    const slice = this.grid.flush(lastFrame.mediaTick, frameIntervalTick, endTick);
    this.enqueueSlice(slice);
  }

  /**
   * 按队列顺序串行编码（同一时刻只有一个编码器实例，避免 GPU 上下文冲突）。
   *
   * 注意：如果已有 drain 在跑，这里不能直接 return —— 那会让调用方
   * （停止录制时的 flushRemainingFrames 之后）以为「队列已清空」，
   * 实际最后一段还在后台编码、甚至还没写盘就返回了。
   * 实测表现是：journal 里 10 段都提交成功，但 stop() 返回时只有 9 段，
   * 探针读到 18.05s 而非 20.03s。
   *
   * 这里等待的是「本轮 drain 的完成信号」而不是轮询 this.draining：
   * 轮询会和递归调用互相等待，直接死锁（实测进程卡死退出码 -1）。
   */
  private async drainSegmentQueue(): Promise<void> {
    if (this.draining) {
      // 等待当前这一轮结束；结束后再看是否有新入队的段需要继续处理
      await this.drainSignal;
      if (this.pendingSegments.length > 0) {
        await this.drainSegmentQueue();
      }
      return;
    }

    this.draining = true;
    let resolveSignal: () => void = () => {};
    this.drainSignal = new Promise<void>((resolve) => {
      resolveSignal = resolve;
    });

    try {
      while (this.pendingSegments.length > 0) {
        const next = this.pendingSegments.shift()!;
        await this.encodeSegmentFromSlice(next);
      }
    } finally {
      this.draining = false;
      resolveSignal();
    }
  }

  private async encodeSegmentFromSlice(slice: PendingSegment): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    const { index, startTick, durationTicks, frames: takeFrames, mic: takeMic, system: takeSystem } = slice;

    try {
      await this.appendJournal('segment-begin', { index, startTick, durationTicks, frames: takeFrames.length });

      // 第 1-2 步：由渲染窗口编码并完成封装（内部先写临时文件）
      const commit = await this.hooks.requestSegment({
        index,
        startTick,
        durationTicks,
        width: session.effective.width,
        height: session.effective.height,
        fps: session.effective.fps,
        frames: takeFrames.map((f) => ({ mediaTick: f.mediaTick, jpeg: f.jpeg })),
        audio: { mic: takeMic, system: takeSystem },
      });

      if (!commit.mp4 || commit.mp4.byteLength === 0) {
        await this.appendJournal('segment-corrupt', { index, reason: 'empty-output' });
        return;
      }

      // 第 3 步：写临时文件
      const relPath = `media/screen/seg-${String(index).padStart(6, '0')}.mp4`;
      const absPath = path.join(session.projectPath, relPath);
      const tempPath = absPath + '.partial';
      await fsp.writeFile(tempPath, commit.mp4);

      // 第 4 步：校验可解码（用 mediabunny 读回；主进程无 WebCodecs，只做封装级校验）
      const verified = await this.verifySegment(tempPath);
      if (!verified.ok) {
        await fsp.rm(tempPath, { force: true });
        await this.appendJournal('segment-corrupt', { index, reason: verified.reason });
        this.hooks.onAppEvent('segment-corrupt', { index, reason: verified.reason });
        return;
      }

      // 第 5 步：刷新落盘
      const handle = await fsp.open(tempPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      // 第 6 步：改名提交
      await fsp.rename(tempPath, absPath);

      // 第 7 步：追加 journal 并更新清单
      const record: SegmentRecord = {
        index,
        path: relPath,
        kind: 'video',
        startTick,
        durationTicks,
        state: 'committed',
        bytes: commit.mp4.byteLength,
        width: session.effective.width,
        height: session.effective.height,
      };
      this.segments.push(record);
      this.bytesWritten += commit.mp4.byteLength;
      await this.appendJournal('segment-commit', {
        index,
        path: relPath,
        startTick,
        durationTicks,
        bytes: commit.mp4.byteLength,
        frames: commit.frames,
        encoder: commit.encoder,
        verifiedDuration: verified.durationUs,
      });

      // 音频分段也落盘（WAV），与视频段同索引便于恢复对齐
      await this.writeAudioSegment(session, index, takeMic, takeSystem, durationTicks);

      this.emitStatus(true);
    } catch (error) {
      await this.appendJournal('segment-corrupt', { index, reason: String(error) });
      this.hooks.onAppEvent('segment-error', { index, message: String(error) });
    }
  }

  /**
   * 校验分段 MP4 是否可解封装（moov 存在、时长合理）。
   *
   * 必须 dispose：FilePathSource 在首次读取时会 open 文件句柄，只有 input.dispose()
   * 会 close 它。旧实现每条 return 都直接返回，每个分段泄漏一个句柄——
   * 3 分钟录制约 110 段，Windows 上这些句柄会阻止删除/移动工程目录（EBUSY）。
   */
  private async verifySegment(filePath: string): Promise<{ ok: boolean; reason?: string; durationUs?: number }> {
    let input: { dispose: () => void } | null = null;
    try {
      const { Input, FilePathSource, ALL_FORMATS } = await import('mediabunny');
      const opened = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
      input = opened;
      const video = await opened.getPrimaryVideoTrack();
      if (!video) return { ok: false, reason: 'no-video-track' };
      const duration = await opened.computeDuration();
      if (!(duration > 0)) return { ok: false, reason: 'zero-duration' };
      return { ok: true, durationUs: Math.round(duration * 1_000_000) };
    } catch (error) {
      return { ok: false, reason: `demux-failed: ${String(error)}` };
    } finally {
      try {
        input?.dispose();
      } catch {
        // 句柄已关闭/对象已被回收：不影响校验结果
      }
    }
  }

  private async writeAudioSegment(
    session: RecordSession,
    index: number,
    mic: AudioPacket[],
    system: AudioPacket[],
    /** 该段应有的时长（ticks）。音频必须与之对齐，否则整段会累计出音画偏差。 */
    durationTicks: number,
  ): Promise<void> {
    // 未启用的音轨不落盘：旧实现会给每段都写一份全静音 WAV，
    // 工程收尾时又把这些静音文件注册成音轨（用户没开麦却多出一条静音轨，还白占磁盘）。
    if (session.config.microphoneEnabled) {
      await this.writeWav(
        path.join(session.projectPath, 'media', 'mic', `seg-${String(index).padStart(6, '0')}.wav`),
        mic,
        durationTicks,
      );
    }
    if (session.config.systemAudioEnabled) {
      await this.writeWav(
        path.join(session.projectPath, 'media', 'system', `seg-${String(index).padStart(6, '0')}.wav`),
        system,
        durationTicks,
      );
    }
  }

  /**
   * 写一个音频段的 WAV。
   *
   * 两个关键点：
   *  1) 长度必须对齐到该段的声明时长，而不是「实际收到多少采样就写多少」。
   *     音频工作进程（WASAPI）启动比 GDI 采集慢约 0.2~0.9 秒，首段只能收到一部分；
   *     末段又因为停止时刻截断只剩几十毫秒。不补齐会让各段音频累计比视频短，
   *     导出后音画偏差逐段放大（实测 339ms，远超 §16.2 的 80ms 要求）。
   *  2) 包必须写到「段内偏移」位置（alignAudioPackets 已按 QPC 算好），
   *     而不是从头顺序拼接：两路设备启动时刻不同，顺序拼接等于把整条音轨前移一个启动延迟。
   *     不足的部分是 Buffer.alloc 的零值，天然静音。
   */
  private async writeWav(target: string, packets: AudioPacket[], durationTicks: number): Promise<void> {
    if (packets.length === 0 && durationTicks <= 0) return;

    const channels = 2;
    const placed: PlacedPcmPacket[] = packets.map((p) => ({
      startFrame: p.startFrame,
      left: p.left,
      right: p.right,
    }));
    const frameCount = audioBufferFrames(placed, durationTicks);
    if (frameCount <= 0) return;

    const data = Buffer.alloc(frameCount * 4 * channels); // 立体声 32-bit float
    writePcmInto(data, placed, frameCount);

    // WAVE_FORMAT_IEEE_FLOAT（3）32-bit
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(48_000, 24);
    header.writeUInt32LE(48_000 * channels * 4, 28);
    header.writeUInt16LE(channels * 4, 32);
    header.writeUInt16LE(32, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    await fsp.writeFile(target, Buffer.concat([header, data]));
  }

  // -------------------------------------------------------------------------
  // 摄像头分段
  // -------------------------------------------------------------------------

  /**
   * 摄像头分段提交（R04）：与屏幕段同索引、同时长，导出时两轨时间映射一致。
   *
   * 摄像头是实时源：encodeSegment 会「实时」采集 durationTicks 的画面。
   * 因此必须在切段瞬间就启动，并且绝不能串在屏幕段的编码循环里 await
   * （否则每段编码耗时都会让摄像头段晚开始，且队列以 >1.6s/段 的速度堆积触发背压丢帧）。
   * 这里用一条串行 Promise 链保证同一隐藏窗口不会被并发编码，失败只记录不抛异常（§9.5）。
   */
  private scheduleCameraSegment(index: number, durationTicks: number): void {
    const commit = this.hooks.commitCameraSegment;
    const session = this.session;
    if (!commit || !session) return;
    this.cameraJobsPending += 1;
    this.cameraChain = this.cameraChain.then(async () => {
      try {
        await commit(session.projectPath, index, durationTicks, session.effective.fps);
      } catch (error) {
        this.hooks.onAppEvent('camera-error', { index, message: String(error) });
      } finally {
        this.cameraJobsPending -= 1;
      }
    });
  }

  /** 等待所有已排队的摄像头分段落盘（停止/收尾前调用，否则工程扫描不到完整摄像头轨）。 */
  /**
   * 等摄像头分段编码队列清空。
   *
   * 必须带超时：链上每一步都是「隐藏摄像头窗口 executeJavaScript 编码」，
   * 摄像头驱动挂死时那个 Promise 永不 settle。旧实现无限 await，
   * 结果 capture:stop 永不返回——悬浮条不消失、工程不落盘，用户只能强杀进程。
   */
  private async drainCameraJobs(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.cameraJobsPending > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.hooks.onAppEvent('camera-error', {
          index: -1,
          message: '摄像头分段编码超时，已放弃等待剩余分段。',
        });
        break;
      }
      await Promise.race([
        this.cameraChain.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 500))),
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // 暂停 / 恢复 / 停止
  // -------------------------------------------------------------------------

  async pause(): Promise<CaptureStatus> {
    if (this.state !== 'Recording') {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '当前不在录制中，无法暂停。',
        retryable: false,
        preservedData: true,
      });
    }
    // 暂停边界必须在 drain 之前确定。
    // drain 可能耗时几百毫秒，旧实现等 drain 完才 clock.pause：
    // 这段时间状态已是 Pausing（帧被丢弃）但媒体时间仍在前进，
    // 恢复后就会在暂停点附近留下一段「时间走了但没有画面」的空洞。
    const pauseQpc = this.nowQpc();
    this.transition('Pausing');
    this.clock.pause(pauseQpc);
    // 提交当前段，保证暂停点之前的画面完整（结束边界取冻结后的媒体时长，
    // 让末帧与暂停点之间的音频样本也能落在本段，而不是被裁掉）
    this.flushRemainingFrames(this.clock.durationTicks(this.nowQpc()));
    await this.drainSegmentQueue();
    await this.appendJournal('pause', { at: pauseQpc });
    this.transition('Paused');
    this.emitStatus(true);
    return this.status();
  }

  async resume(): Promise<CaptureStatus> {
    if (this.state !== 'Paused') {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '当前不处于暂停状态。',
        retryable: false,
        preservedData: true,
      });
    }
    this.transition('Resuming');
    this.clock.resume(this.nowQpc());
    await this.appendJournal('resume', { at: this.nowQpc() });
    this.transition('Recording');
    this.scheduleSegment();
    this.emitStatus(true);
    return this.status();
  }

  /** 停止。重复调用返回同一结果（幂等）。 */
  async stop(): Promise<{ projectPath: string; status: CaptureStatus }> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === 'ReadyToEdit' && this.stopResult) return this.stopResult;

    this.stopPromise = this.doStop();
    try {
      const result = await this.stopPromise;
      this.stopResult = result;
      return result;
    } finally {
      this.stopPromise = null;
    }
  }

  private async doStop(): Promise<{ projectPath: string; status: CaptureStatus }> {
    if (!this.session) {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '没有正在进行的录制会话。',
        retryable: false,
        preservedData: true,
      });
    }
    // 暂停/恢复是异步的（pause() 要等 drain），停止可能并发到达。
    // 旧实现只在 Recording/Paused 时 transition('Stopping')，若停在 Pausing/Resuming
    // 就会在收尾阶段抛「不允许的状态转移」，此时 worker 已停、定时器已清，引擎直接卡死。
    await this.waitForTransientState();

    const state = this.state;
    if (state === 'Idle') {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '没有正在进行的录制会话。',
        retryable: false,
        preservedData: true,
      });
    }

    // 停止边界：以命令发出时刻为界。晚于它的帧/音频包是停止后采集的，直接丢弃；
    // 早于它的（管道里压着的约 1~2 秒）必须收进最后一段。
    const stopQpc = this.nowQpc();

    if (state === 'RecoverableFailure' || state === 'RecoveryReady') {
      // 失败后没有合法路径进入 Finalizing：清理进程并把状态复位到 Idle，
      // 让用户能重新开始（旧实现会在收尾阶段抛非法转移，引擎永久卡在失败态）。
      this.stopping = true;
      this.stopTimers();
      this.clock.stop(stopQpc);
      await this.grabber?.stop().catch(() => {});
      await this.audio?.stop().catch(() => {});
      this.grabber = null;
      this.audio = null;
      await this.drainSegmentQueue().catch(() => {});
      await this.drainCameraJobs().catch(() => {});
      try {
        if (canTransition(this.state, 'Idle')) this.transition('Idle');
        else this.state = 'Idle';
      } catch {
        this.state = 'Idle';
      }
      return { projectPath: this.session.projectPath, status: this.status() };
    }

    this.stopping = true;
    this.stopTimers();
    // 倒计时阶段就点了停止：先按状态机走到可停止状态，收尾成空工程，
    // 保证 main 的 captureStop 仍能读到工程文件（否则 stop 会抛非法转移）。
    if (state === 'Countdown' || state === 'Preparing') {
      if (canTransition(this.state, 'Recording')) this.transition('Recording');
      else if (canTransition(this.state, 'Cancelled')) {
        this.transition('Cancelled');
        this.transition('Idle');
        return { projectPath: this.session.projectPath, status: this.status() };
      }
    }
    if (this.state !== 'Stopping') this.transition('Stopping');
    this.clock.stop(stopQpc);
    await this.appendJournal('stop', { at: stopQpc });

    // 关键顺序：先停采集进程、把管道里剩下的帧读完，再切最后一段。
    //
    // 旧顺序是「先 flushRemainingFrames 再停 grabber」，结果已经写进管道
    // 但还没被主进程读走的帧（约 2 秒的量，正好一个分段窗口）会被直接丢弃，
    // 实测 20 秒录制只成片 18 秒，覆盖率 90%。
    // 注意 handleVideoFrame/handleAudioPacket 在 Stopping 阶段仍然收数据，
    // 否则这段 drain 会被状态守卫挡掉（这正是旧注释声称已修、实际没修的缺陷）。
    await this.grabber?.stop().catch(() => {});
    await this.audio?.stop().catch(() => {});
    this.grabber = null;
    this.audio = null;

    // 现在提交最后一段（结束边界取停止时刻的媒体时长，覆盖末帧到停止点之间的音频）
    this.flushRemainingFrames(this.clock.durationTicks());
    await this.drainSegmentQueue();
    // 摄像头段是实时源，停止时最后一段可能还在编码，必须等它落盘再建工程
    await this.drainCameraJobs();
    await this.hooks.finalizeRecorder();

    // 写指针日志
    await this.writePointerLog();
    await this.appendJournal('complete', {
      segments: this.segments.length,
      durationTicks: this.clock.durationTicks(),
    });

    this.transition('Finalizing');
    await this.finalizeProject();
    this.transition('ReadyToEdit');
    this.emitStatus(true);

    return {
      projectPath: this.session.projectPath,
      status: this.status(),
    };
  }

  /** 等待 Pausing/Resuming/Preparing 这些瞬时状态落定（停止/开始前调用）。 */
  private async waitForTransientState(timeoutMs = 5000): Promise<void> {
    const transient = ['Preparing', 'Pausing', 'Resuming'];
    const deadline = Date.now() + timeoutMs;
    while (transient.includes(this.state) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * 把已完成/已取消/失败的上一次会话复位到 Idle，允许开始新会话。
   *
   * 旧实现只允许 Idle 启动，而 stop() 之后状态永远停在 ReadyToEdit、
   * cancel() 对 ReadyToEdit 直接 return —— 第二场录制必然报「已有录制会话在进行中」，
   * 只能重启应用。CAPTURE_TRANSITIONS 本身允许这几条回 Idle 的转移。
   */
  private async resetFinishedSession(): Promise<void> {
    const finished: CaptureState[] = ['ReadyToEdit', 'Cancelled', 'RecoveryReady', 'RecoverableFailure'];
    if (!finished.includes(this.state)) return;
    this.stopping = true;
    this.stopTimers();
    // 失败可能发生在编码过程中：等当前 drain 收尾，避免新旧会话共用 pendingSegments/drain 标志
    if (this.draining) await this.drainSignal.catch(() => {});
    await this.grabber?.stop().catch(() => {});
    await this.audio?.stop().catch(() => {});
    this.grabber = null;
    this.audio = null;
    // 上一次会话可能还有摄像头分段在编码；不排空就开始新会话会让新摄像头段排队在旧段后面
    await this.drainCameraJobs().catch(() => {});
    this.pendingSegments = [];
    this.draining = false;
    this.grid.reset();
    this.stopping = false;
    try {
      if (canTransition(this.state, 'Idle')) this.transition('Idle');
      else this.state = 'Idle';
    } catch {
      this.state = 'Idle';
    }
  }

  private stopTimers(): void {
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
    if (this.diskTimer) {
      clearInterval(this.diskTimer);
      this.diskTimer = null;
    }
    if (this.pointerTimer) {
      clearInterval(this.pointerTimer);
      this.pointerTimer = null;
    }
  }

  async cancel(): Promise<void> {
    if (this.state === 'Idle') return;
    if (this.state === 'ReadyToEdit') {
      // 已完成的会话只复位状态机，不动工程文件（旧实现直接 return，状态永远停在 ReadyToEdit，
      // 导致下一次 start 被「已有录制会话在进行中」拒绝）。
      try {
        if (canTransition(this.state, 'Idle')) this.transition('Idle');
        else this.state = 'Idle';
      } catch {
        this.state = 'Idle';
      }
      return;
    }
    this.stopping = true;
    this.stopTimers();
    await this.grabber?.stop().catch(() => {});
    await this.audio?.stop().catch(() => {});
    this.grabber = null;
    this.audio = null;
    this.pendingSegments = [];
    this.grid.reset();
    if (this.state !== 'Cancelled') {
      try {
        this.transition('Cancelled');
      } catch {
        this.state = 'Cancelled';
      }
    }
    try {
      if (canTransition(this.state, 'Idle')) this.transition('Idle');
      else this.state = 'Idle';
    } catch {
      this.state = 'Idle';
    }
  }

  private failSession(code: string, message: string, detail?: string): void {
    this.stopping = true;
    this.stopTimers();
    void this.grabber?.stop().catch(() => {});
    void this.audio?.stop().catch(() => {});
    if (this.state !== 'RecoverableFailure') {
      try {
        this.transition('RecoverableFailure');
      } catch {
        this.state = 'RecoverableFailure';
      }
    }
    this.hooks.onAppEvent('capture-error', {
      error: { code, message, retryable: true, preservedData: true, detail },
    });
    // 通知主进程释放会话级资源（currentSession / 悬浮条 / 摄像头）。
    // 没有这一步，崩一次之后「开始录制」会被永久拒绝，直到重启应用。
    try {
      this.hooks.onSessionEnded?.('error');
    } catch {
      // 回调失败不能掩盖原始错误
    }
  }

  // -------------------------------------------------------------------------
  // 标记与指针
  // -------------------------------------------------------------------------

  addMarker(note: string): RecordingMarker {
    if (!this.session || !['Recording', 'Paused', 'Pausing'].includes(this.state)) {
      // 没有会话时记录标记没有意义（mediaTick 恒为 0），还会写一条指向空会话的 journal。
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '当前不在录制中，无法添加标记。',
        retryable: false,
        preservedData: true,
      });
    }
    const mediaTick = Math.max(0, this.clock.durationTicks(this.nowQpc()));
    const marker: RecordingMarker = {
      id: `mk-${Date.now().toString(36)}-${this.markers.length + 1}`,
      mediaTick,
      note,
      createdAt: Date.now(),
    };
    this.markers.push(marker);
    void this.appendJournal('heartbeat', { marker });
    this.emitStatus(true);
    return marker;
  }

  private startPointerSampling(): void {
    if (this.pointerTimer) clearInterval(this.pointerTimer);
    this.pointerTimer = setInterval(() => {
      if (this.state !== 'Recording') return;
      const point = this.deps.getCursorPoint();
      const session = this.session;
      if (!session) return;
      const mediaTick = Math.max(0, this.clock.durationTicks(this.nowQpc()));
      const x = point.x / Math.max(1, session.effective.width);
      const y = point.y / Math.max(1, session.effective.height);

      const last = this.lastPointer;
      const moved = !last || Math.abs(x - last.x) > POINTER_MOVE_EPSILON || Math.abs(y - last.y) > POINTER_MOVE_EPSILON;
      if (!moved) return;

      this.pointerEvents.push({
        tick: mediaTick,
        kind: 'move',
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        px: point.x,
        py: point.y,
        geometryVersion: 1,
        captureState: 'ok',
        confidence: 1,
      });
      this.lastPointer = { x, y, tick: mediaTick };
    }, POINTER_INTERVAL_MS);
  }

  /** 记录一次点击（由界面/全局钩子调用）。 */
  recordClick(x: number, y: number): void {
    const session = this.session;
    if (!session) return;
    // 只在录制/暂停期间记录：停止后再点击属于下一次会话，时间戳会落在旧时间轴上
    if (!['Recording', 'Paused', 'Pausing'].includes(this.state)) return;
    const mediaTick = Math.max(0, this.clock.durationTicks(this.nowQpc()));
    const nx = Math.max(0, Math.min(1, x / Math.max(1, session.effective.width)));
    const ny = Math.max(0, Math.min(1, y / Math.max(1, session.effective.height)));
    this.pointerEvents.push({ tick: mediaTick, kind: 'down', x: nx, y: ny, px: x, py: y, geometryVersion: 1, captureState: 'ok' });
    this.pointerClicks.push({ tick: mediaTick, x: nx, y: ny });
  }

  private async writePointerLog(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const meta: PointerLog = {
      version: 1,
      sourceWidth: session.effective.width,
      sourceHeight: session.effective.height,
      displayScale: 1,
      geometryVersion: 1,
      // 事件本身逐行写在前面，meta 行不再重复一整份（旧实现让文件体积翻倍）。
      // 读取方 electron/main.ts 的 project:read-pointer-log 会把行事件拼回 meta.events。
      events: [],
      clicks: this.pointerClicks,
    };
    const target = path.join(session.projectPath, 'events', 'pointer.jsonl');
    const lines = this.pointerEvents.map((e) => JSON.stringify(e)).join('\n');
    await fsp.writeFile(target, (lines ? lines + '\n' : '') + JSON.stringify({ __meta: meta, __kind: 'meta' }) + '\n');
  }

  // -------------------------------------------------------------------------
  // 磁盘监控与 journal
  // -------------------------------------------------------------------------

  private startDiskMonitor(): void {
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.diskTimer = setInterval(() => {
      const session = this.session;
      if (!session) return;
      const free = this.deps.getFreeDisk(session.projectPath);
      if (free < DISK_MIN_FREE_BYTES) {
        // 磁盘不足：安全停止并保留已提交素材（§9.5）
        this.hooks.onAppEvent('disk-full', { freeBytes: free });
        void this.stop()
          .catch(() => {
            // 停止失败不掩盖磁盘问题
          })
          .finally(() => {
            // 引擎自行结束后必须让主进程释放会话，否则无法再次开始录制
            try {
              this.hooks.onSessionEnded?.('disk-full');
            } catch {
              // 忽略
            }
          });
      }
      this.emitStatus();
    }, DISK_CHECK_INTERVAL_MS);
  }

  private async appendJournal(
    type: RecoveryJournalEntry['type'],
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.journalSeq += 1;
    const entry: RecoveryJournalEntry = {
      seq: this.journalSeq,
      at: Date.now(),
      type,
      sessionId: session.sessionId,
      detail,
    };
    this.journal.push(entry);
    const target = path.join(session.projectPath, 'recovery', 'journal.jsonl');
    try {
      await fsp.appendFile(target, JSON.stringify(entry) + '\n');
    } catch {
      // journal 写入失败不应中断录制；但要在诊断中体现
      this.hooks.onAppEvent('journal-error', { entry });
    }
  }

  private resetSessionState(): void {
    this.clock.reset();
    this.frames = [];
    this.micPackets = [];
    this.systemPackets = [];
    this.segments = [];
    this.journal = [];
    this.journalSeq = 0;
    this.markers = [];
    this.pointerEvents = [];
    this.pointerClicks = [];
    this.lastPointer = null;
    this.bytesWritten = 0;
    this.levels = { mic: 0, system: 0 };
    this.stopResult = null;
    this.stopping = false;
    this.pendingSegments = [];
    this.draining = false;
    this.framesArrived = 0;
    this.nextSegmentNumber = 1;
    this.grid.reset();
    this.cameraChain = Promise.resolve();
    this.cameraJobsPending = 0;
    this.lastStatusAt = 0;
  }

  // -------------------------------------------------------------------------
  // 工程落盘
  // -------------------------------------------------------------------------

  private async finalizeProject(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const durationTicks = Math.max(0, this.clock.durationTicks());
    await this.deps.createProjectForSession({
      ...session,
      // 把实际产出的段与标记交给工程创建逻辑
      ...({ segments: this.segments, markers: this.markers, durationTicks } as Record<string, unknown>),
    } as RecordSession);
  }

  /** 供工程构建使用：本会话已提交的分段与标记。 */
  getCommittedSegments(): SegmentRecord[] {
    return this.segments.slice();
  }

  getDurationTicks(): number {
    return Math.max(0, this.clock.durationTicks());
  }
}

// ---------------------------------------------------------------------------
// 帧分发服务：把 JPEG 帧通过 HTTP 提供给录制渲染窗口
// ---------------------------------------------------------------------------

export interface FrameServer {
  url: string;
  close: () => Promise<void>;
  /** 供调试：已服务帧数 */
  served: () => number;
}

/**
 * 启动本地帧服务。
 *
 * 为什么用 HTTP 而不是 executeJavaScript 传 Buffer：
 *   跨进程传 3.5MB 的 Buffer 会触发 "An object could not be cloned"，
 *   并且每帧走一次 IPC 会阻塞主进程。HTTP 是流式传输，开销可忽略。
 *
 * 路由：
 *   GET /health          → 会话状态
 *   GET /segment?index=N → 该段的帧与音频（一次性返回，供录制渲染窗口编码）
 */
export async function startFrameServer(engine: CaptureEngine): Promise<FrameServer> {
  let served = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: engine.getState() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    served: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
