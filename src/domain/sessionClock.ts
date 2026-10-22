/**
 * 会话时钟与暂停映射（开发文档 §9.2 / §9.3）
 *
 *   会话媒体时间 = 源时间映射到 QPC 后的时间 − 会话零点 − 此前累计暂停时间
 *
 * 约定：
 * - 会话零点由首次有效屏幕帧确定，其他轨道（音频/摄像头/指针）在该点对齐；
 * - 一条共享暂停区间表同时作用于屏幕、音频、摄像头和指针，不在各轨各算一遍；
 * - 较早样本裁掉（返回 mediaTick = null），较晚样本在前方补静音/空白并记录原因；
 * - 暂停期间媒体时间冻结，重复 Pause/Resume/Stop 幂等。
 */

import type { TickRange, Ticks } from './timebase';
import { rangeLength, secondsToTicks } from './timebase';

/** 样本早于会话零点 / 轨道晚起时的处理原因（§9.2）。 */
export type PadReason = 'late-start' | 'device-switch' | 'resume-gap';

export interface SamplePlacement {
  /** 会话媒体时间；null 表示样本早于会话零点，必须裁掉 */
  mediaTick: Ticks | null;
  /** 需要在该样本前方补的空白/静音时长 */
  padTicks: Ticks;
  /** 补空白原因；padTicks 为 0 时为 null */
  padReason: PadReason | null;
  /** 样本是否落在暂停区间内（应丢弃） */
  duringPause: boolean;
}

export interface TrackClock {
  /** 该轨源时钟到会话 QPC 的起始偏移（QPC tick） */
  offsetQpcTicks: Ticks;
  /** 该轨已知的起始媒体时间（晚起时 > 0） */
  startMediaTick: Ticks;
}

export interface SessionClockOptions {
  /** 暂停区间表的最大数量保护 */
  maxPauseRanges?: number;
}

/**
 * 会话时钟。
 *
 * 所有入参/出参都是 QPC tick（100ns 整数）。纯逻辑，不读取系统时钟：
 * 调用方把 QPC 时间传进来，便于单元测试与故障注入复现。
 */
export class SessionClock {
  private zeroQpc: Ticks | null = null;
  /** 共享暂停区间表（QPC 时间，[start, end)） */
  private pauseRanges: TickRange[] = [];
  private pausedAt: Ticks | null = null;
  private stoppedAt: Ticks | null = null;
  private readonly maxPauseRanges: number;
  private readonly trackOffsets = new Map<string, TrackClock>();

  constructor(options: SessionClockOptions = {}) {
    this.maxPauseRanges = Math.max(1, options.maxPauseRanges ?? 10_000);
  }

  /** 首次有效屏幕帧到达：确定会话零点。重复调用保持第一次的零点（幂等）。 */
  setZero(qpcTick: Ticks): Ticks {
    if (this.zeroQpc === null) this.zeroQpc = Math.round(qpcTick);
    return this.zeroQpc;
  }

  get zero(): Ticks | null {
    return this.zeroQpc;
  }

  get hasZero(): boolean {
    return this.zeroQpc !== null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  get stopped(): boolean {
    return this.stoppedAt !== null;
  }

  /** 停止时的 QPC 时刻（重复停止保持第一次，幂等）。 */
  get stopQpc(): Ticks | null {
    return this.stoppedAt;
  }

  /** 注册/更新一条轨道的源时钟偏移（音频、摄像头、指针各自建立映射）。 */
  setTrackOffset(trackId: string, offsetQpcTicks: Ticks, startMediaTick: Ticks = 0): void {
    this.trackOffsets.set(trackId, {
      offsetQpcTicks: Math.round(offsetQpcTicks),
      startMediaTick: Math.max(0, Math.round(startMediaTick)),
    });
  }

  trackOffset(trackId: string): TrackClock | undefined {
    return this.trackOffsets.get(trackId);
  }

  /** 暂停：重复暂停不产生新的暂停区间（幂等）。 */
  pause(qpcTick: Ticks): boolean {
    if (this.stoppedAt !== null) return false;
    if (this.pausedAt !== null) return false;
    this.pausedAt = Math.round(qpcTick);
    return true;
  }

  /** 恢复：未处于暂停时无副作用（幂等）；恢复时闭合一条暂停区间。 */
  resume(qpcTick: Ticks): boolean {
    if (this.stoppedAt !== null) return false;
    if (this.pausedAt === null) return false;
    const at = Math.round(qpcTick);
    const start = this.pausedAt;
    this.pausedAt = null;
    if (at > start) {
      this.pauseRanges.push({ start, end: at });
      if (this.pauseRanges.length > this.maxPauseRanges) this.pauseRanges.shift();
    }
    return true;
  }

  /** 停止：重复停止返回第一次停止时刻（幂等）。若正在暂停则先闭合暂停区间。 */
  stop(qpcTick: Ticks): Ticks {
    if (this.stoppedAt !== null) return this.stoppedAt;
    const at = Math.round(qpcTick);
    if (this.pausedAt !== null) {
      if (at > this.pausedAt) this.pauseRanges.push({ start: this.pausedAt, end: at });
      this.pausedAt = null;
    }
    this.stoppedAt = at;
    return at;
  }

  /** 共享暂停区间表（QPC 时间，已排序，含未闭合的当前暂停区间）。 */
  pauseTable(nowQpc?: Ticks): TickRange[] {
    const table = this.pauseRanges.map((r) => ({ ...r }));
    if (this.pausedAt !== null) {
      const end = nowQpc !== undefined ? Math.max(this.pausedAt, Math.round(nowQpc)) : this.pausedAt;
      if (end > this.pausedAt) table.push({ start: this.pausedAt, end });
    }
    return table;
  }

  /** 截至 qpcTick 的累计暂停时间。 */
  pausedTicksAt(qpcTick: Ticks): Ticks {
    if (this.zeroQpc === null) return 0;
    const at = Math.round(qpcTick);
    let total = 0;
    for (const r of this.pauseRanges) {
      const start = Math.max(r.start, this.zeroQpc);
      const end = Math.min(r.end, at);
      if (end > start) total += end - start;
    }
    if (this.pausedAt !== null && this.pausedAt < at) {
      const start = Math.max(this.pausedAt, this.zeroQpc);
      if (at > start) total += at - start;
    }
    return total;
  }

  /**
   * QPC 时间 → 会话媒体时间。
   * 会话零点之前返回负数（调用方据此裁掉较早样本）。
   */
  mediaTickAt(qpcTick: Ticks): Ticks {
    const at = Math.round(qpcTick);
    if (this.zeroQpc === null) return 0;
    const raw = at - this.zeroQpc;
    if (raw <= 0) return raw;
    return raw - this.pausedTicksAt(at);
  }

  /**
   * 轨道源时间 → 会话媒体时间（先按轨道偏移映射到会话 QPC）。
   * 返回 null 表示样本早于会话零点，必须裁掉。
   */
  trackMediaTickAt(trackId: string, trackQpcTick: Ticks): Ticks | null {
    const track = this.trackOffsets.get(trackId);
    const qpc = Math.round(trackQpcTick) + (track?.offsetQpcTicks ?? 0);
    const media = this.mediaTickAt(qpc);
    const minMedia = track?.startMediaTick ?? 0;
    if (this.zeroQpc === null) return 0;
    if (qpc < this.zeroQpc) return null;
    return media + minMedia;
  }

  /**
   * 放置一个轨道样本：返回媒体时间、需要的补空白与原因。
   * 早于会话零点 → mediaTick=null（裁掉）；晚于轨道应起点 → 补空白（记录原因）。
   */
  placeSample(trackId: string, trackQpcTick: Ticks, expectedMediaTick?: Ticks): SamplePlacement {
    const track = this.trackOffsets.get(trackId);
    const qpc = Math.round(trackQpcTick) + (track?.offsetQpcTicks ?? 0);
    const duringPause = this.isDuringPause(qpc);
    const mediaTick = this.trackMediaTickAt(trackId, trackQpcTick);
    if (mediaTick === null) {
      return { mediaTick: null, padTicks: 0, padReason: null, duringPause };
    }
    if (expectedMediaTick !== undefined && mediaTick > expectedMediaTick) {
      const padTicks = mediaTick - expectedMediaTick;
      const padReason: PadReason =
        (track?.startMediaTick ?? 0) > 0 ? 'late-start' : this.pauseRanges.length > 0 ? 'resume-gap' : 'device-switch';
      return { mediaTick, padTicks, padReason, duringPause };
    }
    return { mediaTick, padTicks: 0, padReason: null, duringPause };
  }

  /** 某个 QPC 时刻是否落在暂停区间内（暂停期间的样本不写入）。 */
  isDuringPause(qpcTick: Ticks): boolean {
    const at = Math.round(qpcTick);
    for (const r of this.pauseRanges) {
      if (at >= r.start && at < r.end) return true;
    }
    if (this.pausedAt !== null && at >= this.pausedAt) return true;
    return false;
  }

  /** 会话媒体总时长（停止后为定值；未停止时按当前 QPC 计算）。 */
  durationTicks(nowQpc?: Ticks): Ticks {
    if (this.zeroQpc === null) return 0;
    const at = this.stoppedAt ?? (nowQpc !== undefined ? Math.round(nowQpc) : this.zeroQpc);
    return Math.max(0, this.mediaTickAt(at));
  }

  /** 累计暂停时长（全部已闭合区间 + 当前暂停）。 */
  get accumulatedPauseTicks(): Ticks {
    return this.pauseRanges.reduce((acc, r) => acc + rangeLength(r), 0);
  }

  /** 恢复/暂停切换次数，用于测试与诊断。 */
  get pauseCount(): number {
    return this.pauseRanges.length;
  }

  /** 测试与故障注入用：重置（不保留历史）。 */
  reset(): void {
    this.zeroQpc = null;
    this.pauseRanges = [];
    this.pausedAt = null;
    this.stoppedAt = null;
    this.trackOffsets.clear();
  }
}

/** 4 秒恢复损失上限（§9.5 / §16.2）。 */
export const RECOVERY_LOSS_TARGET_TICKS: Ticks = secondsToTicks(4);
