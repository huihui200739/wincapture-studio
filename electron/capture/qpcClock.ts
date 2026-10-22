/**
 * QPC 时钟锚定（开发文档 §9.2）
 *
 * 问题：采集子进程给的是 QPC 原始计数（Windows 单调时钟），而主进程的
 * performance.now() 是另一条单调时间轴。两者频率不同、零点不同。
 *
 * 做法：每收到一个带 QPC 的帧/音频包，就记下 (qpc, perfNow) 这一对锚点，
 * 之后任意 perfNow 都能换算到 QPC 时间轴：
 *
 *   qpcNow ≈ anchorQpc + (perfNow − anchorPerf) × qpcFreq / 1000
 *
 * 锚点用滑动中位数平滑，避免单帧的到达抖动影响暂停边界判定。
 * 这不追求微秒级绝对精度——它只需要保证「暂停/恢复边界」落在正确的帧附近，
 * 而精确的帧时间戳一律以子进程给的 QPC 为准。
 */

export class QpcClock {
  private frequency = 10_000_000;
  private anchorQpc: number | null = null;
  private anchorPerf = 0;
  /** 最近的锚点偏移量（qpc - perf*freq/1000），用于中位数平滑 */
  private offsets: number[] = [];
  private readonly maxOffsets: number;

  constructor(maxOffsets = 31) {
    this.maxOffsets = Math.max(3, maxOffsets | 1);
  }

  setFrequency(freq: number | bigint): void {
    const value = Number(freq);
    if (Number.isFinite(value) && value > 0) this.frequency = value;
  }

  get freq(): number {
    return this.frequency;
  }

  /** 把子进程的 QPC 原始计数换算为 100ns tick。 */
  qpcToTick(qpc: number | bigint): number {
    return Math.round((Number(qpc) * 10_000_000) / this.frequency);
  }

  /** 记录一个锚点：该 QPC 对应的主进程 perfNow 时刻。 */
  observe(qpc: number | bigint, perfNow: number): void {
    const qpcValue = Number(qpc);
    if (!Number.isFinite(qpcValue) || qpcValue <= 0) return;
    this.anchorQpc = qpcValue;
    this.anchorPerf = perfNow;
    const offset = qpcValue - (perfNow * this.frequency) / 1000;
    this.offsets.push(offset);
    if (this.offsets.length > this.maxOffsets) this.offsets.shift();
  }

  get anchored(): boolean {
    return this.anchorQpc !== null;
  }

  /** 把当前 perfNow 换算为 QPC 原始计数（未锚定时返回 null）。 */
  qpcAt(perfNow: number): number | null {
    if (this.anchorQpc === null) return null;
    const median = this.medianOffset();
    if (median !== null) return perfNow * (this.frequency / 1000) + median;
    return this.anchorQpc + ((perfNow - this.anchorPerf) * this.frequency) / 1000;
  }

  /** 当前时刻的 QPC tick（未锚定时返回 0）。 */
  tickNow(perfNow: number): number {
    const qpc = this.qpcAt(perfNow);
    return qpc === null ? 0 : this.qpcToTick(qpc);
  }

  private medianOffset(): number | null {
    if (this.offsets.length < 3) return null;
    const sorted = this.offsets.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  reset(): void {
    this.anchorQpc = null;
    this.anchorPerf = 0;
    this.offsets = [];
  }
}
