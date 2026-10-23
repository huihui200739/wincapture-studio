/**
 * 共用合成器（开发文档 §11.1 / §11.2 / §11.5）
 *
 * 预览与导出共用同一份「场景求值 + 绘制」代码：
 *   Domain.evaluateScene() → FrameScene（不可变）→ drawScene(ctx, scene, resources)
 *
 * 合成顺序严格按 §11.2：
 *   解码屏幕 → 源坐标遮挡 → 光标与点击 → 源裁切和运镜
 *            → 屏幕圆角与阴影 → 背景合成
 *            → 摄像头与画布标注 → 输出色彩转换 → 编码
 */

import type { FrameScene, NormalizedRect, PrivacyScene } from '../domain/scene';
import { screenRectPx } from '../domain/scene';
import { hasMotion } from '../domain/projection';
import { screenLayer, drawProjectedScreen } from './projectedScreen';

/** 一帧可用的媒体资源（由调用方按时间点解码后提供）。 */
export interface SceneResources {
  /** 屏幕源画面（未裁切、未缩放） */
  screen: CanvasImageSource | null;
  screenWidth: number;
  screenHeight: number;
  /** 摄像头画面 */
  camera: CanvasImageSource | null;
  /** 光标位图；为空时使用内置绘制 */
  cursor: CanvasImageSource | null;
}

export interface DrawOptions {
  /** 是否绘制编辑辅助层（选择框、手柄）。辅助层不进入视频（§11.1） */
  includeOverlays?: boolean;
  /** 高亮矩形（选中遮挡时） */
  highlight?: NormalizedRect | null;
  /** 设备像素比，用于光标绘制清晰度 */
  devicePixelRatio?: number;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 计算 CSS `linear-gradient(<角度>, …)` 在画布坐标系里的渐变线端点。
 *
 * CSS 角度约定：0deg = 向上、90deg = 向右、180deg = 向下、270deg = 向左，
 * 即方向向量为 (sin θ, −cos θ)（画布 y 轴向下）。渐变线长度按 CSS 规范取
 * |W·sinθ| + |H·cosθ|，这样四角的投影都被覆盖，不会在角落提前用到端色。
 *
 * 之前这里把 y 分量写成 +cosθ，导致所有角度的渐变相对 CSS 预览上下翻转
 * （背景样块与预览/导出方向相反）。
 */
export function cssLinearGradientGeometry(
  angleDeg: number,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const rad = ((Number.isFinite(angleDeg) ? angleDeg : 180) * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2;
  const cy = height / 2;
  return {
    x0: cx - dx * half,
    y0: cy - dy * half,
    x1: cx + dx * half,
    y1: cy + dy * half,
  };
}

function parseBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  background: string,
  width: number,
  height: number,
): void {
  // 支持 #RRGGBB、#RRGGBBAA 与 "linear-gradient(角度, 色标, 色标...)"
  if (background.startsWith('linear-gradient')) {
    const inner = background.slice(background.indexOf('(') + 1, background.lastIndexOf(')'));
    const parts = inner.split(',').map((s) => s.trim());
    const angle = parseFloat(parts[0]);
    const stops = parts.slice(1);
    const g = cssLinearGradientGeometry(Number.isFinite(angle) ? angle : 180, width, height);
    const grad = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1);
    stops.forEach((stop, index) => {
      grad.addColorStop(stops.length === 1 ? 0 : index / (stops.length - 1), stop);
    });
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = background;
  }
  ctx.fillRect(0, 0, width, height);
}

/** 源坐标遮挡在输出画布上的像素矩形（含运镜取景变换）。 */
export function mapSourceRectToScreen(
  rect: NormalizedRect,
  view: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const viewW = view.width > 0 ? view.width : 1;
  const viewH = view.height > 0 ? view.height : 1;
  return {
    x: target.x + ((rect.x - view.x) / viewW) * target.width,
    y: target.y + ((rect.y - view.y) / viewH) * target.height,
    width: (rect.width / viewW) * target.width,
    height: (rect.height / viewH) * target.height,
  };
}

/**
 * 在屏幕裁剪区内绘制源坐标遮挡（§11.2：先于光标、跟随运镜缩放）。
 *
 * 这是遮挡唯一的绘制入口：导出、预览与教程截图都经过 drawScene → 本函数，
 * 不存在「某一产物旁路取原帧」的分支。
 */
export function drawScreenPrivacy(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  items: readonly PrivacyScene[],
  view: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): void {
  for (const privacy of items) {
    const px = mapSourceRectToScreen(privacy.rect, view, target);
    if (px.width <= 0 || px.height <= 0) continue;
    ctx.save();
    if (privacy.style === 'solid') {
      // 高敏感信息优先使用不透明实色覆盖（§12.2）
      ctx.fillStyle = '#000000';
      ctx.fillRect(px.x, px.y, px.width, px.height);
    } else if (privacy.style === 'blur') {
      // 注意：模糊与马赛克按文档只是视觉样式，不作为不可恢复保证（§12.2）。
      ctx.filter = 'blur(16px)';
      ctx.fillStyle = 'rgba(0,0,0,0.88)';
      ctx.fillRect(px.x, px.y, px.width, px.height);
      ctx.filter = 'none';
    } else {
      // 马赛克：深色底 + 网格线，保证既不透明也能看出「已遮挡」
      ctx.fillStyle = 'rgba(24,24,24,0.94)';
      ctx.fillRect(px.x, px.y, px.width, px.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      const step = 9;
      for (let gx = px.x; gx < px.x + px.width; gx += step) {
        ctx.beginPath();
        ctx.moveTo(gx, px.y);
        ctx.lineTo(gx, px.y + px.height);
        ctx.stroke();
      }
      for (let gy = px.y; gy < px.y + px.height; gy += step) {
        ctx.beginPath();
        ctx.moveTo(px.x, gy);
        ctx.lineTo(px.x + px.width, gy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** 绘制内置光标（避免双光标：烧录模式下不叠加，§9.4）。 */
function drawCursor(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: FrameScene,
  screenRect: { x: number; y: number; width: number; height: number },
  resources: SceneResources,
): void {
  if (!scene.cursor.visible) return;
  const zoom = scene.zoom;
  const viewW = 1 / zoom.scale;
  const viewX = Math.min(1 - viewW, Math.max(0, zoom.focusX - viewW / 2));
  const viewY = Math.min(1 - viewW, Math.max(0, zoom.focusY - viewW / 2));

  const toPx = (nx: number, ny: number) => ({
    x: screenRect.x + ((nx - viewX) / viewW) * screenRect.width,
    y: screenRect.y + ((ny - viewY) / viewW) * screenRect.height,
  });

  const pos = toPx(scene.cursor.x, scene.cursor.y);

  // 点击波纹
  const rippleScale = Math.max(0, scene.cursor.rippleScale ?? 1);
  if (scene.cursor.clickProgress > 0 && rippleScale > 0) {
    const clickPos = toPx(scene.cursor.clickX, scene.cursor.clickY);
    const p = scene.cursor.clickProgress;
    const radius = scene.cursor.size * (1.2 + p * 2.4) * rippleScale;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p) * 0.85;
    ctx.strokeStyle = '#ffd54a';
    ctx.lineWidth = Math.max(2, scene.cursor.size * 0.16);
    ctx.beginPath();
    ctx.arc(clickPos.x, clickPos.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (scene.cursor.style === 'dot') {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = Math.max(1, scene.cursor.size * 0.07);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, scene.cursor.size * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (resources.cursor) {
    const size = scene.cursor.size;
    ctx.drawImage(resources.cursor, pos.x - size * 0.1, pos.y - size * 0.05, size, size * 1.35);
    return;
  }

  // 内置箭头光标
  const s = scene.cursor.size / 24;
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 19);
  ctx.lineTo(4.6, 14.6);
  ctx.lineTo(7.6, 21.4);
  ctx.lineTo(10.6, 20.1);
  ctx.lineTo(7.7, 13.4);
  ctx.lineTo(13.8, 13.2);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.72)';
  ctx.lineWidth = 1.6;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** 摄像头画中画，带独立遮挡集合（§11.2：屏幕遮挡不保护摄像头）。 */
function drawCamera(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: FrameScene,
  resources: SceneResources,
): void {
  if (!scene.camera.visible) return;
  const { x, y, width, height } = scene.camera.rect;
  const px = x * scene.outputWidth;
  const py = y * scene.outputHeight;
  const pw = width * scene.outputWidth;
  const ph = height * scene.outputHeight;
  if (pw <= 1 || ph <= 1) return;

  ctx.save();
  roundRectPath(ctx, px, py, pw, ph, scene.camera.cornerRadius);
  ctx.clip();
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(px, py, pw, ph);
  if (resources.camera) {
    // 按「覆盖」方式填充，避免变形。
    // 注意：不能只认 videoWidth/width——VideoFrame 暴露的是 displayWidth，
    // 旧实现遇到 VideoFrame 会算成 0×0 直接不画，画中画变成纯黑块。
    const cam = resources.camera as unknown as {
      displayWidth?: number;
      displayHeight?: number;
      videoWidth?: number;
      videoHeight?: number;
      width?: number;
      height?: number;
    };
    const sw = cam.displayWidth ?? cam.videoWidth ?? cam.width ?? 0;
    const sh = cam.displayHeight ?? cam.videoHeight ?? cam.height ?? 0;
    if (sw > 0 && sh > 0) {
      const scale = Math.max(pw / sw, ph / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(resources.camera, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
    }
  }
  // 摄像头自身遮挡
  for (const privacy of scene.camera.privacy) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(px + privacy.rect.x * pw, py + privacy.rect.y * ph, privacy.rect.width * pw, privacy.rect.height * ph);
  }
  ctx.restore();

  // 边框
  ctx.save();
  roundRectPath(ctx, px, py, pw, ph, scene.camera.cornerRadius);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = Math.max(1, scene.outputWidth * 0.0009);
  ctx.stroke();
  ctx.restore();
}

/**
 * 绘制一帧完整场景。这是预览与导出唯一绘制入口（§11.5 预览一致性）。
 * 调用方需先按 scene.outputWidth/Height 设置 canvas 尺寸。
 */
export function drawScene(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: FrameScene,
  resources: SceneResources,
  options: DrawOptions = {},
): void {
  const W = scene.outputWidth;
  const H = scene.outputHeight;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 1. 背景
  parseBackground(ctx, scene.background, W, H);

  const rect = screenRectPx(scene);
  if (rect.width <= 0 || rect.height <= 0) {
    ctx.restore();
    return;
  }

  // 2. 屏幕内容：圆角裁剪 + 阴影
  const outputContext = ctx;
  const layer = hasMotion(scene) ? screenLayer(ctx, W, H) : null;
  if (layer) {
    ctx = layer.getContext('2d')!; ctx.save();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  }
  if (scene.shadowBlur > 0 && scene.shadowOpacity > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${scene.shadowOpacity})`;
    ctx.shadowBlur = scene.shadowBlur;
    ctx.shadowOffsetY = scene.shadowBlur * 0.35;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, scene.cornerRadius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, scene.cornerRadius);
  ctx.clip();

  if (resources.screen && resources.screenWidth > 0 && resources.screenHeight > 0) {
    const zoom = scene.zoom;
    const viewW = 1 / zoom.scale;
    const viewH = 1 / zoom.scale;
    const viewX = Math.min(1 - viewW, Math.max(0, zoom.focusX - viewW / 2));
    const viewY = Math.min(1 - viewH, Math.max(0, zoom.focusY - viewH / 2));

    // 源裁切 + 运镜：把源画面的 [viewX,viewX+viewW]×[viewY,viewY+viewH] 铺满目标矩形
    const sx = viewX * resources.screenWidth;
    const sy = viewY * resources.screenHeight;
    const sw = viewW * resources.screenWidth;
    const sh = viewH * resources.screenHeight;
    ctx.drawImage(resources.screen, sx, sy, sw, sh, rect.x, rect.y, rect.width, rect.height);

    // 源坐标遮挡：在源坐标系内绘制，跟随运镜一起缩放（§11.2）
    // 用裁剪区内的源→目标映射完成
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    drawScreenPrivacy(
      ctx,
      scene.screenPrivacy,
      { x: viewX, y: viewY, width: viewW, height: viewH },
      rect,
    );
    ctx.restore();
  } else {
    // 无源帧：填充占位（导出时上层会复用上一帧，这里只是兜底）
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  // 3. 光标（在屏幕裁剪区内，随画面变换）
  drawCursor(ctx, scene, rect, resources);

  ctx.restore(); // 结束圆角裁剪

  // 4. 边框高光
  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, scene.cornerRadius);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = Math.max(1, W * 0.0006);
  ctx.stroke();
  ctx.restore();

  // 5. 摄像头画中画
  if (layer) {
    ctx.restore();
    ctx = outputContext;
    drawProjectedScreen(ctx, layer, scene);
  }
  drawCamera(ctx, scene, resources);

  // 6. 画布标注
  for (const note of scene.annotations) {
    ctx.save();
    ctx.font = `600 ${note.fontSize}px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const textW = ctx.measureText(note.text).width;
    const padX = note.fontSize * 0.5;
    const padY = note.fontSize * 0.28;
    const bx = note.x * W;
    const by = note.y * H;
    ctx.fillStyle = 'rgba(12,16,22,0.82)';
    roundRectPath(ctx, bx - padX, by - padY, textW + padX * 2, note.fontSize * 1.5 + padY, note.fontSize * 0.3);
    ctx.fill();
    ctx.fillStyle = note.color;
    ctx.fillText(note.text, bx, by);
    ctx.restore();
  }

  // 7. 编辑辅助层（不进入视频）
  if (options.includeOverlays && options.highlight) {
    const h = options.highlight;
    ctx.save();
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rect.x + h.x * rect.width, rect.y + h.y * rect.height, h.width * rect.width, h.height * rect.height);
    ctx.restore();
  }

  ctx.restore();
}

/** 导出时的帧缓存键（§10.4：缓存键含素材哈希、解码版本、采样规则和遮挡版本）。 */
export function frameCacheKey(scene: FrameScene): string {
  return `${scene.cacheKey}|${scene.clipId ?? 'none'}|${scene.sourceTick ?? -1}`;
}
