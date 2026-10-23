/**
 * 编辑器预览画布（§11.5 预览一致性）
 *
 * 预览与导出走同一条路径：
 *   evaluateScene(project, tick, { outputWidth, outputHeight, variantId }) → drawScene(ctx, scene, resources)
 *
 * 画面来源（P0 修复）：
 * - mock 模式（没有 window.wcs）才允许用 syntheticMedia 的演示画面；
 * - 真实工程必须解码工程里的真实分段（previewSource），与导出用同一批素材。
 *   解码未就绪时画中性占位，绝不用合成演示画面顶替真实录制内容。
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Project } from '@domain/project';
import { activeVariant, findTrack, timelineDuration } from '@domain/project';
import type { FrameScene } from '@domain/scene';
import { evaluateScene, outputSizeForAspect, screenRectPx } from '@domain/scene';
import { drawScene, type SceneResources } from '../../media/compositor';
import { syntheticCamera, syntheticScreen } from '../lib/syntheticMedia';
import {
  paintPreviewPlaceholder,
  shouldUseSyntheticPreview,
  usePreviewMedia,
} from '../lib/previewSource';
import { TICKS_PER_SECOND } from '@domain/timebase';

export interface PreviewCanvasProps {
  project: Project;
  tick: number;
  /** 工程目录绝对路径：真实模式解码素材分段必需 */
  projectPath?: string | null;
  /** 预览渲染宽度上限（像素）；高度按画幅计算 */
  maxWidth?: number;
  /** 编辑辅助层（选择框等），不进入导出 */
  includeOverlays?: boolean;
  highlight?: { x: number; y: number; width: number; height: number } | null;
  /** 外部需要在绘制完成后拿到 scene（用于坐标换算） */
  onScene?: (scene: FrameScene | null) => void;
  className?: string;
  canvasRefOut?: (canvas: HTMLCanvasElement | null) => void;
}

/** 预览输出尺寸：按画幅比例，长边固定 1280，兼顾清晰度与性能。 */
export function previewSizeFor(project: Project, maxWidth = 1280): { width: number; height: number; variantId: string } {
  const variant = activeVariant(project);
  const size = outputSizeForAspect(variant.aspect, maxWidth);
  return { width: size.width, height: size.height, variantId: variant.id };
}

/** 指针位置（预览用）：沿主轨缓慢移动，让光标可见但不干扰。 */
function pointerAt(tick: number): { x: number; y: number; visible: boolean; clickProgress: number } {
  const seconds = tick / TICKS_PER_SECOND;
  const cycle = seconds % 6;
  const x = 0.32 + 0.2 * Math.sin(seconds * 0.55);
  const y = 0.42 + 0.16 * Math.cos(seconds * 0.41);
  return { x, y, visible: true, clickProgress: cycle > 4.6 ? (cycle - 4.6) / 1.4 : 0 };
}

export function PreviewCanvas({
  project,
  tick,
  projectPath = null,
  maxWidth = 1280,
  includeOverlays = true,
  highlight = null,
  onScene,
  className,
  canvasRefOut,
}: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sceneRef = useRef<FrameScene | null>(null);
  const requestRef = useRef(0);
  /** 是否已经画过至少一帧真实画面（决定解码等待时是画占位还是保留上一帧） */
  const paintedRef = useRef(false);
  const synthetic = shouldUseSyntheticPreview();
  const media = usePreviewMedia(projectPath);

  const size = useMemo(() => previewSizeFor(project, maxWidth), [project, maxWidth]);

  useEffect(() => {
    canvasRefOut?.(canvasRef.current);
    return () => canvasRefOut?.(null);
  }, [canvasRefOut]);

  // 换工程/换素材目录时重置绘制状态，避免第一帧沿用上一个工程的画面
  useEffect(() => {
    paintedRef.current = false;
  }, [project.id, projectPath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;

    let cancelled = false;
    const requestId = ++requestRef.current;

    const draw = (resources: SceneResources, scene: FrameScene) => {
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return false;
      try {
        drawScene(ctx, scene, resources, {
          includeOverlays,
          highlight,
          devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
        });
      } catch (error) {
        console.error('[preview] drawScene 失败', error);
        return false;
      }
      return true;
    };

    const placeholder = (message: string) => {
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      paintPreviewPlaceholder(ctx, canvas.width, canvas.height, message);
    };

    // ---- mock 模式：合成演示画面（只有无 window.wcs 时才走到这里）----
    if (synthetic) {
      const render = () => {
        if (cancelled) return;
        let scene: FrameScene;
        try {
          scene = evaluateScene(project, tick, {
            outputWidth: size.width,
            outputHeight: size.height,
            variantId: size.variantId,
            pointer: pointerAt(tick),
            includeOverlays,
          });
        } catch (error) {
          console.error('[preview] evaluateScene 失败', error);
          return;
        }
        const seconds = tick / TICKS_PER_SECOND;
        const hasCamera = !!findTrack(project, 'camera')?.clips.length;
        const resources: SceneResources = {
          screen: syntheticScreen(seconds),
          screenWidth: 1600,
          screenHeight: 900,
          camera: hasCamera && scene.camera.visible ? syntheticCamera(seconds) : null,
          cursor: null,
        };
        if (!draw(resources, scene)) return;
        sceneRef.current = scene;
        onScene?.(scene);
      };
      // 用 rAF 合并同一帧内的多次请求，避免拖动时间线时重复绘制
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(render);
      return () => {
        cancelled = true;
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }

    // ---- 真实模式：几何同步求值，画面异步解码 ----
    let scene: FrameScene;
    try {
      scene = evaluateScene(project, tick, {
        outputWidth: size.width,
        outputHeight: size.height,
        variantId: size.variantId,
        pointer: null,
        includeOverlays,
      });
    } catch (error) {
      console.error('[preview] evaluateScene 失败', error);
      placeholder('预览场景求值失败');
      return;
    }
    // 坐标换算（遮挡框/框选）只依赖 scene 几何，先交给外部，别等解码
    sceneRef.current = scene;
    onScene?.(scene);

    const decode = media;
    if (!decode) {
      placeholder(projectPath ? '预览解码器未就绪，导出画面不受影响' : '请先打开工程目录以解码预览');
      return;
    }
    if (!paintedRef.current) placeholder('正在解码预览画面…');

    void decode
        .resolve(project, scene, tick, canvas)
      .then((result) => {
        if (cancelled || requestId !== requestRef.current) return;
        if (!result) return; // 已被更新的请求取代
        const current = canvasRef.current;
        if (!current) return;
        if (result.screen || !scene.hasSourceFrame) {
          const resources: SceneResources = {
            screen: result.screen,
            screenWidth: result.screenWidth || size.width,
            screenHeight: result.screenHeight || size.height,
            camera: result.camera,
            cursor: null,
          };
          const withPointer = evaluateScene(project, tick, {
            outputWidth: size.width, outputHeight: size.height, variantId: size.variantId,
            pointer: result.pointer, includeOverlays,
          });
          if (draw(resources, withPointer)) paintedRef.current = true;
        } else {
          const ctx2 = current.getContext('2d', { alpha: false });
          if (ctx2) {
            paintPreviewPlaceholder(ctx2, current.width, current.height, result.message ?? '正在解码预览画面…');
          }
        }
      })
      .catch((error) => {
        if (cancelled || requestId !== requestRef.current) return;
        console.error('[preview] 解码预览失败', error);
        placeholder('预览解码失败，导出画面不受影响');
      });

    return () => {
      cancelled = true;
    };
  }, [project, tick, size.width, size.height, size.variantId, includeOverlays, highlight, onScene, synthetic, media, projectPath]);

  return (
    <canvas
      ref={canvasRef}
      className={className ? `stage-canvas ${className}` : 'stage-canvas'}
      width={size.width}
      height={size.height}
      role="img"
      aria-label={`预览画面，时间 ${(tick / TICKS_PER_SECOND).toFixed(2)} 秒`}
    />
  );
}

/**
 * 源归一化矩形 → 输出画布归一化矩形（含运镜缩放与焦点）。
 *
 * 与 domain 的 sourceToOutput 使用同一套视口公式：viewX/Y 会被夹紧，
 * 保证缩放后画面不出界。抽成纯函数便于单测覆盖（有运镜时遮挡框的位置）。
 */
export function sourceRectToDisplayRect(
  scene: FrameScene,
  rect: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const r = screenRectPx(scene);
  const scale = scene.zoom.scale > 0 ? scene.zoom.scale : 1;
  const viewW = 1 / scale;
  const viewX = Math.min(1 - viewW, Math.max(0, scene.zoom.focusX - viewW / 2));
  const viewY = Math.min(1 - viewW, Math.max(0, scene.zoom.focusY - viewW / 2));
  return {
    x: (r.x + ((rect.x - viewX) / viewW) * r.width) / scene.outputWidth,
    y: (r.y + ((rect.y - viewY) / viewW) * r.height) / scene.outputHeight,
    width: (rect.width / viewW) * (r.width / scene.outputWidth),
    height: (rect.height / viewW) * (r.height / scene.outputHeight),
  };
}

/** 输出画布归一化矩形 → 源归一化矩形（sourceRectToDisplayRect 的逆变换，用于框选）。 */
export function displayRectToSourceRect(
  scene: FrameScene,
  rect: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const r = screenRectPx(scene);
  const scale = scene.zoom.scale > 0 ? scene.zoom.scale : 1;
  const viewW = 1 / scale;
  const viewX = Math.min(1 - viewW, Math.max(0, scene.zoom.focusX - viewW / 2));
  const viewY = Math.min(1 - viewW, Math.max(0, scene.zoom.focusY - viewW / 2));
  if (r.width <= 0 || r.height <= 0 || scene.outputWidth <= 0 || scene.outputHeight <= 0) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  const px = rect.x * scene.outputWidth;
  const py = rect.y * scene.outputHeight;
  return {
    x: viewX + ((px - r.x) / r.width) * viewW,
    y: viewY + ((py - r.y) / r.height) * viewW,
    width: (rect.width * scene.outputWidth * viewW) / r.width,
    height: (rect.height * scene.outputHeight * viewW) / r.height,
  };
}

/**
 * 计算「源归一化坐标 ↔ 画布显示坐标」的换算器。
 *
 * 预览 canvas 以 CSS 缩放显示，遮挡框用百分比定位，
 * 因此这里只需要把源坐标经过运镜映射到屏幕区域的归一化比例。
 */
export function useSourceToDisplay(project: Project, tick: number) {
  return useMemo(() => {
    const scene = (() => {
      try {
        const size = previewSizeFor(project, 1280);
        return evaluateScene(project, tick, {
          outputWidth: size.width,
          outputHeight: size.height,
          variantId: size.variantId,
          pointer: pointerAt(tick),
        });
      } catch {
        return null;
      }
    })();
    if (!scene) {
      return {
        scene: null,
        toDisplayRect: (rect: { x: number; y: number; width: number; height: number }) => rect,
        toSourceRect: (rect: { x: number; y: number; width: number; height: number }) => rect,
        screenBox: { left: 0, top: 0, width: 1, height: 1 },
        duration: timelineDuration(project),
      };
    }
    const rect = screenRectPx(scene);
    return {
      scene,
      toDisplayRect: (r: { x: number; y: number; width: number; height: number }) => sourceRectToDisplayRect(scene, r),
      toSourceRect: (r: { x: number; y: number; width: number; height: number }) => displayRectToSourceRect(scene, r),
      screenBox: {
        left: rect.x / scene.outputWidth,
        top: rect.y / scene.outputHeight,
        width: rect.width / scene.outputWidth,
        height: rect.height / scene.outputHeight,
      },
      duration: timelineDuration(project),
    };
  }, [project, tick]);
}
