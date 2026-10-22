/**
 * 运镜规划（开发文档 §10.3 / §12.3）
 *
 * P0 自动运镜依据：点击簇、指针活跃区与停留时间。
 * - 相邻小范围点击合并为一个镜头；
 * - 留出进入、保持、退出三个阶段；
 * - 限制缩放倍数与速度，按最终源分辨率限制放大，避免文字失真；
 * - 自动生成的片段标记 origin=automatic，人工修改后切 manual 并锁定，
 *   重新生成时只替换未锁定片段。
 */

import type { Effect, ZoomParameters } from './project';
import type { TickRange, Ticks } from './timebase';
import { clampTicks, rangeLength, secondsToTicks } from './timebase';

export interface PointerSample {
  /** 会话媒体时间 */
  tick: Ticks;
  /** 归一化到源画面 [0,1] */
  x: number;
  y: number;
}

export interface ClickSample {
  tick: Ticks;
  x: number;
  y: number;
  /** 可选：被点击控件的归一化边界（语义焦点，P1 能力，P0 可缺省） */
  controlRect?: { x: number; y: number; width: number; height: number };
}

export interface ZoomPlannerOptions {
  /** 最小缩放倍数 */
  minScale: number;
  /** 最大缩放倍数 */
  maxScale: number;
  /** 进入/退出过渡时长 */
  easeInTicks: Ticks;
  easeOutTicks: Ticks;
  /** 镜头最短保持时长 */
  minHoldTicks: Ticks;
  /** 相邻点击合并的时间阈值 */
  mergeGapTicks: Ticks;
  /** 相邻点击合并的空间阈值（归一化） */
  mergeDistance: number;
  /** 镜头之间的最小间隔，太近的不重复放大 */
  minGapTicks: Ticks;
  /** 焦点留白，归一化 */
  padding: number;
  /** 优先使用控件边界（§12.3）；false 时退回指针 */
  preferControlBounds: boolean;
  /** 源画面宽高，用于按分辨率限制放大（避免文字失真） */
  sourceWidth: number;
  sourceHeight: number;
}

export const DEFAULT_ZOOM_OPTIONS: ZoomPlannerOptions = {
  minScale: 1.15,
  maxScale: 2.4,
  easeInTicks: secondsToTicks(0.45),
  easeOutTicks: secondsToTicks(0.5),
  minHoldTicks: secondsToTicks(0.9),
  mergeGapTicks: secondsToTicks(1.6),
  mergeDistance: 0.18,
  minGapTicks: secondsToTicks(0.35),
  padding: 0.12,
  preferControlBounds: true,
  sourceWidth: 1920,
  sourceHeight: 1080,
};

interface Cluster {
  start: Ticks;
  end: Ticks;
  sumX: number;
  sumY: number;
  count: number;
  /** 控件边界合并后的包围盒 */
  rect: { x: number; y: number; width: number; height: number } | null;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function unionRect(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number },
) {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 按缩放倍数求焦点可移动范围，保证画面不出界（§12.3）。
 * 返回缩放后可见区域的归一化尺寸，并据此夹紧中心。
 */
function clampFocus(cx: number, cy: number, scale: number): { x: number; y: number } {
  const halfW = 1 / (2 * scale);
  const halfH = 1 / (2 * scale);
  return {
    x: Math.min(1 - halfW, Math.max(halfW, cx)),
    y: Math.min(1 - halfH, Math.max(halfH, cy)),
  };
}

/**
 * 按源分辨率限制放大：放大后有效像素密度不足时降低倍数（§10.3 避免文字失真）。
 *
 * 放大 scale 倍后，可见区域只用到源的 sourceWidth/scale 像素，却被铺到
 * outputWidth 个输出像素上，因此像素密度 = sourceWidth / (scale * outputWidth)。
 * 密度低于 1/2.4 时文字会明显发糊，据此反解出允许的最大倍数：
 *
 *   scale <= 2.4 * sourceWidth / outputWidth
 *
 * 1080p 源配 1080p 输出时上限正好 2.4（与文档口径一致）；更小的源按比例收缩；
 * 低于 1 时不再放大（宁可全窗留白，也不交付糊字）。
 */
const MIN_PIXEL_DENSITY_INV = 2.4;

function resolutionCappedScale(scale: number, options: ZoomPlannerOptions, outputWidth = 1920): number {
  if (options.sourceWidth <= 0 || outputWidth <= 0) return scale;
  const cap = (MIN_PIXEL_DENSITY_INV * options.sourceWidth) / outputWidth;
  // 允许低于 minScale：宁可放大得少一些，也不交付糊字（下限仍是 1 = 不放大）
  return Math.max(1, Math.min(scale, cap, options.maxScale));
}

/** 由点击与指针轨迹生成自动运镜效果（不含已锁定片段）。 */
export function planAutoZoom(
  clicks: readonly ClickSample[],
  pointers: readonly PointerSample[],
  options: Partial<ZoomPlannerOptions> = {},
): Effect[] {
  const opt: ZoomPlannerOptions = { ...DEFAULT_ZOOM_OPTIONS, ...options };
  // 注意：没有点击时仍可能由「指针长停留」生成轻量镜头（§10.3 指针活跃区与停留时间），
  // 因此这里不能提前 return；只有两者都为空时才没有效果。

  // 1. 指针停留区域：用于点击之间没有点击但用户停留很久的片段
  const dwell = findDwellRegions(pointers, opt);

  // 2. 点击聚类
  const sorted = clicks.slice().sort((a, b) => a.tick - b.tick);
  const clusters: Cluster[] = [];
  for (const click of sorted) {
    const last = clusters.at(-1);
    const cx = last ? last.sumX / last.count : 0;
    const cy = last ? last.sumY / last.count : 0;
    const mergeable =
      last &&
      click.tick - last.end <= opt.mergeGapTicks &&
      dist(click.x, click.y, cx, cy) <= opt.mergeDistance;
    if (mergeable && last) {
      last.end = Math.max(last.end, click.tick);
      last.sumX += click.x;
      last.sumY += click.y;
      last.count += 1;
      if (opt.preferControlBounds && click.controlRect) last.rect = unionRect(last.rect, click.controlRect);
    } else {
      clusters.push({
        start: click.tick,
        end: click.tick,
        sumX: click.x,
        sumY: click.y,
        count: 1,
        rect: opt.preferControlBounds && click.controlRect ? { ...click.controlRect } : null,
      });
    }
  }

  const effects: Effect[] = [];
  let lastEnd = -Infinity;

  const pushEffect = (cluster: Cluster) => {
    const cx = cluster.sumX / cluster.count;
    const cy = cluster.sumY / cluster.count;

    let scale = opt.minScale;
    let focusSource: ZoomParameters['focusSource'] = 'pointer';
    if (cluster.rect) {
      // 语义焦点：把控件矩形完整放进画面（含留白）
      const w = cluster.rect.width * (1 + opt.padding * 2);
      const h = cluster.rect.height * (1 + opt.padding * 2);
      const needed = Math.max(w, h);
      scale = Math.min(opt.maxScale, Math.max(opt.minScale, 1 / Math.max(0.05, needed)));
      focusSource = 'control';
    } else {
      // 指针模式：点击次数越多放大越明显
      scale = Math.min(opt.maxScale, opt.minScale + 0.18 * Math.min(4, cluster.count));
    }
    scale = resolutionCappedScale(scale, opt);

    const centerX = cluster.rect ? cluster.rect.x + cluster.rect.width / 2 : cx;
    const centerY = cluster.rect ? cluster.rect.y + cluster.rect.height / 2 : cy;
    const focus = clampFocus(centerX, centerY, scale);

    // 留出进入 / 保持 / 退出
    const holdStart = Math.max(0, cluster.start - opt.easeInTicks);
    const holdEnd = cluster.end + opt.minHoldTicks + opt.easeOutTicks;
    const start = Math.max(0, holdStart);
    const end = holdEnd;

    if (start < lastEnd + opt.minGapTicks) {
      // 与前一个镜头过近：延长前一个镜头而不是叠加
      const prev = effects.at(-1);
      if (prev) {
        prev.range.end = Math.max(prev.range.end, end);
        return;
      }
    }

    const params: ZoomParameters = {
      scale,
      focusX: focus.x,
      focusY: focus.y,
      easeInTicks: opt.easeInTicks,
      easeOutTicks: opt.easeOutTicks,
      focusSource,
    };
    effects.push({
      id: `zoom-auto-${effects.length + 1}`,
      kind: 'zoom',
      range: { start, end },
      parameters: params,
      origin: 'automatic',
      locked: false,
    });
    lastEnd = end;
  };

  for (const cluster of clusters) pushEffect(cluster);

  // 3. 长停留且无点击的区域补一个轻量镜头
  for (const region of dwell) {
    const overlaps = effects.some((e) => e.range.start < region.end && region.start < e.range.end);
    if (overlaps) continue;
    if (effects.some((e) => Math.abs(e.range.start - region.start) < opt.minGapTicks)) continue;
    effects.push({
      id: `zoom-auto-d${effects.length + 1}`,
      kind: 'zoom',
      range: region,
      parameters: {
        scale: opt.minScale,
        focusX: 0.5,
        focusY: 0.5,
        easeInTicks: opt.easeInTicks,
        easeOutTicks: opt.easeOutTicks,
        focusSource: 'pointer',
      },
      origin: 'automatic',
      locked: false,
    });
  }

  return effects.sort((a, b) => a.range.start - b.range.start);
}

/** 指针停留区域：约 2 秒内位移很小。 */
function findDwellRegions(pointers: readonly PointerSample[], opt: ZoomPlannerOptions): TickRange[] {
  const dwellMin = Math.max(secondsToTicks(2), opt.minHoldTicks * 2);
  const out: TickRange[] = [];
  if (pointers.length < 2) return out;
  const sorted = pointers.slice().sort((a, b) => a.tick - b.tick);
  let anchor = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    if (dist(p.x, p.y, anchor.x, anchor.y) > 0.04) {
      if (p.tick - anchor.tick >= dwellMin) out.push({ start: anchor.tick, end: p.tick });
      anchor = p;
    }
  }
  const last = sorted[sorted.length - 1];
  if (last.tick - anchor.tick >= dwellMin) out.push({ start: anchor.tick, end: last.tick });
  return out;
}

/**
 * 重新生成自动运镜：只替换未锁定片段（§10.3）。
 * 手动片段优先：与之重叠的自动片段被裁掉。
 */
export function regenerateAutoZoom(existing: readonly Effect[], planned: readonly Effect[]): Effect[] {
  const manual = existing.filter((e) => e.kind === 'zoom' && (e.locked || e.origin === 'manual'));
  const others = existing.filter((e) => e.kind !== 'zoom');

  const kept: Effect[] = [];
  for (const effect of planned) {
    let pieces: TickRange[] = [effect.range];
    for (const m of manual) {
      const next: TickRange[] = [];
      for (const piece of pieces) {
        const start = Math.max(piece.start, m.range.start);
        const end = Math.min(piece.end, m.range.end);
        if (end <= start) {
          next.push(piece);
          continue;
        }
        if (start > piece.start) next.push({ start: piece.start, end: start });
        if (end < piece.end) next.push({ start: end, end: piece.end });
      }
      pieces = next;
    }
    for (const piece of pieces) {
      if (rangeLength(piece) < secondsToTicks(0.25)) continue;
      kept.push({ ...effect, id: `${effect.id}-${kept.length}`, range: piece });
    }
  }

  return [...others, ...manual, ...kept].sort((a, b) => a.range.start - b.range.start);
}

/** 求某一时间点的运镜状态，预览与导出共用同一曲线求值器（§10.3）。 */
export function evaluateZoom(
  effects: readonly Effect[],
  tick: Ticks,
): { scale: number; focusX: number; focusY: number } {
  let scale = 1;
  let fx = 0.5;
  let fy = 0.5;
  for (const effect of effects) {
    if (effect.kind !== 'zoom') continue;
    if (tick < effect.range.start || tick >= effect.range.end) continue;
    const p = effect.parameters as ZoomParameters;
    const inT = clampTicks(tick - effect.range.start, 0, Math.max(1, p.easeInTicks));
    const outT = clampTicks(effect.range.end - tick, 0, Math.max(1, p.easeOutTicks));
    const inK = p.easeInTicks > 0 ? inT / p.easeInTicks : 1;
    const outK = p.easeOutTicks > 0 ? outT / p.easeOutTicks : 1;
    const ease = (k: number) => k * k * (3 - 2 * k); // smoothstep
    const k = Math.min(ease(inK), ease(outK));
    // 多个镜头重叠时取最强，避免叠加导致过度放大
    if (p.scale > scale || scale === 1) {
      scale = 1 + (p.scale - 1) * k;
      fx = 0.5 + (p.focusX - 0.5) * k;
      fy = 0.5 + (p.focusY - 0.5) * k;
    }
  }
  return { scale, focusX: fx, focusY: fy };
}
