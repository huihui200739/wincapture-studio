/**
 * 时间基准（开发文档 §9.2 / §13.2）
 *
 * - 全部时间以 100 纳秒整数 tick 表示，1 秒 = 10_000_000 tick。
 * - 区间统一为左闭右开 [start, end)。
 * - 不使用系统日历时钟计算工程时长，避免系统时间调整造成回跳。
 * - 帧率与播放速率使用有理数，避免长工程浮点误差。
 */

export const TICKS_PER_SECOND = 10_000_000;
export const TICKS_PER_MS = 10_000;

/** 有符号 64 位整数 tick。JS number 在 ±2^53 内精确，约等于 28.5 年，足够覆盖单工程时长。 */
export type Ticks = number;

/** 左闭右开区间 [start, end) */
export interface TickRange {
  start: Ticks;
  end: Ticks;
}

export interface Rational {
  num: number;
  den: number;
}

export const ZERO_RANGE: TickRange = Object.freeze({ start: 0, end: 0 });

export function secondsToTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: Ticks): number {
  return ticks / TICKS_PER_SECOND;
}

export function msToTicks(ms: number): Ticks {
  return Math.round(ms * TICKS_PER_MS);
}

export function ticksToMs(ticks: Ticks): number {
  return ticks / TICKS_PER_MS;
}

export function clampTicks(value: Ticks, min: Ticks, max: Ticks): Ticks {
  return value < min ? min : value > max ? max : value;
}

export function range(start: Ticks, end: Ticks): TickRange {
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function rangeLength(r: TickRange): Ticks {
  return Math.max(0, r.end - r.start);
}

export function rangeIsEmpty(r: TickRange): boolean {
  return r.end <= r.start;
}

export function rangeContains(r: TickRange, tick: Ticks): boolean {
  return tick >= r.start && tick < r.end;
}

export function rangeIntersects(a: TickRange, b: TickRange): boolean {
  // 空区间 [t,t) 与任何区间都不相交（严格左闭右开语义）
  if (rangeIsEmpty(a) || rangeIsEmpty(b)) return false;
  return a.start < b.end && b.start < a.end;
}

export function rangeIntersection(a: TickRange, b: TickRange): TickRange | null {
  if (rangeIsEmpty(a) || rangeIsEmpty(b)) return null;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/** 从 a 中减去 b，返回 0..2 段（a 可能被切成两段）。 */
export function rangeSubtract(a: TickRange, b: TickRange): TickRange[] {
  const hit = rangeIntersection(a, b);
  if (!hit) return rangeIsEmpty(a) ? [] : [a];
  const out: TickRange[] = [];
  if (hit.start > a.start) out.push({ start: a.start, end: hit.start });
  if (hit.end < a.end) out.push({ start: hit.end, end: a.end });
  return out;
}

export function rangeEquals(a: TickRange, b: TickRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** 排序并合并重叠/相邻区间。 */
export function mergeRanges(ranges: readonly TickRange[]): TickRange[] {
  const sorted = ranges.filter((r) => !rangeIsEmpty(r)).slice().sort((x, y) => x.start - y.start);
  const out: TickRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

export function totalRange(ranges: readonly TickRange[]): TickRange {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return { start: 0, end: 0 };
  return { start: merged[0].start, end: merged[merged.length - 1].end };
}

export function sumRangeLength(ranges: readonly TickRange[]): Ticks {
  return mergeRanges(ranges).reduce((acc, r) => acc + rangeLength(r), 0);
}

// ---------------------------------------------------------------------------
// 有理数
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1;
}

export function makeRational(num: number, den: number): Rational {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    throw new Error(`非法有理数 ${num}/${den}`);
  }
  const sign = den < 0 ? -1 : 1;
  const g = gcd(num, den);
  return { num: (sign * Math.round(num)) / g, den: Math.round(Math.abs(den)) / g };
}

export const ONE = Object.freeze({ num: 1, den: 1 }) as Rational;

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}

export function rationalIsOne(r: Rational): boolean {
  return r.num === r.den;
}

/** tick 值按速率换算：value / rate */
export function divideByRate(value: Ticks, rate: Rational): Ticks {
  return Math.round((value * rate.den) / rate.num);
}

/** tick 值按速率换算：value * rate */
export function multiplyByRate(value: Ticks, rate: Rational): Ticks {
  return Math.round((value * rate.num) / rate.den);
}

// ---------------------------------------------------------------------------
// 帧率
// ---------------------------------------------------------------------------

export interface FrameRate {
  num: number;
  den: number;
}

export function makeFrameRate(num: number, den = 1): FrameRate {
  const r = makeRational(num, den);
  return { num: r.num, den: r.den };
}

export function fpsToNumber(fps: FrameRate): number {
  return fps.num / fps.den;
}

/** 输出第 index 帧应求值的时间点（整数帧位置，§11.4）。 */
export function frameIndexToTicks(index: number, fps: FrameRate): Ticks {
  return Math.round((index * fps.den * TICKS_PER_SECOND) / fps.num);
}

/** 覆盖时长所需的输出总帧数，向上取整（§11.4 总帧数统一取整）。 */
export function ticksToFrameCount(duration: Ticks, fps: FrameRate): number {
  if (duration <= 0) return 0;
  return Math.ceil((duration * fps.num) / (fps.den * TICKS_PER_SECOND));
}

/**
 * 给定时间点所在的输出帧序号。
 *
 * 以 frameIndexToTicks 为唯一真值：返回最大的 i 使 frameIndexToTicks(i) <= tick。
 * 不能直接用 floor(tick * fps)，因为 frameIndexToTicks 内部按 tick 取整，
 * 30fps 下 frameIndexToTicks(1) = 333333，而 floor 公式会把它算回第 0 帧，
 * 造成「导出第 N 帧」与「预览第 N 帧」不一致（§11.5）。
 */
export function ticksToFrameIndex(tick: Ticks, fps: FrameRate): number {
  if (!Number.isFinite(tick) || tick <= 0) return 0;
  let index = Math.max(0, Math.floor((tick * fps.num) / (fps.den * TICKS_PER_SECOND)));
  while (index > 0 && frameIndexToTicks(index, fps) > tick) index -= 1;
  while (frameIndexToTicks(index + 1, fps) <= tick) index += 1;
  return index;
}

// ---------------------------------------------------------------------------
// 时间显示
// ---------------------------------------------------------------------------

function pad(value: number, width = 2): string {
  return Math.floor(Math.abs(value)).toString().padStart(width, '0');
}

/** 时间线显示：mm:ss.cc（cc 为百分秒） */
export function formatDuration(ticks: Ticks): string {
  const clamped = Math.max(0, ticks);
  const totalCs = Math.floor(ticksToMs(clamped) / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  return `${pad(min)}:${pad(sec)}.${pad(cs)}`;
}

/** 录制计时显示：HH:MM:SS */
export function formatClock(ticks: Ticks): string {
  const totalSec = Math.floor(ticksToSeconds(Math.max(0, ticks)));
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}`;
}

/** 解析 "mm:ss.cc" / "hh:mm:ss" / 纯秒数为 tick，用于输入框。 */
export function parseDuration(input: string): Ticks | null {
  const text = input.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return secondsToTicks(Number(text));
  const parts = text.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return secondsToTicks(seconds);
}

/** 把任意数字 tick 规整为整数（防止外部 JSON 传入小数）。 */
export function normalizeTicks(value: number): Ticks {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}
