import { describe, it, expect } from 'vitest';
import { evaluateMotion, projectScreenPoint, unprojectScreenPoint } from '../../src/domain/projection';
import { evaluateScene } from '../../src/domain/scene';
import { createEmptyProject, type Effect } from '../../src/domain/project';

const effect: Effect = { id: '3d', kind: 'zoom', range: { start: 0, end: 1000 }, origin: 'manual', locked: true,
  parameters: { scale: 1, focusX: 0.5, focusY: 0.5, easeInTicks: 100, easeOutTicks: 100,
    rotateX: 25, rotateY: -35, rotateZ: 12, perspective: 1 } };
describe('3D screen projection', () => {
  it('eases in, holds and eases out, and leaves older projects flat', () => {
    expect(evaluateMotion([effect], 0).rotateX).toBe(0);
    expect(evaluateMotion([effect], 50).rotateX).toBeCloseTo(12.5);
    expect(evaluateMotion([effect], 500).rotateX).toBe(25);
    expect(evaluateMotion([effect], 950).rotateX).toBeCloseTo(12.5);
    expect(evaluateMotion([effect], 1000).rotateX).toBe(0);
    expect(evaluateMotion([], 500).rotateY).toBe(0);
  });
  it.each([[1920, 1080], [1080, 1920], [1080, 1080]])('inverse is stable for %i × %i', (w, h) => {
    const p = createEmptyProject('p', 'projection'); p.effects.push(effect);
    const scene = evaluateScene(p, 500, { outputWidth: w, outputHeight: h });
    for (const point of [{ x: 0, y: 0 }, { x: w, y: h }, { x: w / 3, y: h / 4 }]) {
      const projected = projectScreenPoint(scene, point);
      const back = unprojectScreenPoint(scene, projected);
      expect(back.x).toBeCloseTo(point.x, 8); expect(back.y).toBeCloseTo(point.y, 8);
    }
    expect(projectScreenPoint(scene, { x: 0, y: 0 })).not.toEqual({ x: 0, y: 0 });
  });
  it('resolves overlapping effects independently of array order and rejects nonfinite values', () => {
    const other: Effect = { ...effect, id: '0', parameters: { ...effect.parameters, rotateX: -10 } };
    expect(evaluateMotion([other, effect], 500)).toEqual(evaluateMotion([effect, other], 500));
    expect(evaluateMotion([other, effect], 500).rotateX).toBe(-10);
    expect(evaluateMotion([{ ...effect, parameters: { ...effect.parameters, rotateX: NaN, perspective: Infinity } }], 500))
      .toMatchObject({ rotateX: 0, perspective: 2 });
  });
});
