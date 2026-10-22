import { describe, it, expect } from 'vitest';
import {
  rebuildFromJournal,
  rebuildPauseRanges,
  totalPausedTicks,
  toMediaRefs,
  RECOVERY_LOSS_TARGET_TICKS,
} from '../../src/domain/recovery';
import type { RecoveryJournalEntry, SegmentRecord } from '../../src/domain/types';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function entry(
  seq: number,
  type: RecoveryJournalEntry['type'],
  detail?: Record<string, unknown>,
  sessionId = 'sess-1',
): RecoveryJournalEntry {
  return { seq, at: 1_700_000_000_000 + seq * 1000, type, sessionId, detail };
}

function seg(
  index: number,
  kind: 'video' | 'audio',
  path: string,
  startTick: number,
  durationTicks: number,
  state: SegmentRecord['state'] = 'committed',
): SegmentRecord {
  return { index, path, kind, startTick, durationTicks, state };
}

/** 构造一次「正常录制 3 段后停止」的 journal + 段记录。 */
function normalRecording(): { entries: RecoveryJournalEntry[]; records: SegmentRecord[] } {
  const entries: RecoveryJournalEntry[] = [entry(1, 'session-start')];
  const records: SegmentRecord[] = [];
  for (let i = 0; i < 3; i++) {
    const path = `media/screen/seg-00000${i + 1}.mp4`;
    entries.push(entry(2 + i * 2, 'segment-begin', { path }));
    entries.push(entry(3 + i * 2, 'segment-commit', { path }));
    records.push(seg(i + 1, 'video', path, i * 2 * S, 2 * S));
  }
  entries.push(entry(8, 'stop', { mediaTick: 6 * S }));
  entries.push(entry(9, 'complete', { mediaTick: 6 * S }));
  return { entries, records };
}

describe('rebuildFromJournal: 正常完成', () => {
  it('恢复全部已提交段', () => {
    const { entries, records } = normalRecording();
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(3);
    expect(plan.videoSegments).toHaveLength(3);
    expect(plan.discarded).toHaveLength(0);
    expect(plan.completed).toBe(true);
    expect(plan.recoveredTicks).toBe(6 * S);
  });

  it('无损失时 estimatedLossTicks 为 0', () => {
    const { entries, records } = normalRecording();
    const plan = rebuildFromJournal(entries, records);
    expect(plan.estimatedLossTicks).toBe(0);
    expect(plan.withinLossTarget).toBe(true);
    expect(plan.lossRange).toEqual({ start: 6 * S, end: 6 * S });
  });

  it('sessionId 从 session-start 取', () => {
    const { entries, records } = normalRecording();
    expect(rebuildFromJournal(entries, records).sessionId).toBe('sess-1');
  });

  it('summary 是面向用户的中文摘要', () => {
    const { entries, records } = normalRecording();
    const summary = rebuildFromJournal(entries, records).summary;
    expect(summary).toContain('已正常完成');
    expect(summary).toContain('3');
    expect(summary.endsWith('。')).toBe(true);
  });
});

describe('rebuildFromJournal: 强退恢复（§15.1）', () => {
  it('有段文件但没有 commit 的段被丢弃（写到一半崩溃）', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'media/screen/seg-000001.mp4' }),
      entry(3, 'segment-commit', { path: 'media/screen/seg-000001.mp4' }),
      entry(4, 'segment-begin', { path: 'media/screen/seg-000002.mp4' }),
      // 没有 seg-000002 的 commit → 强退
    ];
    const records = [
      seg(1, 'video', 'media/screen/seg-000001.mp4', 0, 2 * S),
      seg(2, 'video', 'media/screen/seg-000002.mp4', 2 * S, 2 * S),
    ];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(1);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0].record.path).toContain('seg-000002');
    expect(plan.completed).toBe(false);
  });

  it('state=writing 的段不进入已提交清单', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'media/screen/seg-000001.mp4' }),
      entry(3, 'segment-commit', { path: 'media/screen/seg-000001.mp4' }),
    ];
    const records = [
      seg(1, 'video', 'media/screen/seg-000001.mp4', 0, 2 * S),
      seg(2, 'video', 'media/screen/seg-000002.mp4', 2 * S, 1 * S, 'writing'),
    ];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(1);
    expect(plan.discarded.some((d) => d.record.state === 'writing')).toBe(true);
  });

  it('state=corrupt 的段被丢弃', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(4, 'segment-begin', { path: 'b.mp4' }),
      entry(5, 'segment-commit', { path: 'b.mp4' }),
    ];
    const records = [
      seg(1, 'video', 'a.mp4', 0, 2 * S),
      seg(2, 'video', 'b.mp4', 2 * S, 2 * S, 'corrupt'),
    ];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(1);
    expect(plan.discarded.some((d) => d.reason.includes('corrupt'))).toBe(true);
  });

  it('journal 标记 segment-corrupt 的段被丢弃（即使段记录是 committed）', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(4, 'segment-corrupt', { path: 'a.mp4' }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(0);
    expect(plan.discarded).toHaveLength(1);
  });

  it('缺少 segment-begin 的段被丢弃（无法确认解码起点）', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-commit', { path: 'a.mp4' }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(0);
    expect(plan.discarded[0].reason).toContain('segment-begin');
  });

  it('begin 晚于 commit 的段被丢弃（日志顺序异常）', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-commit', { path: 'a.mp4' }),
      entry(3, 'segment-begin', { path: 'a.mp4' }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(0);
  });

  it('段时长为 0 被丢弃', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 0)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(0);
  });

  it('重复 seq 只取第一条（日志重复写入稳健）', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(3, 'segment-corrupt', { path: 'a.mp4' }), // 重复 seq 应被忽略
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.committed).toHaveLength(1);
  });

  it('乱序 journal 按 seq 排序后处理', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    expect(rebuildFromJournal(entries, records).committed).toHaveLength(1);
  });
});

describe('rebuildFromJournal: 最后视频段与解码起点检查', () => {
  it('最后视频段时长与解码起点被检查', () => {
    const { entries, records } = normalRecording();
    const plan = rebuildFromJournal(entries, records);
    expect(plan.lastVideoCheck).not.toBeNull();
    expect(plan.lastVideoCheck!.path).toContain('seg-000003');
    expect(plan.lastVideoCheck!.durationTicks).toBe(2 * S);
    expect(plan.lastVideoCheck!.hasDecodeStart).toBe(true);
    expect(plan.lastVideoCheck!.reason).toBeNull();
  });

  it('没有视频段时 lastVideoCheck 为 null', () => {
    const entries: RecoveryJournalEntry[] = [entry(1, 'session-start')];
    const plan = rebuildFromJournal(entries, []);
    expect(plan.lastVideoCheck).toBeNull();
  });

  it('音频段与视频段分开统计', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'v1.mp4' }),
      entry(3, 'segment-commit', { path: 'v1.mp4' }),
      entry(4, 'segment-begin', { path: 'a1.wav' }),
      entry(5, 'segment-commit', { path: 'a1.wav' }),
    ];
    const records = [seg(1, 'video', 'v1.mp4', 0, 2 * S), seg(2, 'audio', 'a1.wav', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.videoSegments).toHaveLength(1);
    expect(plan.audioSegments).toHaveLength(1);
    expect(plan.committed).toHaveLength(2);
  });
});

describe('rebuildFromJournal: 损失区间估算（目标 ≤4 秒）', () => {
  it('尾部丢失 ≤4 秒时 withinLossTarget 为 true', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(4, 'stop', { mediaTick: 5 * S }), // 期望 5s，实际恢复 2s → 丢 3s
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.estimatedLossTicks).toBe(3 * S);
    expect(plan.withinLossTarget).toBe(true);
    expect(plan.lossRange).toEqual({ start: 2 * S, end: 5 * S });
  });

  it('尾部丢失 >4 秒时 withinLossTarget 为 false 并在摘要提示', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(4, 'stop', { mediaTick: 20 * S }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.estimatedLossTicks).toBe(18 * S);
    expect(plan.withinLossTarget).toBe(false);
    expect(plan.summary).toContain('超过 4 秒目标');
  });

  it('恢复损失目标常量为 4 秒', () => {
    expect(RECOVERY_LOSS_TARGET_TICKS).toBe(4 * S);
  });

  it('可自定义损失目标', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(4, 'stop', { mediaTick: 10 * S }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    expect(rebuildFromJournal(entries, records, { lossTargetTicks: 20 * S }).withinLossTarget).toBe(true);
  });

  it('没有 stop/complete 时无法估计损失，loss 为 0 且 lossRange 为空', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.estimatedLossTicks).toBe(0);
    expect(plan.lossRange.start).toBe(plan.lossRange.end);
  });
});

describe('rebuildFromJournal: 暂停中崩溃', () => {
  it('最后事件是 pause 时 endedDuringPause 为 true', () => {
    const entries: RecoveryJournalEntry[] = [
      entry(1, 'session-start'),
      entry(2, 'segment-begin', { path: 'a.mp4' }),
      entry(3, 'segment-commit', { path: 'a.mp4' }),
      entry(4, 'pause', { mediaTick: 2 * S }),
    ];
    const records = [seg(1, 'video', 'a.mp4', 0, 2 * S)];
    const plan = rebuildFromJournal(entries, records);
    expect(plan.endedDuringPause).toBe(true);
    expect(plan.summary).toContain('暂停');
  });

  it('最后事件是 stop 时 endedDuringPause 为 false', () => {
    const { entries, records } = normalRecording();
    expect(rebuildFromJournal(entries, records).endedDuringPause).toBe(false);
  });
});

describe('rebuildPauseRanges: 共享暂停区间表（§9.2）', () => {
  it('重建 pause/resume 区间', () => {
    const entries = [
      entry(1, 'session-start'),
      entry(2, 'pause', { mediaTick: S }),
      entry(3, 'resume', { mediaTick: 3 * S }),
      entry(4, 'pause', { mediaTick: 5 * S }),
      entry(5, 'resume', { mediaTick: 6 * S }),
    ];
    expect(rebuildPauseRanges(entries, 10 * S)).toEqual([
      { start: S, end: 3 * S },
      { start: 5 * S, end: 6 * S },
    ]);
  });

  it('未闭合的 pause 延续到会话结束', () => {
    const entries = [entry(1, 'pause', { mediaTick: 2 * S })];
    expect(rebuildPauseRanges(entries, 10 * S)).toEqual([{ start: 2 * S, end: 10 * S }]);
  });

  it('重复 pause 不产生嵌套区间', () => {
    const entries = [entry(1, 'pause', { mediaTick: S }), entry(2, 'pause', { mediaTick: 2 * S }), entry(3, 'resume', { mediaTick: 4 * S })];
    expect(rebuildPauseRanges(entries, 10 * S)).toEqual([{ start: S, end: 4 * S }]);
  });

  it('未暂停时的 resume 被忽略', () => {
    const entries = [entry(1, 'resume', { mediaTick: 3 * S })];
    expect(rebuildPauseRanges(entries, 10 * S)).toEqual([]);
  });

  it('totalPausedTicks 汇总暂停总长', () => {
    expect(totalPausedTicks([{ start: S, end: 3 * S }, { start: 5 * S, end: 6 * S }])).toBe(3 * S);
    expect(totalPausedTicks([])).toBe(0);
  });
});

describe('toMediaRefs: 段 → 工程媒体引用', () => {
  it('输出路径/类型/起点/时长/序号', () => {
    const { entries, records } = normalRecording();
    const refs = toMediaRefs(rebuildFromJournal(entries, records));
    expect(refs).toHaveLength(3);
    expect(refs[0]).toEqual({
      path: 'media/screen/seg-000001.mp4',
      kind: 'video',
      startTick: 0,
      durationTicks: 2 * S,
      index: 1,
    });
  });

  it('空计划返回空数组', () => {
    const plan = rebuildFromJournal([], []);
    expect(toMediaRefs(plan)).toEqual([]);
  });
});

describe('rebuildFromJournal: 属性测试（固定种子 200 组）', () => {
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('随机 200 组：已提交段清单 ⊆ 有 commit 的段，且已提交段顺序稳定', () => {
    const rand = lcg(20250101);
    for (let round = 0; round < 200; round++) {
      const count = 1 + Math.floor(rand() * 6);
      const entries: RecoveryJournalEntry[] = [entry(1, 'session-start')];
      const records: SegmentRecord[] = [];
      const committedPaths = new Set<string>();
      let seq = 2;
      for (let i = 0; i < count; i++) {
        const path = `media/screen/seg-${String(i + 1).padStart(6, '0')}.mp4`;
        const duration = secondsToTicks(1 + Math.floor(rand() * 2));
        const start = i * 2 * S;
        entries.push(entry(seq++, 'segment-begin', { path }));
        const willCommit = rand() > 0.25;
        if (willCommit) {
          entries.push(entry(seq++, 'segment-commit', { path }));
          committedPaths.add(path);
        }
        records.push(seg(i + 1, 'video', path, start, duration, willCommit ? 'committed' : 'writing'));
      }
      entries.push(entry(seq++, 'stop', { mediaTick: count * 2 * S }));

      const plan = rebuildFromJournal(entries, records);
      // 已提交段必须都有 commit
      for (const item of plan.committed) {
        expect(committedPaths.has(item.record.path)).toBe(true);
      }
      // 有 commit 且 state=committed 的段必须都在已提交清单
      expect(plan.committed.length).toBe(committedPaths.size);
      // 已提交段按 startTick 升序
      for (let i = 1; i < plan.committed.length; i++) {
        expect(plan.committed[i].record.startTick).toBeGreaterThanOrEqual(plan.committed[i - 1].record.startTick);
      }
      // 损失估算非负且区间合法
      expect(plan.estimatedLossTicks).toBeGreaterThanOrEqual(0);
      expect(plan.lossRange.end).toBeGreaterThanOrEqual(plan.lossRange.start);
    }
  });
});
