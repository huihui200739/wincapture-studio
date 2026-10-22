/**
 * 编辑器预览画布（§11.5 预览一致性）
 *
 * 预览与导出走同一条路径：
 *   evaluateScene(project, tick, { outputWidth, outputHeight, variantId }) → drawScene(ctx, scene, resources)
 *
 * mock 模式下用 syntheticMedia 的合成画面作为「已解码的源帧」，
 * 真实模式下由后续接入的解码器提供同样形状的 CanvasImageSource。
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Project } from '@domain/project';
import { activeVariant, findTrack, timelineDuration } from '@domain/project';
import type { FrameScene } from '@domain/scene';
import { evaluateScene, outputSizeForAspect, screenRectPx } from '@domain/scene';
import { drawScene, type SceneResources } from '../../media/compositor';
import { syntheticCamera, syntheticScreen } from '../lib/syntheticMedia';
import { TICKS_PER_SECOND } from '@domain/timebase';

export interface PreviewCanvasProps {
  project: Project;
  tick: number;
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

  const size = useMemo(() => previewSizeFor(project, maxWidth), [project, maxWidth]);

  useEffect(() => {
    canvasRefOut?.(canvasRef.current);
    return () => canvasRefOut?.(null);
  }, [canvasRefOut]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;

    let cancelled = false;

    const render = () => {
      if (cancelled) return;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      const seconds = tick / TICKS_PER_SECOND;

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

      const hasCamera = !!findTrack(project, 'camera')?.clips.length;
      const resources: SceneResources = {
        screen: syntheticScreen(seconds),
        screenWidth: 1600,
        screenHeight: 900,
        camera: hasCamera && scene.camera.visible ? syntheticCamera(seconds) : null,
        cursor: null,
      };

      try {
        drawScene(ctx, scene, resources, {
          includeOverlays,
          highlight,
          devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
        });
      } catch (error) {
        console.error('[preview] drawScene 失败', error);
        return;
      }

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
  }, [project, tick, size.width, size.height, size.variantId, includeOverlays, highlight, onScene]);

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
    const zoom = scene.zoom;
    const viewW = 1 / zoom.scale;
    const viewX = Math.min(1 - viewW, Math.max(0, zoom.focusX - viewW / 2));
    const viewY = Math.min(1 - viewW, Math.max(0, zoom.focusY - viewW / 2));

    // 源坐标 → 输出画布归一化（含运镜）
    const toDisplayRect = (r: { x: number; y: number; width: number; height: number }) => ({
      x: (rect.x + ((r.x - viewX) / viewW) * rect.width) / scene.outputWidth,
      y: (rect.y + ((r.y - viewY) / viewW) * rect.height) / scene.outputHeight,
      width: (r.width / viewW) * (rect.width / scene.outputWidth),
      height: (r.height / viewW) * (rect.height / scene.outputHeight),
    });

    // 输出画布归一化 → 源坐标（逆变换，用于框选）
    const toSourceRect = (r: { x: number; y: number; width: number; height: number }) => {
      const px = r.x * scene.outputWidth;
      const py = r.y * scene.outputHeight;
      return {
        x: viewX + ((px - rect.x) / rect.width) * viewW,
        y: viewY + ((py - rect.y) / rect.height) * viewW,
        width: (r.width * scene.outputWidth * viewW) / rect.width,
        height: (r.height * scene.outputHeight * viewW) / rect.height,
      };
    };

    return {
      scene,
      toDisplayRect,
      toSourceRect,
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
