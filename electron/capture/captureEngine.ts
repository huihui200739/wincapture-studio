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

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
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
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';
import { SessionClock } from '../../src/domain/sessionClock';
import { AudioWorker, GrabberWorker, type AudioPacket, type VideoFramePacket, type WorkerPaths } from './workers';
import { QpcClock } from './qpcClock';

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

  private segmentIndex = 0;
  private segmentTimer: NodeJS.Timeout | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private pointerTimer: NodeJS.Timeout | null = null;
  private segmentInFlight = false;
  /** 已按固定节拍切好、等待编码的分段队列（保证段时长与编码耗时解耦） */
  private pendingSegments: PendingSegment[] = [];
  /** 是否有编码循环在跑（串行，避免并发创建多个编码器） */
  private draining = false;
  /** 当前这一轮 drain 的完成信号（供并发调用方等待，而不是轮询） */
  private drainSignal: Promise<void> = Promise.resolve();
  /** 累计采集到的帧数（性能探针用，不受分段边界影响） */
  private framesArrived = 0;
  /** 下一段的理论触发时刻（绝对毫秒），用于补偿 setTimeout 调度延迟 */
  private nextSegmentDueAt = 0;
  /** 已切好但还没定稿的段（等下一段首帧来确定结束边界） */
  private heldSlice: PendingSegment | null = null;
  /** 下一个分段编号（从 1 开始，不依赖入队顺序） */
  private nextSegmentNumber = 1;
  /** 当前段的媒体时间结束边界（0 表示尚未确定） */
  private segmentBoundaryTick = 0;
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
    await fsp.mkdir(path.join(projectPath, 'media', 'screen'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'media', 'mic'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'media', 'system'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'events'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'recovery'), { recursive: true });

    this.resetSessionState();
    await this.appendJournal('session-start', { config, qualityId: quality.id });

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
      throw new AppError({
        code: 'E_CAPTURE_UNSUPPORTED',
        message: '无法启动屏幕采集。请检查显示器是否被其他程序独占。',
        retryable: true,
        preservedData: true,
        detail: String(error),
      });
    }

    grabber.onFrame((frame) => this.handleVideoFrame(frame));
    grabber.onExit((reason) => {
      if (!this.stopping && this.state === 'Recording') {
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
    const bounds = this.deps.getCursorPoint;
    void bounds;
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
    if (this.state !== 'Recording') return;
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
    this.maybeSliceByTime(mediaTick);
  }

  /**
   * 按媒体时间边界切段。
   *
   * 边界用「绝对时间栅格」而不是「相对上一段累加」。
   * 若用相对累加（上一段结束 + 2s），每次切片的起点是「越过边界那一帧」的时刻，
   * 边界会被逐段推后最多一帧，累计下来每段实际不足 2.00s：
   * 实测 11 段合计 17.68s，而真实录制时长是 20.05s，丢了 2.37s。
   * 用固定栅格（原点 + n×2s）后，段边界不受帧抖动影响，整段时长严格对齐墙钟。
   *
   * @param currentTick 刚到达帧的媒体时间
   */
  private maybeSliceByTime(currentTick: number): void {
    if (!this.session) return;
    if (this.frames.length === 0) return;

    const segmentTicks = Number(SEGMENT_TARGET_TICKS);

    if (this.segmentBoundaryTick === 0) {
      // 第一帧确立栅格原点
      this.segmentBoundaryTick = this.frames[0].mediaTick + segmentTicks;
      return;
    }

    // 当前帧越过边界才切；这样每段包含到边界（不含）为止的所有帧
    if (currentTick < this.segmentBoundaryTick) return;

    const takeFrames = this.frames;
    const takeMic = this.micPackets;
    const takeSystem = this.systemPackets;
    this.frames = [];
    this.micPackets = [];
    this.systemPackets = [];

    // startTick 必须取栅格边界，而不是「本段实际首帧时刻」。
    // 实际首帧比边界晚最多一个帧间隔；若用它当起点，段与段之间会逐段错开，
    // 累计后与音频、与墙钟都产生偏移。
    // 帧序列本身的抖动由编码器的等间隔重采样吸收（见 recorderRuntime 的 picks 逻辑）。
    const startTick = this.segmentBoundaryTick - segmentTicks;
    // 段时长严格等于栅格步长（2 秒），保证相邻段首尾严丝合缝、总时长等于录制时长。
    const durationTicks = segmentTicks;

    this.pendingSegments.push({
      index: this.nextSegmentNumber,
      startTick,
      durationTicks,
      frames: takeFrames,
      mic: takeMic,
      system: takeSystem,
    });
    this.nextSegmentNumber += 1;

    // 背压：待编码队列超过 2 段就丢最旧的（已编码的更早）。
    // 每段 1080p 持有 60 张 JPEG（约 12MB）+ 序列化副本，
    // 队列一堆积就是几百 MB 内存。正常情况编码（约 1 秒）快于分段（2 秒）不会积压；
    // 只有在磁盘卡顿或编码降级时才可能排队，此时宁可丢中间段也不能让内存无限涨
    // （§16.2 总工作集 ≤1.2GB 优先于「一段不丢」）。
    const MAX_PENDING = 2;
    while (this.pendingSegments.length > MAX_PENDING) {
      const dropped = this.pendingSegments.shift()!;
      void this.appendJournal('segment-dropped', {
        index: dropped.index,
        reason: 'encoder-backpressure',
        frames: dropped.frames.length,
      });
      this.hooks.onAppEvent('segment-dropped', { index: dropped.index, reason: '编码积压' });
    }

    // 下一段边界严格按栅格推进，不受本段实际首帧时刻影响
    this.segmentBoundaryTick += segmentTicks;
    // 若落后过多（长卡顿导致一帧跨过多个边界），跳到当前帧之后的第一个栅格点
    while (this.segmentBoundaryTick <= currentTick) {
      this.segmentBoundaryTick += segmentTicks;
    }

    void this.drainSegmentQueue();
  }

  private handleAudioPacket(packet: AudioPacket): void {
    if (this.state !== 'Recording') return;
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
    // 切段已改为「帧到达时按媒体时间边界驱动」（见 maybeSliceByTime）。
    // 定时器只作为兜底：万一长时间没有新帧（例如画面完全静止且采集端停发），
    // 也要把已累积的帧落盘，避免数据一直压在内存里。
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
   * 最后一段的起点同样取栅格边界，时长取「实际结束时刻 - 栅格起点」。
   * 这样所有段首尾相接、总时长严格等于录制时长，不会出现整段变短。
   * 若最后一段只剩极少帧（例如刚切完段就停止），也要保留：
   * 它承载的是「最后这段时间确实录了」这个事实，丢掉的正是 §16.2 说的尾部损失。
   */
  private flushRemainingFrames(): void {
    if (this.session && this.frames.length > 0) {
      const takeFrames = this.frames;
      const takeMic = this.micPackets;
      const takeSystem = this.systemPackets;
      this.frames = [];
      this.micPackets = [];
      this.systemPackets = [];

      const fps = this.session.effective.fps || 30;
      const frameIntervalTick = Math.round(10_000_000 / Math.max(1, fps));

      // 起点：本段的栅格边界
      const startTick = this.segmentBoundaryTick - Number(SEGMENT_TARGET_TICKS);
      // 结束：最后一帧的时刻 + 一个帧间隔（末帧自身也要占满一帧）
      const lastFrame = takeFrames[takeFrames.length - 1];
      const actualEndTick = lastFrame.mediaTick + frameIntervalTick;
      const durationTicks = Math.max(1, actualEndTick - startTick);

      this.pendingSegments.push({
        index: this.nextSegmentNumber,
        startTick,
        durationTicks,
        frames: takeFrames,
        mic: takeMic,
        system: takeSystem,
      });
      this.nextSegmentNumber += 1;
    }
    this.heldSlice = null;
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
    this.segmentInFlight = true;
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
      this.segmentIndex = index;
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
      await this.writeAudioSegment(session.projectPath, index, takeMic, takeSystem, durationTicks);

      // 摄像头分段（R04）：与屏幕段同索引、同时长，导出时两轨时间映射一致。
      // 失败只记录，不抛异常——摄像头不可用不能中断录制（§9.5）。
      if (this.hooks.commitCameraSegment) {
        try {
          await this.hooks.commitCameraSegment(
            session.projectPath,
            index,
            durationTicks,
            session.effective.fps,
          );
        } catch (error) {
          this.hooks.onAppEvent('camera-error', { index, message: String(error) });
        }
      }

      this.emitStatus(true);
    } catch (error) {
      await this.appendJournal('segment-corrupt', { index, reason: String(error) });
      this.hooks.onAppEvent('segment-error', { index, message: String(error) });
    } finally {
      this.segmentInFlight = false;
    }
  }

  /** 校验分段 MP4 是否可解封装（moov 存在、时长合理）。 */
  private async verifySegment(filePath: string): Promise<{ ok: boolean; reason?: string; durationUs?: number }> {
    try {
      const { Input, FilePathSource, ALL_FORMATS } = await import('mediabunny');
      const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
      const video = await input.getPrimaryVideoTrack();
      if (!video) return { ok: false, reason: 'no-video-track' };
      const duration = await input.computeDuration();
      if (!(duration > 0)) return { ok: false, reason: 'zero-duration' };
      return { ok: true, durationUs: Math.round(duration * 1_000_000) };
    } catch (error) {
      return { ok: false, reason: `demux-failed: ${String(error)}` };
    }
  }

  private async writeAudioSegment(
    projectPath: string,
    index: number,
    mic: AudioPacket[],
    system: AudioPacket[],
    /** 该段应有的时长（ticks）。音频必须与之对齐，否则整段会累计出音画偏差。 */
    durationTicks: number,
  ): Promise<void> {
    await this.writeWav(
      path.join(projectPath, 'media', 'mic', `seg-${String(index).padStart(6, '0')}.wav`),
      mic,
      durationTicks,
    );
    await this.writeWav(
      path.join(projectPath, 'media', 'system', `seg-${String(index).padStart(6, '0')}.wav`),
      system,
      durationTicks,
    );
  }

  /**
   * 写一个音频段的 WAV。
   *
   * 关键：长度必须对齐到该段的声明时长，而不是「实际收到多少采样就写多少」。
   * 音频工作进程（WASAPI）启动比 GDI 采集慢约 0.2~0.3 秒，
   * 首段只能收到 1.74 秒；末段又因为停止时刻截断只剩 0.04 秒。
   * 若不补齐，各段音频累计比视频短几百毫秒，导出后音画偏差逐段放大
   * （实测 339ms，远超 §16.2 的 80ms 要求）。
   *
   * 补齐方式：不足补静音、超出则截断。这样每段音频时长严格等于该段视频时长，
   * 段与段之间天然对齐，整段音画偏差只取决于首帧对齐。
   */
  private async writeWav(target: string, packets: AudioPacket[], durationTicks: number): Promise<void> {
    if (packets.length === 0 && durationTicks <= 0) return;

    const sampleRate = 48_000;
    const channels = 2;
    const expectedFrames = Math.max(0, Math.round((durationTicks / 10_000_000) * sampleRate));

    let total = 0;
    for (const p of packets) total += p.left.length;
    // 以声明时长为准：不足补静音，超出截断
    const frameCount = expectedFrames > 0 ? expectedFrames : total;
    if (frameCount === 0) return;

    const data = Buffer.alloc(frameCount * 4 * 2); // 立体声 32-bit float
    let offset = 0;
    let written = 0;
    outer: for (const p of packets) {
      for (let i = 0; i < p.left.length; i++) {
        if (written >= frameCount) break outer;
        data.writeFloatLE(p.left[i], offset);
        offset += 4;
        data.writeFloatLE(p.right[i], offset);
        offset += 4;
        written++;
      }
    }
    // 剩余部分是 Buffer.alloc 的零值，天然就是静音，无需额外写入

    // WAVE_FORMAT_IEEE_FLOAT（3）32-bit
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 4, 28);
    header.writeUInt16LE(channels * 4, 32);
    header.writeUInt16LE(32, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    await fsp.writeFile(target, Buffer.concat([header, data]));
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
    this.transition('Pausing');
    // 先提交当前段，保证暂停点之前的画面完整
    this.flushRemainingFrames();
    await this.drainSegmentQueue();
    this.clock.pause(this.nowQpc());
    await this.appendJournal('pause', { at: this.nowQpc() });
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
    if (this.state === 'Stopping' || this.state === 'Finalizing') {
      // 已有停止在进行中
      while (this.state === 'Stopping' || this.state === 'Finalizing') {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.stopResult) return this.stopResult;
    }

    this.stopping = true;
    this.stopTimers();
    if (this.state === 'Recording' || this.state === 'Paused') {
      this.transition('Stopping');
    }
    this.clock.stop(this.nowQpc());
    await this.appendJournal('stop', { at: this.nowQpc() });

    // 关键顺序：先停采集进程、把管道里剩下的帧读完，再切最后一段。
    //
    // 旧顺序是「先 flushRemainingFrames 再停 grabber」，结果已经写进管道
    // 但还没被主进程读走的帧（约 2 秒的量，正好一个分段窗口）会被直接丢弃，
    // 实测 20 秒录制只成片 18 秒，覆盖率 90%。
    // 停止采集进程会等 stdout 排空（见 GrabberWorker.stop 的 drain 逻辑），
    // 因此停完之后 this.frames 里才是「本次录制完整的全部帧」。
    await this.grabber?.stop();
    await this.audio?.stop();
    this.grabber = null;
    this.audio = null;

    // 现在提交最后一段
    this.flushRemainingFrames();
    await this.drainSegmentQueue();
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
    if (this.state === 'Idle' || this.state === 'ReadyToEdit') return;
    this.stopping = true;
    this.stopTimers();
    await this.grabber?.stop();
    await this.audio?.stop();
    this.grabber = null;
    this.audio = null;
    if (this.state !== 'Cancelled') {
      try {
        this.transition('Cancelled');
      } catch {
        this.state = 'Cancelled';
      }
    }
    this.transition('Idle');
  }

  private failSession(code: string, message: string, detail?: string): void {
    this.stopping = true;
    this.stopTimers();
    void this.grabber?.stop();
    void this.audio?.stop();
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
  }

  // -------------------------------------------------------------------------
  // 标记与指针
  // -------------------------------------------------------------------------

  addMarker(note: string): RecordingMarker {
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
    const mediaTick = Math.max(0, this.clock.durationTicks(this.nowQpc()));
    const nx = Math.max(0, Math.min(1, x / Math.max(1, session.effective.width)));
    const ny = Math.max(0, Math.min(1, y / Math.max(1, session.effective.height)));
    this.pointerEvents.push({ tick: mediaTick, kind: 'down', x: nx, y: ny, px: x, py: y, geometryVersion: 1, captureState: 'ok' });
    this.pointerClicks.push({ tick: mediaTick, x: nx, y: ny });
  }

  private async writePointerLog(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const log: PointerLog = {
      version: 1,
      sourceWidth: session.effective.width,
      sourceHeight: session.effective.height,
      displayScale: 1,
      geometryVersion: 1,
      events: this.pointerEvents,
      clicks: this.pointerClicks,
    };
    const target = path.join(session.projectPath, 'events', 'pointer.jsonl');
    const lines = log.events.map((e) => JSON.stringify(e)).join('\n');
    await fsp.writeFile(target, (lines ? lines + '\n' : '') + JSON.stringify({ __meta: log, __kind: 'meta' }) + '\n');
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
        void this.stop().catch(() => {
          // 停止失败不掩盖磁盘问题
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
    this.segmentIndex = 0;
    this.bytesWritten = 0;
    this.levels = { mic: 0, system: 0 };
    this.stopResult = null;
    this.stopping = false;
    this.segmentInFlight = false;
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
