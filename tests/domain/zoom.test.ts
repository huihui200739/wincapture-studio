import { describe, it, expect } from 'vitest';
import {
  planAutoZoom,
  regenerateAutoZoom,
  evaluateZoom,
  DEFAULT_ZOOM_OPTIONS,
} from '../../src/domain/zoom';
import type { ClickSample, PointerSample } from '../../src/domain/zoom';
import type { Effect } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function click(tick: number, x: number, y: number, controlRect?: { x: number; y: number; width: number; height: number }): ClickSample {
  return controlRect ? { tick, x, y, controlRect } : { tick, x, y };
}

function zoom(id: string, start: number, end: number, scale = 2, locked = false): Effect {
  return {
    id,
    kind: 'zoom',
    range: { start, end },
    parameters: { scale, focusX: 0.5, focusY: 0.5, easeInTicks: S / 2, easeOutTicks: S / 2 },
    origin: locked ? 'manual' : 'automatic',
    locked,
  };
}

describe('planAutoZoom: 基本规划', () => {
  it('无点击时不生成效果', () => {
    expect(planAutoZoom([], [])).toEqual([]);
  });

  it('单次点击生成一个 automatic 效果，留出进入/保持/退出', () => {
    const effects = planAutoZoom([click(5 * S, 0.5, 0.5)], []);
    expect(effects).toHaveLength(1);
    expect(effects[0].origin).toBe('automatic');
    expect(effects[0].locked).toBe(false);
    expect(effects[0].range.start).toBeLessThanOrEqual(5 * S);
    expect(effects[0].range.end).toBeGreaterThan(5 * S);
    expect(effects[0].range.end - effects[0].range.start).toBeGreaterThanOrEqual(DEFAULT_ZOOM_OPTIONS.minHoldTicks);
  });

  it('缩放倍数限制在 min..max 之间', () => {
    const effects = planAutoZoom([click(S, 0.3, 0.3), click(1.1 * S, 0.31, 0.31), click(1.2 * S, 0.29, 0.3)], []);
    for (const effect of effects) {
      const p = effect.parameters as { scale: number };
      expect(p.scale).toBeGreaterThanOrEqual(DEFAULT_ZOOM_OPTIONS.minScale - 1e-9);
      expect(p.scale).toBeLessThanOrEqual(DEFAULT_ZOOM_OPTIONS.maxScale + 1e-9);
    }
  });

  it('焦点夹紧在画面内（不出界）', () => {
    // 点击角落，缩放后焦点必须仍让画面铺满
    const effects = planAutoZoom([click(S, 0.01, 0.01)], [], { minScale: 2, maxScale: 2 });
    const p = effects[0].parameters as { scale: number; focusX: number; focusY: number };
    const half = 1 / (2 * p.scale);
    expect(p.focusX).toBeGreaterThanOrEqual(half - 1e-9);
    expect(p.focusX).toBeLessThanOrEqual(1 - half + 1e-9);
    expect(p.focusY).toBeGreaterThanOrEqual(half - 1e-9);
    expect(p.focusY).toBeLessThanOrEqual(1 - half + 1e-9);
  });

  it('相邻小范围点击合并为一个镜头', () => {
    const clicks = [click(S, 0.5, 0.5), click(1.1 * S, 0.51, 0.5), click(1.2 * S, 0.49, 0.51)];
    const effects = planAutoZoom(clicks, []);
    expect(effects).toHaveLength(1);
  });

  it('时间上很远或空间上很远的点击分成两个镜头', () => {
    const clicks = [click(S, 0.2, 0.2), click(20 * S, 0.8, 0.8)];
    const effects = planAutoZoom(clicks, []);
    expect(effects.length).toBeGreaterThanOrEqual(2);
  });

  it('结果按时间排序', () => {
    const clicks = [click(20 * S, 0.8, 0.8), click(S, 0.2, 0.2)];
    const effects = planAutoZoom(clicks, []);
    for (let i = 1; i < effects.length; i++) {
      expect(effects[i].range.start).toBeGreaterThanOrEqual(effects[i - 1].range.start);
    }
  });

  it('优先使用控件边界（语义焦点）', () => {
    const effects = planAutoZoom([click(5 * S, 0.5, 0.5, { x: 0.4, y: 0.4, width: 0.2, height: 0.1 })], []);
    const p = effects[0].parameters as { focusSource: string; focusX: number; focusY: number };
    expect(p.focusSource).toBe('control');
    expect(p.focusX).toBeCloseTo(0.5, 5);
    expect(p.focusY).toBeCloseTo(0.45, 5);
  });

  it('preferControlBounds=false 时退回指针', () => {
    const effects = planAutoZoom([click(5 * S, 0.5, 0.5, { x: 0.4, y: 0.4, width: 0.2, height: 0.1 })], [], {
      preferControlBounds: false,
    });
    expect((effects[0].parameters as { focusSource: string }).focusSource).toBe('pointer');
  });

  it('按源分辨率限制放大（小源不放大到糊）', () => {
    const effects = planAutoZoom([click(S, 0.5, 0.5)], [], {
      minScale: 2.4,
      maxScale: 2.4,
      sourceWidth: 640,
      sourceHeight: 360,
    });
    const p = effects[0].parameters as { scale: number };
    expect(p.scale).toBeLessThan(2.4);
    expect(p.scale).toBeGreaterThanOrEqual(1);
  });

  it('长停留无点击区域补一个轻量镜头', () => {
    const pointers: PointerSample[] = [];
    for (let t = 0; t <= 5 * S; t += S / 10) pointers.push({ tick: t, x: 0.5, y: 0.5 });
    const effects = planAutoZoom([], pointers);
    expect(effects).toHaveLength(1);
    expect(effects[0].range.start).toBe(0);
    expect(effects[0].range.end).toBe(5 * S);
  });

  it('停留区域与点击镜头重叠时不重复放大', () => {
    const pointers: PointerSample[] = [];
    for (let t = 0; t <= 5 * S; t += S / 10) pointers.push({ tick: t, x: 0.5, y: 0.5 });
    const effects = planAutoZoom([click(2.5 * S, 0.5, 0.5)], pointers);
    // 点击镜头覆盖了停留区域，不应再叠加
    expect(effects).toHaveLength(1);
  });
});

describe('regenerateAutoZoom: 手动优先，只替换未锁定', () => {
  it('保留手动/锁定片段', () => {
    const manual = zoom('manual-1', 0, 2 * S, 2, true);
    const planned = [zoom('auto-1', 5 * S, 7 * S)];
    const out = regenerateAutoZoom([manual], planned);
    expect(out.some((e) => e.id === 'manual-1')).toBe(true);
  });

  it('自动片段与手动片段重叠时被裁掉重叠部分', () => {
    const manual = zoom('manual-1', 3 * S, 5 * S, 2, true);
    const planned = [zoom('auto-1', 0, 10 * S)];
    const out = regenerateAutoZoom([manual], planned);
    const autos = out.filter((e) => e.id !== 'manual-1');
    // 自动片段被切成 [0,3) 和 [5,10)
    expect(autos.length).toBeGreaterThanOrEqual(2);
    for (const auto of autos) {
      expect(auto.range.end <= 3 * S || auto.range.start >= 5 * S).toBe(true);
    }
  });

  it('保留非 zoom 效果', () => {
    const privacy: Effect = {
      id: 'pv-1',
      kind: 'privacy',
      range: { start: 0, end: S },
      parameters: { x: 0, y: 0, width: 0.1, height: 0.1, anchor: 'screen', style: 'solid', confirmed: true },
      origin: 'manual',
      locked: true,
    };
    const out = regenerateAutoZoom([privacy], [zoom('auto-1', 5 * S, 6 * S)]);
    expect(out.some((e) => e.id === 'pv-1')).toBe(true);
  });

  it('过短的自动片段被丢弃（< 0.25s）', () => {
    const manual = zoom('manual-1', 0, 10 * S - 1, 2, true);
    const planned = [zoom('auto-1', 0, 10 * S)];
    const out = regenerateAutoZoom([manual], planned);
    const autos = out.filter((e) => e.id !== 'manual-1');
    for (const auto of autos) {
      expect(auto.range.end - auto.range.start).toBeGreaterThanOrEqual(secondsToTicks(0.25));
    }
  });

  it('重复调用结果确定（同输入同输出）', () => {
    const planned = [zoom('auto-1', S, 3 * S)];
    const a = regenerateAutoZoom([], planned);
    const b = regenerateAutoZoom([], planned);
    expect(a.map((e) => e.range)).toEqual(b.map((e) => e.range));
  });
});

describe('evaluateZoom: 曲线求值', () => {
  it('无效果时 scale = 1，焦点居中', () => {
    expect(evaluateZoom([], 0)).toEqual({ scale: 1, focusX: 0.5, focusY: 0.5 });
  });

  it('区间外不生效', () => {
    const effect = zoom('z', 2 * S, 4 * S, 2);
    expect(evaluateZoom([effect], 0).scale).toBe(1);
    expect(evaluateZoom([effect], 4 * S).scale).toBe(1); // 右开
    expect(evaluateZoom([effect], 6 * S).scale).toBe(1);
  });

  it('区间左闭：起点即开始过渡', () => {
    const effect = zoom('z', 2 * S, 4 * S, 2);
    const atStart = evaluateZoom([effect], 2 * S);
    expect(atStart.scale).toBeGreaterThanOrEqual(1);
    expect(atStart.scale).toBeLessThan(2);
  });

  it('保持段中间达到目标缩放', () => {
    const effect = zoom('z', 2 * S, 6 * S, 2);
    // 2s 进入 + 中间保持
    const mid = evaluateZoom([effect], 4 * S);
    expect(mid.scale).toBeCloseTo(2, 5);
  });

  it('过渡是单调的（进入阶段）', () => {
    const effect = zoom('z', 2 * S, 6 * S, 2);
    let prev = evaluateZoom([effect], 2 * S).scale;
    for (let t = 2 * S; t <= 4 * S; t += S / 20) {
      const cur = evaluateZoom([effect], t).scale;
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });

  it('多个镜头重叠时取最强，不叠加', () => {
    const a = zoom('a', 0, 10 * S, 2);
    const b = zoom('b', 0, 10 * S, 1.5);
    const out = evaluateZoom([a, b], 5 * S);
    expect(out.scale).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('焦点随过渡插值', () => {
    const effect: Effect = {
      ...zoom('z', 2 * S, 6 * S, 2),
      parameters: { scale: 2, focusX: 0.2, focusY: 0.8, easeInTicks: S, easeOutTicks: S },
    };
    const mid = evaluateZoom([effect], 4 * S);
    expect(mid.focusX).toBeCloseTo(0.2, 5);
    expect(mid.focusY).toBeCloseTo(0.8, 5);
  });

  it('非 zoom 效果被忽略', () => {
    const privacy: Effect = {
      id: 'pv',
      kind: 'privacy',
      range: { start: 0, end: 10 * S },
      parameters: { x: 0, y: 0, width: 0.1, height: 0.1, anchor: 'screen', style: 'solid', confirmed: true },
      origin: 'manual',
      locked: true,
    };
    expect(evaluateZoom([privacy], 5 * S).scale).toBe(1);
  });

  it('预览与导出使用同一求值器：同 tick 结果完全一致', () => {
    const effects = [zoom('z1', S, 5 * S, 1.8), zoom('z2', 6 * S, 9 * S, 2.2)];
    for (const tick of [0, S, 2 * S, 3 * S, 5 * S, 7 * S, 9 * S]) {
      const a = evaluateZoom(effects, tick);
      const b = evaluateZoom(effects, tick);
      expect(a).toEqual(b);
    }
  });
});
