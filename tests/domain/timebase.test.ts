import { describe, it, expect } from 'vitest';
import {
  TICKS_PER_SECOND,
  TICKS_PER_MS,
  ZERO_RANGE,
  secondsToTicks,
  ticksToSeconds,
  msToTicks,
  ticksToMs,
  clampTicks,
  range,
  rangeLength,
  rangeIsEmpty,
  rangeContains,
  rangeIntersects,
  rangeIntersection,
  rangeSubtract,
  rangeEquals,
  mergeRanges,
  totalRange,
  sumRangeLength,
  makeRational,
  rationalToNumber,
  rationalIsOne,
  divideByRate,
  multiplyByRate,
  makeFrameRate,
  fpsToNumber,
  frameIndexToTicks,
  ticksToFrameCount,
  ticksToFrameIndex,
  formatDuration,
  formatClock,
  parseDuration,
  normalizeTicks,
  ONE,
} from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

describe('timebase: 基本换算', () => {
  it('1 秒 = 10_000_000 tick，1 毫秒 = 10_000 tick', () => {
    expect(S).toBe(10_000_000);
    expect(TICKS_PER_MS).toBe(10_000);
    expect(secondsToTicks(1)).toBe(S);
    expect(secondsToTicks(0.5)).toBe(S / 2);
    expect(msToTicks(1)).toBe(10_000);
  });

  it('秒/tick 往返（整数秒无损）', () => {
    for (const sec of [0, 1, 2, 30, 3600]) {
      expect(ticksToSeconds(secondsToTicks(sec))).toBe(sec);
    }
  });

  it('秒转 tick 使用四舍五入，不产生浮点尾巴', () => {
    expect(secondsToTicks(0.1)).toBe(1_000_000);
    expect(secondsToTicks(0.3)).toBe(3_000_000);
    expect(Number.isInteger(secondsToTicks(1 / 3))).toBe(true);
  });

  it('ms 往返', () => {
    expect(ticksToMs(msToTicks(250))).toBe(250);
  });

  it('clampTicks 夹紧到闭区间', () => {
    expect(clampTicks(-5, 0, 10)).toBe(0);
    expect(clampTicks(15, 0, 10)).toBe(10);
    expect(clampTicks(5, 0, 10)).toBe(5);
  });

  it('normalizeTicks 把非法值规整为整数', () => {
    expect(normalizeTicks(1.6)).toBe(2);
    expect(normalizeTicks(-1.6)).toBe(-2);
    expect(normalizeTicks(NaN)).toBe(0);
    expect(normalizeTicks(Infinity)).toBe(0);
  });
});

describe('timebase: 区间 [start, end) 严格左闭右开', () => {
  it('range 规范化参数顺序', () => {
    expect(range(10, 0)).toEqual({ start: 0, end: 10 });
    expect(range(0, 10)).toEqual({ start: 0, end: 10 });
  });

  it('rangeLength 不为负', () => {
    expect(rangeLength({ start: 0, end: 10 })).toBe(10);
    expect(rangeLength({ start: 10, end: 0 })).toBe(0);
    expect(rangeLength(ZERO_RANGE)).toBe(0);
  });

  it('rangeIsEmpty：end <= start 为空', () => {
    expect(rangeIsEmpty({ start: 5, end: 5 })).toBe(true);
    expect(rangeIsEmpty({ start: 6, end: 5 })).toBe(true);
    expect(rangeIsEmpty({ start: 4, end: 5 })).toBe(false);
  });

  it('rangeContains：start 属于区间，end 不属于', () => {
    const r = { start: 100, end: 200 };
    expect(rangeContains(r, 99)).toBe(false);
    expect(rangeContains(r, 100)).toBe(true); // 左闭
    expect(rangeContains(r, 199)).toBe(true);
    expect(rangeContains(r, 200)).toBe(false); // 右开
    expect(rangeContains(r, 201)).toBe(false);
  });

  it('相邻区间不算相交（[0,10) 与 [10,20)）', () => {
    expect(rangeIntersects({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(rangeIntersection({ start: 0, end: 10 }, { start: 10, end: 20 })).toBeNull();
  });

  it('空区间与任何区间都不相交', () => {
    expect(rangeIntersects({ start: 5, end: 5 }, { start: 0, end: 10 })).toBe(false);
    expect(rangeIntersection({ start: 5, end: 5 }, { start: 0, end: 10 })).toBeNull();
  });

  it('rangeIntersection 取交集', () => {
    expect(rangeIntersection({ start: 0, end: 10 }, { start: 5, end: 20 })).toEqual({ start: 5, end: 10 });
    expect(rangeIntersection({ start: 0, end: 30 }, { start: 5, end: 20 })).toEqual({ start: 5, end: 20 });
  });

  it('rangeEquals 按值比较', () => {
    expect(rangeEquals({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true);
    expect(rangeEquals({ start: 1, end: 2 }, { start: 1, end: 3 })).toBe(false);
  });
});

describe('timebase: rangeSubtract 边界', () => {
  it('完全不相交时原样返回', () => {
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 10, end: 20 })).toEqual([{ start: 0, end: 10 }]);
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 20, end: 30 })).toEqual([{ start: 0, end: 10 }]);
  });

  it('覆盖整个区间时返回空', () => {
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 0, end: 10 })).toEqual([]);
    expect(rangeSubtract({ start: 0, end: 10 }, { start: -5, end: 15 })).toEqual([]);
  });

  it('切掉头部只保留尾段', () => {
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 0, end: 5 })).toEqual([{ start: 5, end: 10 }]);
  });

  it('切掉尾部只保留头段', () => {
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 5, end: 10 })).toEqual([{ start: 0, end: 5 }]);
  });

  it('中间挖空切成两段', () => {
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 3, end: 7 })).toEqual([
      { start: 0, end: 3 },
      { start: 7, end: 10 },
    ]);
  });

  it('单点接触（切 [5,5) 空区间）不改变区间', () => {
    expect(rangeSubtract({ start: 0, end: 10 }, { start: 5, end: 5 })).toEqual([{ start: 0, end: 10 }]);
  });

  it('左闭边界：切 [10,20) 不影响 [0,10) 的尾部', () => {
    const out = rangeSubtract({ start: 0, end: 10 }, { start: 10, end: 20 });
    expect(out).toHaveLength(1);
    expect(out[0].end).toBe(10);
  });

  it('右开边界：切 [0,10) 后 [10,20) 完整保留', () => {
    const out = rangeSubtract({ start: 10, end: 20 }, { start: 0, end: 10 });
    expect(out).toEqual([{ start: 10, end: 20 }]);
  });

  it('空区间相减返回空数组', () => {
    expect(rangeSubtract({ start: 5, end: 5 }, { start: 0, end: 10 })).toEqual([]);
  });
});

describe('timebase: mergeRanges / totalRange / sumRangeLength', () => {
  it('合并重叠区间', () => {
    expect(mergeRanges([{ start: 0, end: 5 }, { start: 3, end: 8 }])).toEqual([{ start: 0, end: 8 }]);
  });

  it('合并相邻区间（[0,5) + [5,10) → [0,10)）', () => {
    expect(mergeRanges([{ start: 0, end: 5 }, { start: 5, end: 10 }])).toEqual([{ start: 0, end: 10 }]);
  });

  it('相邻但不重叠的语义：mergeRanges 会合并相邻，rangeIntersects 不会', () => {
    const a = { start: 0, end: 5 };
    const b = { start: 5, end: 10 };
    expect(rangeIntersects(a, b)).toBe(false);
    expect(mergeRanges([a, b])).toHaveLength(1);
  });

  it('保留不相邻的多个区间并排序', () => {
    const out = mergeRanges([{ start: 20, end: 30 }, { start: 0, end: 5 }]);
    expect(out).toEqual([
      { start: 0, end: 5 },
      { start: 20, end: 30 },
    ]);
  });

  it('过滤空区间', () => {
    expect(mergeRanges([{ start: 5, end: 5 }, { start: 0, end: 3 }])).toEqual([{ start: 0, end: 3 }]);
  });

  it('不修改输入数组', () => {
    const input = [{ start: 0, end: 5 }, { start: 3, end: 8 }];
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeRanges(input);
    expect(input).toEqual(snapshot);
  });

  it('totalRange 取合并后的首尾', () => {
    expect(totalRange([{ start: 5, end: 10 }, { start: 0, end: 3 }])).toEqual({ start: 0, end: 10 });
    expect(totalRange([])).toEqual({ start: 0, end: 0 });
  });

  it('sumRangeLength 先合并再求和，不重复计数', () => {
    expect(sumRangeLength([{ start: 0, end: 5 }, { start: 3, end: 8 }])).toBe(8);
    expect(sumRangeLength([{ start: 0, end: 5 }, { start: 5, end: 10 }])).toBe(10);
  });
});

describe('timebase: 有理数', () => {
  it('约分到最简', () => {
    expect(makeRational(30, 60)).toEqual({ num: 1, den: 2 });
    expect(makeRational(60, 30)).toEqual({ num: 2, den: 1 });
    expect(makeRational(100, 1)).toEqual({ num: 100, den: 1 });
  });

  it('负分母翻转到分子', () => {
    expect(makeRational(1, -2)).toEqual({ num: -1, den: 2 });
  });

  it('非法有理数抛错', () => {
    expect(() => makeRational(1, 0)).toThrow();
    expect(() => makeRational(NaN, 1)).toThrow();
    expect(() => makeRational(1, Infinity)).toThrow();
  });

  it('rationalToNumber / rationalIsOne', () => {
    expect(rationalToNumber({ num: 1, den: 2 })).toBe(0.5);
    expect(rationalIsOne(ONE)).toBe(true);
    expect(rationalIsOne({ num: 2, den: 1 })).toBe(false);
  });

  it('divideByRate 与 multiplyByRate 互逆（整数可整除时）', () => {
    const half = makeRational(1, 2); // 0.5 倍速
    expect(divideByRate(1000, half)).toBe(2000); // 时长变 2 倍
    expect(multiplyByRate(2000, half)).toBe(1000);
  });

  it('divideByRate 使用四舍五入保持整数 tick', () => {
    const rate = makeRational(1, 3);
    const out = divideByRate(100, rate);
    expect(Number.isInteger(out)).toBe(true);
    expect(out).toBe(300);
  });
});

describe('timebase: 帧率换算', () => {
  it('30fps：每帧 333333 tick（四舍五入）', () => {
    expect(frameIndexToTicks(0, makeFrameRate(30, 1))).toBe(0);
    expect(frameIndexToTicks(1, makeFrameRate(30, 1))).toBe(333_333);
    expect(frameIndexToTicks(30, makeFrameRate(30, 1))).toBe(S);
  });

  it('60fps：每帧 166667 tick', () => {
    expect(frameIndexToTicks(1, makeFrameRate(60, 1))).toBe(166_667);
    expect(frameIndexToTicks(60, makeFrameRate(60, 1))).toBe(S);
  });

  it('29.97fps（30000/1001）长工程不累积明显误差', () => {
    const fps = makeFrameRate(30000, 1001);
    const ticks = frameIndexToTicks(30000, fps);
    // 30000 帧 = 1001 秒
    expect(Math.abs(ticks - 1001 * S)).toBeLessThanOrEqual(1);
  });

  it('ticksToFrameCount 向上取整', () => {
    expect(ticksToFrameCount(0, makeFrameRate(30, 1))).toBe(0);
    expect(ticksToFrameCount(-5, makeFrameRate(30, 1))).toBe(0);
    expect(ticksToFrameCount(S, makeFrameRate(30, 1))).toBe(30);
    expect(ticksToFrameCount(S + 1, makeFrameRate(30, 1))).toBe(31);
    expect(ticksToFrameCount(S / 2, makeFrameRate(30, 1))).toBe(15);
  });

  it('ticksToFrameIndex 向下取整', () => {
    const fps = makeFrameRate(30, 1);
    expect(ticksToFrameIndex(0, fps)).toBe(0);
    expect(ticksToFrameIndex(333_332, fps)).toBe(0);
    expect(ticksToFrameIndex(333_333, fps)).toBe(1);
    expect(ticksToFrameIndex(S, fps)).toBe(30);
  });

  it('帧序号 → tick → 帧序号 在帧边界上稳定', () => {
    const fps = makeFrameRate(30, 1);
    for (const index of [0, 1, 2, 29, 30, 31, 299, 300]) {
      expect(ticksToFrameIndex(frameIndexToTicks(index, fps), fps)).toBe(index);
    }
  });

  it('fpsToNumber', () => {
    expect(fpsToNumber(makeFrameRate(30, 1))).toBe(30);
    expect(fpsToNumber(makeFrameRate(30000, 1001))).toBeCloseTo(29.97002997, 6);
  });

  it('makeFrameRate 约分', () => {
    expect(makeFrameRate(60, 2)).toEqual({ num: 30, den: 1 });
  });
});

describe('timebase: 时间显示与解析', () => {
  it('formatDuration 为 mm:ss.cc', () => {
    expect(formatDuration(0)).toBe('00:00.00');
    expect(formatDuration(S)).toBe('00:01.00');
    expect(formatDuration(S * 61.5)).toBe('01:01.50');
    expect(formatDuration(S * 3600)).toBe('60:00.00');
  });

  it('formatDuration 对负数夹紧为 0', () => {
    expect(formatDuration(-S)).toBe('00:00.00');
  });

  it('formatClock 为 HH:MM:SS', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(S * 59)).toBe('00:00:59');
    expect(formatClock(S * 3600 + S * 61)).toBe('01:01:01');
  });

  it('parseDuration 支持纯秒数、mm:ss、hh:mm:ss', () => {
    expect(parseDuration('1.5')).toBe(secondsToTicks(1.5));
    expect(parseDuration('01:30')).toBe(secondsToTicks(90));
    expect(parseDuration('01:01:01')).toBe(secondsToTicks(3661));
    expect(parseDuration('  2  ')).toBe(secondsToTicks(2));
  });

  it('parseDuration 非法输入返回 null', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('1:2:3:4')).toBeNull();
    expect(parseDuration('1:xx')).toBeNull();
  });

  it('formatDuration 与 parseDuration 往返（百分秒精度）', () => {
    const ticks = secondsToTicks(83.47);
    const text = formatDuration(ticks);
    const back = parseDuration(text);
    expect(back).not.toBeNull();
    expect(Math.abs((back as number) - ticks)).toBeLessThanOrEqual(TICKS_PER_MS * 10);
  });
});

// ---------------------------------------------------------------------------
// 回归：非法有理数与非法时长的边界
// ---------------------------------------------------------------------------

describe('回归：makeRational 不得返回 den = 0', () => {
  it('分母舍入为 0 的小数输入抛错，而不是返回非法有理数', () => {
    // 旧实现：gcd 用舍入后的值、分子用原始值，0.5/0.25 → { num: 1, den: 0 }
    expect(() => makeRational(0.5, 0.25)).toThrow();
    expect(() => makeRational(1, 0.4)).toThrow();
  });

  it('正常整数与负分母仍正确约分', () => {
    expect(makeRational(-1, -2)).toEqual({ num: 1, den: 2 });
    expect(makeRational(3, -6)).toEqual({ num: -1, den: 2 });
  });
});

describe('回归：ticksToFrameCount 对非法输入返回 0', () => {
  it('NaN / Infinity 时长不会把总帧数变成 NaN', () => {
    const fps = makeFrameRate(30, 1);
    expect(ticksToFrameCount(NaN, fps)).toBe(0);
    expect(ticksToFrameCount(Infinity, fps)).toBe(0);
    expect(ticksToFrameCount(S, { num: 0, den: 0 })).toBe(0);
    expect(ticksToFrameCount(S, { num: NaN, den: 1 })).toBe(0);
  });
});
