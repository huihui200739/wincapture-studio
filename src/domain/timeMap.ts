/**
 * TimeMap（开发文档 §10.1）
 *
 * 单一映射器，对屏幕、音频、摄像头、指针、镜头、遮挡、步骤执行同一条映射，
 * 不在各面板临时补算时间。
 *
 *   目标时间 = 片段目标起点 + (源时间 − 片段源起点) ÷ 播放速率
 */

import type { Clip, Project, TrackKind } from './project';
import { findTrack } from './project';
import type { TickRange, Ticks } from './timebase';
import { divideByRate, rangeSubtract } from './timebase';

export interface ClipSegment {
  clip: Clip;
  /** 时间线区间 [start, end) */
  timeline: TickRange;
  /** 源素材区间 [start, end) */
  source: TickRange;
}

export interface SourceToTimelineHit {
  timelineTick: Ticks;
  clip: Clip;
  /** 同一素材时间可能被多次引用（复制片段），故返回全部命中 */
}

export class TimeMap {
  private readonly segmentsByTrack = new Map<TrackKind, ClipSegment[]>();

  constructor(private readonly project: Project) {
    for (const track of project.tracks) {
      const segments: ClipSegment[] = track.clips
        .map((clip) => ({
          clip,
          timeline: {
            start: clip.timelineInTicks,
            end: clip.timelineInTicks + divideByRate(clip.sourceDurationTicks, clip.rate),
          },
          source: {
            start: clip.sourceInTicks,
            end: clip.sourceInTicks + clip.sourceDurationTicks,
          },
        }))
        .sort((a, b) => a.timeline.start - b.timeline.start);
      this.segmentsByTrack.set(track.kind, segments);
    }
  }

  /** 轨道在时间线上的有序片段。 */
  segments(kind: TrackKind): readonly ClipSegment[] {
    return this.segmentsByTrack.get(kind) ?? [];
  }

  /** 时间线时间 → 该轨道命中片段的源时间；未命中返回 null。 */
  toSource(kind: TrackKind, timelineTick: Ticks): { sourceTick: Ticks; clip: Clip } | null {
    for (const seg of this.segments(kind)) {
      if (timelineTick >= seg.timeline.start && timelineTick < seg.timeline.end) {
        const offset = timelineTick - seg.timeline.start;
        const raw = seg.source.start + Math.round(offset * (seg.clip.rate.num / seg.clip.rate.den));
        // 变速片段在整数 tick 上取整后可能正好落在 source.end（右开区间之外），
        // 夹到 end-1 保证「命中片段」时一定返回片段内部的源时间。
        return { sourceTick: Math.min(seg.source.end - 1, Math.max(seg.source.start, raw)), clip: seg.clip };
      }
    }
    return null;
  }

  /** 源素材时间 → 时间线时间（可能命中多个片段，返回全部）。 */
  toTimeline(kind: TrackKind, assetId: string, sourceTick: Ticks): SourceToTimelineHit[] {
    const hits: SourceToTimelineHit[] = [];
    for (const seg of this.segments(kind)) {
      if (seg.clip.assetId !== assetId) continue;
      if (sourceTick >= seg.source.start && sourceTick < seg.source.end) {
        const offset = sourceTick - seg.source.start;
        const raw = seg.timeline.start + divideByRate(offset, seg.clip.rate);
        hits.push({
          timelineTick: Math.min(seg.timeline.end - 1, Math.max(seg.timeline.start, raw)),
          clip: seg.clip,
        });
      }
    }
    return hits;
  }

  /**
   * 把一个「源时间区间」映射到时间线区间集合。
   * 若源区间跨片段，会切成多段；被删除部分自然不产生结果。
   */
  mapSourceRange(kind: TrackKind, assetId: string, sourceRange: TickRange): TickRange[] {
    const out: TickRange[] = [];
    for (const seg of this.segments(kind)) {
      if (seg.clip.assetId !== assetId) continue;
      const start = Math.max(sourceRange.start, seg.source.start);
      const end = Math.min(sourceRange.end, seg.source.end);
      if (end <= start) continue;
      const mappedStart = seg.timeline.start + divideByRate(start - seg.source.start, seg.clip.rate);
      const mappedEnd = seg.timeline.start + divideByRate(end - seg.source.start, seg.clip.rate);
      // 变速取整可能把极短源区间压成零长度；空区间不应出现在映射结果里。
      if (mappedEnd <= mappedStart) continue;
      out.push({ start: mappedStart, end: mappedEnd });
    }
    return out;
  }

  /** 时间线区间 → 源时间区间集合（供裁剪、波形、缩略图使用）。 */
  mapTimelineRange(kind: TrackKind, timelineRange: TickRange): TickRange[] {
    const out: TickRange[] = [];
    for (const seg of this.segments(kind)) {
      const start = Math.max(timelineRange.start, seg.timeline.start);
      const end = Math.min(timelineRange.end, seg.timeline.end);
      if (end <= start) continue;
      const mappedStart = seg.source.start + Math.round((start - seg.timeline.start) * (seg.clip.rate.num / seg.clip.rate.den));
      const mappedEnd = seg.source.start + Math.round((end - seg.timeline.start) * (seg.clip.rate.num / seg.clip.rate.den));
      if (mappedEnd <= mappedStart) continue;
      out.push({ start: mappedStart, end: mappedEnd });
    }
    return out;
  }

  /**
   * 删除区间后事件的处理（§10.1）：删除区间内事件按类型删除或裁断。
   * 返回事件区间扣除删除区间后的剩余部分。
   */
  static subtractRemoved(range: TickRange, removed: readonly TickRange[]): TickRange[] {
    let pieces: TickRange[] = [{ ...range }];
    for (const cut of removed) {
      const next: TickRange[] = [];
      for (const piece of pieces) next.push(...rangeSubtract(piece, cut));
      pieces = next;
    }
    return pieces;
  }

  /** 主视频轨的片段序列（时间线顺序）。 */
  mainSegments(): readonly ClipSegment[] {
    const main = findTrack(this.project, 'primaryVideo');
    if (!main) return [];
    return this.segments(main.kind);
  }

  /** 某一时间线时刻，主轨是否落在片段内（决定是否需要复帧）。 */
  mainHit(timelineTick: Ticks): ClipSegment | null {
    for (const seg of this.mainSegments()) {
      if (timelineTick >= seg.timeline.start && timelineTick < seg.timeline.end) return seg;
    }
    return null;
  }
}
