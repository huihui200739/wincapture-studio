/**
 * 工程数据模型（开发文档 §13）
 *
 * 约定：
 * - 时间字段为有符号 64 位整数 tick（1 秒 = 10_000_000 tick），区间 [start, end)。
 * - 播放速率使用有理数，帧率保存分子分母，避免长工程浮点误差。
 * - 源素材只读；剪辑只改变引用（§10.1 非破坏编辑）。
 * - 超出 JS 整数安全范围的字段跨语言传递时使用十进制字符串。
 */

import type { FrameRate, Rational, TickRange, Ticks } from './timebase';
import { TICKS_PER_SECOND, makeFrameRate, ONE } from './timebase';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_DIR_SUFFIX = '.wcaproj';
export const PROJECT_PACK_SUFFIX = '.wcapack';

export type MediaKind = 'screen' | 'camera' | 'mic' | 'system';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  /** 工程相对路径，禁止绝对路径与 .. 越界（§13.1） */
  path: string;
  /** 内容哈希（sha256 前 32 位十六进制），用于素材重定位 */
  hash: string;
  durationTicks: Ticks;
  width: number;
  height: number;
  /** 音频素材的采样率，视频素材为 0 */
  sampleRate: number;
  /** 音频素材的声道数，视频素材为 0 */
  channels: number;
  createdAt: number;
}

export interface Clip {
  id: string;
  assetId: string;
  /** 源素材内的起点，左闭 */
  sourceInTicks: Ticks;
  /** 引用源素材的时长 */
  sourceDurationTicks: Ticks;
  /** 在时间线上的目标起点 */
  timelineInTicks: Ticks;
  /** 播放速率（1/1 为原速） */
  rate: Rational;
  /** 关联组：同一次录制产生的轨道片段共享，删除/重排一起作用（§10.2） */
  linkGroupId: string;
}

export type TrackKind = 'primaryVideo' | 'camera' | 'mic' | 'system';

export interface Track {
  id: string;
  kind: TrackKind;
  /** 轨道是否静音（音频轨） */
  muted: boolean;
  /** 线性增益，1 为原始音量 */
  gain: number;
  clips: Clip[];
}

/** 效果种类：运镜、遮挡、光标样式等（§10.3 / §12.2 / §11.2） */
export type EffectKind = 'zoom' | 'privacy' | 'cursor' | 'annotation';

export type EffectOrigin = 'automatic' | 'manual';

export interface ZoomParameters {
  /** 3D screen rotation in degrees; older projects default to a flat screen. */
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  /** Camera distance relative to the output long edge, 1..5. */
  perspective?: number;
  /** 目标缩放倍数，1 为不放大 */
  scale: number;
  /** 焦点中心，归一化到源画面 [0,1] */
  focusX: number;
  focusY: number;
  /** 进入/退出过渡时长 */
  easeInTicks: Ticks;
  easeOutTicks: Ticks;
  /** 可选：语义焦点来源（§12.3），用于界面展示依据 */
  focusSource?: 'pointer' | 'control' | 'manual';
  /** 自动运镜的平滑鼠标焦点路径，使用时间线 tick。 */
  focusPath?: { tick: Ticks; x: number; y: number }[];
}

export type PrivacyAnchor = 'screen' | 'window' | 'keyframe';
export type PrivacyStyle = 'solid' | 'blur' | 'mosaic';

export interface PrivacyParameters {
  /** 归一化到源画面的矩形 [0,1] */
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: PrivacyAnchor;
  style: PrivacyStyle;
  /** 确认状态；未确认不等于已遮挡（§13.2） */
  confirmed: boolean;
  /** 若来自隐私候选，记录候选 ID */
  candidateId?: string;
}

export interface CursorParameters {
  style?: 'arrow' | 'dot';
  /** 0 disables idle hiding; source media ticks. */
  hideAfterTicks?: Ticks;
  /** Positive offsets sample later pointer events to correct capture latency. */
  timeOffsetTicks?: Ticks;
  /** 光标绘制尺寸（输出像素） */
  size: number;
  /** 点击反馈：波纹半径倍数 */
  clickRipple: number;
  visible: boolean;
  /** 烧录模式：使用源画面自带光标，后期不再叠加（§9.4 降级模式） */
  burnedIn: boolean;
}

export interface AnnotationParameters {
  text: string;
  /** 输出坐标，归一化 */
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export type EffectParameters = ZoomParameters | PrivacyParameters | CursorParameters | AnnotationParameters;

export interface Effect {
  id: string;
  kind: EffectKind;
  /** 作用的时间区间（时间线时间，[start, end)） */
  range: TickRange;
  /** 锚点类型（遮挡专用） */
  anchor?: PrivacyAnchor;
  parameters: EffectParameters;
  origin: EffectOrigin;
  /** 人工修改后锁定，自动重生成不得覆盖（§10.3） */
  locked: boolean;
  /** 关联的步骤 ID（若该效果由标记/步骤派生） */
  stepId?: string;
}

export type StepSource = 'marker' | 'click' | 'manual';

export interface TutorialStep {
  id: string;
  /**
   * 步骤对应的**源（媒体）时间**区间，经 TimeMap 映射到成片时间（§12.1）。
   * 存储源时间而不是成片时间：修剪/删除/重排后步骤会自动跟随内容，
   * 不需要在每个编辑命令里同步平移。渲染与导出前用 stepTimelineRange 映射。
   */
  sourceRange: TickRange;
  title: string;
  description: string;
  /**
   * 截图所取的**源（媒体）时间点**，与 sourceRange 同一时间轴。
   * 渲染前用 stepTimelineTick 映射为成片时间；已被剪掉时映射返回 null。
   */
  imageTick: Ticks;
  /** 操作区域，归一化到源画面 */
  actionRect: { x: number; y: number; width: number; height: number } | null;
  source: StepSource;
  /** 截图对应的遮挡版本，用于缓存键与一致性校验（§12.2） */
  privacyVersion: number;
}

export interface CanvasLayoutOverride {
  /** 该画幅下摄像头位置，归一化到输出画布 */
  camera?: { x: number; y: number; width: number; height: number; visible: boolean };
  /** 安全区（字幕/标注），归一化 */
  safeArea?: { x: number; y: number; width: number; height: number };
  /** 背景与圆角等样式覆盖 */
  background?: string;
  /** 画幅焦点约束 */
  focus?: { x: number; y: number; scale: number } | null;
}

export interface CanvasVariant {
  id: string;
  /** 宽高比 [w, h]，例如 [16, 9] */
  aspect: [number, number];
  layoutOverrides: CanvasLayoutOverride;
}

export interface CanvasStyle {
  /** 背景：纯色 hex 或渐变描述 */
  background: string;
  /** 画面圆角（输出像素） */
  cornerRadius: number;
  /** 阴影模糊半径（输出像素），0 为无阴影 */
  shadowBlur: number;
  shadowOpacity: number;
  /** 画面在画布中的内边距比例，0 为铺满 */
  padding: number;
  /** 摄像头画中画默认布局 */
  camera: { x: number; y: number; width: number; height: number; visible: boolean; cornerRadius: number };
}

export interface RecordingMarker {
  id: string;
  /** 录制会话内的媒体时间 */
  mediaTick: Ticks;
  /** 用户输入的备忘录文本（本机保存） */
  note: string;
  createdAt: number;
}

export interface ProjectSettings {
  fps: FrameRate;
  /** 默认画布画幅 */
  activeVariantId: string;
  canvas: CanvasStyle;
  /** 指针采样上限（Hz），文档 §9.4 建议约 120Hz */
  pointerSampleHz: number;
  /** 是否启用步骤增强（UIA），MVP 关闭 */
  stepEnhancement: boolean;
}

export interface Project {
  schemaVersion: number;
  id: string;
  /** 单调递增的工程版本（§13.2） */
  revision: number;
  timebase: { ticksPerSecond: number };
  name: string;
  createdAt: number;
  updatedAt: number;
  assets: MediaAsset[];
  tracks: Track[];
  effects: Effect[];
  steps: TutorialStep[];
  variants: CanvasVariant[];
  markers: RecordingMarker[];
  settings: ProjectSettings;
  /** 已确认遮挡的版本号，变化时缓存失效（§12.2） */
  privacyVersion: number;
}

export const DEFAULT_CANVAS: CanvasStyle = {
  background: '#101418',
  cornerRadius: 14,
  shadowBlur: 28,
  shadowOpacity: 0.45,
  padding: 0.06,
  camera: { x: 0.72, y: 0.68, width: 0.24, height: 0.24, visible: true, cornerRadius: 12 },
};

export const DEFAULT_VARIANTS: CanvasVariant[] = [
  { id: 'landscape', aspect: [16, 9], layoutOverrides: {} },
  { id: 'square', aspect: [1, 1], layoutOverrides: {} },
  { id: 'portrait', aspect: [9, 16], layoutOverrides: {} },
];

export function createEmptyProject(id: string, name: string, now = Date.now()): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    revision: 1,
    timebase: { ticksPerSecond: TICKS_PER_SECOND },
    name,
    createdAt: now,
    updatedAt: now,
    assets: [],
    tracks: [
      { id: 'main', kind: 'primaryVideo', muted: false, gain: 1, clips: [] },
      { id: 'camera', kind: 'camera', muted: false, gain: 1, clips: [] },
      { id: 'mic', kind: 'mic', muted: false, gain: 1, clips: [] },
      { id: 'system', kind: 'system', muted: false, gain: 1, clips: [] },
    ],
    effects: [],
    steps: [],
    variants: DEFAULT_VARIANTS.map((v) => ({ ...v, layoutOverrides: { ...v.layoutOverrides } })),
    markers: [],
    settings: {
      fps: makeFrameRate(30, 1),
      activeVariantId: 'landscape',
      canvas: { ...DEFAULT_CANVAS, camera: { ...DEFAULT_CANVAS.camera } },
      pointerSampleHz: 120,
      stepEnhancement: false,
    },
    privacyVersion: 0,
  };
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}

export function findTrack(project: Project, kind: TrackKind): Track | undefined {
  if (!Array.isArray(project.tracks)) return undefined;
  return project.tracks.find((t) => t?.kind === kind);
}

export function findAsset(project: Project, id: string): MediaAsset | undefined {
  if (!Array.isArray(project.assets)) return undefined;
  return project.assets.find((a) => a?.id === id);
}

export function findVariant(project: Project, id: string): CanvasVariant | undefined {
  if (!Array.isArray(project.variants)) return undefined;
  return project.variants.find((v) => v?.id === id);
}

/** 兜底画幅：工程 variants 为空/损坏时仍能预览与导出，避免读取 `.aspect` 抛异常。 */
const FALLBACK_VARIANT: CanvasVariant = Object.freeze({
  id: 'landscape',
  aspect: [16, 9] as [number, number],
  layoutOverrides: {},
}) as CanvasVariant;

export function activeVariant(project: Project): CanvasVariant {
  const found = findVariant(project, project.settings?.activeVariantId);
  if (found) return found;
  const first = Array.isArray(project.variants) ? project.variants[0] : undefined;
  return first ?? FALLBACK_VARIANT;
}

export function effectsOfKind<K extends EffectKind>(
  project: Project,
  kind: K,
): (Effect & { kind: K })[] {
  return project.effects.filter((e) => e.kind === kind) as (Effect & { kind: K })[];
}

/** 时间线总时长：所有主视频轨片段的最大结束时间（§10.1） */
export function clipTimelineDuration(clip: Clip): Ticks {
  const rate = clip.rate;
  if (!rate || !Number.isFinite(rate.num) || !Number.isFinite(rate.den) || rate.num <= 0 || rate.den <= 0) return 0;
  const ticks = Math.round(clip.sourceDurationTicks * rate.den / rate.num);
  return Number.isFinite(ticks) ? Math.max(0, ticks) : 0;
}

export function timelineDuration(project: Project): Ticks {
  const main = findTrack(project, 'primaryVideo');
  if (!main || !Array.isArray(main.clips)) return 0;
  let end = 0;
  for (const clip of main.clips) {
    if (!clip || !Number.isFinite(clip.timelineInTicks) || !Number.isFinite(clip.sourceDurationTicks)) continue;
    const rate = clip.rate;
    // 速率非法时跳过该片段：宁可时长为 0 也不要返回 Infinity/NaN 污染导出计划与缓存键。
    if (!rate || !Number.isFinite(rate.num) || !Number.isFinite(rate.den) || rate.num <= 0 || rate.den <= 0) continue;
    const clipEnd = clip.timelineInTicks + Math.round((clip.sourceDurationTicks * rate.den) / rate.num);
    if (Number.isFinite(clipEnd) && clipEnd > end) end = clipEnd;
  }
  return Math.max(0, end);
}

export function defaultRate(): Rational {
  return { ...ONE };
}
