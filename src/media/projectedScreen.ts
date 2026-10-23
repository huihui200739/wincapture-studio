import type { FrameScene } from '../domain/scene';
import { projectScreenPoint, type Point } from '../domain/projection';
import { projectGpuSurface } from './perspectiveGpu';
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const layers = new WeakMap<Context, OffscreenCanvas>();
const projectedLayers = new WeakMap<OffscreenCanvas, OffscreenCanvas>();
export function screenLayer(ctx: Context, width: number, height: number): OffscreenCanvas {
  let layer = layers.get(ctx);
  if (!layer || layer.width !== width || layer.height !== height) {
    layer = new OffscreenCanvas(width, height); layers.set(ctx, layer);
  }
  layer.getContext('2d')!.clearRect(0, 0, width, height);
  return layer;
}

/** Piecewise affine textured mesh approximates perspective in the shared 2D renderer. */
export function drawProjectedScreen(ctx: Context, layer: OffscreenCanvas, scene: FrameScene): void {
  const gpu = projectGpuSurface(layer, scene);
  if (gpu) { ctx.drawImage(gpu, 0, 0); return; }
  const destination = ctx;
  let projected = projectedLayers.get(layer);
  if (!projected || projected.width !== layer.width || projected.height !== layer.height) {
    projected = new OffscreenCanvas(layer.width, layer.height); projectedLayers.set(layer, projected);
  }
  // Software rasterization is also used when WebGL is unavailable. GPU Canvas2D
  // copy+clip has different edge coverage and can leave dark triangle boundaries.
  ctx = projected.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, projected.width, projected.height);
  ctx.save();
  // Raster overlaps must replace alpha, not accumulate it. Otherwise the
  // translucent shadow becomes darker along every triangle boundary.
  ctx.globalCompositeOperation = 'copy';
  const triangle = (a: Point, b: Point, c: Point) => {
    const A = projectScreenPoint(scene, a), B = projectScreenPoint(scene, b), C = projectScreenPoint(scene, c);
    const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    const xx = ((B.x - A.x) * (c.y - a.y) - (C.x - A.x) * (b.y - a.y)) / det;
    const xy = ((C.x - A.x) * (b.x - a.x) - (B.x - A.x) * (c.x - a.x)) / det;
    const yx = ((B.y - A.y) * (c.y - a.y) - (C.y - A.y) * (b.y - a.y)) / det;
    const yy = ((C.y - A.y) * (b.x - a.x) - (B.y - A.y) * (c.x - a.x)) / det;
    ctx.save();
    // Slightly overlap the raster clip to avoid transparent antialiasing seams.
    const ox = (A.x + B.x + C.x) / 3, oy = (A.y + B.y + C.y) / 3;
    // Expanding each vertex by a fixed radial distance barely moves the long
    // diagonal edge of a thin triangle. Expand by its altitude instead so every
    // raster edge overlaps by at least one output pixel, including white fills.
    const area2 = Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y));
    const longest = Math.max(Math.hypot(B.x - A.x, B.y - A.y), Math.hypot(C.x - A.x, C.y - A.y), Math.hypot(C.x - B.x, C.y - B.y));
    const factor = 1 + 1.1 / Math.max(0.01, area2 / (3 * longest));
    const expand = (p: Point) => ({ x: ox + (p.x - ox) * factor, y: oy + (p.y - oy) * factor });
    const aa = expand(A), bb = expand(B), cc = expand(C);
    ctx.beginPath(); ctx.moveTo(aa.x, aa.y); ctx.lineTo(bb.x, bb.y); ctx.lineTo(cc.x, cc.y); ctx.closePath(); ctx.clip();
    ctx.setTransform(xx, yx, xy, yy, A.x - xx * a.x - xy * a.y, A.y - yx * a.x - yy * a.y);
    ctx.drawImage(layer, 0, 0); ctx.restore();
  };
  const columns = 20, rows = 12;
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const a = { x: x * layer.width / columns, y: y * layer.height / rows };
    const b = { x: (x + 1) * layer.width / columns, y: a.y };
    const c = { x: a.x, y: (y + 1) * layer.height / rows };
    const d = { x: b.x, y: c.y };
    triangle(a, b, c); triangle(b, d, c);
  }
  ctx.restore();
  destination.drawImage(projected, 0, 0);
}
