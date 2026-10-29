/**
 * 时间线（§6.1）
 *
 * - 轨道顺序：主视频 / 摄像头 / 麦克风 / 系统声音 / 运镜 / 遮挡 / 步骤标记。
 * - 初始只展开常用轨道（画面 + 两条音频），运镜、遮挡、步骤标记等高级轨道按需展开。
 * - 片段块、播放头、可拖拽 seek、可缩放。
 * - 删除时间线片段 ≠ 删除源素材：这里只做前者，文案也明确区分。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Effect, PrivacyParameters, Project, TrackKind, ZoomParameters } from '@domain/project';
import { findTrack, timelineDuration } from '@domain/project';
import { stepTimelineRange } from '@domain/tutorial';
import { planGroupMove, linkedClips } from '@domain/clipEditing';
import { moveClipZooms } from '@domain/zoomEditing';
import { TICKS_PER_SECOND, formatDuration, ticksToSeconds } from '@domain/timebase';
import type { Ticks } from '@domain/timebase';
import { cn } from '../lib/format';
import { normalizeShortcutEvent } from '../lib/hooks';
import { Icon, IconButton } from './ui';
import { LineIcon, type LineIconKind } from './LineIcon';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ChoiceButton } from './ChoiceButton';
import { AudioWaveform } from './AudioWaveform';
import { WaveformSource, type WaveformPeakLoader } from '../lib/waveformSource';
import { wcs } from '../lib/wcs';
import { VideoThumbnails } from './VideoThumbnails';
import { usePreviewMedia } from '../lib/previewSource';
import { timelineSnapTargets, snapPosition } from '@domain/snapping';
import { anchoredTimelineScroll, clampTimelineZoom, MAX_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM, timelineZoomAnchor, type TimelineZoomAnchor } from '../lib/timelineViewport';

const TRACK_LABEL: Record<TrackKind, string> = {
  primaryVideo: '主视频',
  camera: '摄像头',
  mic: '麦克风',
  system: '系统声音',
};

/**
 * 轨头图标：22×22 圆角块 + 任务色淡染。颜色只表达轨道身份，
 * 主视频保持石墨黑，彩板留给效果轨与设备轨。
 */
const LANE_ICON: Record<string, { kind: LineIconKind; tint: string; ink: string }> = {
  primaryVideo: { kind: 'film', tint: 'rgba(0,0,0,.07)', ink: 'var(--ds-secondary)' },
  camera: { kind: 'camera', tint: 'rgba(255,138,92,.2)', ink: '#dd5420' },
  mic: { kind: 'microphone', tint: 'rgba(0,0,0,.055)', ink: 'var(--ds-secondary)' },
  system: { kind: 'speaker', tint: 'rgba(0,0,0,.055)', ink: 'var(--ds-secondary)' },
  zoom: { kind: 'zoom', tint: 'rgba(181,230,85,.3)', ink: '#5a9e1c' },
  privacy: { kind: 'shield', tint: 'rgba(69,203,184,.26)', ink: '#0f8c7a' },
  step: { kind: 'pin', tint: 'rgba(242,173,71,.2)', ink: '#9a6d20' },
  marker: { kind: 'pin', tint: 'rgba(242,173,71,.2)', ink: '#9a6d20' },
};

export interface TimelineProps {
  project: Project;
  tick: number;
  onSeek: (tick: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  selectedEffectId: string | null;
  onSelectEffect: (id: string | null) => void;
  selectedStepId: string | null;
  onSelectStep: (id: string | null) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelected: () => void;
  effectClipboardKind: Effect['kind'] | null;
  onCopyEffect: () => void;
  onPasteEffect: (attributesOnly?: boolean) => void;
  onToggleTrackMute: (kind: TrackKind) => void;
  /** 拖动片段到新位置（R08 重排）；调用方负责提交 MoveClip 命令 */
  onMoveClip: (clipId: string, timelineInTicks: number) => void;
  /**
   * 拖动片段左右手柄裁剪（可选）。不传时手柄只做视觉提示，不响应拖拽。
   * 调用方负责提交 TrimClip 命令。
   */
  onTrimClip?: (
    clipId: string,
    patch: { sourceInTicks: number; sourceDurationTicks: number; timelineInTicks: number },
  ) => void;
  /** 落点因重叠/越界被夹紧时的提示（可选）；不传则静默夹紧 */
  onMoveBlocked?: (message: string) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 工程根目录绝对路径，用于读取真实音频分段。 */
  projectPath?: string | null;
}

interface RowDef {
  key: string;
  label: string;
  kind: TrackKind | 'zoom' | 'privacy' | 'step' | 'marker';
  advanced: boolean;
}

interface TimelineContext {
  x: number;
  y: number;
  kind: 'clip' | 'effect' | 'step' | 'empty';
  id: string | null;
  origin: HTMLElement;
}

const CLIP_KEYS = 'arrowleft arrowright shift+arrowleft shift+arrowright enter space shift+f10 contextmenu';
const GESTURE_KEYS = `${CLIP_KEYS} escape delete backspace ctrl+b ctrl+z ctrl+y ctrl+shift+z ctrl+s ctrl+c ctrl+v ctrl+shift+v home end f f1`;

const ROWS: RowDef[] = [
  { key: 'primaryVideo', label: '主视频', kind: 'primaryVideo', advanced: false },
  { key: 'camera', label: '摄像头', kind: 'camera', advanced: false },
  { key: 'mic', label: '麦克风', kind: 'mic', advanced: false },
  { key: 'system', label: '系统声音', kind: 'system', advanced: false },
  { key: 'zoom', label: '运镜', kind: 'zoom', advanced: true },
  { key: 'privacy', label: '遮挡', kind: 'privacy', advanced: true },
  { key: 'step', label: '步骤标记', kind: 'step', advanced: true },
];


/** 领域层分割命令要求两侧都不短于 1ms（commands.ts MIN_CLIP_TICKS），界面提前做同样校验。 */
const MIN_CLIP_TICKS = 10_000;

/** 片段在时间线上的结束 tick（与 domain clipEnd 同一公式，包含播放速率）。 */
export function clipEndTick(clip: Clip): Ticks {
  return clip.timelineInTicks + Math.round((clip.sourceDurationTicks * clip.rate.den) / clip.rate.num);
}

/**
 * 播放头是否位于某个片段内部且两侧都够长。
 *
 * domain 的 splitOne 只分割 `tick > start && tick < end` 且两侧 >= 1ms 的片段；
 * 若不提前判断，Ctrl+B 在片段边界/太靠近端点时不会产生任何变化，却仍然压入一条
 * 空的撤销记录（用户按 Ctrl+Z 会「撤销了个寂寞」）。
 */
export function splittableTick(project: Project, tick: Ticks): boolean {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const start = clip.timelineInTicks;
      const end = clipEndTick(clip);
      if (tick <= start || tick >= end) continue;
      const left = Math.round((tick - start) * (clip.rate.num / clip.rate.den));
      if (left < MIN_CLIP_TICKS) continue;
      if (clip.sourceDurationTicks - left < MIN_CLIP_TICKS) continue;
      return true;
    }
  }
  return false;
}

export interface ClipMovePlan {
  clipId: string;
  /** 原始时间线位置 */
  originTick: Ticks;
  /** 调用方期望的位置（已夹紧到 >= 0） */
  desiredTick: Ticks;
  /** 实际可用位置 */
  tick: Ticks;
  /** 是否因重叠/越界被调整 */
  adjusted: boolean;
}

export interface ClipTrimPlan {
  clipId: string;
  /** 裁剪后的时间线起点 */
  timelineInTicks: Ticks;
  /** 裁剪后的源入点 */
  sourceInTicks: Ticks;
  /** 裁剪后的源时长 */
  sourceDurationTicks: Ticks;
  /** 裁剪后在时间线上占据的长度（按速率换算） */
  spanTicks: Ticks;
}

/** 片段播放速率（> 0）。 */
function rateOf(clip: Clip): number {
  const num = clip.rate.num > 0 ? clip.rate.num : 1;
  const den = clip.rate.den > 0 ? clip.rate.den : 1;
  return num / den;
}

/**
 * 计算拖拽裁剪手柄后的片段参数。
 *
 * 手抖/约束都在这里收敛：
 * - 源入点不得小于 0，时长不得小于 MIN_CLIP_TICKS；
 * - 时间线位置不得越过同轨相邻片段（宁可停住，也不制造重叠）；
 * - 向右扩展不超过素材剩余长度（读不到素材信息时只保证不短于最短时长）。
 */
export function planClipTrim(
  project: Project,
  clipId: string,
  edge: 'left' | 'right',
  deltaTimelineTicks: Ticks,
): ClipTrimPlan | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (!clip) continue;
    const rate = rateOf(clip);
    // 时间线长度 = 源时长 ÷ 播放速率（与 clipEndTick / TimeMap 一致）
    const span = Math.round(clip.sourceDurationTicks / rate);
    const minSpan = Math.max(1, Math.round(MIN_CLIP_TICKS / (rate || 1)));
    const asset = project.assets.find((item) => item.id === clip.assetId);

    let timelineIn = clip.timelineInTicks;
    let sourceIn = clip.sourceInTicks;
    let sourceDuration = clip.sourceDurationTicks;

    if (edge === 'left') {
      const prevEnd = track.clips
        .filter((other) => other.id !== clip.id && other.timelineInTicks < clip.timelineInTicks)
        .reduce((acc, other) => Math.max(acc, clipEndTick(other)), 0);
      const desiredIn = Math.max(0, clip.timelineInTicks + Math.round(deltaTimelineTicks));
      // 能往左最多扩展到源起点 0
      const earliestBySource = clip.timelineInTicks - Math.round(clip.sourceInTicks / (rate || 1));
      const latest = clip.timelineInTicks + span - minSpan;
      const nextIn = Math.min(latest, Math.max(prevEnd, Math.max(0, Math.max(earliestBySource, desiredIn))));
      const deltaTimeline = nextIn - clip.timelineInTicks;
      const deltaSource = Math.round(deltaTimeline * rate);
      sourceIn = clip.sourceInTicks + deltaSource;
      sourceDuration = Math.max(MIN_CLIP_TICKS, clip.sourceDurationTicks - deltaSource);
      timelineIn = nextIn;
    } else {
      const nextStart = track.clips
        .filter((other) => other.id !== clip.id && other.timelineInTicks >= clip.timelineInTicks)
        .reduce((acc, other) => Math.min(acc, other.timelineInTicks), Number.POSITIVE_INFINITY);
      let desiredSpan = span + Math.round(deltaTimelineTicks);
      desiredSpan = Math.max(minSpan, desiredSpan);
      if (Number.isFinite(nextStart)) desiredSpan = Math.min(desiredSpan, Math.max(minSpan, nextStart - clip.timelineInTicks));
      let desiredSourceDuration = Math.round(desiredSpan * rate);
      const availableSource = asset ? Math.max(MIN_CLIP_TICKS, asset.durationTicks - clip.sourceInTicks) : Number.POSITIVE_INFINITY;
      desiredSourceDuration = Math.min(availableSource, Math.max(MIN_CLIP_TICKS, desiredSourceDuration));
      sourceDuration = desiredSourceDuration;
    }

    const spanTicks = Math.round(sourceDuration / rate);
    return { clipId, timelineInTicks: timelineIn, sourceInTicks: sourceIn, sourceDurationTicks: sourceDuration, spanTicks };
  }
  return null;
}

/**
 * 计算片段拖拽/键盘移动的落点。
 *
 * domain 的 MoveClip 不检查同轨重叠，而 validate 又把重叠视为 error：
 * 直接落下会产生「时间线上两个片段叠在一起、预览按 TimeMap 取先出现的片段」的
 * 不可解释状态，所以界面先把落点夹紧到最近的不重叠位置。
 *
 * 使用领域层的整组落点规划，同时检查画面、摄像头和音频轨道。
 */
export function planClipMove(project: Project, clipId: string, desiredTick: Ticks): ClipMovePlan | null {
  return planGroupMove(project, clipId, desiredTick);
}

export function Timeline({
  project,
  tick,
  onSeek,
  selectedClipId,
  onSelectClip,
  selectedEffectId,
  onSelectEffect,
  selectedStepId,
  onSelectStep,
  onSplitAtPlayhead,
  onDeleteSelected,
  effectClipboardKind,
  onCopyEffect,
  onPasteEffect,
  onToggleTrackMute,
  onMoveClip,
  onMoveBlocked,
  onTrimClip,
  zoom,
  onZoomChange,
  collapsed,
  onToggleCollapsed,
  projectPath,
}: TimelineProps) {
  const hasZoom = project.effects.some(e => e.kind === 'zoom');
  const [showAdvanced, setShowAdvanced] = useState(hasZoom);
  const [detailTracks, setDetailTracks] = useState(false);
  const [waveformMode, setWaveformMode] = useState(false);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [contextMenu, setContextMenu] = useState<TimelineContext | null>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const [customHeight, setCustomHeight] = useState<number | null>(null);
  const [layoutHeight, setLayoutHeight] = useState({ timeline: 220, editor: 600 });
  const resizing = useRef<{ y: number; height: number; previous: number | null } | null>(null);
  useEffect(() => {
    const timeline = timelineRef.current;
    const editor = timeline?.parentElement;
    if (!timeline || !editor) return;
    const measure = () => {
      const next = { timeline: Math.round(timeline.getBoundingClientRect().height), editor: editor.clientHeight };
      setLayoutHeight(previous => previous.timeline === next.timeline && previous.editor === next.editor ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(timeline);
    observer.observe(editor);
    measure();
    return () => observer.disconnect();
  }, []);
  // 至少给预览区留下 40% 的空间；重置时继续使用原有的响应式默认高度。
  const maxHeight = Math.max(120, Math.min(600, Math.floor(layoutHeight.editor * 0.6)));
  const minHeight = Math.min(150, maxHeight);
  const clampHeight = (height: number) => Math.max(minHeight, Math.min(maxHeight, Math.round(height)));
  useEffect(() => { if (hasZoom) setShowAdvanced(true); }, [project.id, hasZoom]);
  const thumbnailMedia = usePreviewMedia(projectPath ?? null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gutterRowsRef = useRef<HTMLDivElement | null>(null);
  const viewport = useRef({ left: 0, top: 0 });
  const restoredScrollNode = useRef<HTMLDivElement | null>(null);
  const zoomAnchor = useRef<TimelineZoomAnchor | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  useEffect(() => {
    const node = scrollRef.current; if (!node) return;
    const observer = new ResizeObserver(() => setViewportWidth(node.clientWidth));
    observer.observe(node); setViewportWidth(node.clientWidth);
    return () => observer.disconnect();
  }, [collapsed]);
  const scrubbing = useRef(false);

  /** 轨道静音状态一律从工程派生：撤销/重做、其它面板切换静音后无需手动同步。 */
  const muteOf = useCallback(
    (kind: TrackKind): boolean => findTrack(project, kind)?.muted ?? false,
    [project],
  );

  const duration = useMemo(() => Math.max(timelineDuration(project), TICKS_PER_SECOND), [project]);
  const canSplit = useMemo(() => splittableTick(project, tick), [project, tick]);
  // Match the command's effect → step → clip priority, including stale selections.
  const canDelete = selectedEffectId
    ? project.effects.some(effect => effect.id === selectedEffectId)
    : selectedStepId
      ? project.steps.some(step => step.id === selectedStepId)
      : project.tracks.some(track => track.clips.some(clip => clip.id === selectedClipId));
  const deleteLabel = selectedEffectId ? '删除所选效果（Delete）'
    : selectedStepId ? '删除所选教程步骤（Delete）'
      : '删除所选时间线片段（Delete，不删除源素材）';
  const fitPixelsPerSecond = Math.max(1, (viewportWidth - 55) / (duration / TICKS_PER_SECOND));
  const effectiveZoom = clampTimelineZoom(zoom);
  const pxPerTick = (fitPixelsPerSecond * effectiveZoom) / TICKS_PER_SECOND;
  const contentWidth = Math.max(viewportWidth, (duration / TICKS_PER_SECOND) * fitPixelsPerSecond * effectiveZoom + 55);

  const syncViewport = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    viewport.current = { left: node.scrollLeft, top: node.scrollTop };
    const gutter = gutterRowsRef.current;
    if (gutter) {
      // Both viewports need the same usable height when a horizontal scrollbar appears.
      gutter.style.marginBottom = `${node.offsetHeight - node.clientHeight}px`;
      if (gutter.scrollTop !== node.scrollTop) gutter.scrollTop = node.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    viewport.current = { left: 0, top: 0 };
    zoomAnchor.current = null;
    if (scrollRef.current) { scrollRef.current.scrollLeft = 0; scrollRef.current.scrollTop = 0; }
  }, [project.id]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) { restoredScrollNode.current = null; return; }
    if (restoredScrollNode.current !== node) {
      node.scrollLeft = viewport.current.left;
      node.scrollTop = viewport.current.top;
      restoredScrollNode.current = node;
    }
    if (zoomAnchor.current) {
      node.scrollLeft = anchoredTimelineScroll(zoomAnchor.current, pxPerTick, contentWidth, node.clientWidth);
      zoomAnchor.current = null;
    }
    syncViewport();
  }, [collapsed, contentWidth, pxPerTick, layoutHeight.timeline, syncViewport]);

  const changeZoom = (requested: number) => {
    const next = clampTimelineZoom(requested);
    if (next === effectiveZoom) return;
    const node = scrollRef.current;
    zoomAnchor.current = timelineZoomAnchor(node?.scrollLeft ?? viewport.current.left, node?.clientWidth ?? viewportWidth, pxPerTick, tick);
    onZoomChange(next);
  };
  const fitTimeline = () => {
    zoomAnchor.current = null;
    viewport.current.left = 0;
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    onZoomChange(MIN_TIMELINE_ZOOM);
  };
  const revealPlayhead = () => {
    const node = scrollRef.current;
    if (node) node.scrollLeft = Math.max(0, tick * pxPerTick - node.clientWidth / 2);
  };

  const rows = useMemo(() => ROWS.filter(row => (showAdvanced || !row.advanced) &&
    (detailTracks || row.key === 'primaryVideo' || row.key === 'zoom' ||
      (row.key === 'privacy' && project.effects.some(e => e.kind === 'privacy')) || (row.key === 'step' && project.steps.length > 0))),
    [showAdvanced, detailTracks, project.effects, project.steps]);

  const tickToX = useCallback((value: number) => value * pxPerTick, [pxPerTick]);

  const xToTick = useCallback(
    (x: number) => Math.max(0, Math.min(duration, Math.round(x / pxPerTick))),
    [duration, pxPerTick],
  );

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      const x = clientX - rect.left + scroll.scrollLeft;
      onSeek(xToTick(x));
    },
    [onSeek, xToTick],
  );

  const onScrubPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 点在片段/效果块上时只做选择，不移动播放头
    if (target.closest('.tl-clip, .tl-effect, .tl-step-band, .tl-marker, .timeline-row-label')) return;
    scrubbing.current = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    seekFromEvent(event.clientX);
  };
  const onScrubPointerMove = (event: React.PointerEvent) => {
    if (!scrubbing.current) return;
    seekFromEvent(event.clientX);
  };
  const onScrubPointerUp = () => {
    scrubbing.current = false;
  };

  // ---- 片段拖拽移动（R08 重排）----
  // 用 pointer 事件而不是 HTML5 拖放：拖放对「按像素连续移动」的支持很差，
  // 而且拿不到精确的落点时间。这里自己算，拖动时只更新预览位置，松手才提交命令，
  // 保证一次拖拽只进一次撤销栈。
  // desiredTick 记录「鼠标真正想放的位置」，currentTick 是「夹紧后实际预览位置」：
  // 松手时用 desiredTick 重新规划，才能判断是否发生过重叠回退并给用户提示。
  const dragRef = useRef<{
    clipId: string;
    startX: number;
    originTick: number;
    currentTick: number;
    desiredTick: number;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ clipId: string; tick: number } | null>(null);

  // ---- 片段裁剪（拖左右手柄）----
  // 旧实现的两个手柄只是 aria-hidden 的空 span，光标是 ew-resize 却没有任何处理：
  // 拖动边缘走的是「整段移动」逻辑，用户以为在裁剪、实际改了位置。
  const trimRef = useRef<{ clipId: string; edge: 'left' | 'right'; startX: number } | null>(null);
  const [trimPreview, setTrimPreview] = useState<ClipTrimPlan | null>(null);
  const trimPlanRef = useRef<ClipTrimPlan | null>(null);
  const capturedPointer = useRef<{ element: HTMLElement; id: number } | null>(null);
  const [clipGestureActive, setClipGestureActive] = useState(false);
  const releaseClipPointer = useCallback(() => {
    const capture = capturedPointer.current;
    capturedPointer.current = null;
    if (capture?.element.hasPointerCapture(capture.id)) capture.element.releasePointerCapture(capture.id);
  }, []);
  const cancelClipGesture = useCallback(() => {
    dragRef.current = null;
    trimRef.current = null;
    trimPlanRef.current = null;
    setDragPreview(null);
    setTrimPreview(null);
    setSnapGuide(null);
    setClipGestureActive(false);
    releaseClipPointer();
  }, [releaseClipPointer]);
  useEffect(() => {
    if (!clipGestureActive) return;
    const onVisibility = () => { if (document.hidden) cancelClipGesture(); };
    window.addEventListener('blur', cancelClipGesture);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancelClipGesture);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [cancelClipGesture, clipGestureActive]);
  useEffect(() => {
    cancelClipGesture();
    // A global command such as Ctrl+Z can change the project while a menu is open.
    if (contextMenu) (contextMenu.origin.isConnected ? contextMenu.origin : timelineRef.current)?.focus({ preventScroll: true });
    setContextMenu(null);
  }, [project, collapsed, cancelClipGesture]);

  const onClipPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, clip: Clip) => {
      if (event.button !== 0) return;
      if (capturedPointer.current) return;
      event.stopPropagation();
      setContextMenu(null);
      event.currentTarget.focus({ preventScroll: true });
      onSelectClip(clip.id);
      capturedPointer.current = { element: event.currentTarget, id: event.pointerId };
      setClipGestureActive(true);
      const handle = (event.target as HTMLElement).closest('.tl-clip-handle');
      if (handle && onTrimClip) {
        const edge = handle.classList.contains('is-left') ? 'left' : 'right';
        trimRef.current = { clipId: clip.id, edge, startX: event.clientX };
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        return;
      }
      dragRef.current = {
        clipId: clip.id,
        startX: event.clientX,
        originTick: clip.timelineInTicks,
        currentTick: clip.timelineInTicks,
        desiredTick: clip.timelineInTicks,
      };
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [onSelectClip, onTrimClip],
  );

  const onClipPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (capturedPointer.current?.id !== event.pointerId) return;
      const trim = trimRef.current;
      if (trim) {
        const deltaTicks = Math.round((event.clientX - trim.startX) / pxPerTick);
        // 吸附到 10ms 网格，与移动保持同一手感
        const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === trim.clipId)!;
        const edge = trim.edge === 'left' ? clip.timelineInTicks : clipEndTick(clip);
        const snap = !snappingEnabled || event.altKey ? { value: edge + deltaTicks, guide: null } : snapPosition(edge + deltaTicks, timelineSnapTargets(project, trim.clipId, tick), 8 / pxPerTick);
        const plan = planClipTrim(project, trim.clipId, trim.edge, snap.value - edge);
        const actualEdge = plan ? plan.timelineInTicks + (trim.edge === 'right' ? plan.spanTicks : 0) : null;
        setSnapGuide(actualEdge !== null && Math.abs(actualEdge - snap.value) <= 1 ? snap.guide : null);
        trimPlanRef.current = plan;
        setTrimPreview(plan);
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const deltaTicks = Math.round((event.clientX - drag.startX) / pxPerTick);
      // 吸附到 10ms 网格，避免拖出无法复现的零头
      const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === drag.clipId)!;
      const snap = !snappingEnabled || event.altKey ? { value: drag.originTick + deltaTicks, guide: null } : snapPosition(drag.originTick + deltaTicks,
        timelineSnapTargets(project, drag.clipId, tick), 8 / pxPerTick, [0, clipEndTick(clip) - clip.timelineInTicks]);
      const desired = Math.max(0, snap.value);
      const plan = planClipMove(project, drag.clipId, desired);
      const next = plan ? plan.tick : desired;
      setSnapGuide(next === desired ? snap.guide : null);
      drag.desiredTick = desired;
      if (next === drag.currentTick) return;
      drag.currentTick = next;
      setDragPreview({ clipId: drag.clipId, tick: next });
    },
    [project, pxPerTick, snappingEnabled, tick],
  );

  /** 正在拖动的片段（用于关联组预览：同组片段一起偏移） */
  const draggedClipForPreview = useMemo(
    () =>
      dragPreview
        ? project.tracks.flatMap((track) => track.clips).find((item) => item.id === dragPreview.clipId) ?? null
        : null,
    [dragPreview, project],
  );

  const onClipPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (capturedPointer.current?.id !== event.pointerId) return;
    setClipGestureActive(false);
    releaseClipPointer();
    setSnapGuide(null);
    // 裁剪优先：手柄拖拽松手时提交一次 TrimClip（只进一次撤销栈）
    const trim = trimRef.current;
    trimRef.current = null;
    if (trim) {
      const plan = trimPlanRef.current;
      trimPlanRef.current = null;
      setTrimPreview(null);
      if (!plan || !onTrimClip) return;
      const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === trim.clipId);
      if (!clip) return;
      if (
        plan.timelineInTicks === clip.timelineInTicks &&
        plan.sourceInTicks === clip.sourceInTicks &&
        plan.sourceDurationTicks === clip.sourceDurationTicks
      ) {
        return; // 没变化：不产生空撤销记录
      }
      onTrimClip(trim.clipId, {
        sourceInTicks: plan.sourceInTicks,
        sourceDurationTicks: plan.sourceDurationTicks,
        timelineInTicks: plan.timelineInTicks,
      });
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    if (!drag) return;
    const plan = planClipMove(project, drag.clipId, drag.desiredTick);
    if (!plan) return;
    // 松手位置因重叠被夹紧：明确告诉用户，而不是悄悄落回原处
    if (plan.adjusted) {
      onMoveBlocked?.(
        plan.tick === plan.originTick
          ? '目标位置与同轨其它片段重叠，片段未移动。'
          : '目标位置与同轨其它片段重叠，已放到最近的不重叠位置。',
      );
    }
    if (plan.tick === plan.originTick) return;
    onMoveClip(drag.clipId, plan.tick);
  }, [onMoveBlocked, onMoveClip, onTrimClip, project, releaseClipPointer]);

  const closeContextMenu = (restoreFocus: boolean) => {
    if (restoreFocus) (contextMenu?.origin.isConnected ? contextMenu.origin : timelineRef.current)?.focus({ preventScroll: true });
    setContextMenu(null);
  };
  const openContextMenu = (target: HTMLElement, x: number, y: number) => {
    if (collapsed || (!target.closest('.timeline-inner') && target !== timelineRef.current)) return;
    cancelClipGesture();
    const item = target.closest<HTMLElement>('[data-timeline-kind]');
    const kind = item?.dataset.timelineKind;
    const id = item?.dataset.timelineId ?? null;
    const origin = item ?? timelineRef.current!;
    origin.focus({ preventScroll: true });
    if (kind === 'clip') onSelectClip(id);
    else if (kind === 'effect') onSelectEffect(id);
    else if (kind === 'step') onSelectStep(id);
    else { onSelectClip(null); onSelectEffect(null); onSelectStep(null); }
    setContextMenu({ x, y, id, origin, kind: kind === 'clip' || kind === 'effect' || kind === 'step' ? kind : 'empty' });
  };
  const selectContextAction = (item: ContextMenuItem) => {
    if (item.disabled) return;
    const origin = contextMenu?.origin;
    setContextMenu(null);
    item.onSelect();
    requestAnimationFrame(() => {
      const selected = timelineRef.current?.querySelector<HTMLElement>('.tl-clip.is-selected,.tl-effect.is-selected,.tl-step-band.is-selected');
      (selected ?? (origin?.isConnected ? origin : timelineRef.current))?.focus({ preventScroll: true });
    });
  };
  const contextKind = contextMenu?.kind ?? 'empty';
  const contextEffect = project.effects.find(effect => effect.id === contextMenu?.id);
  const contextStart = contextKind === 'clip'
    ? project.tracks.flatMap(track => track.clips).find(clip => clip.id === contextMenu?.id)?.timelineInTicks
    : contextKind === 'effect' ? contextEffect?.range.start
      : contextKind === 'step' ? (() => { const step = project.steps.find(step => step.id === contextMenu?.id); return step ? stepTimelineRange(project, step)?.start : undefined; })() : undefined;
  const contextLabel = contextKind === 'clip' ? '时间线片段' : contextKind === 'effect' ? '效果' : contextKind === 'step' ? '教程步骤' : '时间线';
  const contextItems: ContextMenuItem[] = [];
  if (contextStart !== undefined) contextItems.push({ id: 'seek', label: `定位到${contextKind === 'clip' ? '片段' : contextLabel}开头`, icon: 'stepBack', onSelect: () => onSeek(contextStart) });
  if (contextKind === 'clip' || contextKind === 'empty') contextItems.push({ id: 'split', label: '在播放头分割', icon: 'split', shortcut: 'Ctrl+B', keys: ['ctrl+b'], disabled: !canSplit, onSelect: onSplitAtPlayhead });
  if (contextKind === 'effect') contextItems.push({ id: 'copy', label: '复制效果', icon: 'copy', shortcut: 'Ctrl+C', keys: ['ctrl+c'], disabled: !contextEffect, onSelect: onCopyEffect });
  contextItems.push({ id: 'paste', label: '粘贴效果', icon: 'paste', shortcut: 'Ctrl+V', keys: ['ctrl+v'], disabled: !effectClipboardKind, onSelect: () => onPasteEffect() });
  if (contextKind === 'effect') contextItems.push({ id: 'paste-attributes', label: '只粘贴属性', icon: 'paste', shortcut: 'Ctrl+Shift+V', keys: ['ctrl+shift+v'], disabled: !contextEffect || contextEffect.kind !== effectClipboardKind, onSelect: () => onPasteEffect(true) });
  if (contextKind === 'empty') contextItems.push(
    { id: 'reveal', label: '定位播放头', icon: 'target', onSelect: revealPlayhead },
    { id: 'fit', label: '适应整个时间线', icon: 'zoomOut', onSelect: fitTimeline },
  );
  else contextItems.push({ id: 'delete', label: contextKind === 'clip' ? '删除时间线片段' : contextKind === 'effect' ? '删除效果' : '删除教程步骤', icon: 'trash', shortcut: 'Delete', keys: ['delete', 'backspace'], danger: true, separator: true, disabled: !canDelete, onSelect: onDeleteSelected });

  // ---- 刻度 ----
  // 好数步长（1/2/5×10ⁿ）按 128px 目标间距选取；minor 刻度 = major/2，偶数位为 major。
  const ticks = useMemo(() => {
    const secondsVisible = duration / TICKS_PER_SECOND;
    const targetCount = Math.max(3, Math.floor(contentWidth / 128));
    const rawStep = secondsVisible / targetCount;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 0.01))));
    const niceSteps = [1, 2, 5, 10].map((m) => m * magnitude);
    const step = niceSteps.find((s) => s >= rawStep) ?? niceSteps[niceSteps.length - 1];
    const minorStep = step / 2;
    const out: { tick: number; label: string; major: boolean }[] = [];
    for (let s = 0, i = 0; s <= secondsVisible + 0.001; s += minorStep, i++) {
      out.push({
        tick: Math.round(s * TICKS_PER_SECOND),
        label: formatRuler(s, step < 1),
        major: i % 2 === 0,
      });
    }
    return out;
  }, [contentWidth, duration]);

  const clipsOf = (kind: TrackKind): Clip[] => findTrack(project, kind)?.clips ?? [];
  const zoomEffects = useMemo(() => {
    const effects = project.effects.filter(effect => effect.kind === 'zoom');
    if (!dragPreview || !draggedClipForPreview) return effects;
    const group = linkedClips(project, draggedClipForPreview);
    const ranges = project.tracks.filter(track => track.kind === 'primaryVideo').flatMap(track =>
      track.clips.filter(clip => group.includes(clip)).map(clip => ({ start: clip.timelineInTicks, end: clipEndTick(clip) })));
    const preview = { ...project, effects: structuredClone(effects) };
    moveClipZooms(preview, ranges, dragPreview.tick - draggedClipForPreview.timelineInTicks);
    return preview.effects;
  }, [project, dragPreview, draggedClipForPreview]);
  const privacyEffects = useMemo(() => project.effects.filter((e) => e.kind === 'privacy'), [project.effects]);

  // ---- 音频波形（§10.4）----
  // 素材 id → 工程相对路径。音频轨的 clip 只带 assetId，画波形需要真实文件路径。
  const assetPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of project.assets) map.set(asset.id, asset.path);
    return map;
  }, [project.assets]);

  const assetPathOf = useCallback((assetId: string): string | null => assetPathMap.get(assetId) ?? null, [assetPathMap]);

  const waveformSource = useMemo(() => projectPath ? new WaveformSource(projectPath, wcs()) : null, [projectPath, project.id]);
  const loadWaveformPeaks = useCallback<WaveformPeakLoader>((...args) => {
    if (!waveformSource) return Promise.reject(new Error('工程尚未打开'));
    return waveformSource.load(...args);
  }, [waveformSource]);

  return (
    <section ref={timelineRef} className={cn('editor-timeline', collapsed && 'is-collapsed', waveformMode && 'is-waveform-mode')} aria-label="时间线" tabIndex={-1}
      data-keys="shift+f10 contextmenu"
      onContextMenu={event => {
        const target = event.target as HTMLElement;
        if (!target.closest('.timeline-inner')) return;
        event.preventDefault(); event.stopPropagation();
        openContextMenu(target, event.clientX, event.clientY);
      }}
      onKeyDown={event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const target = event.target as HTMLElement;
        if (!target.closest('.timeline-inner') && target !== event.currentTarget) return;
        event.preventDefault(); event.stopPropagation();
        const box = target.getBoundingClientRect();
        openContextMenu(target, Math.max(8, box.left + 12), Math.max(8, box.top + Math.min(box.height, 36)));
      }}
      style={{ height: !collapsed && customHeight !== null ? clampHeight(customHeight) : undefined }}>
      {!collapsed && <div className="timeline-resize-handle" role="separator" tabIndex={0}
        aria-label="调整时间线高度" aria-orientation="horizontal"
        aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={layoutHeight.timeline}
        aria-valuetext={`${layoutHeight.timeline} 像素`}
        title="拖动调整时间线高度，双击恢复默认；方向键微调"
        data-keys="arrowup arrowdown shift+arrowup shift+arrowdown home end escape"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          resizing.current = { y: event.clientY, height: layoutHeight.timeline, previous: customHeight };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (resizing.current) setCustomHeight(clampHeight(resizing.current.height + resizing.current.y - event.clientY));
        }}
        onPointerUp={event => {
          resizing.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          if (resizing.current) setCustomHeight(resizing.current.previous);
          resizing.current = null;
        }}
        onLostPointerCapture={() => { resizing.current = null; }}
        onDoubleClick={() => setCustomHeight(null)}
        onKeyDown={event => {
          const step = event.shiftKey ? 40 : 10;
          if (event.key === 'ArrowUp') setCustomHeight(previous => clampHeight(clampHeight(previous ?? layoutHeight.timeline) + step));
          else if (event.key === 'ArrowDown') setCustomHeight(previous => clampHeight(clampHeight(previous ?? layoutHeight.timeline) - step));
          else if (event.key === 'Home') setCustomHeight(minHeight);
          else if (event.key === 'End') setCustomHeight(maxHeight);
          else if (event.key === 'Escape' && resizing.current) {
            setCustomHeight(resizing.current.previous);
            resizing.current = null;
          } else return;
          event.preventDefault();
        }}><span aria-hidden="true" /></div>}
      <div className="timeline-toolbar">
        <IconButton
          icon={collapsed ? 'chevronRight' : 'chevronDown'}
          label={collapsed ? '展开时间线' : '收起时间线'}
          size="sm"
          onClick={onToggleCollapsed}
        />
        <IconButton icon="split" label="在播放头分割（Ctrl+B）" size="sm" disabled={!canSplit}
          title={canSplit ? '在播放头分割（Ctrl+B）' : '将播放头移到片段内部后分割'} onClick={onSplitAtPlayhead} />
        <IconButton icon="trash" label={deleteLabel} size="sm" variant="danger" disabled={!canDelete}
          title={canDelete ? deleteLabel : '先选择一个时间线片段、效果或教程步骤'} onClick={onDeleteSelected} />
        <button type="button" className="advanced-tracks-toggle" onClick={() => setShowAdvanced((v) => !v)} aria-pressed={showAdvanced}>
          <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} size={11} />
          {showAdvanced ? '隐藏高级轨道' : '显示高级轨道（运镜 / 遮挡 / 步骤）'}
        </button>
        <div className="timeline-toolbar-spacer" />
        <div className="timeline-display-toggle" role="group" aria-label="时间线显示">
          <ChoiceButton selected={!waveformMode} aria-pressed={!waveformMode} onClick={() => setWaveformMode(false)}><LineIcon kind="film" size={14} />画面</ChoiceButton>
          <ChoiceButton selected={waveformMode} aria-pressed={waveformMode} onClick={() => { setWaveformMode(true); setDetailTracks(true); }}><LineIcon kind="waveform" size={14} />波形</ChoiceButton>
          <span className="timeline-display-toggle-thumb" aria-hidden="true" style={{ transform: waveformMode ? 'translateX(calc(100% + 2px))' : 'translateX(0)' }} />
        </div>
        <div className="timeline-toolbar-spacer" />
        <button type="button" className="studio-track-toggle timeline-snap-toggle" aria-label="时间线吸附" aria-pressed={snappingEnabled}
          title={snappingEnabled ? '吸附已开启：靠近片段边界或播放头时对齐；Alt 临时跳过' : '吸附已关闭：点击开启边界对齐'}
          onClick={() => { setSnappingEnabled(enabled => !enabled); setSnapGuide(null); }}>
          <LineIcon kind="magnet" size={14} /><span>{snappingEnabled ? '吸附' : '吸附已关'}</span>
        </button>
        <button type="button" className="studio-track-toggle timeline-device-toggle" aria-label={detailTracks ? '收起音频 / 摄像头' : '音频 / 摄像头'}
          title={detailTracks ? '收起音频与摄像头轨道' : '显示音频与摄像头轨道'} aria-pressed={detailTracks} onClick={() => setDetailTracks(!detailTracks)}>
          <Icon name="volume" size={13} /><span>{detailTracks ? '收起音频 / 摄像头' : '音频 / 摄像头'}</span>
        </button>
        <IconButton icon="target" label="定位播放头" title={collapsed ? '展开时间线后定位播放头' : '将播放头移回可见区域，不改变播放位置'} size="sm" disabled={collapsed} onClick={revealPlayhead} />
        <div className="timeline-zoom">
          <button type="button" className="studio-track-toggle" aria-label="适应整个时间线" title="显示完整时间线" onClick={fitTimeline}>适应</button>
          <IconButton icon="zoomOut" label="缩小时间线" size="sm" disabled={effectiveZoom <= MIN_TIMELINE_ZOOM} onClick={() => changeZoom(effectiveZoom / 1.5)} />
          <input
            type="range"
            min={MIN_TIMELINE_ZOOM}
            max={MAX_TIMELINE_ZOOM}
            step={0.1}
            value={effectiveZoom}
            aria-label="时间线缩放"
            aria-valuetext={`${Math.round(effectiveZoom * 100)}%`}
            title="放大查看细节；缩放时保留播放头或视区中心的位置"
            onChange={(event) => changeZoom(Number(event.target.value))}
          />
          <IconButton icon="zoomIn" label="放大时间线" size="sm" disabled={effectiveZoom >= MAX_TIMELINE_ZOOM} onClick={() => changeZoom(effectiveZoom * 1.5)} />
          <span style={{ fontFamily: 'var(--font-mono)', minWidth: 34, textAlign: 'right' }}>{effectiveZoom.toFixed(1)}×</span>
        </div>
      </div>

      {contextMenu && <ContextMenu anchor={contextMenu} label={contextLabel} items={contextItems}
        hint={contextKind === 'clip' ? '只删除时间线片段，源素材文件保留。' : undefined}
        onClose={closeContextMenu} onSelect={selectContextAction} />}

      {!collapsed && (
        <div className="timeline-body">
          <div className="timeline-gutter">
            <div className="timeline-gutter-head" aria-hidden="true" />
            <div className="timeline-gutter-rows" ref={gutterRowsRef}
              onScroll={event => { if (scrollRef.current && scrollRef.current.scrollTop !== event.currentTarget.scrollTop) scrollRef.current.scrollTop = event.currentTarget.scrollTop; }}
              onWheel={event => {
                const node = scrollRef.current;
                if (!node || event.ctrlKey || event.metaKey) return;
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
                node.scrollTop += event.deltaY * unit;
                node.scrollLeft += event.deltaX * unit;
              }}>
              {rows.map((row) => {
                const isAudioRow = row.kind === 'mic' || row.kind === 'system';
                const muted = isAudioRow ? muteOf(row.kind as TrackKind) : false;
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={cn('timeline-row-label', isAudioRow && 'is-audio')}
                    onClick={() => {
                      if (isAudioRow) {
                        onToggleTrackMute(row.kind as TrackKind);
                        return;
                      }
                      if (row.kind === 'zoom' || row.kind === 'privacy') {
                        // 高级效果轨：选中播放头命中的效果，没有就选第一条
                        const effects = row.kind === 'zoom' ? zoomEffects : privacyEffects;
                        const hit =
                          effects.find((effect) => tick >= effect.range.start && tick < effect.range.end) ?? effects[0];
                        if (hit) onSelectEffect(hit.id);
                        return;
                      }
                      if (row.kind === 'step') {
                        // 步骤存源时间，播放头是成片时间：必须走映射才能判断「当前步骤」
                        const hit =
                          project.steps.find((step) => {
                            const range = stepTimelineRange(project, step);
                            return range !== null && tick >= range.start && tick < range.end;
                          }) ?? project.steps[0];
                        if (hit) onSelectStep(hit.id);
                        return;
                      }
                      // 视频轨：选中播放头所在片段，没有则选轨道第一段（与 title 承诺一致）
                      const clips = findTrack(project, row.kind as TrackKind)?.clips ?? [];
                      const hit = clips.find((clip) => tick >= clip.timelineInTicks && tick < clipEndTick(clip)) ?? clips[0];
                      if (hit) onSelectClip(hit.id);
                    }}
                    title={
                      isAudioRow
                        ? '点击切换该轨道静音'
                        : row.advanced
                          ? '点击选中该轨道上播放头处的条目'
                          : '点击选中该轨道片段'
                    }
                  >
                    <span
                      className="lane-icon"
                      aria-hidden="true"
                      style={{ ['--lane-tint' as string]: LANE_ICON[row.kind]?.tint, ['--lane-ink' as string]: LANE_ICON[row.kind]?.ink }}
                    >
                      <LineIcon kind={LANE_ICON[row.kind]?.kind ?? 'film'} size={12} />
                    </span>
                    <span>{row.label}</span>
                    {isAudioRow && <Icon name={muted ? 'eyeOff' : 'volume'} size={10} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="timeline-scroll" ref={scrollRef} onScroll={syncViewport}>
            <div
              className="timeline-inner"
              style={{ width: contentWidth }}
              onPointerDown={onScrubPointerDown}
              onPointerMove={onScrubPointerMove}
              onPointerUp={onScrubPointerUp}
              onPointerCancel={onScrubPointerUp}
            >
              {/* 刻度尺 + 拖拽 seek */}
              {snapGuide !== null && <div className="tl-snap-guide" style={{ left: tickToX(snapGuide) }} />}
              <div className="timeline-ruler" aria-hidden="true">
                {ticks.map((item) => (
                  <span
                    key={item.tick}
                    className={cn('timeline-tick', item.major && 'is-major')}
                    style={{ left: tickToX(item.tick) }}
                  >
                    {item.major ? item.label : ''}
                  </span>
                ))}
              </div>

              {rows.map((row) => {
                const isAudioRow = row.kind === 'mic' || row.kind === 'system';
                return (
                  <div key={row.key} className={cn('timeline-row', isAudioRow && 'is-audio')}>
                    {row.kind === 'zoom' &&
                      zoomEffects.map((effect) => {
                        const params = effect.parameters as ZoomParameters;
                        return (
                          <div
                            key={effect.id}
                            className={cn('tl-effect', 'is-zoom', selectedEffectId === effect.id && 'is-selected')}
                            style={{
                              left: tickToX(effect.range.start),
                              width: Math.max(8, tickToX(effect.range.end - effect.range.start)),
                            }}
                            role="button"
                            tabIndex={0}
                            data-timeline-kind="effect" data-timeline-id={effect.id}
                            data-keys="enter space shift+f10 contextmenu"
                            aria-label={`运镜 ${params.scale.toFixed(2)} 倍，${formatDuration(effect.range.start)} 到 ${formatDuration(effect.range.end)}`}
                            onClick={() => onSelectEffect(effect.id)}
                            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectEffect(effect.id); } }}
                            title={`运镜 ${params.scale.toFixed(2)}× · ${effect.locked ? '已锁定' : '未锁定'} · ${effect.origin === 'automatic' ? '自动生成' : '手动'}`}
                          >
                            {effect.locked && <Icon name="lock" size={9} />}
                            {params.scale.toFixed(1)}× 运镜
                          </div>
                        );
                      })}

                    {row.kind === 'privacy' &&
                      privacyEffects.map((effect) => {
                        const params = effect.parameters as PrivacyParameters;
                        return (
                          <div
                            key={effect.id}
                            className={cn(
                              'tl-effect',
                              'is-privacy',
                              !params.confirmed && 'is-unconfirmed',
                              selectedEffectId === effect.id && 'is-selected',
                            )}
                            style={{
                              left: tickToX(effect.range.start),
                              width: Math.max(8, tickToX(effect.range.end - effect.range.start)),
                            }}
                            role="button"
                            tabIndex={0}
                            data-timeline-kind="effect" data-timeline-id={effect.id}
                            data-keys="enter space shift+f10 contextmenu"
                            aria-label={`遮挡区域，${params.confirmed ? '已确认' : '未确认（未遮挡）'}，样式 ${styleText(params.style)}`}
                            onClick={() => onSelectEffect(effect.id)}
                            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectEffect(effect.id); } }}
                            title={`${params.confirmed ? '已确认遮挡' : '未确认，导出时不会视为已遮挡'} · ${styleText(params.style)}`}
                          >
                            {params.confirmed ? <Icon name="shield" size={9} /> : <Icon name="warning" size={9} />}
                            {params.confirmed ? '已遮挡' : '未确认'}
                          </div>
                        );
                      })}

                    {row.kind === 'step' &&
                      project.steps.map((step, index) => {
                        // 已被剪掉的步骤不画带（否则会出现在错误的位置上）
                        const band = stepTimelineRange(project, step);
                        if (!band) return null;
                        return (
                        <div
                          key={step.id}
                          className={cn('tl-step-band', selectedStepId === step.id && 'is-selected')}
                          style={{
                            left: tickToX(band.start),
                            width: Math.max(10, tickToX(band.end - band.start)),
                          }}
                          role="button"
                          tabIndex={0}
                          data-timeline-kind="step" data-timeline-id={step.id}
                          data-keys="enter space shift+f10 contextmenu"
                          aria-label={`步骤 ${index + 1} ${step.title}`}
                          onClick={() => onSelectStep(step.id)}
                          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectStep(step.id); } }}
                          title={`步骤 ${index + 1}：${step.title}`}
                        >
                          {index + 1}. {step.title}
                        </div>
                        );
                      })}

                    {(row.kind === 'primaryVideo' || row.kind === 'camera' || row.kind === 'mic' || row.kind === 'system') &&
                      clipsOf(row.kind).map((clip) => {
                        const trimming = trimPreview?.clipId === clip.id ? trimPreview : null;
                        const width = Math.max(
                          6,
                          tickToX(trimming ? trimming.spanTicks : clipEndTick(clip) - clip.timelineInTicks),
                        );
                        const dragging = dragPreview?.clipId === clip.id;
                        // 关联组预览：拖动主轨时，同组的摄像头/音频片段跟着一起偏移，
                        // 而不是松手后才「瞬移」到新位置（用户会以为它们没联动）。
                        const draggedClip = draggedClipForPreview;
                        const followsDrag =
                          !trimming &&
                          !dragging &&
                          !!dragPreview &&
                          !!clip.linkGroupId &&
                          clip.linkGroupId === draggedClip?.linkGroupId;
                        const groupOffset =
                          followsDrag && dragPreview && draggedClip
                            ? dragPreview.tick - draggedClip.timelineInTicks
                            : 0;
                        const leftTick = trimming
                          ? trimming.timelineInTicks
                          : dragging && dragPreview
                            ? dragPreview.tick
                            : Math.max(0, clip.timelineInTicks + groupOffset);
                        return (
                          <div
                            key={clip.id}
                            className={cn('tl-clip', isAudioRow && 'is-audio-clip', isAudioRow && muteOf(row.kind as TrackKind) && 'is-muted', selectedClipId === clip.id && 'is-selected', dragging && 'is-dragging')}
                            style={{
                              left: tickToX(leftTick),
                              width,
                            }}
                            role="button"
                            tabIndex={0}
                            data-timeline-kind="clip" data-timeline-id={clip.id}
                            // 声明本元素自己处理方向键：全局快捷键先查这个属性并让路
                            data-keys={clipGestureActive ? GESTURE_KEYS : CLIP_KEYS}
                            aria-label={`${TRACK_LABEL[row.kind as TrackKind]} 片段，${formatDuration(leftTick)} 到 ${formatDuration(leftTick + (clipEndTick(clip) - clip.timelineInTicks))}${dragging ? '，正在拖动' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectClip(clip.id);
                            }}
                            onPointerDown={(event) => onClipPointerDown(event, clip)}
                            onPointerMove={onClipPointerMove}
                            onPointerUp={onClipPointerUp}
                            onPointerCancel={cancelClipGesture}
                            onLostPointerCapture={() => { if (capturedPointer.current) cancelClipGesture(); }}
                            onKeyDown={(event) => {
                              if (dragRef.current || trimRef.current) {
                                if (event.key === 'Escape') cancelClipGesture();
                                if (GESTURE_KEYS.split(' ').includes(normalizeShortcutEvent(event.nativeEvent))) {
                                  event.preventDefault(); event.stopPropagation();
                                }
                                return;
                              }
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onSelectClip(clip.id);
                                return;
                              }
                              // 键盘重排：左右方向键移动 0.5 秒，按住 Shift 移动 1 帧（R08 / §6.4 键盘可达）
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                                event.preventDefault();
                                event.stopPropagation();
                                const fps = project.settings.fps;
                                const frameTicks = Math.max(1, Math.round((TICKS_PER_SECOND * fps.den) / fps.num));
                                const stepTicks = event.shiftKey ? frameTicks : TICKS_PER_SECOND / 2;
                                const delta = event.key === 'ArrowLeft' ? -stepTicks : stepTicks;
                                const nextTick = Math.max(0, Math.round(clip.timelineInTicks + delta));
                                onMoveClip(clip.id, nextTick);
                              }
                            }}
                            title={`${TRACK_LABEL[row.kind as TrackKind]} · ${formatDuration(clip.sourceDurationTicks)} · 拖动吸附到片段边缘/播放头，Alt 暂停磁吸，双击定位`}
                            onDoubleClick={() => onSeek(clip.timelineInTicks)}
                          >
                            {!isAudioRow && <VideoThumbnails project={project} clip={clip} width={width} camera={row.kind === 'camera'} media={thumbnailMedia} />}
                            {isAudioRow && clip.assetId && (
                              <AudioWaveform
                                assetId={clip.assetId}
                                relativePath={assetPathOf(clip.assetId) ?? ''}
                                sourceFromSeconds={ticksToSeconds(clip.sourceInTicks)}
                                durationSeconds={ticksToSeconds(clip.sourceDurationTicks)}
                                width={width}
                                height={waveformMode ? 40 : 26}
                                loadPeaks={loadWaveformPeaks}
                                className="tl-waveform"
                              />
                            )}
                            <span className="tl-clip-label">
                              {formatClipLength(clipEndTick(clip) - clip.timelineInTicks)}
                            </span>
                            <span className="tl-clip-handle is-left" aria-hidden="true" />
                            <span className="tl-clip-handle is-right" aria-hidden="true" />
                          </div>
                        );
                      })}

                    {row.kind === 'step' &&
                      project.markers.map((marker) => (
                        <div
                          key={marker.id}
                          className="tl-marker"
                          style={{ left: tickToX(marker.mediaTick) }}
                          title={`标记：${marker.note || '（无备注）'} @ ${formatDuration(marker.mediaTick)}`}
                          role="button"
                          tabIndex={0}
                          aria-label={`标记 ${marker.note || '无备注'}`}
                          onClick={() => onSeek(marker.mediaTick)}
                          onKeyDown={(event) => event.key === 'Enter' && onSeek(marker.mediaTick)}
                        />
                      ))}
                  </div>
                );
              })}

              {/* 播放头：tick 可能因删除/撤销而暂时超出新时长，显示时夹到内容范围内 */}
              <div className="tl-playhead" style={{ left: tickToX(Math.max(0, Math.min(tick, duration))) }} aria-hidden="true" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function formatRuler(seconds: number, showCentiseconds: boolean): string {
  if (showCentiseconds) {
    const total = Math.round(seconds * 100);
    const m = Math.floor(total / 6000);
    const s = Math.floor(total / 100) % 60;
    const cs = total % 100;
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 片段右下角的短时长徽章：4.7s / 12.6s。 */
function formatClipLength(ticks: number): string {
  const seconds = ticks / TICKS_PER_SECOND;
  return `${seconds >= 100 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

function styleText(style: PrivacyParameters['style']): string {
  return style === 'solid' ? '实色' : style === 'blur' ? '模糊' : '马赛克';
}
