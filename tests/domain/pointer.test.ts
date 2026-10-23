import { describe, expect, it } from 'vitest';
import { createPointerLookup, pointerForScene } from '../../src/domain/pointer';
import { createEmptyProject } from '../../src/domain/project';
import { evaluateScene } from '../../src/domain/scene';
import type { PointerEventLike } from '../../src/domain/types';
const S = 10_000_000;
const event = (tick: number, kind: PointerEventLike['kind'] = 'move', x = 0.4): PointerEventLike => ({ tick, kind, x, y: 0.5 });

describe('shared pointer evaluation', () => {
  it('sorts a copy, handles empty logs and rejects nonfinite events', () => {
    const events = [event(S), event(0), event(NaN)];
    const lookup = createPointerLookup(events);
    expect(lookup(-1)).toBeNull();
    expect(lookup(NaN)).toBeNull();
    expect(createPointerLookup([])(S)).toBeNull();
    expect(lookup(S)?.x).toBe(0.4);
    expect(events[0].tick).toBe(S);
  });
  it('keeps clicks across more than 96 high-frequency samples and seeks backward', () => {
    const events = [event(0, 'down', 0.2), ...Array.from({ length: 300 }, (_, i) => event((i + 1) * 10_000))];
    const lookup = createPointerLookup(events);
    expect(lookup(3_000_000)?.clickProgress).toBeCloseTo(2 / 3);
    expect(lookup(3_000_000)?.clickX).toBe(0.2);
    expect(lookup(1_000_000)?.clickProgress).toBeCloseTo(1 / 4.5);
    expect(lookup(5_000_000)?.clickProgress).toBe(0);
  });
  it('stationary sampling does not reset idle time; clicking does', () => {
    const lookup = createPointerLookup([event(0), event(S), event(2 * S), event(3 * S, 'down')]);
    expect(lookup(2 * S)?.idleTicks).toBe(2 * S);
    expect(lookup(3 * S)?.idleTicks).toBe(0);
    expect(createPointerLookup([event(0, 'move', 1.1)])(0)?.visible).toBe(false);
  });
  it('uses trimmed and sped-up source time plus calibration, and hides in gaps', () => {
    const p = createEmptyProject('p', 'pointer');
    p.tracks[0].clips.push({ id: 'c', assetId: 'a', sourceInTicks: 4 * S, sourceDurationTicks: 4 * S,
      timelineInTicks: S, rate: { num: 2, den: 1 }, linkGroupId: '' });
    p.effects.push({ id: 'cursor', kind: 'cursor', range: { start: S, end: 3 * S }, origin: 'manual', locked: false,
      parameters: { size: 26, visible: true, burnedIn: false, clickRipple: 0, timeOffsetTicks: S / 10,
        hideAfterTicks: 2 * S, style: 'dot' } });
    const lookup = (tick: number) => ({ x: tick / (10 * S), y: 0.5, visible: true, idleTicks: 2 * S });
    expect(pointerForScene(p, 0, lookup)).toBeNull();
    const pointer = pointerForScene(p, 2 * S, lookup);
    expect(pointer?.x).toBeCloseTo(0.61);
    const scene = evaluateScene(p, 2 * S, { outputWidth: 1920, outputHeight: 1080, pointer });
    expect(scene.cursor.visible).toBe(false);
    expect(scene.cursor.rippleScale).toBe(0);
    expect(scene.cursor.style).toBe('dot');
  });
});
