/**
 * 源素材解码器（开发文档 §11.1 / §11.4 / §9.5）
 *
 * 职责：把工程里的「源素材」按任意时间点解出画面与 PCM，交给 compositor.drawScene 合成。
 * 本文件不做任何绘制，只负责「时间 → 帧 / 采样」的取数。
 *
 * 关键约束：
 * - WP-A 录制时每约 2 秒产出一个**自包含 MP4**（moov 前置），所以一个素材可能是多个段文件。
 *   这里用 `SegmentSet` 描述「一组段 + 各自起始时间」，跨段边界按时间轴连续取帧。
 * - 同一段内顺序读取要快：维护每个段的解码游标（顺序前进），只有跳读超出窗口才重新 seek。
 * - 返回给调用方的是**自己持有的 OffscreenCanvas**，而不是 VideoFrame：
 *   mediabunny 的 `VideoSample.toCanvasImageSource()` 返回的 VideoFrame 会在下一个微任务被自动关闭，
 *   直接交给异步绘制路径会拿到已关闭的帧。
 * - 本文件运行在渲染进程（WebCodecs 只在渲染进程可用），不引入 node:fs。
 */

import { AppError } from '../shared/errors';
import type { TickRange, Ticks } from '../domain/timebase';
import { TICKS_PER_SECOND } from '../domain/timebase';

// ---------------------------------------------------------------------------
// mediabunny 运行时装载
// ---------------------------------------------------------------------------
//
// 环境差异（已实测）：
//   Node 侧：require('mediabunny/dist/bundles/mediabunny.node.cjs')
//   渲染进程：UMD bundle node_modules/mediabunny/dist/bundles/mediabunny.cjs（<script> 后挂到 globalThis.Mediabunny）
//
// 本文件只用结构化的最小接口，不静态 import 'mediabunny'，避免把解码器绑死在某个打包方式上。

export interface MediabunnyVideoSample {
  readonly timestamp: number;
  readonly duration: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  draw(
    context: OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void;
  toCanvasImageSource(): CanvasImageSource;
  close(): void;
}

export interface MediabunnyVideoSink {
  samples(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<MediabunnyVideoSample, void, unknown>;
  getSample(timestamp: number): Promise<MediabunnyVideoSample | null>;
}

export interface MediabunnyWrappedAudioBuffer {
  buffer: AudioBuffer;
  timestamp: number;
  duration: number;
}

export interface MediabunnyAudioSink {
  buffers(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<MediabunnyWrappedAudioBuffer, void, unknown>;
}

export interface MediabunnyVideoTrack {
  getCodedWidth(): Promise<number>;
  getCodedHeight(): Promise<number>;
  getRotation(): Promise<number>;
  getCodec(): Promise<string | null>;
}

export interface MediabunnyAudioTrack {
  getNumberOfChannels(): Promise<number>;
  getSampleRate(): Promise<number>;
  getCodec(): Promise<string | null>;
}

export interface MediabunnyInput {
  getPrimaryVideoTrack(): Promise<MediabunnyVideoTrack | null>;
  getPrimaryAudioTrack(): Promise<MediabunnyAudioTrack | null>;
  computeDuration(): Promise<number>;
  getFirstTimestamp(): Promise<number>;
  dispose(): void;
}

export interface MediabunnyLike {
  Input: new (options: { source: unknown; formats: unknown[]; initInput?: unknown }) => MediabunnyInput;
  ALL_FORMATS: unknown[];
  BlobSource: new (blob: Blob) => unknown;
  /**
   * 直接以 Uint8Array/ArrayBuffer 为数据源（不复制）。
   * 校验整片 MP4 时用它替代 BlobSource，可少一份整片副本。
   */
  BufferSource?: new (buffer: ArrayBuffer | ArrayBufferView) => unknown;
  FilePathSource?: new (path: string) => unknown;
  VideoSampleSink: new (track: MediabunnyVideoTrack) => MediabunnyVideoSink;
  AudioBufferSink: new (track: MediabunnyAudioTrack) => MediabunnyAudioSink;
}

let injectedLib: MediabunnyLike | null = null;

/** 由宿主（渲染进程 / 验证脚本）注入已加载的 mediabunny 模块。 */
export function configureMediabunny(lib: MediabunnyLike | null): void {
  injectedLib = lib;
}

/**
 * 取得 mediabunny 模块。
 * 顺序：显式注入 → 全局 UMD（渲染进程 script 标签）→ Node require（Node 侧）。
 */
export function loadMediabunny(): MediabunnyLike {
  if (injectedLib) return injectedLib;

  const g = globalThis as unknown as Record<string, unknown> & {
    require?: (id: string) => unknown;
  };
  const globalUmd = g.Mediabunny as MediabunnyLike | undefined;
  if (globalUmd && typeof globalUmd.Input === 'function') {
    injectedLib = globalUmd;
    return injectedLib;
  }
  if (typeof g.require === 'function') {
    for (const id of ['mediabunny/dist/bundles/mediabunny.node.cjs', 'mediabunny']) {
      try {
        const mod = g.require(id) as MediabunnyLike;
        if (mod && typeof mod.Input === 'function') {
          injectedLib = mod;
          return mod;
        }
      } catch {
        // 换下一个候选
      }
    }
  }
  throw new AppError({
    code: 'E_EXPORT_FAILED',
    message: '解码器未就绪：mediabunny 未加载。',
    retryable: true,
    preservedData: true,
    detail: 'decoder.ts: 请先在渲染进程注入 mediabunny UMD bundle，或调用 configureMediabunny()。',
  });
}

// ---------------------------------------------------------------------------
// 分段素材
// ---------------------------------------------------------------------------

/**
 * 一个段文件。WP-A 的分段录制里，同一素材由多个自包含 MP4 顺序拼接而成。
 */
export interface MediaSegment {
  /** 段文件路径（Node 侧直接读）或渲染进程交给 readFile 的键 */
  path: string;
  /** 该段首帧在**素材时间轴**上的 tick（不是文件内时间） */
  startTick: Ticks;
  /** 段可用时长（可选提示；缺省时按下一段起点推算） */
  durationTicks?: Ticks;
  /** 已读入的字节（渲染进程由主进程读好后传入，避免二次读盘） */
  data?: Uint8Array | Blob;
}

/**
 * 一组段文件 + 各自起始时间，提供「任意时间点落在哪个段」的查询。
 *
 * 段在时间轴上首尾相接：第 i 段覆盖 [startTick_i, startTick_{i+1})，
 * 最后一段覆盖 [startTick_last, +∞)（真实结束时间由解码器探测）。
 */
export class SegmentSet {
  readonly segments: MediaSegment[];

  constructor(segments: readonly MediaSegment[]) {
    this.segments = segments
      .filter((s) => !!s && typeof s.path === 'string')
      .map((s) => ({ ...s, startTick: Math.max(0, Math.round(s.startTick || 0)) }))
      .sort((a, b) => a.startTick - b.startTick);
  }

  get length(): number {
    return this.segments.length;
  }

  get empty(): boolean {
    return this.segments.length === 0;
  }

  get startTick(): Ticks {
    return this.segments.length ? this.segments[0].startTick : 0;
  }

  /** 时间轴总时长（仅在各段都给了 durationTicks 时精确）。 */
  get durationTicks(): Ticks {
    if (!this.segments.length) return 0;
    let end = this.startTick;
    for (const seg of this.segments) {
      const dur = seg.durationTicks ?? 0;
      end = Math.max(end, seg.startTick + dur);
    }
    return end - this.startTick;
  }

  /** 段 i 在时间轴上的结束 tick（最后一段返回 +∞）。 */
  endTickOf(index: number): Ticks {
    if (index < 0 || index >= this.segments.length) return 0;
    if (index === this.segments.length - 1) return Number.POSITIVE_INFINITY;
    return this.segments[index + 1].startTick;
  }

  /** 覆盖 tick 的段下标；早于第一段返回 -1。 */
  indexAt(tick: Ticks): number {
    const segs = this.segments;
    if (!segs.length) return -1;
    if (tick < segs[0].startTick) return -1;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].startTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** 与 [range.start, range.end) 有交集的段下标列表（升序）。 */
  indicesIn(range: TickRange): number[] {
    const out: number[] = [];
    if (range.end <= range.start || !this.segments.length) return out;
    let index = Math.max(0, this.indexAt(range.start));
    while (index < this.segments.length) {
      const seg = this.segments[index];
      if (seg.startTick >= range.end) break;
      const segEnd = this.endTickOf(index);
      if (segEnd > range.start) out.push(index);
      index += 1;
    }
    return out;
  }

  /** 归一化到某个段内部的秒数。 */
  localSeconds(index: number, tick: Ticks): number {
    const seg = this.segments[index];
    if (!seg) return 0;
    return Math.max(0, (tick - seg.startTick) / TICKS_PER_SECOND);
  }
}

/** 便于调用方从「单个文件素材」快速构造。 */
export function singleSegmentSet(path: string, durationTicks = 0): SegmentSet {
  return new SegmentSet([{ path, startTick: 0, durationTicks }]);
}

// ---------------------------------------------------------------------------
// 解码 PCM
// ---------------------------------------------------------------------------

/** 解码出的一段平面 PCM。 */
export interface DecodedAudio {
  /** 平面 Float32（长度 = 声道数），每声道 frameCount 个采样 */
  channels: Float32Array[];
  sampleRate: number;
  /** 第一个采样对应的**素材时间轴** tick */
  startTick: Ticks;
  frameCount: number;
  /** 区间内是否真的取到了非静音数据（全零也算取到，这里只表示「有音轨数据」） */
  hasData: boolean;
}

// ---------------------------------------------------------------------------
// VideoFrameSource
// ---------------------------------------------------------------------------

export interface VideoFrameSourceOptions {
  /** 目标音频采样率（默认 48000，与导出内部采样率一致，避免二次重采样） */
  sampleRate?: number;
  /** 读取段文件字节；渲染进程必须提供（无 node:fs） */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** 是否允许直接用 Node 文件路径（默认：有 readFile 时关闭） */
  nodeFilePaths?: boolean;
  /** mediabunny 模块（缺省走 loadMediabunny()） */
  mediabunny?: MediabunnyLike;
  /** 顺序读取的跳读窗口（秒）；超出则重新 seek。默认 1.5s */
  seekWindowSeconds?: number;
  /** 同时保持打开的段数上限（LRU 淘汰）。默认 8 */
  maxOpenSegments?: number;
}

interface FrameCache {
  start: number;
  end: number;
  canvas: OffscreenCanvas;
}

interface VideoCursor {
  iter: AsyncIterator<MediabunnyVideoSample> | null;
  sample: MediabunnyVideoSample | null;
  next?: MediabunnyVideoSample | null;
  /** 当前 sample 的文件内时间戳（秒） */
  pos: number;
}

interface AudioCursor {
  iter: AsyncIterator<MediabunnyWrappedAudioBuffer> | null;
  next: MediabunnyWrappedAudioBuffer | null;
  /** 已消费到的文件内时间（秒） */
  pos: number;
}

interface SegmentEntry {
  index: number;
  segment: MediaSegment;
  input: MediabunnyInput | null;
  videoTrack: MediabunnyVideoTrack | null;
  audioTrack: MediabunnyAudioTrack | null;
  videoSink: MediabunnyVideoSink | null;
  audioSink: MediabunnyAudioSink | null;
  width: number;
  height: number;
  audioChannels: number;
  audioSampleRate: number;
  /** 该段媒体时长（秒） */
  durationSeconds: number;
  canvas: OffscreenCanvas | null;
  frame: FrameCache | null;
  videoCursor: VideoCursor | null;
  audioCursor: AudioCursor | null;
  lastUsed: number;
}

const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_SEEK_WINDOW = 1.5;
const DEFAULT_MAX_OPEN = 8;
/** 顺序读取时容忍的时间戳抖动（秒） */
const TIME_EPS = 1e-6;

/**
 * 一个素材的画面 / 声音来源。
 *
 * 用法：
 *   const src = new VideoFrameSource({ readFile });
 *   await src.open(segments);
 *   const frame = await src.getFrameAt(tick);   // OffscreenCanvas（复用，别长期持有）
 *   const pcm = await src.getAudioAt({ start, end }, { channels: 2 });
 *   src.close();
 */
export class VideoFrameSource {
  private set: SegmentSet;
  private readonly sampleRate: number;
  private readonly seekWindow: number;
  private readonly maxOpen: number;
  private readonly lib: MediabunnyLike;
  private readonly readFile?: (path: string) => Promise<Uint8Array>;
  private readonly useNodePaths: boolean;

  private readonly entries = new Map<number, SegmentEntry>();
  /** 正在打开中的段：同一段的并发 `ensureOpen` 复用同一个 Promise，避免重复创建 Input 泄漏 */
  private readonly opening = new Map<number, Promise<SegmentEntry>>();
  private readonly failed = new Set<number>();
  private opened = false;
  private clock = 0;

  constructor(private readonly options: VideoFrameSourceOptions = {}, segments?: readonly MediaSegment[]) {
    this.set = new SegmentSet(segments ?? []);
    this.sampleRate = Math.round(options.sampleRate && options.sampleRate > 0 ? options.sampleRate : DEFAULT_SAMPLE_RATE);
    this.seekWindow = Math.max(0.1, options.seekWindowSeconds ?? DEFAULT_SEEK_WINDOW);
    this.maxOpen = Math.max(1, Math.round(options.maxOpenSegments ?? DEFAULT_MAX_OPEN));
    this.readFile = options.readFile;
    this.useNodePaths = options.nodeFilePaths ?? !options.readFile;
    this.lib = options.mediabunny ?? loadMediabunny();
  }

  /** 打开一组段文件。可重复调用（会先关闭已有段）。 */
  async open(segments?: readonly MediaSegment[] | SegmentSet): Promise<void> {
    if (segments) {
      const next = segments instanceof SegmentSet ? new SegmentSet(segments.segments) : new SegmentSet(segments);
      this.set = next;
    }
    this.closeEntries();
    this.failed.clear();
    this.opened = true;
    if (this.set.empty) {
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '素材没有可用的分段文件。',
        retryable: true,
        preservedData: true,
        detail: 'decoder.ts: SegmentSet 为空',
      });
    }
    // 预热：尽早暴露「素材缺失 / 编解码器不可用」这类问题，而不是等逐帧渲染时
    // 静默拿到 null、最终导出一部黑屏视频。首段损坏时继续探测后续段（上限 5 段），
    // 全部打不开才算素材不可用。
    let firstError: unknown = null;
    const probeLimit = Math.min(this.set.length, 5);
    for (let i = 0; i < probeLimit; i++) {
      try {
        await this.ensureOpen(i);
        firstError = null;
        break;
      } catch (error) {
        this.failed.add(i);
        if (firstError === null) firstError = error;
      }
    }
    if (this.entries.size === 0) {
      const detail = firstError instanceof Error ? firstError.message : String(firstError ?? '未知原因');
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '素材的所有分段都无法打开。',
        retryable: true,
        preservedData: true,
        detail: `decoder.ts: ${detail}`,
      });
    }
  }

  get segmentSet(): SegmentSet {
    return this.set;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 是否至少有一段带视频轨。 */
  get hasVideo(): boolean {
    for (const entry of this.entries.values()) if (entry.videoTrack) return true;
    return false;
  }

  /** 是否至少有一段带音频轨。 */
  get hasAudio(): boolean {
    for (const entry of this.entries.values()) if (entry.audioTrack) return true;
    return false;
  }

  /** 已探测到的素材时间轴总时长（tick）。未探测到的段按段起点推算。 */
  get durationTicks(): Ticks {
    let end = this.set.startTick;
    for (let i = 0; i < this.set.length; i++) {
      const entry = this.entries.get(i);
      const seg = this.set.segments[i];
      const dur = entry ? Math.round(entry.durationSeconds * TICKS_PER_SECOND) : (seg.durationTicks ?? 0);
      end = Math.max(end, seg.startTick + dur);
    }
    return Math.max(0, end - this.set.startTick);
  }

  /**
   * 取 tick 时刻应显示的画面：**最近的前一帧**。
   * 只有整条素材都没有可用帧时才返回 null（会向前回溯到更早的段）。
   *
   * 分段录制里任意一段损坏不应让整次导出失败（§9.5 分段自包含的恢复意义）：
   * 当前段解码异常时把它标记为失败并回溯到更早的段，用上一段的末帧兜底。
   */
  async getFrameAt(tick: Ticks): Promise<OffscreenCanvas | null> {
    this.requireOpen();
    const index = this.set.indexAt(tick);
    if (index < 0) return null;
    for (let i = index; i >= 0; i--) {
      if (this.failed.has(i)) continue;
      try {
        const frame = await this.frameInSegment(i, tick);
        if (frame) return frame;
      } catch {
        // 段损坏 / 解码器异常：释放该段资源并回溯，不再对同一段反复重试
        this.markSegmentFailed(i);
      }
    }
    return null;
  }

  /** 取 tick 所在段该时刻的画面尺寸（未解码时返回 null）。 */
  async getSizeAt(tick: Ticks): Promise<{ width: number; height: number } | null> {
    const index = this.set.indexAt(tick);
    if (index < 0) return null;
    const entry = await this.ensureOpen(index).catch(() => null);
    if (!entry || !entry.videoTrack) return null;
    return { width: entry.width, height: entry.height };
  }

  /**
   * 取 [range.start, range.end) 的 PCM（已按目标采样率重采样、已对齐到采样网格）。
   * 区间内没有音轨数据时返回 null。
   */
  async getAudioAt(range: TickRange, options: { channels?: number } = {}): Promise<DecodedAudio | null> {
    this.requireOpen();
    const sr = this.sampleRate;
    const startSample = Math.max(0, Math.round((range.start * sr) / TICKS_PER_SECOND));
    const endSample = Math.max(startSample, Math.round((range.end * sr) / TICKS_PER_SECOND));
    const count = endSample - startSample;
    if (count <= 0) return null;

    const indices = this.set.indicesIn(range);
    if (!indices.length) return null;

    let hasAnyAudioTrack = false;
    for (const i of indices) {
      const entry = await this.ensureOpen(i).catch(() => null);
      if (entry?.audioSink) hasAnyAudioTrack = true;
    }
    if (!hasAnyAudioTrack) return null;

    const channels = Math.max(1, Math.round(options.channels ?? this.pickChannels(indices)));
    const out: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(count));
    let wrote = false;

    for (const i of indices) {
      const entry = await this.ensureOpen(i).catch(() => null);
      if (!entry || !entry.audioSink) continue;
      const segStart = this.set.segments[i].startTick;
      const segEnd = this.set.endTickOf(i);
      const interStart = Math.max(range.start, segStart);
      const interEnd = Math.min(range.end, Number.isFinite(segEnd) ? segEnd : range.end);
      if (interEnd <= interStart) continue;

      const aSec = (interStart - segStart) / TICKS_PER_SECOND;
      const bSec = (interEnd - segStart) / TICKS_PER_SECOND;
      const buffers = await this.collectAudioBuffers(entry, aSec, bSec);
      for (const wb of buffers) {
        if (this.copyBufferInto(wb, segStart, range, startSample, count, sr, out, channels)) wrote = true;
      }
    }

    return {
      channels: out,
      sampleRate: sr,
      startTick: Math.round((startSample * TICKS_PER_SECOND) / sr),
      frameCount: count,
      hasData: wrote,
    };
  }

  /** 关闭所有段，释放解码器与文件句柄。 */
  close(): void {
    this.closeEntries();
    this.opened = false;
  }

  // -------------------------------------------------------------------------
  // 内部：段打开与 LRU
  // -------------------------------------------------------------------------

  private requireOpen(): void {
    if (!this.opened) {
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '解码器尚未打开素材。',
        retryable: true,
        preservedData: true,
        detail: 'decoder.ts: 先调用 open(segments)',
      });
    }
  }

  private pickChannels(indices: number[]): number {
    for (const i of indices) {
      const entry = this.entries.get(i);
      if (entry?.audioTrack && entry.audioChannels > 0) return entry.audioChannels;
    }
    return 2;
  }

  private async makeSource(segment: MediaSegment): Promise<unknown> {
    if (segment.data !== undefined) {
      const blob = segment.data instanceof Blob ? segment.data : new Blob([segment.data as unknown as BlobPart]);
      return new this.lib.BlobSource(blob);
    }
    if (this.readFile) {
      const bytes = await this.readFile(segment.path);
      return new this.lib.BlobSource(new Blob([bytes as unknown as BlobPart]));
    }
    if (this.useNodePaths && this.lib.FilePathSource) {
      return new this.lib.FilePathSource(segment.path);
    }
    throw new AppError({
      code: 'E_MEDIA_MISSING',
      message: '无法读取素材文件。',
      retryable: true,
      preservedData: true,
      detail: `decoder.ts: 段 ${segment.path} 既没有 data，也没有 readFile / FilePathSource`,
    });
  }

  private async ensureOpen(index: number): Promise<SegmentEntry> {
    const existing = this.entries.get(index);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing;
    }
    // 同一段的并发打开必须合并：两次并发各建一个 Input 时，后写入 entries 的会
    // 覆盖前一个，被覆盖的 Input/解码器永远拿不到 dispose（文件句柄 + 解码上下文泄漏）。
    const inflight = this.opening.get(index);
    if (inflight) return inflight;
    const promise = this.openEntry(index);
    this.opening.set(index, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(index);
    }
  }

  private async openEntry(index: number): Promise<SegmentEntry> {
    const segment = this.set.segments[index];
    if (!segment) {
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '素材分段索引越界。',
        retryable: false,
        preservedData: true,
        detail: `decoder.ts: index=${index} total=${this.set.length}`,
      });
    }

    const source = await this.makeSource(segment);
    const input = new this.lib.Input({ source, formats: this.lib.ALL_FORMATS });
    const entry: SegmentEntry = {
      index,
      segment,
      input,
      videoTrack: null,
      audioTrack: null,
      videoSink: null,
      audioSink: null,
      width: 0,
      height: 0,
      audioChannels: 0,
      audioSampleRate: 0,
      durationSeconds: segment.durationTicks ? segment.durationTicks / TICKS_PER_SECOND : 0,
      canvas: null,
      frame: null,
      videoCursor: null,
      audioCursor: null,
      lastUsed: ++this.clock,
    };

    try {
      const [videoTrack, audioTrack, duration] = await Promise.all([
        input.getPrimaryVideoTrack().catch(() => null),
        input.getPrimaryAudioTrack().catch(() => null),
        input.computeDuration().catch(() => 0),
      ]);
      if (duration > 0) entry.durationSeconds = duration;
      if (videoTrack) {
        entry.videoTrack = videoTrack;
        const [w, h] = await Promise.all([
          videoTrack.getCodedWidth().catch(() => 0),
          videoTrack.getCodedHeight().catch(() => 0),
        ]);
        entry.width = w;
        entry.height = h;
        entry.videoSink = new this.lib.VideoSampleSink(videoTrack);
      }
      if (audioTrack) {
        entry.audioTrack = audioTrack;
        const [ch, rate] = await Promise.all([
          audioTrack.getNumberOfChannels().catch(() => 0),
          audioTrack.getSampleRate().catch(() => 0),
        ]);
        entry.audioChannels = ch;
        entry.audioSampleRate = rate;
        entry.audioSink = new this.lib.AudioBufferSink(audioTrack);
      }
    } catch (error) {
      this.disposeEntry(entry);
      throw error;
    }

    if (!entry.videoTrack && !entry.audioTrack) {
      this.disposeEntry(entry);
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '素材分段既没有视频轨也没有音频轨。',
        retryable: true,
        preservedData: true,
        detail: `decoder.ts: ${segment.path}`,
      });
    }

    this.entries.set(index, entry);
    this.evictIfNeeded(index);
    return entry;
  }

  /** 已判定损坏并跳过的分段索引（导出侧据此如实报告降级）。 */
  failedSegmentIndexes(): number[] {
    return [...this.failed].sort((a, b) => a - b);
  }

  /** 标记某段不可用并立即释放它的解码器/文件句柄（损坏段不再占用资源）。 */
  private markSegmentFailed(index: number): void {
    this.failed.add(index);
    const entry = this.entries.get(index);
    if (!entry) return;
    this.entries.delete(index);
    this.disposeEntry(entry);
  }

  private evictIfNeeded(keep: number): void {
    if (this.entries.size <= this.maxOpen) return;
    const candidates = [...this.entries.values()]
      .filter((e) => e.index !== keep)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.entries.size > this.maxOpen && candidates.length) {
      const victim = candidates.shift()!;
      this.entries.delete(victim.index);
      this.disposeEntry(victim);
    }
  }

  private disposeEntry(entry: SegmentEntry): void {
    this.closeVideoCursor(entry);
    // 音频游标是一个挂起的 async generator，不 return 会一直持有 mediabunny 的
    // 解码器与文件读取器引用，直到 GC；长录制里 LRU 反复驱逐段时会累积句柄。
    if (entry.audioCursor?.iter && typeof entry.audioCursor.iter.return === 'function') {
      void Promise.resolve(entry.audioCursor.iter.return()).catch(() => undefined);
    }
    entry.audioCursor = null;
    entry.frame = null;
    entry.canvas = null;
    try {
      entry.input?.dispose();
    } catch {
      // 忽略释放异常
    }
    entry.input = null;
    entry.videoSink = null;
    entry.audioSink = null;
  }

  private closeEntries(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    // 打开中的段无法取消，但清空记录避免 open() 后残留旧 Promise
    this.opening.clear();
  }

  // -------------------------------------------------------------------------
  // 内部：视频取帧
  // -------------------------------------------------------------------------

  private async frameInSegment(index: number, tick: Ticks): Promise<OffscreenCanvas | null> {
    let entry: SegmentEntry;
    try {
      entry = await this.ensureOpen(index);
    } catch {
      this.failed.add(index);
      return null;
    }
    if (!entry.videoSink) return null;

    const local = Math.max(0, (tick - entry.segment.startTick) / TICKS_PER_SECOND);
    const cached = entry.frame;
    if (cached && local + TIME_EPS >= cached.start && local < cached.end + TIME_EPS) return cached.canvas;

    const sample = await this.sampleAt(entry, local);
    if (!sample) return null;
    const canvas = this.paint(entry, sample);
    const dur = sample.duration && sample.duration > 0 ? sample.duration : 1 / 60;
    entry.frame = { start: sample.timestamp, end: sample.timestamp + dur, canvas };
    return canvas;
  }

  /** 取「文件内时间 t 处最近的前一帧」。同一段内顺序前进，跳读才重新 seek。 */
  private async sampleAt(entry: SegmentEntry, t: number): Promise<MediabunnyVideoSample | null> {
    const sink = entry.videoSink;
    if (!sink) return null;

    const cursor = entry.videoCursor;
    const sequential = cursor && t + TIME_EPS >= cursor.pos && t - cursor.pos <= this.seekWindow;
    if (!sequential) {
      this.closeVideoCursor(entry);
      const sample = await sink.getSample(t);
      if (!sample) return null;
      entry.videoCursor = { iter: null, sample, pos: sample.timestamp };
      return sample;
    }

    const cur = entry.videoCursor!;
    // 已有帧仍覆盖 t：直接用，不必再解码下一帧
    const curDur = cur.sample && cur.sample.duration > 0 ? cur.sample.duration : 0;
    if (cur.sample && curDur > 0 && cur.pos + curDur > t + TIME_EPS) return cur.sample;
    if (!cur.iter) cur.iter = sink.samples(cur.pos + 1e-4)[Symbol.asyncIterator]();
    return this.advanceVideoCursor(cur, t);
  }

  private async advanceVideoCursor(
    cur: VideoCursor,
    t: number,
  ): Promise<MediabunnyVideoSample | null> {
    for (;;) {
      const next = cur.next ? { done: false, value: cur.next } : await cur.iter!.next();
      cur.next = null;
      if (next.done) return cur.sample;
      const sample = next.value;
      if (sample.timestamp > t + TIME_EPS) {
        // 越过了目标：保留上一帧（t 早于首帧时用这一帧兜底）
        if (cur.sample) {
          cur.next = sample;
          return cur.sample;
        }
        cur.sample = sample;
        cur.pos = sample.timestamp;
        return sample;
      }
      if (cur.sample && cur.sample !== sample) cur.sample.close();
      cur.sample = sample;
      cur.pos = sample.timestamp;
      const dur = sample.duration && sample.duration > 0 ? sample.duration : 0;
      if (dur <= 0 || sample.timestamp + dur > t + TIME_EPS) return sample;
    }
  }

  private closeVideoCursor(entry: SegmentEntry): void {
    const cursor = entry.videoCursor;
    entry.videoCursor = null;
    if (!cursor) return;
    try {
      cursor.sample?.close();
      cursor.next?.close();
    } catch {
      // 忽略
    }
    if (cursor.iter && typeof cursor.iter.return === 'function') {
      void Promise.resolve(cursor.iter.return()).catch(() => undefined);
    }
  }

  private paint(entry: SegmentEntry, sample: MediabunnyVideoSample): OffscreenCanvas {
    const w = Math.max(1, Math.round(sample.displayWidth || entry.width || 2));
    const h = Math.max(1, Math.round(sample.displayHeight || entry.height || 2));
    if (!entry.canvas || entry.canvas.width !== w || entry.canvas.height !== h) {
      entry.canvas = new OffscreenCanvas(w, h);
    }
    const ctx = entry.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('decoder.ts: 无法创建 2D 上下文');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // sample.draw 会应用 rotation / flip 元数据，比 toCanvasImageSource 更稳
    sample.draw(ctx, 0, 0, w, h);
    return entry.canvas;
  }

  // -------------------------------------------------------------------------
  // 内部：音频取数
  // -------------------------------------------------------------------------

  /** 收集 [aSec, bSec) 内（文件内时间）的音频块，段内顺序前进。 */
  private async collectAudioBuffers(
    entry: SegmentEntry,
    aSec: number,
    bSec: number,
  ): Promise<MediabunnyWrappedAudioBuffer[]> {
    const sink = entry.audioSink;
    const out: MediabunnyWrappedAudioBuffer[] = [];
    if (!sink || bSec <= aSec) return out;

    let cursor = entry.audioCursor;
    const sequential = cursor && aSec + TIME_EPS >= cursor.pos && aSec - cursor.pos <= this.seekWindow;
    if (!sequential) {
      // 重建游标前必须关掉旧的 async generator：disposeEntry 里已经写明「不 return
      // 会一直持有解码器与文件读取器，直到 GC」，但这条重建路径过去漏了。
      // 时间线来回 seek/重排时每次都泄漏一个仍持有句柄的 generator。
      if (cursor?.iter && typeof cursor.iter.return === 'function') {
        void Promise.resolve(cursor.iter.return()).catch(() => undefined);
      }
      cursor = { iter: null, next: null, pos: Math.max(0, aSec - 0.5) };
      entry.audioCursor = cursor;
    }
    const cur = cursor!;
    if (!cur.iter) cur.iter = sink.buffers(cur.pos)[Symbol.asyncIterator]();

    for (;;) {
      if (!cur.next) {
        const next = await cur.iter.next();
        if (next.done) break;
        cur.next = next.value;
      }
      const wb = cur.next;
      const start = wb.timestamp;
      if (start >= bSec - TIME_EPS) break;
      cur.next = null;
      const end = start + (wb.duration > 0 ? wb.duration : wb.buffer.length / wb.buffer.sampleRate);
      cur.pos = end;
      if (end > aSec + TIME_EPS) out.push(wb);
    }
    return out;
  }

  /**
   * 把一个源音频块按时间对齐混入输出缓冲。
   * @returns 是否真的写入了采样
   */
  private copyBufferInto(
    wb: MediabunnyWrappedAudioBuffer,
    segmentStartTick: Ticks,
    range: TickRange,
    outStartSample: number,
    outCount: number,
    outSampleRate: number,
    out: Float32Array[],
    outChannels: number,
  ): boolean {
    const buf = wb.buffer;
    const srcRate = buf.sampleRate;
    if (!srcRate || buf.length <= 0) return false;

    const bufferStartTick = segmentStartTick + Math.round(wb.timestamp * TICKS_PER_SECOND);
    const bufferEndTick = bufferStartTick + Math.round((buf.length / srcRate) * TICKS_PER_SECOND);
    const interStart = Math.max(range.start, bufferStartTick);
    const interEnd = Math.min(range.end, bufferEndTick);
    if (interEnd <= interStart) return false;

    const outFrom = Math.max(0, Math.round(((interStart - range.start) * outSampleRate) / TICKS_PER_SECOND));
    const outTo = Math.min(outCount, Math.round(((interEnd - range.start) * outSampleRate) / TICKS_PER_SECOND));
    if (outTo <= outFrom) return false;

    const srcChCount = buf.numberOfChannels;
    const srcData: Float32Array[] = [];
    for (let ch = 0; ch < srcChCount; ch++) srcData.push(buf.getChannelData(ch));

    // 目标声道 ← 源声道映射：单声道复制、立体声下混取均值
    const map: { a: Float32Array; b: Float32Array | null }[] = [];
    for (let ch = 0; ch < outChannels; ch++) {
      if (srcChCount === 1) map.push({ a: srcData[0], b: null });
      else if (outChannels === 1) map.push({ a: srcData[0], b: srcChCount > 1 ? srcData[1] : null });
      else map.push({ a: srcData[Math.min(ch, srcChCount - 1)], b: null });
    }

    for (let j = outFrom; j < outTo; j++) {
      const relOut = j - outFrom;
      // 该输出采样在源块内的精确位置
      const srcPos =
        (((interStart + (relOut * TICKS_PER_SECOND) / outSampleRate - bufferStartTick) * srcRate) /
          TICKS_PER_SECOND);
      if (srcPos < 0 || srcPos >= buf.length) continue;
      const i0 = Math.floor(srcPos);
      const frac = srcPos - i0;
      const i1 = Math.min(buf.length - 1, i0 + 1);
      for (let ch = 0; ch < outChannels; ch++) {
        const m = map[ch];
        let v = m.a[i0];
        if (frac > 0) v = v + (m.a[i1] - v) * frac;
        if (m.b) {
          let v2 = m.b[i0];
          if (frac > 0) v2 = v2 + (m.b[i1] - v2) * frac;
          v = (v + v2) * 0.5;
        }
        out[ch][j] += v;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// 便捷工厂
// ---------------------------------------------------------------------------

/** 按「素材 → 分段列表」的映射一次性打开多个素材。任一素材失败时关闭已打开的源，不泄漏句柄。 */
export async function openFrameSources(
  map: Record<string, readonly MediaSegment[]>,
  options: VideoFrameSourceOptions = {},
): Promise<Map<string, VideoFrameSource>> {
  const out = new Map<string, VideoFrameSource>();
  try {
    for (const [assetId, segments] of Object.entries(map)) {
      const source = new VideoFrameSource(options, segments);
      await source.open();
      out.set(assetId, source);
    }
    return out;
  } catch (error) {
    for (const source of out.values()) {
      try {
        source.close();
      } catch {
        // 忽略关闭异常
      }
    }
    throw error;
  }
}
