/**
 * 导出执行器（开发文档 §11.4 / §11.5 / §9.5）
 *
 * 运行在**渲染进程**（WebCodecs 只在渲染进程可用），因此本文件不引入 node:fs：
 * 文件写入 / 改名 / 删除 / 剩余空间查询全部通过注入的 `ExportFileIO` 回调完成，
 * 由调用方（主进程）实现。
 *
 * 流程：
 *   1. 工程不可变快照（深拷贝）+ sha256（crypto.subtle.digest）
 *   2. 生成导出计划（buildExportPlan）——总帧数、每帧时间点、音频混合区间
 *   3. 逐帧：frameTickAt → evaluateScene → 解码源帧 → drawScene → ContinuousMuxer.addFrame
 *   4. 音频：按同一时间映射取 PCM，应用增益 / 淡入淡出 / 限幅，不默认加音量美化
 *   5. 先写 .partial → mediabunny 重新打开校验 → rename 到最终路径
 *   6. 取消：删除 .partial，抛 E_EXPORT_CANCELLED，不产生伪完成文件
 */

import { ContinuousMuxer } from './encode';
import { drawScene } from './compositor';
import type { SceneResources } from './compositor';
import { evaluateScene } from '../domain/scene';
import type { FrameScene, SceneOptions } from '../domain/scene';
import { buildExportPlan, frameSceneOptions, frameTickAt } from '../domain/exportPlan';
import type { AudioMixInterval, ExportPlan } from '../domain/exportPlan';
import { TimeMap } from '../domain/timeMap';
import { pointerForScene } from '../domain/pointer';
import type { Project } from '../domain/project';
import { TICKS_PER_SECOND, fpsToNumber } from '../domain/timebase';
import type { TickRange, Ticks } from '../domain/timebase';
import type { ExportProfile, ExportProgress, ExportResult } from '../shared/ipc';
import { AppError } from '../shared/errors';
import { VideoFrameSource } from './decoder';
import type { DecodedAudio, MediaSegment, MediabunnyLike } from './decoder';
import { loadMediabunny } from './decoder';

// ---------------------------------------------------------------------------
// 注入面
// ---------------------------------------------------------------------------

/** 文件系统回调，由主进程实现（渲染进程没有 node:fs）。 */
export interface ExportFileIO {
  /** 写文件（覆盖）。path 可能是 .partial。 */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** 同一卷内原子改名。 */
  rename(from: string, to: string): Promise<void>;
  /** 删除文件；取消/失败时清理 .partial。缺省时无法清理，会在结果中标记。 */
  removeFile?(path: string): Promise<void>;
  /** 目标路径所在卷的剩余字节数；提供时会做导出前空间检查。 */
  freeBytes?(path: string): Promise<number>;
  /** 读回文件字节；提供时校验阶段会真正重新打开磁盘上的 .partial。 */
  readFile?(path: string): Promise<Uint8Array>;
}

/**
 * 一个素材的画面 / 声音来源。`VideoFrameSource` 在结构上实现了该接口。
 * 验证脚本也用它注入合成源帧（不依赖真实录制）。
 */
export interface FrameProvider {
  /** 取 tick 时刻最近的前一帧；真的没有帧才返回 null。 */
  getFrameAt(tick: Ticks): Promise<CanvasImageSource | null>;
  /** 取 [range.start, range.end) 的 PCM。 */
  getAudioAt?(range: TickRange, options?: { channels?: number }): Promise<DecodedAudio | null>;
  /** 已判定损坏并跳过的分段索引（用于导出后如实报告降级）。 */
  failedSegmentIndexes?(): number[];
  close?(): void;
}

/** 素材解析：把工程里的 assetId 映射到分段列表或现成的解码器。 */
export interface ExportMediaProvider {
  /** 该素材的全部分段（含各自起始 tick）；返回空数组表示素材缺失。 */
  segmentsFor(assetId: string): readonly MediaSegment[] | Promise<readonly MediaSegment[]>;
  /** 读取段文件字节（渲染进程必须提供）。 */
  readFile?(path: string): Promise<Uint8Array>;
  /** 直接提供解码器，优先于 segmentsFor。 */
  providerFor?(assetId: string): FrameProvider | null | Promise<FrameProvider | null>;
}

/** 进度事件：在 ipc 的 ExportProgress 之上补一个整数百分比，便于界面直接显示。 */
export interface ExportProgressEvent extends ExportProgress {
  /** 0..100 整数百分比，与 progress 同一数值 */
  percent: number;
}

export interface ExportProjectOptions {
  jobId?: string;
  /** 工程（本函数会自行深拷贝，不会修改传入对象） */
  project: Project;
  profile: ExportProfile;
  /** 最终输出路径（绝对路径，由调用方决定） */
  outputPath: string;
  io: ExportFileIO;
  /** 素材来源；缺省时源画面为占位（仅用于验证/空工程） */
  media?: ExportMediaProvider;
  /** 指针位置求值（光标与点击波纹）；缺省时光标不绘制 */
  pointerAt?: (tick: Ticks) => SceneOptions['pointer'];
  /** 进度回调，已节流到每秒最多 10 次 */
  onProgress?: (progress: ExportProgressEvent) => void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 注入 mediabunny（校验用）；缺省走 loadMediabunny() */
  mediabunny?: MediabunnyLike;
  /** 预估输出字节数；缺省按码率×时长估算。用于磁盘空间检查 */
  estimatedBytes?: number;
}

/** 导出结果：ipc 的 ExportResult + 快照哈希与告警。 */
export interface ExportProjectResult extends ExportResult {
  /** 工程快照 sha256（十六进制），用于追溯「这一版工程导出的」 */
  snapshotHash: string;
  /** 实际写入的临时文件路径（成功后已改名，因此为 null） */
  partialPath: string | null;
  /** 非致命问题（素材缺失导致降级等），不虚报成功细节 */
  warnings: string[];
  /** 校验细节，便于界面/日志展示真实数据 */
  verifiedDetail: ExportVerifyDetail | null;
}

export interface ExportVerifyDetail {
  /** 校验数据来源：file=重新读取磁盘上的 .partial，memory=内存字节 */
  source: 'file' | 'memory';
  durationSeconds: number;
  expectedDurationSeconds: number;
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  packetCount: number;
  expectedFrames: number;
  hasAudio: boolean;
  audioChannels: number;
  audioSampleRate: number;
  videoCodec: string | null;
  audioCodec: string | null;
  /** 逐项检查结果 */
  checks: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 取消时抛出的稳定错误码（shared/errors.ts 已定义） */
export const EXPORT_CANCELLED = 'E_EXPORT_CANCELLED' as const;
/** 磁盘不足 */
export const EXPORT_DISK_FULL = 'E_DISK_FULL' as const;

/** 音频块大小（采样数）：约 85ms @48k，兼顾交错粒度与回调次数 */
const AUDIO_CHUNK_SAMPLES = 4096;
/** 片段边界的抗爆音淡入淡出时长（秒）。只防爆音，不做音量美化 */
const AUDIO_EDGE_FADE_SECONDS = 0.008;
/** 进度回调上限：每秒最多 10 次（§14.3） */
const PROGRESS_MAX_PER_SECOND = 10;
/** 节流统计窗口（毫秒） */
const PROGRESS_WINDOW_MS = 1000;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** 递归按 key 排序的稳定序列化，保证同一工程快照得到同一哈希。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  }
  return `{${parts.join(',')}}`;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** sha256（WebCrypto）。用于工程快照哈希，§11.4。 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new AppError({
      code: 'E_EXPORT_FAILED',
      message: '当前环境缺少 WebCrypto，无法计算工程快照哈希。',
      retryable: false,
      preservedData: true,
      detail: 'exporter.ts: crypto.subtle 不可用',
    });
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

/** 深拷贝工程快照。导出期间用户继续编辑不会影响本次导出。 */
export function snapshotProject(project: Project): Project {
  if (typeof structuredClone === 'function') return structuredClone(project);
  return JSON.parse(JSON.stringify(project)) as Project;
}

function isDiskFullError(error: unknown): boolean {
  const e = error as { code?: string; message?: string; name?: string } | null;
  if (!e) return false;
  const text = `${e.code ?? ''} ${e.name ?? ''} ${e.message ?? ''}`.toLowerCase();
  return (
    e.code === 'ENOSPC' ||
    text.includes('enospc') ||
    text.includes('no space left') ||
    text.includes('disk full') ||
    text.includes('磁盘空间不足')
  );
}

function cancelError(): AppError {
  return new AppError({
    code: 'E_EXPORT_CANCELLED',
    message: '导出已取消，未生成输出文件。',
    retryable: true,
    preservedData: true,
    detail: 'exporter.ts: 收到取消信号',
  });
}

function diskFullError(detail: string): AppError {
  return new AppError({
    code: 'E_DISK_FULL',
    message: '磁盘空间不足，导出已中止。请清理目标磁盘后重试。',
    retryable: true,
    preservedData: true,
    detail,
  });
}

function exportFailedError(message: string, detail?: string): AppError {
  return new AppError({
    code: 'E_EXPORT_FAILED',
    message,
    retryable: true,
    preservedData: true,
    detail,
  });
}

// ---------------------------------------------------------------------------
// 进度上报（节流）
// ---------------------------------------------------------------------------

interface ProgressReporter {
  emit(percent: number, phase: ExportProgress['phase'], message: string, framesDone: number, bytes: number): void;
  get lastPercent(): number;
}

function createProgressReporter(
  jobId: string,
  totalFrames: number,
  sink: ((progress: ExportProgressEvent) => void) | undefined,
): ProgressReporter {
  /**
   * 已发送事件的时间戳（滚动 1 秒窗口）。
   *
   * 硬约束：任意 1 秒窗口内回调 ≤10 次。
   * 为了不让阶段切换（preparing→rendering→muxing→finalizing）被节流吃掉，
   * 给不同优先级分配固定预算：
   *   普通进度 ≤ 7 次，阶段切换 ≤ 9 次（即留 2 个位置），终态可到 10 次。
   * 这样既能保证速率上限，又保证 UI 一定看到每个阶段。
   */
  const window: { at: number; phaseChange: boolean }[] = [];
  const NORMAL_BUDGET = 7;
  const PHASE_BUDGET = PROGRESS_MAX_PER_SECOND - 1;
  let lastPercent = -1;
  let lastPhase: ExportProgress['phase'] | null = null;
  /** 被节流丢弃的最新普通进度；阶段切换/终态前用它补位，保证 UI 不倒退也不跳空 */
  let pending: ExportProgressEvent | null = null;

  const prune = (now: number): void => {
    while (window.length > 0 && now - window[0].at > PROGRESS_WINDOW_MS) window.shift();
  };

  const deliver = (event: ExportProgressEvent, now: number, phaseChange: boolean): void => {
    window.push({ at: now, phaseChange });
    lastPercent = event.percent;
    lastPhase = event.phase;
    try {
      sink!(event);
    } catch {
      // 进度回调异常不能中断导出
    }
  };

  const build = (
    percent: number,
    phase: ExportProgress['phase'],
    message: string,
    framesDone: number,
    bytes: number,
  ): ExportProgressEvent => {
    const p = Math.round(clamp(percent, 0, 100));
    return {
      jobId,
      progress: p / 100,
      percent: p,
      phase,
      framesDone,
      framesTotal: totalFrames,
      message,
      bytesWritten: bytes,
    };
  };

  return {
    get lastPercent() {
      return lastPercent;
    },
    emit(percent, phase, message, framesDone, bytes) {
      const event = build(percent, phase, message, framesDone, bytes);
      if (!sink) {
        lastPercent = event.percent;
        lastPhase = phase;
        return;
      }
      const now = Date.now();
      prune(now);

      const terminal = phase === 'done' || phase === 'cancelled' || phase === 'failed';
      const phaseChange = phase !== lastPhase;

      if (terminal) {
        // 终态必须送达。先补发被节流的最新进度（若预算允许），避免界面从 60% 直接跳到 100%
        if (pending && window.length < NORMAL_BUDGET) deliver(pending, now, false);
        pending = null;
        deliver(event, now, phaseChange);
        return;
      }

      // 百分比不倒退
      if (event.percent < lastPercent) return;

      if (phaseChange) {
        // 阶段切换优先：先补发一次最新进度，再切阶段（预算各占 1）
        if (pending && window.length < NORMAL_BUDGET) deliver(pending, now, false);
        pending = null;
        if (window.length >= PHASE_BUDGET) return;
        deliver(event, now, true);
        return;
      }

      if (window.length >= NORMAL_BUDGET) {
        // 超速：只记住最新一条；进度是累计值，丢弃旧的不丢信息
        pending = event;
        return;
      }
      pending = null;
      deliver(event, now, false);
    },
  };
}

// ---------------------------------------------------------------------------
// 帧持有（避免把解码器复用的画布直接交给异步路径）
// ---------------------------------------------------------------------------

/** 把一帧拷贝到自有画布，既能「静态复帧」又能安全跨帧持有。 */
class FrameHolder {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private hasFrame = false;

  get current(): OffscreenCanvas | null {
    return this.hasFrame ? this.canvas : null;
  }

  capture(source: CanvasImageSource, width: number, height: number): OffscreenCanvas | null {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
    }
    if (!this.ctx) return null;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(source, 0, 0, w, h);
    this.hasFrame = true;
    return this.canvas;
  }

  reset(): void {
    this.hasFrame = false;
    this.canvas = null;
    this.ctx = null;
  }
}

function intrinsicSize(source: CanvasImageSource): { width: number; height: number } {
  const s = source as unknown as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
  const width = s.displayWidth ?? s.videoWidth ?? s.width ?? 0;
  const height = s.displayHeight ?? s.videoHeight ?? s.height ?? 0;
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// ---------------------------------------------------------------------------
// 音频混合
// ---------------------------------------------------------------------------

/**
 * 按播放速率把源 PCM 重采样为 `outCount` 个输出采样（线性插值）。
 *
 * rate 是播放速度倍数：rate=2 表示源 10s 压成 5s，输出第 k 个采样对应源 k×2 处。
 * 越界部分留 0（解码不足时宁可有极短静音，也不读越界内存）。
 */
export function resampleAudioChannels(
  channels: readonly Float32Array[],
  outCount: number,
  rate: number,
): Float32Array[] {
  const count = Math.max(0, Math.floor(outCount));
  const step = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return channels.map((src) => {
    const dst = new Float32Array(count);
    const maxIndex = src.length - 1;
    if (maxIndex < 0) return dst;
    for (let k = 0; k < count; k++) {
      const pos = k * step;
      const i0 = Math.floor(pos);
      if (i0 > maxIndex) break;
      const frac = pos - i0;
      const s0 = src[i0];
      const s1 = i0 < maxIndex ? src[i0 + 1] : s0;
      dst[k] = frac === 0 ? s0 : s0 + (s1 - s0) * frac;
    }
    return dst;
  });
}

/**
 * 按时间线逐块混合 PCM 并推给封装器。
 *
 * 说明：
 * - 音频按块顺序追加，块长恒定（末块除外），所以累积时间严格等于「已加采样数 / 采样率」，
 *   与视频时间轴不会漂移。
 * - 增益取轨道线性增益（被静音的轨道记 0，但仍占位，不丢弃时间）。
 * - 淡入淡出只做片段边界 8ms 的抗爆音斜坡，不做音量美化。
 * - 混完统一限幅到 [-1, 1]。
 */
export class TimelineAudioMixer {
  private addedSamples = 0;
  private readonly sampleRate: number;
  private readonly channels: number;

  constructor(
    private readonly plan: ExportPlan,
    private readonly sources: Map<string, FrameProvider>,
    private readonly muxer: { audioBufferFactory: Pick<BaseAudioContext, 'createBuffer'> | null; addAudio(buffer: AudioBuffer): Promise<void> },
    private readonly abortCheck: () => void,
    /** clipId → 播放速率（AudioMixInterval 不含 rate，从工程片段补齐） */
    private readonly clipRate: Map<string, number> = new Map(),
    /** 非致命问题收集：音频解码失败必须让用户知道，而不是导出「成功」的静音视频 */
    private readonly warnings: string[] = [],
  ) {
    this.sampleRate = plan.audioSampleRate;
    this.channels = plan.audioChannels;
  }

  private readonly warned = new Set<string>();

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(message);
  }

  /** 推进到 targetSample（时间线采样数）。force=true 时把余量也写掉（收尾）。 */
  async pumpTo(targetSample: number, force = false): Promise<void> {
    const target = clamp(Math.round(targetSample), 0, this.plan.audioTotalSamples);
    while (this.addedSamples < target) {
      const remaining = target - this.addedSamples;
      if (!force && remaining < AUDIO_CHUNK_SAMPLES) break;
      const count = Math.min(AUDIO_CHUNK_SAMPLES, remaining);
      const buffer = await this.renderChunk(this.addedSamples, count);
      if (buffer) {
        // 注意：ContinuousMuxer.addAudio 内部是 AudioBufferSource，按「紧接上一块」顺序排布，
        // 而本混合器从 0 号采样开始、块长恒定、无空洞，所以顺序追加即等价于按时间戳追加，
        // 不会产生漂移。这里不传时间戳（encode.ts 的实现只接受 1 个参数）。
        await this.muxer.addAudio(buffer);
      }
      this.addedSamples += count;
      this.abortCheck();
    }
  }

  get added(): number {
    return this.addedSamples;
  }

  async renderChunk(startSample: number, count: number): Promise<AudioBuffer | null> {
    const sr = this.sampleRate;
    const channels = this.channels;
    const factory = this.muxer.audioBufferFactory;
    if (!factory) return null;

    const out: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(count));

    const chunkEndSample = startSample + count;
    const fadeSamples = Math.max(1, Math.round(sr * AUDIO_EDGE_FADE_SECONDS));

    for (const interval of this.plan.audioIntervals) {
      if (interval.muted) continue;
      const gain = clamp(interval.gain, 0, 4);
      if (gain <= 0) continue;
      if (interval.sampleEnd <= startSample || interval.sampleStart >= chunkEndSample) continue;

      const a = Math.max(startSample, interval.sampleStart);
      const b = Math.min(chunkEndSample, interval.sampleEnd);
      if (b <= a) continue;

      const provider = this.sources.get(interval.assetId);
      if (!provider?.getAudioAt) {
        this.warnOnce(
          `missing-audio-provider:${interval.assetId}`,
          `音频素材 ${interval.assetId} 缺失或不可解码，对应区间已按静音导出。`,
        );
        continue;
      }

      const decoded = await this.decodeInterval(provider, interval, a, b, channels);
      if (!decoded) continue;

      const intervalFade = Math.min(
        fadeSamples,
        Math.max(1, Math.floor((interval.sampleEnd - interval.sampleStart) / 2)),
      );
      const baseOffset = a - startSample;
      for (let j = 0; j < decoded.frameCount; j++) {
        const dest = baseOffset + j;
        if (dest < 0 || dest >= count) continue;
        const posOnTimeline = a + j;
        const fadeIn = clamp((posOnTimeline - interval.sampleStart) / intervalFade, 0, 1);
        const fadeOut = clamp((interval.sampleEnd - posOnTimeline) / intervalFade, 0, 1);
        const env = gain * Math.min(fadeIn, fadeOut);
        for (let ch = 0; ch < channels; ch++) {
          const src = decoded.channels[Math.min(ch, decoded.channels.length - 1)];
          if (!src) continue;
          out[ch][dest] += src[j] * env;
        }
      }
    }

    // 限幅：导出链路上唯一的增益整形（§11.4）
    for (let ch = 0; ch < channels; ch++) {
      const data = out[ch];
      for (let i = 0; i < count; i++) data[i] = clampSample(data[i]);
    }

    const buffer = factory.createBuffer(channels, count, sr);
    for (let ch = 0; ch < channels; ch++) {
      buffer.copyToChannel(out[ch] as unknown as Float32Array<ArrayBuffer>, ch);
    }
    return buffer;
  }

  /** 取某个音频区间在输出采样 [a, b) 对应的源 PCM，并对齐到该区间起点。 */
  private async decodeInterval(    provider: FrameProvider,
    interval: AudioMixInterval,
    a: number,
    b: number,
    channels: number,
  ): Promise<DecodedAudio | null> {
    const sr = this.sampleRate;
    const timelineStartTick = Math.round((a * TICKS_PER_SECOND) / sr);
    const timelineEndTick = Math.round((b * TICKS_PER_SECOND) / sr);
    const rate = this.clipRate.get(interval.clipId) ?? 1;
    const sourceStart =
      interval.source.start + Math.round((timelineStartTick - interval.timeline.start) * rate);
    const sourceEnd =
      interval.source.start + Math.round((timelineEndTick - interval.timeline.start) * rate);
    const range: TickRange = {
      start: Math.max(interval.source.start, sourceStart),
      end: Math.min(interval.source.end, Math.max(sourceStart + 1, sourceEnd)),
    };
    if (range.end <= range.start) return null;

    let decoded: DecodedAudio | null = null;
    try {
      decoded = await provider.getAudioAt!(range, { channels });
    } catch (error) {
      // 不能静默吞掉：否则导出结果「成功」但整段音频消失，用户只能事后发现。
      this.warnOnce(
        `audio-decode-failed:${interval.clipId}`,
        `音频片段 ${interval.clipId} 解码失败（${error instanceof Error ? error.message : String(error)}），对应区间已按静音导出。`,
      );
      return null;
    }
    if (!decoded || decoded.frameCount <= 0) return null;

    // 变速片段：解码得到的是「源时长」的采样（输出时长 × rate），
    // 必须按 rate 重采样成输出采样数，否则 rate>1 会写到片段结束之后、
    // rate<1 则每块只填前 rate 比例（听感是周期性断音）。
    // 当前 UI 尚未暴露变速，但领域模型与导出计划都支持，属「一启用就必须正确」的路径。
    if (Math.abs(rate - 1) > 1e-6) {
      const outCount = Math.max(0, b - a);
      decoded = {
        ...decoded,
        channels: resampleAudioChannels(decoded.channels, outCount, rate),
        frameCount: outCount,
      };
    }

    // 解码结果按采样网格对齐；把它的源起点换算成相对本区间起点的输出采样偏移
    const offset = Math.round(
      (((decoded.startTick - range.start) * sr) / TICKS_PER_SECOND) / Math.max(1e-9, rate),
    );
    if (offset === 0) return decoded;
    const shifted: Float32Array[] = decoded.channels.map((src) => {
      const dst = new Float32Array(decoded!.frameCount);
      if (offset >= 0) {
        if (offset < src.length) dst.set(src.subarray(0, src.length - offset), offset);
      } else {
        const from = -offset;
        if (from < src.length) dst.set(src.subarray(from), 0);
      }
      return dst;
    });
    return { ...decoded, channels: shifted };
  }
}

// ---------------------------------------------------------------------------
// 输出校验
// ---------------------------------------------------------------------------

interface VerificationOutcome {
  ok: boolean;
  detail: ExportVerifyDetail;
  failures: string[];
}

async function verifyMp4(
  data: Uint8Array,
  plan: ExportPlan,
  lib: MediabunnyLike,
  source: 'file' | 'memory',
  expectedFrames: number,
): Promise<VerificationOutcome> {
  const expectedDuration = plan.durationTicks / TICKS_PER_SECOND;
  const fps = fpsToNumber(plan.fps);
  const failures: string[] = [];

  const detail: ExportVerifyDetail = {
    source,
    durationSeconds: 0,
    expectedDurationSeconds: expectedDuration,
    videoWidth: 0,
    videoHeight: 0,
    frameRate: 0,
    packetCount: 0,
    expectedFrames,
    hasAudio: false,
    audioChannels: 0,
    audioSampleRate: 0,
    videoCodec: null,
    audioCodec: null,
    checks: {},
  };

  let input: MediabunnyInputLike | null = null;
  try {
    // BufferSource 直接引用字节数组，不像 BlobSource 那样在构造 Blob 时再复制一整份；
    // 长录制（10 分钟 1080p 约 900MB）下这一步能省掉一份整片内存。
    const source = lib.BufferSource
      ? new lib.BufferSource(data as unknown as ArrayBufferView)
      : new lib.BlobSource(new Blob([data as unknown as BlobPart]));
    input = new lib.Input({
      source,
      formats: lib.ALL_FORMATS,
    }) as unknown as MediabunnyInputLike;
    const opened = input;
    const videoTrack = await opened.getPrimaryVideoTrack();
    if (plan.audioOnly) {
      detail.durationSeconds = await opened.computeDuration();
      detail.checks['noVideoTrack'] = !videoTrack;
      detail.checks['duration'] = Math.abs(detail.durationSeconds - expectedDuration) <= 0.08;
      const audio = await opened.getPrimaryAudioTrack();
      detail.hasAudio = !!audio;
      detail.checks['audioTrack'] = !!audio;
      if (audio) {
        detail.audioChannels = await audio.getNumberOfChannels();
        detail.audioSampleRate = await audio.getSampleRate();
        detail.audioCodec = await audio.getCodec();
        detail.checks['audioFormat'] = detail.audioChannels === plan.audioChannels &&
          detail.audioSampleRate === plan.audioSampleRate && detail.audioCodec === 'aac';
      }
      for (const [key, ok] of Object.entries(detail.checks)) if (!ok) failures.push(`音频校验失败：${key}`);
      return { ok: failures.length === 0, detail, failures };
    }
    if (!videoTrack) {
      failures.push('输出中没有视频轨');
      detail.checks['videoTrack'] = false;
      return { ok: false, detail, failures };
    }
    detail.checks['videoTrack'] = true;

    const [duration, width, height, codec, stats] = await Promise.all([
      opened.computeDuration(),
      videoTrack.getCodedWidth(),
      videoTrack.getCodedHeight(),
      videoTrack.getCodec(),
      videoTrack.computePacketStats(),
    ]);
    detail.durationSeconds = duration;
    detail.videoWidth = width;
    detail.videoHeight = height;
    detail.videoCodec = codec ?? null;
    detail.frameRate = stats?.averagePacketRate ?? 0;
    detail.packetCount = stats?.packetCount ?? 0;

    // 时长：允许 1.5 帧误差
    const durationTolerance = Math.max(1.5 / Math.max(1, fps), 0.05);
    detail.checks['duration'] = Math.abs(duration - expectedDuration) <= durationTolerance;
    if (!detail.checks['duration']) {
      failures.push(`时长 ${duration.toFixed(3)}s 与期望 ${expectedDuration.toFixed(3)}s 不符`);
    }
    detail.checks['dimensions'] = width === plan.outputWidth && height === plan.outputHeight;
    if (!detail.checks['dimensions']) {
      failures.push(`分辨率 ${width}×${height} 与期望 ${plan.outputWidth}×${plan.outputHeight} 不符`);
    }
    detail.checks['frameRate'] = Math.abs(detail.frameRate - fps) <= Math.max(0.5, fps * 0.02);
    if (!detail.checks['frameRate']) {
      failures.push(`帧率 ${detail.frameRate.toFixed(3)} 与期望 ${fps} 不符`);
    }
    detail.checks['frameCount'] = Math.abs(detail.packetCount - expectedFrames) <= 1;
    if (!detail.checks['frameCount']) {
      failures.push(`帧数 ${detail.packetCount} 与期望 ${expectedFrames} 不符`);
    }

    const audioTrack = await opened.getPrimaryAudioTrack();
    detail.hasAudio = !!audioTrack;
    detail.checks['audioTrack'] = !!audioTrack;
    if (!audioTrack) {
      failures.push('输出中没有音频轨');
    } else {
      const [ch, rate, acodec] = await Promise.all([
        audioTrack.getNumberOfChannels(),
        audioTrack.getSampleRate(),
        audioTrack.getCodec(),
      ]);
      detail.audioChannels = ch;
      detail.audioSampleRate = rate;
      detail.audioCodec = acodec ?? null;
      detail.checks['audioFormat'] = ch === plan.audioChannels && rate === plan.audioSampleRate;
      if (!detail.checks['audioFormat']) {
        failures.push(`音频 ${ch}ch@${rate}Hz 与期望 ${plan.audioChannels}ch@${plan.audioSampleRate}Hz 不符`);
      }
    }
    return { ok: failures.length === 0, detail, failures };
  } catch (error) {
    failures.push(`重新解封装失败：${error instanceof Error ? error.message : String(error)}`);
    detail.checks['open'] = false;
    return { ok: false, detail, failures };
  } finally {
    try {
      input?.dispose();
    } catch {
      // 忽略
    }
  }
}

/** 校验用的最小结构（避免把 decoder 的接口再导出一遍）。 */
interface MediabunnyInputLike {
  getPrimaryVideoTrack(): Promise<{
    getCodedWidth(): Promise<number>;
    getCodedHeight(): Promise<number>;
    getCodec(): Promise<string | null>;
    computePacketStats(): Promise<{ packetCount: number; averagePacketRate: number }>;
  } | null>;
  getPrimaryAudioTrack(): Promise<{
    getNumberOfChannels(): Promise<number>;
    getSampleRate(): Promise<number>;
    getCodec(): Promise<string | null>;
  } | null>;
  computeDuration(): Promise<number>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 导出一个工程为 MP4。
 *
 * @throws AppError code=E_EXPORT_CANCELLED 取消（.partial 已删除）
 * @throws AppError code=E_DISK_FULL 磁盘不足
 * @throws AppError code=E_EXPORT_FAILED 其他失败（.partial 已删除）
 */
export async function exportProject(options: ExportProjectOptions): Promise<ExportProjectResult> {
  const { project, profile, outputPath, io } = options;
  const jobId = options.jobId ?? `export-${Date.now().toString(36)}`;
  const partialPath = `${outputPath}.partial`;
  const warnings: string[] = [];
  const sources = new Map<string, FrameProvider>();

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw cancelError();
  };

  // ---- 0. 快照（导出期间用户继续编辑不影响本次导出） ----
  const snapshot = snapshotProject(project);
  const plan = buildExportPlan(snapshot, profile);
  const totalFrames = Math.max(0, plan.totalFrames);
  const progress = createProgressReporter(jobId, plan.audioOnly ? 0 : totalFrames, options.onProgress);

  let muxer: ContinuousMuxer | null = null;
  /** `.partial` 是否已经「尝试写入」（写失败也视为可能留下残片，必须清理） */
  let partialWriteAttempted = false;
  let partialWritten = false;
  let renamed = false;
  /** 已渲染帧数：失败/取消时进度必须带上真实值，不能显示成 0 帧 */
  let framesDone = 0;

  const cleanupPartial = async (): Promise<void> => {
    if (renamed) return;
    // 关键：写文件是「先落盘、后置标记」——磁盘写满时 writeFile 抛错，但文件可能已经
    // 留下全部或部分字节。只看 partialWritten 会把这种最常见的失败当成「还没写」，
    // 把几 GB 的 .partial 永久留在用户磁盘上（还会占满下一次导出所需的空闲空间）。
    if (!partialWriteAttempted && !partialWritten) return;
    if (!io.removeFile) {
      warnings.push(`无法删除临时文件（未提供 removeFile）：${partialPath}`);
      return;
    }
    try {
      await io.removeFile(partialPath);
      partialWritten = false;
      partialWriteAttempted = false;
    } catch (error) {
      warnings.push(
        `删除临时文件失败：${partialPath} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  try {
    progress.emit(0, 'preparing', '正在创建工程快照…', 0, 0);
    const snapshotHash = await sha256Hex(stableStringify(snapshot));
    throwIfAborted();

    if (totalFrames <= 0) {
      throw exportFailedError('工程时长为 0，没有可导出的帧。', 'exporter.ts: plan.totalFrames=0');
    }

    // ---- 1. 磁盘空间预检 ----
    const estimated =
      options.estimatedBytes ??
      estimateOutputBytes(plan, { videoBitrate: profile.videoBitrate, audioBitrate: profile.audioBitrate });
    if (io.freeBytes) {
      let free = 0;
      try {
        free = await io.freeBytes(outputPath);
      } catch {
        warnings.push('无法读取目标磁盘剩余空间，跳过空间预检。');
      }
      if (free > 0 && free < estimated) {
        throw diskFullError(
          `目标磁盘剩余 ${free} 字节，预计需要 ${estimated} 字节（输出 ${plan.outputWidth}×${plan.outputHeight} @ ${fpsToNumber(plan.fps)}fps）`,
        );
      }
    }

    // ---- 2. 打开素材 ----
    const lib = options.mediabunny ?? safeLoadMediabunny();
    const clipAsset = new Map<string, string>();
    for (const track of snapshot.tracks) for (const clip of track.clips) clipAsset.set(clip.id, clip.assetId);

    const needed = new Set<string>();
    if (!plan.audioOnly) for (const segment of plan.segments) needed.add(segment.assetId);
    for (const interval of plan.audioIntervals) needed.add(interval.assetId);

    const mainAssetIds = new Set<string>();
    for (const segment of plan.segments) {
      if (segment.track === 'primaryVideo') mainAssetIds.add(segment.assetId);
    }

    for (const assetId of needed) {
      throwIfAborted();
      try {
        const provider = await resolveProvider(assetId, options, lib);
        if (provider) sources.set(assetId, provider);
        else if (mainAssetIds.has(assetId)) {
          throw new AppError({
            code: 'E_MEDIA_MISSING',
            message: '主视频素材缺失，无法导出。',
            retryable: true,
            preservedData: true,
            detail: `exporter.ts: assetId=${assetId} 没有可用分段`,
          });
        } else {
          warnings.push(`素材 ${assetId} 缺失，相关轨道按静音/占位处理。`);
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'E_EXPORT_CANCELLED') throw error;
        if (mainAssetIds.has(assetId)) throw error;
        warnings.push(
          `素材 ${assetId} 打开失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throwIfAborted();

    // ---- 3. 初始化封装器 ----
    const fps = fpsToNumber(plan.fps);
    muxer = new ContinuousMuxer({
      audioOnly: plan.audioOnly,
      width: plan.outputWidth,
      height: plan.outputHeight,
      fps,
      videoBitrate: profile.videoBitrate > 0 ? profile.videoBitrate : 12_000_000,
      audioBitrate: profile.audioBitrate > 0 ? profile.audioBitrate : 192_000,
      audioSampleRate: plan.audioSampleRate,
      audioChannels: plan.audioChannels,
      includeAudio: true,
    });
    const encoderLabel = await muxer.init(true);
    throwIfAborted();

    const drawContext = plan.audioOnly ? null : muxer.drawContext;
    const screenHolder = new FrameHolder();
    const cameraHolder = new FrameHolder();
    const timeMap = new TimeMap(snapshot);
    const sceneOptions = frameSceneOptions(plan);
    // 音频区间只带 clipId，播放速率从工程片段补齐（保证音频与画面同一条时间映射）
    const clipRate = new Map<string, number>();
    for (const track of snapshot.tracks) {
      for (const clip of track.clips) {
        clipRate.set(clip.id, clip.rate.den > 0 ? clip.rate.num / clip.rate.den : 1);
      }
    }
    const audioMixer = new TimelineAudioMixer(plan, sources, muxer, throwIfAborted, clipRate, warnings);

    progress.emit(1, 'rendering', '开始逐帧渲染…', 0, 0);

    // ---- 4. 逐帧渲染 ----
    framesDone = 0;
    for (let i = 0; i < totalFrames && !plan.audioOnly; i++) {
      throwIfAborted();
      const tick = frameTickAt(plan, i);
      // 指针日志是按「素材/会话时间」记录的（captureEngine 写的是 clock.durationTicks），
      // 而这里的 tick 是时间线时间。修剪、删除前段、重排之后两者不再相等，
      // 直接拿时间线 tick 查表会让整片光标与点击波纹偏移一个编辑量。
      const pointer = options.pointerAt ? pointerForScene(snapshot, tick, options.pointerAt, timeMap) : null;
      const scene = evaluateScene(snapshot, tick, {
        ...sceneOptions,
        pointer,
        includeOverlays: false,
      });
      const resources = await resolveResources({
        scene,
        tick,
        clipAsset,
        sources,
        screenHolder,
        cameraHolder,
        timeMap,
      });
      drawScene(drawContext!, scene, resources, { includeOverlays: false });
      await muxer.addFrame(tick / TICKS_PER_SECOND);
      framesDone += 1;

      // 音频与视频交错推进，避免长时间只喂一条轨
      const nextTick = frameTickAt(plan, Math.min(i + 1, totalFrames));
      const targetSamples = Math.round((nextTick * plan.audioSampleRate) / TICKS_PER_SECOND);
      await audioMixer.pumpTo(targetSamples);

      const percent = 2 + (framesDone / totalFrames) * 84;
      progress.emit(
        percent,
        'rendering',
        `渲染第 ${framesDone}/${totalFrames} 帧`,
        framesDone,
        0,
      );
    }

    // ---- 5. 音频收尾 ----
    throwIfAborted();
    if (plan.audioOnly) {
      const chunk = plan.audioSampleRate;
      for (let sample = 0; sample < plan.audioTotalSamples; sample += chunk) {
        throwIfAborted();
        await audioMixer.pumpTo(Math.min(plan.audioTotalSamples, sample + chunk));
        progress.emit(2 + Math.min(1, (sample + chunk) / plan.audioTotalSamples) * 82, 'encoding', '正在混合并编码音频…', 0, 0);
      }
    }
    await audioMixer.pumpTo(plan.audioTotalSamples, true);
    throwIfAborted();

    // 损坏分段是「静默降级」的：画面回退到上一段末帧、音频按静音导出。
    // 导出本身会成功、完整性校验也会通过，所以必须在这里把降级原因交给界面，
    // 否则用户只有回放时才发现某一段冻结/失声。
    for (const [assetId, provider] of sources) {
      const failed = provider.failedSegmentIndexes?.() ?? [];
      if (failed.length > 0) {
        warnings.push(
          `素材 ${assetId} 有 ${failed.length} 个分段无法解码，对应画面已用上一帧填充、音频按静音处理。`,
        );
      }
    }

    // ---- 6. 封装（长尾阶段也推进进度，不允许卡在 99%） ----
    progress.emit(86, 'muxing', '正在完成封装…', framesDone, 0);
    const heartbeat = startHeartbeat(progress, framesDone);
    let finalized: { data: Uint8Array; frames: number; encoder: string };
    try {
      finalized = await muxer.finalize();
    } finally {
      stopHeartbeat(heartbeat);
    }
    throwIfAborted();
    progress.emit(92, 'muxing', '封装完成，正在写入临时文件…', framesDone, finalized.data.byteLength);

    // ---- 7. 写 .partial ----
    // 先标记「尝试写入」再 await：写盘失败（磁盘满、IPC 中断、进程被杀前抛错）时
    // 文件可能已经存在，清理逻辑必须尝试删除。
    partialWriteAttempted = true;
    try {
      await io.writeFile(partialPath, finalized.data);
      partialWritten = true;
    } catch (error) {
      if (isDiskFullError(error)) {
        throw diskFullError(`写入 ${partialPath} 时磁盘空间不足`);
      }
      throw error;
    }
    throwIfAborted();
    // 记下真实字节数：回读校验后会主动释放整片编码结果，不能再从它上面读
    const encodedBytes = finalized.data.byteLength;
    progress.emit(94, 'finalizing', '正在校验输出文件…', framesDone, encodedBytes);

    // ---- 8. 重新打开校验 ----
    let verifyBytes = finalized.data;
    let verifySource: 'file' | 'memory' = 'memory';
    if (io.readFile) {
      // 回读前先放弃内存里的编码结果：否则「整片编码结果 + 回读副本 + 校验器副本」
      // 会同时驻留，10 分钟 1080p 场景峰值可达数 GB，隐藏导出窗口直接 OOM。
      // verifyBytes 仍持有原数组，读回失败时还能退回内存校验。
      finalized.data = new Uint8Array(0);
      try {
        verifyBytes = await io.readFile(partialPath);
        verifySource = 'file';
      } catch (error) {
        warnings.push(
          `读回 .partial 失败，改用内存字节校验：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const verification = await verifyMp4(verifyBytes, plan, lib, verifySource, framesDone);
    throwIfAborted();
    if (!verification.ok) {
      throw exportFailedError(
        '输出完整性校验未通过，已丢弃临时文件。',
        `exporter.ts: ${verification.failures.join('; ')}`,
      );
    }

    // ---- 9. 原子改名（提交点：改名之前是最后一个可取消的位置） ----
    throwIfAborted();
    progress.emit(98, 'finalizing', '校验通过，正在提交文件…', framesDone, verifyBytes.byteLength);
    throwIfAborted();
    await io.rename(partialPath, outputPath);
    renamed = true;

    const result: ExportProjectResult = {
      jobId,
      ok: true,
      outputPath,
      encoder: finalized.encoder || encoderLabel,
      error: null,
      durationTicks: plan.durationTicks,
      frames: framesDone,
      bytes: encodedBytes,
      verified: true,
      snapshotHash,
      partialPath: null,
      warnings,
      verifiedDetail: verification.detail,
    };
    progress.emit(100, 'done', `导出完成：${framesDone} 帧`, framesDone, result.bytes);
    return result;
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : isDiskFullError(error)
          ? diskFullError(error instanceof Error ? error.message : String(error))
          : exportFailedError(
              '导出失败，请重试或查看诊断日志。',
              error instanceof Error ? `${error.message}` : String(error),
            );

    try {
      await muxer?.cancel();
    } catch {
      // 忽略
    }
    await cleanupPartial();

    progress.emit(
      progress.lastPercent,
      appError.code === 'E_EXPORT_CANCELLED' ? 'cancelled' : 'failed',
      appError.message,
      framesDone,
      0,
    );
    throw appError;
  } finally {
    // 释放封装器：硬件 VideoEncoder / AAC 编码器 / 1080p 画布不能等 GC，
    // 否则同一隐藏窗口里连续导出会持续占用 GPU 编码会话。
    try {
      muxer?.dispose();
    } catch {
      // 忽略释放异常
    }
    for (const provider of sources.values()) {
      try {
        provider.close?.();
      } catch {
        // 忽略
      }
    }
    sources.clear();
  }
}

/** 估算输出体积时的编码参数；缺省沿用 12Mbps 视频 + 192kbps 音频。 */
export interface OutputByteEstimateOptions {
  /** 视频码率（比特/秒）；<=0 或未提供时用 12Mbps */
  videoBitrate?: number;
  /** 音频码率（比特/秒）；<=0 或未提供时用 192kbps */
  audioBitrate?: number;
}

/**
 * 按码率估算输出体积（含 15% 封装与索引余量）。
 *
 * 之前这里把 12Mbps/192kbps 写死，不看导出 profile：导出 4Mbps 档时估算值约为
 * 实际体积的 3 倍，会把「磁盘其实够用」的导出在预检阶段误判为磁盘不足；
 * 反过来 20Mbps 档会低估，写盘阶段才失败。调用方应传 profile 里的真实码率。
 */
export function estimateOutputBytes(plan: ExportPlan, options: OutputByteEstimateOptions = {}): number {
  const seconds = plan.durationTicks / TICKS_PER_SECOND;
  const videoBits = plan.audioOnly
    ? 0
    : options.videoBitrate && options.videoBitrate > 0
      ? options.videoBitrate
      : 12_000_000;
  const audioBits = options.audioBitrate && options.audioBitrate > 0 ? options.audioBitrate : 192_000;
  return Math.ceil(((videoBits + audioBits) / 8) * Math.max(1, seconds) * 1.15) + 8 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function safeLoadMediabunny(): MediabunnyLike {
  return loadMediabunny();
}

async function resolveProvider(
  assetId: string,
  options: ExportProjectOptions,
  lib: MediabunnyLike,
): Promise<FrameProvider | null> {
  const media = options.media;
  if (!media) return null;
  if (media.providerFor) {
    const direct = await media.providerFor(assetId);
    if (direct) return direct;
  }
  const segments = await media.segmentsFor(assetId);
  if (!segments || segments.length === 0) return null;
  const source = new VideoFrameSource(
    {
      mediabunny: lib,
      readFile: media.readFile,
      nodeFilePaths: !media.readFile,
      sampleRate: 48_000,
    },
    segments,
  );
  await source.open();
  return source;
}

interface ResolveResourcesInput {
  scene: FrameScene;
  tick: Ticks;
  clipAsset: Map<string, string>;
  sources: Map<string, FrameProvider>;
  screenHolder: FrameHolder;
  cameraHolder: FrameHolder;
  timeMap: TimeMap;
}

/**
 * 组装一帧的媒体资源。
 * - 屏幕：用 scene.sourceTick（TimeMap 求出的源时间）取最近前一帧；未命中片段时复用上一帧（§9.4 静态复帧）
 * - 摄像头：按同一 TimeMap 求源时间
 * - 光标：由 evaluateScene 用内置绘制（cursor=null）
 */
async function resolveResources(input: ResolveResourcesInput): Promise<SceneResources> {
  const { scene, tick, clipAsset, sources, screenHolder, cameraHolder, timeMap } = input;

  let screen: CanvasImageSource | null = null;
  let screenWidth = 0;
  let screenHeight = 0;

  if (scene.hasSourceFrame && scene.sourceTick !== null && scene.clipId) {
    const assetId = clipAsset.get(scene.clipId);
    const provider = assetId ? sources.get(assetId) : undefined;
    if (provider) {
      const frame = await provider.getFrameAt(scene.sourceTick);
      if (frame) {
        const size = intrinsicSize(frame);
        const held = screenHolder.capture(frame, size.width, size.height);
        if (held) {
          screen = held;
          screenWidth = held.width;
          screenHeight = held.height;
        }
      }
    }
  }
  if (!screen) {
    // 静态复帧：沿用上一帧，而不是画占位
    const held = screenHolder.current;
    if (held) {
      screen = held;
      screenWidth = held.width;
      screenHeight = held.height;
    }
  }

  let camera: CanvasImageSource | null = null;
  if (scene.camera.visible) {
    const hit = timeMap.toSource('camera', tick);
    if (hit) {
      const provider = sources.get(hit.clip.assetId);
      if (provider) {
        const frame = await provider.getFrameAt(hit.sourceTick);
        if (frame) {
          const size = intrinsicSize(frame);
          camera = cameraHolder.capture(frame, size.width, size.height);
        }
      }
    }
    if (!camera) camera = cameraHolder.current;
  }

  return { screen, screenWidth, screenHeight, camera, cursor: null };
}

/** 封装长尾阶段的心跳：把进度从 86 缓慢推到 91，避免视觉上「卡住」。 */
function startHeartbeat(progress: ProgressReporter, framesDone: number): ReturnType<typeof setInterval> | null {
  if (typeof setInterval !== 'function') return null;
  let current = Math.max(86, progress.lastPercent);
  const timer = setInterval(() => {
    current = Math.min(91, current + 1);
    progress.emit(current, 'muxing', '正在完成封装…', framesDone, 0);
  }, 120);
  // Node/Electron 的定时器不阻止退出
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

function stopHeartbeat(timer: ReturnType<typeof setInterval> | null): void {
  if (timer) clearInterval(timer);
}
