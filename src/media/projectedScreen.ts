import type { FrameScene } from '../domain/scene';
import { projectScreenPoint, type Point } from '../domain/projection';
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const layers = new WeakMap<Context, OffscreenCanvas>();
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
    const expand = (p: Point) => { const n = Math.hypot(p.x - ox, p.y - oy); return { x: p.x + (p.x - ox) * 0.65 / n, y: p.y + (p.y - oy) * 0.65 / n }; };
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
}
