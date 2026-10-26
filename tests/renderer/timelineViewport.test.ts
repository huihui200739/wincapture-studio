import { describe, expect, it } from 'vitest';
import { anchoredTimelineScroll, clampTimelineZoom, timelineZoomAnchor } from '../../src/renderer/lib/timelineViewport';

describe('timeline zoom viewport', () => {
  it('放大后仍把可见播放头保持在原来的屏幕位置', () => {
    const anchor = timelineZoomAnchor(200, 800, 10, 50);
    expect(anchor).toEqual({ tick: 50, viewportX: 300 });
    expect(anchoredTimelineScroll(anchor, 20, 3000, 800)).toBe(700);
    expect(50 * 20 - 700).toBe(300);
  });

  it.each([0, 500])('播放头 %s 不在可见范围时，保留视区中心', playhead => {
    const anchor = timelineZoomAnchor(1000, 800, 10, playhead);
    expect(anchor).toEqual({ tick: 140, viewportX: 400 });
    expect(anchoredTimelineScroll(anchor, 20, 5000, 800)).toBe(2400);
  });

  it('缩小到文档边缘时不产生负滚动或越界空白', () => {
    expect(anchoredTimelineScroll({ tick: 5, viewportX: 200 }, 10, 1200, 800)).toBe(0);
    expect(anchoredTimelineScroll({ tick: 500, viewportX: 200 }, 10, 1200, 800)).toBe(400);
    expect(anchoredTimelineScroll({ tick: 50, viewportX: 200 }, 10, 600, 800)).toBe(0);
  });

  it('缩放有明确上下限，不生成小于完整时间线的无意义空白', () => {
    expect(clampTimelineZoom(0.4)).toBe(1);
    expect(clampTimelineZoom(10)).toBe(5);
    expect(clampTimelineZoom(2.25)).toBe(2.3);
    expect(clampTimelineZoom(Number.NaN)).toBe(1);
    expect(clampTimelineZoom(Infinity)).toBe(1);
  });
});
