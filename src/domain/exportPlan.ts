/**
 * 导出计划（开发文档 §11.4 / §11.5）
 *
 * 导出前把工程求值为一份不可变、可序列化的计划：
 * - 总帧数由工程时长与帧率统一取整（ticksToFrameCount）；
 * - 每个输出帧的时间点由 frameIndexToTicks 计算，与预览求值使用同一函数，
 *   保证「第 N 帧」在预览与导出中指向同一个时间线 tick；
 * - 需要解码的源片段时间区间（视频/摄像头）；
 * - 音频混合区间（时间线区间 + 源区间 + 输出采样区间 + 增益/静音）。
 *
 * 本文件是纯逻辑：不读取磁盘、不依赖渲染层。调用方（WP-C 导出器）用
 * frameTickAt() 得到帧时间点后交给 evaluateScene()，再用 drawScene() 绘制。
 */

import type { Project, TrackKind } from './project';
import { activeVariant, findTrack, timelineDuration } from './project';
import type { FrameRate, Rational, TickRange, Ticks } from './timebase';
import {
  TICKS_PER_SECOND,
  frameIndexToTicks,
  makeFrameRate,
  ticksToFrameCount,
  ticksToFrameIndex,
} from './timebase';
import { outputSizeForAspect } from './scene';
import type { SceneOptions } from './scene';

/** 内部音频统一 48kHz（§9.3）。 */
export const DEFAULT_AUDIO_SAMPLE_RATE = 48_000;

/**
 * 导出 profile 的结构化子集。
 * 与 src/shared/ipc.ts 的 ExportProfile 结构兼容（字段可缺省，缺省时取工程设置）。
 */
export interface ExportProfileLike {
  /** 输出画幅 ID；不存在时回退到工程当前画幅 */
  variantId?: string;
  width?: number;
  height?: number;
  fps?: { num: number; den: number } | number;
  videoBitrate?: number;
  audioBitrate?: number;
  /** 纯音频 M4A（P1，MVP 关闭） */
  audioOnly?: boolean;
  includeTutorial?: boolean;
}

/** 一段需要解码的源区间（按时间线顺序）。 */
export interface SourceSegment {
  track: TrackKind;
  clipId: string;
  assetId: string;
  /** 时间线区间 [start, end) */
  timeline: TickRange;
  /** 源素材区间 [start, end) */
  source: TickRange;
  /** 播放速率 */
  rate: Rational;
  /** 命中的输出帧区间 [frameStart, frameEnd) */
  frameStart: number;
  frameEnd: number;
}

/** 一段音频混合区间。 */
export interface AudioMixInterval {
  track: TrackKind;
  clipId: string;
  assetId: string;
  timeline: TickRange;
  source: TickRange;
  /** 输出采样区间 [sampleStart, sampleEnd) */
  sampleStart: number;
  sampleEnd: number;
  /** 源素材采样起点 */
  sourceSampleStart: number;
  /** 播放速率（数值形式，便于音频按同一时间映射换算：源偏移 = 时间线偏移 × rate） */
  rate: number;
  /** 轨道线性增益 */
  gain: number;
  /** 轨道是否静音（仍保留区间，导出器据此写静音而不是丢弃时间） */
  muted: boolean;
}

export interface ExportPlan {
  projectId: string;
  /** 生成计划时的工程 revision（不可变快照标识，§11.4） */
  revision: number;
  privacyVersion: number;
  variantId: string;
  aspect: [number, number];
  outputWidth: number;
  outputHeight: number;
  fps: FrameRate;
  /** 输出时长（tick），取自主视频轨 */
  durationTicks: Ticks;
  /** 输出总帧数（向上取整） */
  totalFrames: number;
  audioOnly: boolean;
  includeTutorial: boolean;
  audioSampleRate: number;
  audioChannels: number;
  /** 音频总采样数，尾部对齐输出边界（§11.4） */
  audioTotalSamples: number;
  /** 视频/摄像头源区间（按时间线排序） */
  segments: SourceSegment[];
  /** 音频混合区间（按时间线排序） */
  audioIntervals: AudioMixInterval[];
  /** 缓存键前缀：revision + privacyVersion + 输出参数 */
  cacheKeyPrefix: string;
}

// ---------------------------------------------------------------------------
// 帧与时间
// ---------------------------------------------------------------------------

/**
 * 第一个满足 frameIndexToTicks(i) >= tick 的帧序号。
 * 由于 frameIndexToTicks 使用四舍五入，floor 结果可能相差 1，这里做一次校正，
 * 保证 [start, end) 的边界归属严格。
 */
export function firstFrameAtOrAfter(tick: Ticks, fps: FrameRate): number {
  if (!Number.isFinite(tick)) return 0;
  let index = Math.max(0, ticksToFrameIndex(tick, fps));
  // 向下校正：前一帧的时间点可能已经 >= tick（四舍五入造成）
  while (index > 0 && frameIndexToTicks(index - 1, fps) >= tick) index -= 1;
  // 向上校正：当前帧的时间点仍 < tick
  while (frameIndexToTicks(index, fps) < tick) index += 1;
  return index;
}

/** 把时间线区间映射为命中的输出帧区间 [start, end)。左闭右开语义保持一致。 */
export function frameRangeForTicks(range: TickRange, fps: FrameRate): { start: number; end: number } {
  const start = firstFrameAtOrAfter(range.start, fps);
  const end = firstFrameAtOrAfter(range.end, fps);
  return { start, end: Math.max(start, end) };
}

/** 第 frameIndex 帧应求值的时间线 tick（预览与导出唯一来源，§11.4）。 */
export function frameTickAt(plan: ExportPlan, frameIndex: number): Ticks {
  if (!Number.isFinite(frameIndex)) return 0;
  return frameIndexToTicks(Math.max(0, Math.floor(frameIndex)), plan.fps);
}

/** 最后一帧的时间点；总帧数为 0 时返回 0。 */
export function lastFrameTick(plan: ExportPlan): Ticks {
  if (plan.totalFrames <= 0) return 0;
  return frameTickAt(plan, plan.totalFrames - 1);
}

/** 交给 evaluateScene 的场景选项：与预览使用同一输出尺寸和画幅。 */
export function frameSceneOptions(plan: ExportPlan): SceneOptions {
  return {
    outputWidth: plan.outputWidth,
    outputHeight: plan.outputHeight,
    variantId: plan.variantId,
  };
}

/** 第 frameIndex 帧命中的主视频源区间；未命中（空隙）返回 null。 */
export function sourceSegmentAtFrame(plan: ExportPlan, frameIndex: number): SourceSegment | null {
  for (const segment of plan.segments) {
    if (segment.track !== 'primaryVideo') continue;
    if (frameIndex >= segment.frameStart && frameIndex < segment.frameEnd) return segment;
  }
  return null;
}

/** 第 frameIndex 帧对应的源素材时间；未命中返回 null。 */
export function sourceTickAtFrame(plan: ExportPlan, frameIndex: number): Ticks | null {
  const segment = sourceSegmentAtFrame(plan, frameIndex);
  if (!segment) return null;
  const tick = frameTickAt(plan, frameIndex);
  const offset = tick - segment.timeline.start;
  const scaled = Math.round(offset * (segment.rate.num / segment.rate.den));
  return Math.min(segment.source.end - 1, segment.source.start + Math.max(0, scaled));
}

/** 第 sampleIndex 个输出采样命中的音频区间（可多段：不同轨道同时存在）。 */
export function audioIntervalsAtSample(plan: ExportPlan, sampleIndex: number): AudioMixInterval[] {
  return plan.audioIntervals.filter((i) => sampleIndex >= i.sampleStart && sampleIndex < i.sampleEnd);
}

/** 计划的简短描述，用于导出日志与进度信息。 */
export function describeExportPlan(plan: ExportPlan): string {
  const seconds = plan.durationTicks / TICKS_PER_SECOND;
  return `${plan.outputWidth}×${plan.outputHeight} · ${plan.fps.num}/${plan.fps.den}fps · ${seconds.toFixed(2)}s · ${plan.totalFrames} 帧`;
}

// ---------------------------------------------------------------------------
// 构建计划
// ---------------------------------------------------------------------------

function normalizeFps(fps: ExportProfileLike['fps'], fallback: FrameRate): FrameRate {
  if (fps === undefined) return { ...fallback };
  if (typeof fps === 'number') {
    if (!Number.isFinite(fps) || fps <= 0) return { ...fallback };
    return makeFrameRate(fps, 1);
  }
  if (!Number.isFinite(fps.num) || !Number.isFinite(fps.den) || fps.num <= 0 || fps.den <= 0) {
    return { ...fallback };
  }
  return makeFrameRate(fps.num, fps.den);
}

function even(v: number): number {
  const n = Math.max(2, Math.round(v));
  return n % 2 === 0 ? n : n + 1;
}

function clipTimelineRange(clip: { timelineInTicks: Ticks; sourceDurationTicks: Ticks; rate: Rational }): TickRange {
  return {
    start: clip.timelineInTicks,
    end: clip.timelineInTicks + Math.round((clip.sourceDurationTicks * clip.rate.den) / clip.rate.num),
  };
}

/**
 * 构建导出计划。
 *
 * 不修改传入工程；返回的对象是可 JSON 序列化的纯数据（可跨进程传递）。
 */
export function buildExportPlan(project: Project, profile: ExportProfileLike = {}): ExportPlan {
  const fps = normalizeFps(profile.fps, project.settings.fps);

  const requestedVariant = profile.variantId
    ? project.variants.find((v) => v.id === profile.variantId)
    : undefined;
  const variant = requestedVariant ?? activeVariant(project);
  const aspect: [number, number] = [variant.aspect[0], variant.aspect[1]];

  const defaultSize = outputSizeForAspect(aspect);
  const outputWidth = even(profile.width && profile.width > 0 ? profile.width : defaultSize.width);
  const outputHeight = even(profile.height && profile.height > 0 ? profile.height : defaultSize.height);

  const durationTicks = timelineDuration(project);
  const totalFrames = ticksToFrameCount(durationTicks, fps);

  const segments: SourceSegment[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const timeline = clipTimelineRange(clip);
      if (timeline.end <= timeline.start) continue;
      const frames = frameRangeForTicks(timeline, fps);
      // 片段可能位于输出时长之外（例如摄像头轨比主轨长）：帧区间必须夹到
      // [0, totalFrames]，否则会给出 frameStart > totalFrames 的「未来帧」区间。
      segments.push({
        track: track.kind,
        clipId: clip.id,
        assetId: clip.assetId,
        timeline,
        source: {
          start: clip.sourceInTicks,
          end: clip.sourceInTicks + clip.sourceDurationTicks,
        },
        rate: { ...clip.rate },
        frameStart: Math.min(frames.start, totalFrames),
        frameEnd: Math.min(frames.end, totalFrames),
      });
    }
  }
  segments.sort((a, b) => a.timeline.start - b.timeline.start || a.track.localeCompare(b.track));

  const audio = buildAudioMixIntervals(project, { durationTicks });
  const audioIntervals = audio.intervals.filter((i) => i.sampleEnd > i.sampleStart);

  return {
    projectId: project.id,
    revision: project.revision,
    privacyVersion: project.privacyVersion,
    variantId: variant.id,
    aspect,
    outputWidth,
    outputHeight,
    fps,
    durationTicks,
    totalFrames,
    audioOnly: profile.audioOnly ?? false,
    includeTutorial: profile.includeTutorial ?? false,
    audioSampleRate: audio.sampleRate,
    audioChannels: audio.channels,
    audioTotalSamples: audio.totalSamples,
    segments,
    audioIntervals,
    cacheKeyPrefix: [project.revision, project.privacyVersion, outputWidth, outputHeight, variant.id].join(':'),
  };
}

export interface AudioMixOptions {
  durationTicks?: Ticks;
  sampleRate?: number;
  /** 输出声道数；缺省时按轨道取（系统声 2，麦克风 1，取最大值） */
  channels?: number;
}

export interface AudioMixResult {
  sampleRate: number;
  channels: number;
  totalSamples: number;
  intervals: AudioMixInterval[];
}

/**
 * 计算音频混合区间。
 *
 * 只处理 mic / system 两条音频轨（主视频轨是屏幕画面，摄像头轨为视频）。
 * 区间按 [sampleStart, sampleEnd) 左闭右开给出，源区间用同一 TimeMap 语义换算，
 * 保证音频与画面来自同一条时间映射（§11.4「音频按同一时间映射混合」）。
 */
export function buildAudioMixIntervals(project: Project, options: AudioMixOptions = {}): AudioMixResult {
  const sampleRate = options.sampleRate && options.sampleRate > 0 ? Math.round(options.sampleRate) : DEFAULT_AUDIO_SAMPLE_RATE;
  const durationTicks = options.durationTicks ?? timelineDuration(project);
  const totalSamples = Math.max(0, Math.round((durationTicks * sampleRate) / TICKS_PER_SECOND));

  const intervals: AudioMixInterval[] = [];
  let channels = options.channels && options.channels > 0 ? Math.round(options.channels) : 0;

  for (const kind of ['mic', 'system'] as const) {
    const track = findTrack(project, kind);
    if (!track) continue;
    for (const clip of track.clips) {
      const timeline = clipTimelineRange(clip);
      if (timeline.end <= timeline.start) continue;
      const sampleStart = Math.max(0, Math.round((timeline.start * sampleRate) / TICKS_PER_SECOND));
      const sampleEnd = Math.min(totalSamples, Math.round((timeline.end * sampleRate) / TICKS_PER_SECOND));
      if (sampleEnd <= sampleStart) continue;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const assetChannels = asset && asset.channels > 0 ? asset.channels : kind === 'system' ? 2 : 1;
      if (options.channels === undefined) channels = Math.max(channels, assetChannels);
      intervals.push({
        track: kind,
        clipId: clip.id,
        assetId: clip.assetId,
        timeline,
        source: { start: clip.sourceInTicks, end: clip.sourceInTicks + clip.sourceDurationTicks },
        sampleStart,
        sampleEnd,
        sourceSampleStart: Math.max(0, Math.round((clip.sourceInTicks * sampleRate) / TICKS_PER_SECOND)),
        rate: clip.rate.den === 0 ? 1 : clip.rate.num / clip.rate.den,
        gain: Number.isFinite(track.gain) ? Math.max(0, Math.min(4, track.gain)) : 1,
        muted: track.muted,
      });
    }
  }

  intervals.sort((a, b) => a.sampleStart - b.sampleStart || a.track.localeCompare(b.track));

  return {
    sampleRate,
    channels: channels || 2,
    totalSamples,
    intervals,
  };
}
