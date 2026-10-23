import { describe, it, expect } from 'vitest';
import { TimeMap } from '../../src/domain/timeMap';
import type { ClipSegment } from '../../src/domain/timeMap';
import { createEmptyProject } from '../../src/domain/project';
import type { Project, Clip } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks, divideByRate } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function clip(partial: Partial<Clip> & { id: string; assetId: string }): Clip {
  return {
    sourceInTicks: 0,
    sourceDurationTicks: S,
    timelineInTicks: 0,
    rate: { num: 1, den: 1 },
    linkGroupId: 'g1',
    ...partial,
  };
}

function projectWith(clips: Clip[], kind: 'primaryVideo' | 'camera' | 'mic' | 'system' = 'primaryVideo'): Project {
  const project = createEmptyProject('p1', 'test');
  const track = project.tracks.find((t) => t.kind === kind)!;
  track.clips = clips;
  return project;
}

describe('TimeMap: 片段构建与排序', () => {
  it('segments 按时间线起点排序', () => {
    const project = projectWith([
      clip({ id: 'b', assetId: 'a1', timelineInTicks: 10 * S }),
      clip({ id: 'a', assetId: 'a1', timelineInTicks: 0 }),
    ]);
    const map = new TimeMap(project);
    const segs = map.segments('primaryVideo');
    expect(segs.map((s) => s.clip.id)).toEqual(['a', 'b']);
  });

  it('segment 的 timeline/source 区间按速率换算', () => {
    const project = projectWith([
      clip({
        id: 'c1',
        assetId: 'a1',
        sourceInTicks: 2 * S,
        sourceDurationTicks: 4 * S,
        timelineInTicks: S,
        rate: { num: 1, den: 2 }, // 0.5 倍速 → 时长翻倍
      }),
    ]);
    const seg = new TimeMap(project).segments('primaryVideo')[0];
    expect(seg.timeline).toEqual({ start: S, end: S + 8 * S });
    expect(seg.source).toEqual({ start: 2 * S, end: 6 * S });
  });

  it('空轨道返回空数组', () => {
    const map = new TimeMap(createEmptyProject('p', 'n'));
    expect(map.segments('primaryVideo')).toEqual([]);
    expect(map.mainSegments()).toEqual([]);
  });
});

describe('TimeMap: toSource 左闭右开边界', () => {
  const project = projectWith([
    clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: S }),
  ]);
  const map = new TimeMap(project);

  it('片段起点属于片段（左闭）', () => {
    const hit = map.toSource('primaryVideo', S);
    expect(hit).not.toBeNull();
    expect(hit!.sourceTick).toBe(0);
  });

  it('片段终点不属于片段（右开）', () => {
    expect(map.toSource('primaryVideo', S + 5 * S)).toBeNull();
  });

  it('终点前一个 tick 属于片段', () => {
    const hit = map.toSource('primaryVideo', S + 5 * S - 1);
    expect(hit).not.toBeNull();
    expect(hit!.sourceTick).toBe(5 * S - 1);
  });

  it('起点前一个 tick 不属于片段', () => {
    expect(map.toSource('primaryVideo', S - 1)).toBeNull();
  });

  it('区间中间正确换算偏移', () => {
    const hit = map.toSource('primaryVideo', S + 2 * S);
    expect(hit!.sourceTick).toBe(2 * S);
    expect(hit!.clip.id).toBe('c1');
  });

  it('未命中返回 null', () => {
    expect(map.toSource('primaryVideo', 100 * S)).toBeNull();
  });
});

describe('TimeMap: toTimeline 与重复引用', () => {
  it('同一素材被多次引用时返回全部命中', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: 10 * S }),
    ]);
    const map = new TimeMap(project);
    const hits = map.toTimeline('primaryVideo', 'a1', 2 * S);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.timelineTick).sort((a, b) => a - b)).toEqual([2 * S, 12 * S]);
  });

  it('不同素材不串台', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceDurationTicks: 5 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a2', sourceDurationTicks: 5 * S, timelineInTicks: 10 * S }),
    ]);
    const map = new TimeMap(project);
    expect(map.toTimeline('primaryVideo', 'a2', 0)).toHaveLength(1);
    expect(map.toTimeline('primaryVideo', 'a1', 0)).toHaveLength(1);
  });

  it('源区间右开边界：sourceTick = source.end 不命中', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: 0 }),
    ]);
    const map = new TimeMap(project);
    expect(map.toTimeline('primaryVideo', 'a1', 5 * S)).toHaveLength(0);
    expect(map.toTimeline('primaryVideo', 'a1', 5 * S - 1)).toHaveLength(1);
  });
});

describe('TimeMap: mapSourceRange 跨段切分', () => {
  it('一个源区间跨多个片段时切成多段', () => {
    // 源 0..10s 被切成 3 个引用，分别放在时间线 0s、10s、20s
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 3 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a1', sourceInTicks: 3 * S, sourceDurationTicks: 3 * S, timelineInTicks: 10 * S }),
      clip({ id: 'c3', assetId: 'a1', sourceInTicks: 6 * S, sourceDurationTicks: 4 * S, timelineInTicks: 20 * S }),
    ]);
    const map = new TimeMap(project);
    const out = map.mapSourceRange('primaryVideo', 'a1', { start: 2 * S, end: 9 * S });
    expect(out).toHaveLength(3);
    // 段1：源 2..3 → 时间线 2..3
    expect(out[0]).toEqual({ start: 2 * S, end: 3 * S });
    // 段2：源 3..6 → 时间线 10..13
    expect(out[1]).toEqual({ start: 10 * S, end: 13 * S });
    // 段3：源 6..9 → 时间线 20..23
    expect(out[2]).toEqual({ start: 20 * S, end: 23 * S });
  });

  it('跨段切分后的各段长度之和 = 源区间长度（1 倍速）', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 4 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a1', sourceInTicks: 4 * S, sourceDurationTicks: 6 * S, timelineInTicks: 30 * S }),
    ]);
    const map = new TimeMap(project);
    const out = map.mapSourceRange('primaryVideo', 'a1', { start: 0, end: 10 * S });
    const total = out.reduce((acc, r) => acc + (r.end - r.start), 0);
    expect(total).toBe(10 * S);
  });

  it('完全落在空隙中的源区间不产生结果', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 3 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a1', sourceInTicks: 6 * S, sourceDurationTicks: 3 * S, timelineInTicks: 10 * S }),
    ]);
    const map = new TimeMap(project);
    // 源 3..6 已被删除
    expect(map.mapSourceRange('primaryVideo', 'a1', { start: 3 * S, end: 6 * S })).toEqual([]);
  });

  it('源区间边界恰好等于片段边界时不产生空段', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 3 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a1', sourceInTicks: 3 * S, sourceDurationTicks: 3 * S, timelineInTicks: 10 * S }),
    ]);
    const map = new TimeMap(project);
    const out = map.mapSourceRange('primaryVideo', 'a1', { start: 3 * S, end: 3 * S });
    expect(out).toEqual([]);
    const out2 = map.mapSourceRange('primaryVideo', 'a1', { start: 2 * S, end: 3 * S });
    expect(out2).toEqual([{ start: 2 * S, end: 3 * S }]);
  });

  it('变速片段的映射按速率换算', () => {
    const project = projectWith([
      clip({
        id: 'c1',
        assetId: 'a1',
        sourceInTicks: 0,
        sourceDurationTicks: 10 * S,
        timelineInTicks: 0,
        rate: { num: 2, den: 1 }, // 2 倍速 → 时间线时长减半
      }),
    ]);
    const map = new TimeMap(project);
    const out = map.mapSourceRange('primaryVideo', 'a1', { start: 2 * S, end: 4 * S });
    expect(out).toEqual([{ start: S, end: 2 * S }]);
  });
});

describe('TimeMap: mapTimelineRange', () => {
  it('时间线区间 → 源区间集合', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: 0 }),
      clip({ id: 'c2', assetId: 'a1', sourceInTicks: 20 * S, sourceDurationTicks: 5 * S, timelineInTicks: 5 * S }),
    ]);
    const map = new TimeMap(project);
    const out = map.mapTimelineRange('primaryVideo', { start: 3 * S, end: 7 * S });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: 3 * S, end: 5 * S });
    expect(out[1]).toEqual({ start: 20 * S, end: 22 * S });
  });

  it('时间线区间落在空隙时返回空', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: 0 }),
    ]);
    const map = new TimeMap(project);
    expect(map.mapTimelineRange('primaryVideo', { start: 6 * S, end: 8 * S })).toEqual([]);
  });

  it('空时间线区间返回空', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5 * S, timelineInTicks: 0 }),
    ]);
    const map = new TimeMap(project);
    expect(map.mapTimelineRange('primaryVideo', { start: 2 * S, end: 2 * S })).toEqual([]);
  });
});

describe('TimeMap: subtractRemoved', () => {
  it('无删除时原样返回', () => {
    expect(TimeMap.subtractRemoved({ start: 0, end: 10 }, [])).toEqual([{ start: 0, end: 10 }]);
  });

  it('单次删除中间挖空切成两段', () => {
    expect(TimeMap.subtractRemoved({ start: 0, end: 10 }, [{ start: 3, end: 7 }])).toEqual([
      { start: 0, end: 3 },
      { start: 7, end: 10 },
    ]);
  });

  it('多次删除产生多段', () => {
    const out = TimeMap.subtractRemoved({ start: 0, end: 20 }, [
      { start: 2, end: 4 },
      { start: 8, end: 10 },
      { start: 16, end: 18 },
    ]);
    expect(out).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 8 },
      { start: 10, end: 16 },
      { start: 18, end: 20 },
    ]);
  });

  it('删除区间完全覆盖时返回空', () => {
    expect(TimeMap.subtractRemoved({ start: 5, end: 10 }, [{ start: 0, end: 20 }])).toEqual([]);
  });

  it('删除区间与事件边界重合时不多切一段（左闭右开）', () => {
    expect(TimeMap.subtractRemoved({ start: 0, end: 10 }, [{ start: 10, end: 20 }])).toEqual([{ start: 0, end: 10 }]);
    expect(TimeMap.subtractRemoved({ start: 10, end: 20 }, [{ start: 0, end: 10 }])).toEqual([{ start: 10, end: 20 }]);
  });

  it('删除空区间不改变结果', () => {
    expect(TimeMap.subtractRemoved({ start: 0, end: 10 }, [{ start: 5, end: 5 }])).toEqual([{ start: 0, end: 10 }]);
  });

  it('乱序删除区间仍正确（按顺序逐个扣）', () => {
    const out = TimeMap.subtractRemoved({ start: 0, end: 20 }, [
      { start: 12, end: 14 },
      { start: 2, end: 4 },
    ]);
    expect(out).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 12 },
      { start: 14, end: 20 },
    ]);
  });
});

describe('TimeMap: mainHit', () => {
  it('命中主轨片段返回 segment', () => {
    const project = projectWith([clip({ id: 'c1', assetId: 'a1', sourceDurationTicks: 5 * S, timelineInTicks: 0 })]);
    const map = new TimeMap(project);
    const seg = map.mainHit(0);
    expect(seg).not.toBeNull();
    expect(seg!.clip.id).toBe('c1');
  });

  it('终点不命中（右开）', () => {
    const project = projectWith([clip({ id: 'c1', assetId: 'a1', sourceDurationTicks: 5 * S, timelineInTicks: 0 })]);
    const map = new TimeMap(project);
    expect(map.mainHit(5 * S)).toBeNull();
  });

  it('摄像头轨不影响主轨命中', () => {
    const project = projectWith([clip({ id: 'cam', assetId: 'a2', sourceDurationTicks: 5 * S })], 'camera');
    const map = new TimeMap(project);
    expect(map.mainHit(0)).toBeNull();
    expect(map.segments('camera')).toHaveLength(1);
  });
});

describe('TimeMap: 属性（固定种子随机序列）', () => {
  // 线性同余生成器：固定种子，结果可复现
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('随机 200 组：mapSourceRange 结果各段长度之和 = 源区间长度（1 倍速、无重叠引用）', () => {
    const rand = lcg(20240601);
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const clipCount = 1 + Math.floor(rand() * 4);
      const clips: Clip[] = [];
      let sourceCursor = 0;
      let timelineCursor = 0;
      for (let c = 0; c < clipCount; c++) {
        const duration = secondsToTicks(1 + Math.floor(rand() * 4));
        clips.push(
          clip({
            id: `c${c}`,
            assetId: 'a1',
            sourceInTicks: sourceCursor,
            sourceDurationTicks: duration,
            timelineInTicks: timelineCursor,
          }),
        );
        sourceCursor += duration;
        timelineCursor += duration + secondsToTicks(Math.floor(rand() * 3));
      }
      const map = new TimeMap(projectWith(clips));
      const start = secondsToTicks(Math.floor(rand() * 4));
      const end = start + secondsToTicks(1 + Math.floor(rand() * 5));
      const out = map.mapSourceRange('primaryVideo', 'a1', { start, end });
      const covered = out.reduce((acc, r) => acc + (r.end - r.start), 0);
      const expected = Math.min(end, sourceCursor) - Math.min(start, sourceCursor);
      expect(covered).toBe(Math.max(0, expected));
      // 结果各段必须在时间线内且不越界
      for (const r of out) {
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.end).toBeGreaterThan(r.start);
        expect(r.end).toBeLessThanOrEqual(timelineCursor);
      }
      checked += 1;
    }
    expect(checked).toBe(200);
  });

  it('随机 200 组：toSource / toTimeline 在 1 倍速下互为逆映射', () => {
    const rand = lcg(777);
    for (let i = 0; i < 200; i++) {
      const duration = secondsToTicks(1 + Math.floor(rand() * 10));
      const timelineIn = secondsToTicks(Math.floor(rand() * 5));
      const sourceIn = secondsToTicks(Math.floor(rand() * 5));
      const project = projectWith([
        clip({
          id: 'c1',
          assetId: 'a1',
          sourceInTicks: sourceIn,
          sourceDurationTicks: duration,
          timelineInTicks: timelineIn,
        }),
      ]);
      const map = new TimeMap(project);
      const offset = Math.floor(rand() * duration);
      const tl = timelineIn + offset;
      const src = map.toSource('primaryVideo', tl);
      expect(src).not.toBeNull();
      expect(src!.sourceTick).toBe(sourceIn + offset);
      const back = map.toTimeline('primaryVideo', 'a1', src!.sourceTick);
      expect(back).toHaveLength(1);
      expect(back[0].timelineTick).toBe(tl);
    }
  });

  it('随机 200 组：subtractRemoved 的总长 = 原区间长 − 被删除覆盖长度', () => {
    const rand = lcg(31337);
    for (let i = 0; i < 200; i++) {
      const total = secondsToTicks(2 + Math.floor(rand() * 20));
      const range = { start: 0, end: total };
      const cuts: { start: number; end: number }[] = [];
      let cursor = 0;
      while (cursor < total) {
        const len = secondsToTicks(Math.floor(rand() * 3));
        if (len > 0 && cursor + len <= total) cuts.push({ start: cursor, end: cursor + len });
        cursor += len + secondsToTicks(1);
      }
      const out = TimeMap.subtractRemoved(range, cuts);
      const remaining = out.reduce((acc, r) => acc + (r.end - r.start), 0);
      const cutLen = cuts.reduce((acc, r) => acc + (r.end - r.start), 0);
      expect(remaining).toBe(total - cutLen);
      // 各段不重叠且有序
      for (let k = 1; k < out.length; k++) expect(out[k].start).toBeGreaterThanOrEqual(out[k - 1].end);
    }
  });
});

describe('TimeMap: 变速与除零保护', () => {
  it('2 倍速片段的时间线时长为源时长一半', () => {
    const c = clip({ id: 'c1', assetId: 'a1', sourceDurationTicks: 10 * S, rate: { num: 2, den: 1 } });
    const project = projectWith([c]);
    const seg: ClipSegment = new TimeMap(project).segments('primaryVideo')[0];
    expect(seg.timeline.end - seg.timeline.start).toBe(5 * S);
    expect(divideByRate(10 * S, { num: 2, den: 1 })).toBe(5 * S);
  });
});

// ---------------------------------------------------------------------------
// 回归：变速取整不得越出片段区间 / 产生零长度区间
// ---------------------------------------------------------------------------

describe('回归：变速映射的取整边界', () => {
  it('慢放片段的 toSource 不会返回 source.end（右开边界之外）', () => {
    // 0.5 倍速：源时长 3tick → 时间线时长 6tick；tick 5 的精确源时间 2.5 会被舍入到 3
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 3, timelineInTicks: 0, rate: { num: 1, den: 2 } }),
    ]);
    const map = new TimeMap(project);
    const hit = map.toSource('primaryVideo', 5);
    expect(hit).not.toBeNull();
    expect(hit!.sourceTick).toBeGreaterThanOrEqual(0);
    expect(hit!.sourceTick).toBeLessThan(3);
    expect(hit!.sourceTick).toBe(2);
  });

  it('快放片段的 toTimeline 不会返回 timeline.end（右开边界之外）', () => {
    // 3 倍速：源时长 4tick → 时间线时长 1tick；源 tick 3 映射到 round(1) = 1 = timeline.end
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 4, timelineInTicks: 0, rate: { num: 3, den: 1 } }),
    ]);
    const map = new TimeMap(project);
    const hits = map.toTimeline('primaryVideo', 'a1', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].timelineTick).toBe(0);
  });

  it('变速压缩后的零长度映射结果被丢弃', () => {
    const fast = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5, timelineInTicks: 0, rate: { num: 2, den: 1 } }),
    ]);
    expect(new TimeMap(fast).mapSourceRange('primaryVideo', 'a1', { start: 1, end: 2 })).toEqual([]);

    const slow = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 5, timelineInTicks: 0, rate: { num: 1, den: 2 } }),
    ]);
    expect(new TimeMap(slow).mapTimelineRange('primaryVideo', { start: 1, end: 2 })).toEqual([]);
  });

  it('映射结果的所有区间都非空', () => {
    const project = projectWith([
      clip({ id: 'c1', assetId: 'a1', sourceInTicks: 0, sourceDurationTicks: 20, timelineInTicks: 0, rate: { num: 2, den: 1 } }),
    ]);
    const map = new TimeMap(project);
    for (let start = 0; start < 20; start++) {
      for (const range of map.mapSourceRange('primaryVideo', 'a1', { start, end: start + 1 })) {
        expect(range.end).toBeGreaterThan(range.start);
      }
    }
    for (let start = 0; start < 10; start++) {
      for (const range of map.mapTimelineRange('primaryVideo', { start, end: start + 1 })) {
        expect(range.end).toBeGreaterThan(range.start);
      }
    }
  });
});
