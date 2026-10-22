/**
 * 恢复逻辑：journal 重建（开发文档 §15.1 / §15.2 / §9.5）
 *
 * 纯逻辑，不做任何文件 IO：输入 journal 条目序列与已发现的段记录，
 * 输出「有效已提交段清单」「最后视频段时长与解码起点检查结果」「损失区间估算」。
 *
 * 规则（§15.1 提交顺序）：
 *   写临时文件 → 完成封装 → 校验可解码 → 刷新落盘 → 改名提交 → 追加 journal → 更新清单
 *
 * 因此：
 * - 只有 journal 中出现 segment-commit 且段记录 state === 'committed' 的段才算有效；
 * - state === 'writing' / 'corrupt' 的段一律不进入已提交清单；
 * - 段记录存在但 journal 无对应 commit（写到一半崩溃）→ 视为未提交，计入损失；
 * - 最后一段即使已提交，也要检查「解码起点」是否可用：segment-begin 之后若无 commit，
 *   该段不可解码，只能丢弃；
 * - 损失区间估算目标 ≤ 4 秒（§9.5 / §16.2），超过则必须在界面明确显示。
 */

import type { RecoveryJournalEntry, SegmentRecord } from './types';
import type { TickRange, Ticks } from './timebase';
import { TICKS_PER_SECOND, rangeLength, secondsToTicks } from './timebase';

/** 恢复损失目标上限（§16.2「故障尾部损失 不高于4秒」）。 */
export const RECOVERY_LOSS_TARGET_TICKS: Ticks = secondsToTicks(4);

export interface RebuiltSegment {
  record: SegmentRecord;
  /** journal 中的提交条目序号 */
  commitSeq: number;
  /** 提交时间戳 */
  committedAt: number;
}

export interface DecodeStartCheck {
  /** 检查的段路径 */
  path: string;
  /** 是否具有可用解码起点（有 begin + commit，且段时长 > 0） */
  hasDecodeStart: boolean;
  /** 段时长（tick） */
  durationTicks: Ticks;
  /** 问题说明 */
  reason: string | null;
}

export interface RecoveryPlan {
  sessionId: string | null;
  /** 有效已提交段（按 startTick 排序，视频与音频分开） */
  committed: RebuiltSegment[];
  videoSegments: RebuiltSegment[];
  audioSegments: RebuiltSegment[];
  /** 未提交/损坏而被丢弃的段 */
  discarded: { record: SegmentRecord; reason: string }[];
  /** 最后视频段的时长与解码起点检查 */
  lastVideoCheck: DecodeStartCheck | null;
  /** 已恢复总时长（tick） */
  recoveredTicks: Ticks;
  /** 损失区间（相对已提交内容的尾部） */
  lossRange: TickRange;
  /** 估算损失时长 */
  estimatedLossTicks: Ticks;
  /** 是否满足 ≤4 秒目标 */
  withinLossTarget: boolean;
  /** 会话是否正常完成（有 complete 条目） */
  completed: boolean;
  /** 是否曾在暂停中崩溃（恢复时需提示补一段空白） */
  endedDuringPause: boolean;
  /** 面向用户的中文摘要 */
  summary: string;
}

export interface RecoveryOptions {
  /** 损失目标上限，默认 4 秒 */
  lossTargetTicks?: Ticks;
  /** 段时长容差（tick），用于判断「尾段是否可疑」，默认 1 秒 */
  tailToleranceTicks?: Ticks;
  /** 预期段时长（约 2 秒，§9.5），用于估算缺失段数 */
  expectedSegmentTicks?: Ticks;
}

/**
 * 按 journal 重建有效段清单。
 *
 * journal 是 append-only 的顺序日志；本函数对乱序/重复条目保持稳健：
 * - 同一 seq 重复出现只取第一次；
 * - commit 先于 begin 出现（日志被截断或并发写坏）时，该 commit 被忽略。
 */
export function rebuildFromJournal(
  entries: readonly RecoveryJournalEntry[],
  records: readonly SegmentRecord[],
  options: RecoveryOptions = {},
): RecoveryPlan {
  const lossTarget = options.lossTargetTicks ?? RECOVERY_LOSS_TARGET_TICKS;
  const expected = options.expectedSegmentTicks ?? secondsToTicks(2);

  // 1. 规整 journal：按 seq 去重 + 按 seq 排序
  const seen = new Set<number>();
  const ordered: RecoveryJournalEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.seq !== 'number') continue;
    if (seen.has(entry.seq)) continue;
    seen.add(entry.seq);
    ordered.push(entry);
  }
  ordered.sort((a, b) => a.seq - b.seq);

  const sessionId = ordered.find((e) => e.type === 'session-start')?.sessionId ?? ordered[0]?.sessionId ?? null;
  const completed = ordered.some((e) => e.type === 'complete');
  const stopEntry = [...ordered].reverse().find((e) => e.type === 'stop');
  const endedDuringPause = lastEventType(ordered) === 'pause' || lastEventType(ordered) === 'segment-begin';

  // 2. 收集 begin / commit / corrupt，按段路径索引
  const begins = new Map<string, RecoveryJournalEntry>();
  const commits = new Map<string, RecoveryJournalEntry>();
  const corrupts = new Map<string, RecoveryJournalEntry>();
  const pathOf = (entry: RecoveryJournalEntry): string | null => {
    const detail = entry.detail ?? {};
    const path = detail.path ?? detail.segmentPath ?? detail.file;
    return typeof path === 'string' && path.length > 0 ? path : null;
  };

  for (const entry of ordered) {
    if (entry.type === 'segment-begin') {
      const path = pathOf(entry);
      if (path && !begins.has(path)) begins.set(path, entry);
    } else if (entry.type === 'segment-commit') {
      const path = pathOf(entry);
      if (path && !commits.has(path)) commits.set(path, entry);
    } else if (entry.type === 'segment-corrupt') {
      const path = pathOf(entry);
      if (path) corrupts.set(path, entry);
    }
  }

  // 3. 判定每段是否有效
  const committed: RebuiltSegment[] = [];
  const discarded: { record: SegmentRecord; reason: string }[] = [];

  for (const record of records) {
    if (!record || !record.path) {
      discarded.push({ record, reason: '段记录缺少路径' });
      continue;
    }
    if (corrupts.has(record.path)) {
      discarded.push({ record, reason: 'journal 标记该段损坏（segment-corrupt）' });
      continue;
    }
    if (record.state === 'writing') {
      discarded.push({ record, reason: '段仍处于 writing 状态，未完成封装' });
      continue;
    }
    if (record.state === 'corrupt') {
      discarded.push({ record, reason: '段记录状态为 corrupt' });
      continue;
    }
    const commit = commits.get(record.path);
    if (!commit) {
      // 有段文件但没有 commit：写到一半崩溃，不能进入已提交清单（§15.1）
      discarded.push({ record, reason: 'journal 中没有该段的 segment-commit 条目' });
      continue;
    }
    const begin = begins.get(record.path);
    if (!begin) {
      discarded.push({ record, reason: '缺少 segment-begin，无法确认解码起点' });
      continue;
    }
    if (!Number.isFinite(record.durationTicks) || record.durationTicks <= 0) {
      discarded.push({ record, reason: '段时长为 0 或非法' });
      continue;
    }
    if (begin.seq > commit.seq) {
      discarded.push({ record, reason: 'segment-begin 晚于 segment-commit，日志顺序异常' });
      continue;
    }
    committed.push({ record, commitSeq: commit.seq, committedAt: commit.at });
  }

  committed.sort((a, b) => a.record.startTick - b.record.startTick || a.record.index - b.record.index);
  const videoSegments = committed.filter((s) => s.record.kind === 'video');
  const audioSegments = committed.filter((s) => s.record.kind === 'audio');

  // 4. 最后视频段：时长与解码起点
  const lastVideo = videoSegments.at(-1) ?? null;
  const lastVideoCheck: DecodeStartCheck | null = lastVideo
    ? {
        path: lastVideo.record.path,
        hasDecodeStart: lastVideo.record.durationTicks > 0,
        durationTicks: lastVideo.record.durationTicks,
        reason: lastVideo.record.durationTicks > 0 ? null : '最后视频段时长为 0，无法定位解码起点',
      }
    : null;

  // 5. 已恢复时长与损失区间
  const recoveredTicks = committed.reduce((acc, s) => {
    if (s.record.kind !== 'video') return acc;
    return Math.max(acc, s.record.startTick + s.record.durationTicks);
  }, 0);

  const lastEnd = committed.reduce((acc, s) => Math.max(acc, s.record.startTick + s.record.durationTicks), 0);
  const lossStart = recoveredTicks > 0 ? recoveredTicks : lastEnd;

  // 期望的完整时长：最后一条 stop/complete 里记录的 mediaTick（若有）
  const expectedDuration = expectedDurationFrom(ordered, stopEntry);
  const estimatedLossTicks = Math.max(0, expectedDuration - lossStart);
  const lossRange: TickRange = { start: lossStart, end: Math.max(lossStart, expectedDuration) };

  const withinLossTarget = estimatedLossTicks <= lossTarget;

  const summary = buildSummary({
    sessionId,
    completed,
    endedDuringPause,
    committedCount: committed.length,
    videoCount: videoSegments.length,
    discardedCount: discarded.length,
    recoveredTicks,
    estimatedLossTicks,
    withinLossTarget,
    expectedSegmentTicks: expected,
  });

  return {
    sessionId,
    committed,
    videoSegments,
    audioSegments,
    discarded,
    lastVideoCheck,
    recoveredTicks,
    lossRange,
    estimatedLossTicks,
    withinLossTarget,
    completed,
    endedDuringPause,
    summary,
  };
}

function lastEventType(entries: readonly RecoveryJournalEntry[]): RecoveryJournalEntry['type'] | null {
  for (let i = entries.length - 1; i >= 0; i--) return entries[i].type;
  return null;
}

/** 从 journal 的 stop/complete 条目中取会话媒体时长。 */
function expectedDurationFrom(
  entries: readonly RecoveryJournalEntry[],
  stopEntry: RecoveryJournalEntry | undefined,
): Ticks {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'stop' && entry.type !== 'complete' && entry.type !== 'heartbeat') continue;
    const detail = entry.detail ?? {};
    const candidates = [detail.mediaTick, detail.durationTicks, detail.mediaDurationTicks];
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    }
  }
  void stopEntry;
  return 0;
}

function buildSummary(input: {
  sessionId: string | null;
  completed: boolean;
  endedDuringPause: boolean;
  committedCount: number;
  videoCount: number;
  discardedCount: number;
  recoveredTicks: Ticks;
  estimatedLossTicks: Ticks;
  withinLossTarget: boolean;
  expectedSegmentTicks: Ticks;
}): string {
  const parts: string[] = [];
  parts.push(input.completed ? '录制已正常完成' : '录制被中断，已按 journal 重建');
  parts.push(`恢复 ${input.committedCount} 个已提交段（视频 ${input.videoCount} 个）`);
  if (input.discardedCount > 0) parts.push(`${input.discardedCount} 个未完成段已丢弃`);
  if (input.endedDuringPause) parts.push('中断发生在暂停期间，恢复后不补计时');
  if (input.estimatedLossTicks > 0) {
    parts.push(
      `预计损失 ${(input.estimatedLossTicks / TICKS_PER_SECOND).toFixed(1)} 秒${
        input.withinLossTarget ? '' : '，超过 4 秒目标，请检查磁盘与写入性能'
      }`,
    );
  }
  void input.expectedSegmentTicks;
  return parts.join('；') + '。';
}

// ---------------------------------------------------------------------------
// 暂停区间重建
// ---------------------------------------------------------------------------

/**
 * 从 journal 的 pause/resume 条目重建共享暂停区间表（§9.2）。
 * 未闭合的 pause 视为延续到会话结束（endTick）。
 */
export function rebuildPauseRanges(
  entries: readonly RecoveryJournalEntry[],
  endTick: Ticks,
): TickRange[] {
  const ordered = entries.slice().sort((a, b) => a.seq - b.seq);
  const ranges: TickRange[] = [];
  let pausedAt: Ticks | null = null;
  for (const entry of ordered) {
    if (entry.type === 'pause' && pausedAt === null) {
      pausedAt = entryTick(entry);
    } else if (entry.type === 'resume' && pausedAt !== null) {
      const end = entryTick(entry);
      if (end > pausedAt) ranges.push({ start: pausedAt, end });
      pausedAt = null;
    }
  }
  if (pausedAt !== null && endTick > pausedAt) ranges.push({ start: pausedAt, end: endTick });
  return ranges;
}

function entryTick(entry: RecoveryJournalEntry): Ticks {
  const detail = entry.detail ?? {};
  const value = detail.mediaTick ?? detail.tick ?? detail.at;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

/** 暂停区间总长（用于「恢复后不补计时」的展示）。 */
export function totalPausedTicks(ranges: readonly TickRange[]): Ticks {
  return ranges.reduce((acc, r) => acc + rangeLength(r), 0);
}

// ---------------------------------------------------------------------------
// 由段记录生成工程片段
// ---------------------------------------------------------------------------

export interface RecoveredMediaRef {
  /** 工程相对路径 */
  path: string;
  kind: 'video' | 'audio';
  /** 会话媒体起点 */
  startTick: Ticks;
  durationTicks: Ticks;
  /** 段序号（用于稳定 ID） */
  index: number;
}

/** 把已提交段转换为可直接写入工程的媒体引用（不含 UI 决策）。 */
export function toMediaRefs(plan: RecoveryPlan): RecoveredMediaRef[] {
  return plan.committed.map((s) => ({
    path: s.record.path,
    kind: s.record.kind,
    startTick: s.record.startTick,
    durationTicks: s.record.durationTicks,
    index: s.record.index,
  }));
}
