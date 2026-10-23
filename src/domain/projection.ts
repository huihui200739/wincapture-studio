import type { Effect, ZoomParameters } from './project';
import type { FrameScene } from './scene';

export interface ScreenMotion { rotateX: number; rotateY: number; rotateZ: number; perspective: number }
export interface Point { x: number; y: number }
const safe = (v: number | undefined, fallback = 0) => Number.isFinite(v) ? v! : fallback;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Use the same deterministic winner and smooth transition as the zoom curve. */
export function evaluateMotion(effects: readonly Effect[], tick: number): ScreenMotion {
  let winner: Effect | undefined;
  let weight = 0;
  let scale = -Infinity;
  for (const effect of effects) {
    if (effect.kind !== 'zoom' || tick < effect.range.start || tick >= effect.range.end) continue;
    const p = effect.parameters as ZoomParameters;
    const smooth = (v: number) => { const k = clamp(v, 0, 1); return k * k * (3 - 2 * k); };
    const k = Math.min(smooth(p.easeInTicks > 0 ? (tick - effect.range.start) / p.easeInTicks : 1),
      smooth(p.easeOutTicks > 0 ? (effect.range.end - tick) / p.easeOutTicks : 1));
    const current = 1 + (Math.max(1, safe(p.scale, 1)) - 1) * k;
    if (current > scale + 1e-9 || (Math.abs(current - scale) <= 1e-9 && (!winner || effect.id < winner.id))) {
      winner = effect; scale = current; weight = k;
    }
  }
  const p = winner?.parameters as ZoomParameters | undefined;
  return { rotateX: clamp(safe(p?.rotateX), -45, 45) * weight,
    rotateY: clamp(safe(p?.rotateY), -45, 45) * weight,
    rotateZ: clamp(safe(p?.rotateZ), -45, 45) * weight,
    perspective: clamp(safe(p?.perspective, 2), 1, 5) };
}

export function hasMotion(scene: FrameScene): boolean {
  const m = scene.screenMotion;
  return !!m && Math.abs(m.rotateX) + Math.abs(m.rotateY) + Math.abs(m.rotateZ) > 1e-6;
}

/** Homography of a rotated z=0 screen plane, in output pixel coordinates. */
function geometry(scene: FrameScene) {
  const m = scene.screenMotion ?? { rotateX: 0, rotateY: 0, rotateZ: 0, perspective: 2 };
  const rad = Math.PI / 180;
  const x = m.rotateX * rad, y = m.rotateY * rad, z = m.rotateZ * rad;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return { a: cz * cy, b: cz * sy * sx - sz * cx,
    c: sz * cy, d: sz * sy * sx + cz * cx,
    e: -sy, f: cy * sx,
    distance: Math.max(scene.outputWidth, scene.outputHeight) * m.perspective,
    ox: (scene.screenRect.x + scene.screenRect.width / 2) * scene.outputWidth,
    oy: (scene.screenRect.y + scene.screenRect.height / 2) * scene.outputHeight };
}

export function projectScreenPoint(scene: FrameScene, point: Point): Point {
  if (!hasMotion(scene)) return point;
  const g = geometry(scene), x = point.x - g.ox, y = point.y - g.oy;
  const w = 1 - (g.e * x + g.f * y) / g.distance;
  return { x: g.ox + (g.a * x + g.b * y) / w, y: g.oy + (g.c * x + g.d * y) / w };
}

/** Homogeneous weight, used for perspective-correct GPU texture interpolation. */
export function screenProjectionWeight(scene: FrameScene, point: Point): number {
  if (!hasMotion(scene)) return 1;
  const g = geometry(scene);
  return 1 - (g.e * (point.x - g.ox) + g.f * (point.y - g.oy)) / g.distance;
}

export function unprojectScreenPoint(scene: FrameScene, point: Point): Point {
  if (!hasMotion(scene)) return point;
  const g = geometry(scene), u = point.x - g.ox, v = point.y - g.oy;
  const a = g.a + u * g.e / g.distance, b = g.b + u * g.f / g.distance;
  const c = g.c + v * g.e / g.distance, d = g.d + v * g.f / g.distance;
  const det = a * d - b * c;
  return { x: g.ox + (u * d - b * v) / det, y: g.oy + (a * v - u * c) / det };
}

export function mapRectBounds(rect: { x: number; y: number; width: number; height: number }, map: (p: Point) => Point) {
  const points = [map(rect), map({ x: rect.x + rect.width, y: rect.y }),
    map({ x: rect.x, y: rect.y + rect.height }), map({ x: rect.x + rect.width, y: rect.y + rect.height })];
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
}
