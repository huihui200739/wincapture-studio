import { describe, expect, it } from 'vitest';
import { createEmptyProject, type ZoomParameters } from '../../src/domain/project';
import { planProjectAutoZoom, evaluateZoom } from '../../src/domain/zoom';
import { applyCommand, makeCommand, CommandHistory } from '../../src/domain/commands';
import { createPointerLookup } from '../../src/domain/pointer';
import type { PointerLog } from '../../src/domain/types';
const S = 10_000_000;
function project() {
  const p = createEmptyProject('auto', 'auto');
  p.assets.push({ id: 's', kind: 'screen', path: 'media/screen/seg-000001.mp4', hash: 'hash', durationTicks: 20 * S,
    width: 1920, height: 1080, sampleRate: 0, channels: 0, createdAt: 0 });
  p.tracks[0].clips.push({ id: 'c', assetId: 's', sourceInTicks: 0, sourceDurationTicks: 10 * S,
    timelineInTicks: 0, rate: { num: 1, den: 1 }, linkGroupId: '' });
  return p;
}
function log(): PointerLog {
  return { version: 1, sourceWidth: 1920, sourceHeight: 1080, displayScale: 1, geometryVersion: 1,
    events: [{ tick: S, kind: 'move', x: 0.3, y: 0.3 },
      { tick: 2 * S, kind: 'down', x: 0.3, y: 0.3 },
      { tick: 2.2 * S, kind: 'move', x: 0.4, y: 0.4 },
      { tick: 2.4 * S, kind: 'move', x: 0.65, y: 0.65 }],
    clicks: [{ tick: 2 * S, x: 0.3, y: 0.3 }] };
}
describe('自动运镜实际工程接入', () => {
  it('录制日志生成明显放大并跟随移动，最终回到全景', () => {
    const planned = planProjectAutoZoom(project(), log());
    const click = planned.find(e => e.range.start <= 2 * S && e.range.end > 2 * S)!;
    expect(evaluateZoom([click], 2 * S).scale).toBeGreaterThan(1.5);
    expect(evaluateZoom([click], 2.4 * S).focusX).toBeGreaterThan(evaluateZoom([click], 2 * S).focusX);
    expect(evaluateZoom(planned, 10 * S).scale).toBe(1);
  });
  it('映射裁剪、变速和重排，镜头不会超出所属视频片段', () => {
    const p = project();
    p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], sourceInTicks: S, sourceDurationTicks: 3 * S,
      timelineInTicks: 5 * S, rate: { num: 2, den: 1 } };
    const planned = planProjectAutoZoom(p, log());
    expect(planned.length).toBeGreaterThan(0);
    expect(evaluateZoom(planned, 5.5 * S).scale).toBeGreaterThan(1);
    for (const e of planned) { expect(e.range.start).toBeGreaterThanOrEqual(5 * S); expect(e.range.end).toBeLessThanOrEqual(6.5 * S); }
  });
  it('压缩后的静止鼠标仍可产生停留运镜，无日志时不虚构', () => {
    const l = log(); l.clicks = []; l.events = [l.events[0]];
    expect(planProjectAutoZoom(project(), l).length).toBeGreaterThan(0);
    l.events = []; expect(planProjectAutoZoom(project(), l)).toEqual([]);
  });
  it('重生成是一次可撤销操作，保留手动镜头和其它效果', () => {
    const p = project();
    p.effects = [{ id: 'manual', kind: 'zoom', origin: 'manual', locked: true,
      range: { start: 0, end: S }, parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 1, easeOutTicks: 1 } }];
    const h = new CommandHistory();
    const out = h.execute(p, makeCommand(p, { kind: 'RegenerateAutoZoom', planned: planProjectAutoZoom(p, log()) })).project;
    expect(out.effects).toContainEqual(p.effects[0]);
    expect(out.effects.length).toBeGreaterThan(1);
    expect(h.undo(out)?.effects).toEqual(p.effects);
  });
  it('删除和变速同步移动鼠标焦点路径', () => {
    const p = project();
    p.effects = [{ id: 'follow', kind: 'zoom', origin: 'automatic', locked: false,
      range: { start: 5 * S, end: 8 * S }, parameters: { scale: 2, focusX: 0.4, focusY: 0.4, easeInTicks: 1, easeOutTicks: 1,
        focusPath: [{ tick: 6 * S, x: 0.4, y: 0.4 }, { tick: 7 * S, x: 0.6, y: 0.6 }] } }];
    const deleted = applyCommand(p, makeCommand(p, { kind: 'DeleteRange', range: { start: S, end: 2 * S }, ripple: true })).project;
    expect((deleted.effects[0].parameters as ZoomParameters).focusPath?.[0].tick).toBe(5 * S);
    const sped = applyCommand(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'c', rate: { num: 2, den: 1 } })).project;
    expect((sped.effects[0].parameters as ZoomParameters).focusPath?.[0].tick).toBe(3 * S);
  });
  it('鼠标短间隔插值消除阶梯，不跨长停留提前移动', () => {
    const lookup = createPointerLookup([{ tick: 0, kind: 'move', x: 0.2, y: 0.2 },
      { tick: S / 20, kind: 'move', x: 0.6, y: 0.6 }, { tick: S, kind: 'move', x: 0.8, y: 0.8 }]);
    expect(lookup(S / 40)?.x).toBeCloseTo(0.4);
    expect(lookup(S / 2)?.x).toBeCloseTo(0.6);
  });
});
