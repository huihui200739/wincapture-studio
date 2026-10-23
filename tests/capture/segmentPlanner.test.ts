import { describe, it, expect } from 'vitest';
import { SegmentGrid } from '../../electron/capture/segmentPlanner';
import { secondsToTicks } from '../../src/domain/timebase';

const TARGET = secondsToTicks(1.6);
const FRAME = Math.round(secondsToTicks(1) / 30);

function feed(grid: SegmentGrid, fromTick: number, toTick: number, step = FRAME) {
  const slices = [] as { startTick: number; durationTicks: number }[];
  for (let tick = fromTick; tick <= toTick; tick += step) {
    const slice = grid.observe(tick);
    if (slice) slices.push(slice);
  }
  return slices;
}

describe('SegmentGrid: 正常切段', () => {
  it('首帧只建立原点，不切段', () => {
    const grid = new SegmentGrid(TARGET);
    expect(grid.observe(100)).toBeNull();
    expect(grid.initialized).toBe(true);
    expect(grid.nextStartTick).toBe(100);
    expect(grid.nextBoundaryTick).toBe(100 + TARGET);
  });

  it('段与段首尾相接、互不重叠，时长严格等于栅格步长', () => {
    const grid = new SegmentGrid(TARGET);
    const slices = feed(grid, 0, secondsToTicks(10));
    expect(slices.length).toBe(6); // 1.6s × 6 = 9.6s
    expect(slices[0].startTick).toBe(0);
    for (const slice of slices) expect(slice.durationTicks).toBe(TARGET);
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].startTick).toBe(slices[i - 1].startTick + slices[i - 1].durationTicks);
    }
  });

  it('栅格原点跟随首帧（首帧不在 0 时第 0 段从首帧开始）', () => {
    const grid = new SegmentGrid(TARGET);
    const slices = feed(grid, 500_000, 500_000 + secondsToTicks(3));
    expect(slices[0].startTick).toBe(500_000);
  });

  it('正好越过边界的那一帧触发切段，边界前的帧不触发', () => {
    const grid = new SegmentGrid(TARGET);
    grid.observe(0);
    expect(grid.observe(TARGET - 1)).toBeNull();
    const slice = grid.observe(TARGET);
    expect(slice).toEqual({ startTick: 0, durationTicks: TARGET });
  });
});

describe('SegmentGrid: 暂停/停止处的 flush', () => {
  it('flush 出短段后从真实结束时刻重新起栅格，下一段不会重叠（暂停恢复场景）', () => {
    const grid = new SegmentGrid(TARGET);
    // 录到 1.0s 时暂停
    grid.observe(0);
    grid.observe(secondsToTicks(0.5));
    grid.observe(secondsToTicks(1.0));
    const partial = grid.flush(secondsToTicks(1.0), FRAME);
    expect(partial.startTick).toBe(0);
    expect(partial.durationTicks).toBe(secondsToTicks(1.0) + FRAME);

    // 恢复后继续到 3s：下一段必须从 partial 的结束处开始
    const later = feed(grid, secondsToTicks(1.0), secondsToTicks(3.0));
    expect(later.length).toBeGreaterThanOrEqual(1);
    expect(later[0].startTick).toBe(partial.startTick + partial.durationTicks);
    expect(later[0].startTick).toBeGreaterThanOrEqual(partial.startTick + partial.durationTicks);
  });

  it('flush 时长覆盖到末帧之后一个帧间隔，末帧自身占满一帧', () => {
    const grid = new SegmentGrid(TARGET);
    grid.observe(0);
    const slice = grid.flush(FRAME * 10, FRAME);
    expect(slice.durationTicks).toBe(FRAME * 11);
  });

  it('可选的真实结束时刻会把短段延长到暂停/停止边界（保住末段音频）', () => {
    const grid = new SegmentGrid(TARGET);
    grid.observe(0);
    const slice = grid.flush(FRAME * 10, FRAME, FRAME * 20);
    expect(slice.durationTicks).toBe(FRAME * 20);
    expect(grid.nextStartTick).toBe(FRAME * 20);
  });

  it('尚未初始化时 flush 以末帧为起点、至少一个帧间隔', () => {
    const grid = new SegmentGrid(TARGET);
    const slice = grid.flush(12345, 0);
    expect(slice.startTick).toBe(12345);
    expect(slice.durationTicks).toBe(1);
  });

  it('连续两次 flush 的段也首尾相接（停止前的兜底调用）', () => {
    const grid = new SegmentGrid(TARGET);
    grid.observe(0);
    const first = grid.flush(secondsToTicks(0.5), FRAME);
    const second = grid.flush(secondsToTicks(0.9), FRAME);
    expect(second.startTick).toBe(first.startTick + first.durationTicks);
  });
});

describe('SegmentGrid: 长卡顿', () => {
  it('一帧跨过多个栅格时跳过空区间，不把空白压进下一段', () => {
    const grid = new SegmentGrid(TARGET);
    grid.observe(0);
    // 采集端卡了 5 秒后突然来一帧
    const slice = grid.observe(secondsToTicks(5));
    expect(slice).toEqual({ startTick: 0, durationTicks: TARGET });
    // 下一段起点跳到 4.8s（最后一个小于 5s 的栅格点），不是 1.6s
    expect(grid.nextStartTick).toBe(secondsToTicks(4.8));
    expect(grid.nextBoundaryTick).toBe(secondsToTicks(6.4));

    const next = grid.observe(secondsToTicks(6.5));
    expect(next?.startTick).toBe(secondsToTicks(4.8));
  });

  it('reset 后重新从首帧建立栅格（新会话）', () => {
    const grid = new SegmentGrid(TARGET);
    grid.observe(0);
    grid.observe(TARGET);
    grid.reset();
    expect(grid.initialized).toBe(false);
    expect(grid.observe(777)).toBeNull();
    expect(grid.nextStartTick).toBe(777);
  });

  it('非法目标时长直接抛错（防止配置错误产生 0 长段）', () => {
    expect(() => new SegmentGrid(0)).toThrow();
    expect(() => new SegmentGrid(Number.NaN)).toThrow();
  });
});
