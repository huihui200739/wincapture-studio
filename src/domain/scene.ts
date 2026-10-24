/**
 * 渲染场景求值（开发文档 §11.1 / §11.2）
 *
 * Domain 把工程状态在指定时间求值为不可变 FrameScene：
 * 画布、源裁切、镜头变换、屏幕装饰、光标、摄像头、遮挡、标注和颜色配置。
 * FrameScene 不持有界面控件，也不读取磁盘文件——渲染层与导出层共用同一份求值结果。
 *
 * 合成顺序（§11.2）：
 *   解码屏幕 → 源坐标遮挡 → 光标与点击 → 源裁切和运镜
 *            → 屏幕圆角与阴影 → 背景合成
 *            → 摄像头与画布标注 → 输出色彩转换 → 编码
 */

import type { CanvasVariant, Effect, Project, TutorialStep, ZoomParameters, PrivacyParameters, CursorParameters, AnnotationParameters } from './project';
import { activeVariant, timelineDuration } from './project';
import { TimeMap as TimeMapClass } from './timeMap';
import type { Ticks, TickRange } from './timebase';
import { clampTicks } from './timebase';
import { evaluateZoom } from './zoom';
import { evaluateMotion, projectScreenPoint, type ScreenMotion } from './projection';
import { stepTimelineRange } from './tutorial';

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceCrop {
  /** 归一化到源画面 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorScene {
  visible: boolean;
  /** 归一化到源画面 */
  x: number;
  y: number;
  /** 输出像素尺寸 */
  size: number;
  /** 点击波纹进度 0..1，0 表示无波纹 */
  clickProgress: number;
  clickX: number;
  clickY: number;
  rippleScale?: number;
  style?: 'arrow' | 'dot';
}

export interface PrivacyScene {
  /** 源坐标归一化矩形 */
  rect: NormalizedRect;
  style: PrivacyParameters['style'];
  effectId: string;
}

export interface CameraScene {
  visible: boolean;
  /** 归一化到输出画布 */
  rect: NormalizedRect;
  cornerRadius: number;
  /** 摄像头自身是否有遮挡（§11.2：屏幕遮挡不自动保护摄像头） */
  privacy: PrivacyScene[];
}

export interface AnnotationScene {
  text: string;
  /** 归一化到输出画布 */
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export interface FrameScene {
  tick: Ticks;
  /** 输出画布尺寸（像素） */
  outputWidth: number;
  outputHeight: number;
  aspect: [number, number];
  /** 背景与装饰 */
  background: string;
  cornerRadius: number;
  shadowBlur: number;
  shadowOpacity: number;
  padding: number;
  /** 屏幕内容在画布中的目标矩形（归一化到输出画布） */
  screenRect: NormalizedRect;
  /** 源画面裁切（运镜由 zoom 决定） */
  sourceCrop: SourceCrop;
  zoom: { scale: number; focusX: number; focusY: number };
  screenMotion?: ScreenMotion;
  /** 源坐标遮挡（先于运镜应用） */
  screenPrivacy: PrivacyScene[];
  cursor: CursorScene;
  camera: CameraScene;
  annotations: AnnotationScene[];
  /** 是否命中主轨片段；false 时渲染层复用上一帧（静态复帧，§9.4） */
  hasSourceFrame: boolean;
  /** 该时刻对应的源素材时间，未命中为 null */
  sourceTick: Ticks | null;
  /** 色彩配置：首发统一 SDR Rec.709（§7.5） */
  colorSpace: 'srgb';
  /** 该帧是否需要从源取帧的片段 ID */
  clipId: string | null;
  /** 预览与导出共用的缓存键 */
  cacheKey: string;
}

export interface SceneOptions {
  outputWidth: number;
  outputHeight: number;
  variantId?: string;
  /** 指针位置（源归一化坐标），由调用方按 TimeMap 求值后传入 */
  pointer?: { x: number; y: number; visible: boolean; clickProgress?: number; clickX?: number; clickY?: number; idleTicks?: number } | null;
  /** 是否包含编辑辅助层（选择框、手柄）。辅助层不进入视频（§11.1） */
  includeOverlays?: boolean;
}

/** 画幅对应的默认输出尺寸（§11.3 1920×1080 及相应竖屏/方形尺寸） */
export function outputSizeForAspect(aspect: [number, number], longEdge = 1920): { width: number; height: number } {
  const [w, h] = aspect;
  if (w >= h) {
    const width = longEdge;
    const height = Math.round((longEdge * h) / w);
    return { width: even(width), height: even(height) };
  }
  const height = longEdge;
  const width = Math.round((longEdge * w) / h);
  return { width: even(width), height: even(height) };
}

function even(v: number): number {
  return v % 2 === 0 ? v : v + 1;
}

/** 把源画面按「包含」方式放入画布内框（letterbox），保持比例不裁切。 */
export function fitRect(contentAspect: number, box: NormalizedRect): NormalizedRect {
  const boxW = box.width;
  const boxH = box.height;
  const boxAspect = boxW / boxH;
  if (contentAspect > boxAspect) {
    const height = boxW / contentAspect;
    return { x: box.x, y: box.y + (boxH - height) / 2, width: boxW, height };
  }
  const width = boxH * contentAspect;
  return { x: box.x + (boxW - width) / 2, y: box.y, width, height: boxH };
}

function rectFromParams(p: PrivacyParameters): NormalizedRect {
  return { x: p.x, y: p.y, width: p.width, height: p.height };
}

function variantLayout(project: Project, variant: CanvasVariant, aspect: [number, number]) {
  const canvas = project.settings.canvas;
  const padding = Math.max(0, Math.min(0.4, canvas.padding));
  const box: NormalizedRect = {
    x: padding,
    y: padding,
    width: 1 - padding * 2,
    height: 1 - padding * 2,
  };
  const overrides = variant.layoutOverrides;
  return {
    canvas,
    box,
    padding,
    background: overrides.background ?? canvas.background,
    camera: overrides.camera ?? canvas.camera,
    safeArea: overrides.safeArea ?? null,
    aspect,
  };
}

/**
 * 求值某一时间点的渲染场景。这是预览与导出唯一入口（§11.5 预览一致性）。
 */
export function evaluateScene(project: Project, tick: Ticks, options: SceneOptions): FrameScene {
  const variant = options.variantId
    ? project.variants.find((v) => v.id === options.variantId) ?? activeVariant(project)
    : activeVariant(project);
  const aspect = variant.aspect;
  const layout = variantLayout(project, variant, aspect);
  const timeMap = new TimeMapClass(project);

  const mainHit = timeMap.mainHit(tick);
  // 源时间一律走 TimeMap：这里曾经自己算一遍，既没有夹到片段内部（变速时可能
  // 求出 source.end，落在片段之外），又和导出/TimeMap 的口径可能漂移。
  const sourceTick = mainHit ? (timeMap.toSource('primaryVideo', tick)?.sourceTick ?? null) : null;

  // 运镜只对当前时间线时间生效（效果区间按时间线时间记录）
  const zoomEffects = project.effects.filter((e) => e.kind === 'zoom');
  const zoom = evaluateZoom(zoomEffects, tick);
  const screenMotion = evaluateMotion(zoomEffects, tick);

  const sourceAspect = mainHit
    ? (() => {
        const asset = project.assets.find((a) => a.id === mainHit.clip.assetId);
        return asset && asset.height > 0 ? asset.width / asset.height : 16 / 9;
      })()
    : 16 / 9;

  // fitRect operates in normalized canvas units. Compensate for the pixel
  // aspect of the canvas, otherwise a 16:9 source on a 16:9 canvas is squashed.
  const screenRect = fitRect(sourceAspect / (options.outputWidth / options.outputHeight), layout.box);

  // 源坐标遮挡：在源坐标系内应用，随画面变换一起缩放。
  //
  // anchor 有两份：Effect.anchor（可选，历史字段）与 PrivacyParameters.anchor（必填）。
  // 旧实现只看前者，一旦某条遮挡只写了参数里的 anchor（手写工程 JSON、旧版本迁移、
  // 以及将来任何漏写顶层字段的创建路径），它既进不了 screenPrivacy 也进不了
  // cameraPrivacy —— 预览和导出都不画遮挡，而界面上仍显示「已确认遮挡」。
  // 隐私安全不允许这种静默失效：以参数为准，缺什么就按源坐标兜底。
  const screenPrivacy: PrivacyScene[] = [];
  const cameraPrivacy: PrivacyScene[] = [];
  for (const effect of project.effects) {
    if (effect.kind !== 'privacy') continue;
    if (tick < effect.range.start || tick >= effect.range.end) continue;
    const p = effect.parameters as PrivacyParameters;
    if (!p.confirmed) continue;
    const scene: PrivacyScene = { rect: rectFromParams(p), style: p.style, effectId: effect.id };
    // 三种锚点的矩形都归一化到源画面（见 PrivacyParameters 注释），
    // 区别只在矩形如何随运镜/窗口变化，落到场景里都是源坐标遮挡。
    // 未知锚点同样按源坐标遮挡：宁可多遮，不可漏遮。
    screenPrivacy.push(scene);
  }

  // 光标：默认由独立事件轨绘制，避免双光标（§9.4）。
  // 光标参数同样受效果区间约束：区间外应回落到默认叠加行为，否则一次 [0,5s) 的
  // 烧录光标设置会让整段视频都不再绘制后期光标。
  const cursorEffect = project.effects.find(
    (e) => e.kind === 'cursor' && tick >= e.range.start && tick < e.range.end,
  );
  const cursorParams = cursorEffect?.parameters as CursorParameters | undefined;
  const burnedIn = cursorParams?.burnedIn ?? false;
  const pointer = options.pointer;
  const cursor: CursorScene = {
    visible: !burnedIn && (cursorParams?.visible ?? true) && !!pointer?.visible &&
      (!(cursorParams?.hideAfterTicks && cursorParams.hideAfterTicks > 0) ||
        (pointer?.idleTicks ?? 0) < cursorParams.hideAfterTicks),
    x: pointer?.x ?? 0.5,
    y: pointer?.y ?? 0.5,
    size: cursorParams?.size ?? 22,
    clickProgress: pointer?.clickProgress ?? 0,
    clickX: pointer?.clickX ?? pointer?.x ?? 0.5,
    clickY: pointer?.clickY ?? pointer?.y ?? 0.5,
    rippleScale: cursorParams?.clickRipple ?? 1,
    style: cursorParams?.style ?? 'arrow',
  };

  const cameraRect = layout.camera;
  const camera: CameraScene = {
    visible: cameraRect.visible && !!timeMap.toSource('camera', tick),
    rect: {
      x: cameraRect.x,
      y: cameraRect.y,
      width: cameraRect.width,
      height: cameraRect.height,
    },
    cornerRadius:
      'cornerRadius' in cameraRect && typeof cameraRect.cornerRadius === 'number'
        ? cameraRect.cornerRadius
        : layout.canvas.camera.cornerRadius,
    privacy: cameraPrivacy,
  };

  const annotations: AnnotationScene[] = project.effects
    .filter((e) => e.kind === 'annotation' && tick >= e.range.start && tick < e.range.end)
    .map((e) => {
      const p = e.parameters as AnnotationParameters;
      return { text: p.text, x: p.x, y: p.y, fontSize: p.fontSize, color: p.color };
    });

  const cacheKey = [
    project.revision,
    project.privacyVersion,
    tick,
    options.outputWidth,
    options.outputHeight,
    variant.id,
  ].join(':');

  return {
    tick,
    outputWidth: options.outputWidth,
    outputHeight: options.outputHeight,
    aspect,
    background: layout.background,
    cornerRadius: layout.canvas.cornerRadius,
    shadowBlur: layout.canvas.shadowBlur,
    shadowOpacity: layout.canvas.shadowOpacity,
    // 与 screenRect 使用同一个夹紧后的 padding，避免渲染层按未夹紧值排布阴影/圆角
    padding: layout.padding,
    screenRect,
    sourceCrop: { x: 0, y: 0, width: 1, height: 1 },
    zoom,
    screenMotion,
    screenPrivacy,
    cursor,
    camera,
    annotations,
    hasSourceFrame: !!mainHit,
    sourceTick,
    colorSpace: 'srgb',
    clipId: mainHit?.clip.id ?? null,
    cacheKey,
  };
}

/** 工程在指定画幅下的输出时长（§11.4）。 */
export function sceneDuration(project: Project): Ticks {
  return timelineDuration(project);
}

/** 计算画布内屏幕区域（像素），供渲染层直接使用。 */
export function screenRectPx(scene: FrameScene): { x: number; y: number; width: number; height: number } {
  return {
    x: scene.screenRect.x * scene.outputWidth,
    y: scene.screenRect.y * scene.outputHeight,
    width: scene.screenRect.width * scene.outputWidth,
    height: scene.screenRect.height * scene.outputHeight,
  };
}

/** 把源归一化坐标映射到输出画布像素坐标（含运镜）。 */
export function sourceToOutput(
  scene: FrameScene,
  nx: number,
  ny: number,
): { x: number; y: number } {
  const r = screenRectPx(scene);
  const { scale, focusX, focusY } = scene.zoom;
  // 运镜：以焦点为中心放大，源坐标 → 可视窗口
  const viewW = 1 / scale;
  const viewH = 1 / scale;
  const viewX = clampTicks(Math.round((focusX - viewW / 2) * 1e6), 0, Math.round((1 - viewW) * 1e6)) / 1e6;
  const viewY = clampTicks(Math.round((focusY - viewH / 2) * 1e6), 0, Math.round((1 - viewH) * 1e6)) / 1e6;
  const u = (nx - viewX) / viewW;
  const v = (ny - viewY) / viewH;
  return projectScreenPoint(scene, { x: r.x + u * r.width, y: r.y + v * r.height });
}

/** 当前时间点命中的运镜效果（供界面显示「依据/置信度」，§12.3）。 */
export function zoomEffectAt(project: Project, tick: Ticks): (Effect & { kind: 'zoom' }) | null {
  for (const effect of project.effects) {
    if (effect.kind !== 'zoom') continue;
    if (tick >= effect.range.start && tick < effect.range.end) return effect as Effect & { kind: 'zoom' };
  }
  return null;
}

/** 该时刻应显示的步骤（用于编辑器联动高亮）。 */
export function stepAt(project: Project, tick: Ticks): TutorialStep | null {
  const map = new TimeMapClass(project);
  for (const step of project.steps) {
    const range = stepTimelineRange(project, step, map);
    if (range && tick >= range.start && tick < range.end) return step;
  }
  return null;
}

/** 主视频轨是否有内容（决定空工程预览状态）。 */
export function hasContent(project: Project): boolean {
  return project.tracks.some((t) => t.kind === 'primaryVideo' && t.clips.length > 0);
}

/** 运镜参数的默认值（新建效果时使用）。 */
export function defaultZoomParams(): ZoomParameters {
  return {
    scale: 1.6,
    focusX: 0.5,
    focusY: 0.5,
    easeInTicks: 4_500_000,
    easeOutTicks: 5_000_000,
    focusSource: 'manual',
  };
}

export type { TickRange };
