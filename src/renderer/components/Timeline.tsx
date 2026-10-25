/**
 * 时间线（§6.1）
 *
 * - 轨道顺序：主视频 / 摄像头 / 麦克风 / 系统声音 / 运镜 / 遮挡 / 步骤标记。
 * - 初始只展开常用轨道（画面 + 两条音频），运镜、遮挡、步骤标记等高级轨道按需展开。
 * - 片段块、播放头、可拖拽 seek、可缩放。
 * - 删除时间线片段 ≠ 删除源素材：这里只做前者，文案也明确区分。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, PrivacyParameters, Project, TrackKind, ZoomParameters } from '@domain/project';
import { findTrack, timelineDuration } from '@domain/project';
import { stepTimelineRange } from '@domain/tutorial';
import { planGroupMove } from '@domain/clipEditing';
import { TICKS_PER_SECOND, formatDuration, ticksToSeconds } from '@domain/timebase';
import type { Ticks } from '@domain/timebase';
import { cn } from '../lib/format';
import { Badge, Icon, IconButton } from './ui';
import { AudioWaveform } from './AudioWaveform';
import { VideoThumbnails } from './VideoThumbnails';
import { usePreviewMedia } from '../lib/previewSource';
import { timelineSnapTargets, snapPosition } from '@domain/snapping';

const TRACK_LABEL: Record<TrackKind, string> = {
  primaryVideo: '主视频',
  camera: '摄像头',
  mic: '麦克风',
  system: '系统声音',
};

/**
 * 轨道配色（§P1）：颜色只表达稳定的轨道类别，不靠渐变抢预览。
 * 片段底色用低饱和中性色，类别色只出现在左侧色条与标签圆点上。
 */
const TRACK_STYLE: Record<TrackKind, { accent: string; background: string }> = {
  primaryVideo: { accent: '#77a9ff', background: 'rgba(119, 169, 255, 0.16)' },
  camera: { accent: '#b39ddb', background: 'rgba(179, 157, 219, 0.16)' },
  mic: { accent: '#4fc08d', background: 'rgba(79, 192, 141, 0.16)' },
  system: { accent: '#5fbccd', background: 'rgba(95, 188, 205, 0.16)' },
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
  /** 工程根目录绝对路径，波形读取 WAV 时需要（可选，缺省时波形退化为色块） */
  projectPath?: string | null;
}

/** 只取波形读取需要的那一小部分 API，避免把整个 WcsApi 类型拖进来。 */
interface WcsLike {
  readExportFile?: (path: string) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
}

interface RowDef {
  key: string;
  label: string;
  kind: TrackKind | 'zoom' | 'privacy' | 'step' | 'marker';
  advanced: boolean;
}

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
  useEffect(() => { if (hasZoom) setShowAdvanced(true); }, [project.id, hasZoom]);
  const thumbnailMedia = usePreviewMedia(projectPath ?? null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
  const fitPixelsPerSecond = Math.max(1, (viewportWidth - 55) / (duration / TICKS_PER_SECOND));
  const pxPerTick = (fitPixelsPerSecond * zoom) / TICKS_PER_SECOND;
  const contentWidth = Math.max(viewportWidth, (duration / TICKS_PER_SECOND) * fitPixelsPerSecond * zoom + 55);

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

  const onClipPointerDown = useCallback(
    (event: React.PointerEvent, clip: Clip) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      onSelectClip(clip.id);
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
    (event: React.PointerEvent) => {
      const trim = trimRef.current;
      if (trim) {
        const deltaTicks = Math.round((event.clientX - trim.startX) / pxPerTick);
        // 吸附到 10ms 网格，与移动保持同一手感
        const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === trim.clipId)!;
        const edge = trim.edge === 'left' ? clip.timelineInTicks : clipEndTick(clip);
        const snap = event.altKey ? { value: edge + deltaTicks, guide: null } : snapPosition(edge + deltaTicks, timelineSnapTargets(project, trim.clipId, tick), 8 / pxPerTick);
        const plan = planClipTrim(project, trim.clipId, trim.edge, snap.value - edge);
        const actualEdge = plan ? plan.timelineInTicks + (trim.edge === 'right' ? plan.spanTicks : 0) : null;
        setSnapGuide(actualEdge !== null && Math.abs(actualEdge - snap.value) <= 1 ? snap.guide : null);
        if (plan) setTrimPreview(plan);
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const deltaTicks = Math.round((event.clientX - drag.startX) / pxPerTick);
      // 吸附到 10ms 网格，避免拖出无法复现的零头
      const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === drag.clipId)!;
      const snap = event.altKey ? { value: drag.originTick + deltaTicks, guide: null } : snapPosition(drag.originTick + deltaTicks,
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
    [project, pxPerTick, tick],
  );

  /** 正在拖动的片段（用于关联组预览：同组片段一起偏移） */
  const draggedClipForPreview = useMemo(
    () =>
      dragPreview
        ? project.tracks.flatMap((track) => track.clips).find((item) => item.id === dragPreview.clipId) ?? null
        : null,
    [dragPreview, project],
  );

  const onClipPointerUp = useCallback(() => {
    setSnapGuide(null);
    // 裁剪优先：手柄拖拽松手时提交一次 TrimClip（只进一次撤销栈）
    const trim = trimRef.current;
    trimRef.current = null;
    if (trim) {
      const plan = trimPreview;
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
  }, [onMoveBlocked, onMoveClip, onTrimClip, project, trimPreview]);

  // ---- 刻度 ----
  const ticks = useMemo(() => {
    const secondsVisible = duration / TICKS_PER_SECOND;
    const targetCount = Math.max(4, Math.floor(contentWidth / 74));
    const rawStep = secondsVisible / targetCount;
    const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = niceSteps.find((s) => s >= rawStep) ?? 600;
    const out: { tick: number; label: string; major: boolean }[] = [];
    for (let s = 0; s <= secondsVisible + 0.001; s += step) {
      out.push({
        tick: Math.round(s * TICKS_PER_SECOND),
        label: step >= 1 ? formatShort(s) : `${s.toFixed(1)}s`,
        major: Math.abs(s % (step * 2)) < 1e-6,
      });
    }
    return out;
  }, [contentWidth, duration]);

  const clipsOf = (kind: TrackKind): Clip[] => findTrack(project, kind)?.clips ?? [];
  const zoomEffects = useMemo(() => project.effects.filter((e) => e.kind === 'zoom'), [project.effects]);
  const privacyEffects = useMemo(() => project.effects.filter((e) => e.kind === 'privacy'), [project.effects]);

  // ---- 音频波形（§10.4）----
  // 素材 id → 工程相对路径。音频轨的 clip 只带 assetId，画波形需要真实文件路径。
  const assetPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of project.assets) map.set(asset.id, asset.path);
    return map;
  }, [project.assets]);

  const assetPathOf = useCallback((assetId: string): string | null => assetPathMap.get(assetId) ?? null, [assetPathMap]);

  /**
   * 读素材字节给波形用。
   *
   * 注意：这里的相对路径是「工程内相对路径」，IPC 要绝对路径。
   * 拿不到工程目录时直接返回 null，波形退化成纯色块而不是报错。
   */
  const readAssetBytes = useCallback(
    async (relativePath: string): Promise<ArrayBuffer | null> => {
      if (!relativePath) return null;
      try {
        const api = (window as unknown as { wcs?: WcsLike }).wcs;
        if (!api?.readExportFile || !projectPath) return null;
        const normalized = relativePath.replace(/[\\/]+/g, '\\');
        const absolute = `${projectPath.replace(/[\\/]+$/, '')}\\${normalized}`;
        const response = await api.readExportFile(absolute);
        if (!response?.ok || !response.data) return null;
        const bytes = response.data as Uint8Array;
        // Uint8Array 可能只是更大 ArrayBuffer 的视图，必须按 offset 切出来
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } catch {
        return null;
      }
    },
    [projectPath],
  );

  return (
    <section className={cn('editor-timeline', collapsed && 'is-collapsed')} aria-label="时间线">
      <div className="timeline-toolbar">
        <IconButton
          icon={collapsed ? 'chevronRight' : 'chevronDown'}
          label={collapsed ? '展开时间线' : '收起时间线'}
          size="sm"
          onClick={onToggleCollapsed}
        />
        <span style={{ fontSize: 'var(--fs-aux)', color: 'var(--text-muted)', fontWeight: 500 }}>时间线</span>
        <Badge tone="muted">{`${project.tracks.reduce((acc, t) => acc + t.clips.length, 0)} 片段`}</Badge>
        <div className="stage-toolbar-divider" />
        <IconButton icon="split" label="在播放头分割（Ctrl+B）" size="sm" onClick={onSplitAtPlayhead} />
        <IconButton icon="trash" label="删除所选时间线片段（Delete，不删除源素材）" size="sm" variant="danger" onClick={onDeleteSelected} />
        <button type="button" className="advanced-tracks-toggle" onClick={() => setShowAdvanced((v) => !v)} aria-pressed={showAdvanced}>
          <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} size={11} />
          {showAdvanced ? '隐藏高级轨道' : '显示高级轨道（运镜 / 遮挡 / 步骤）'}
        </button>
        <div className="timeline-toolbar-spacer" />
        <button className="studio-track-toggle" aria-pressed={detailTracks} onClick={() => setDetailTracks(!detailTracks)}><Icon name="volume" size={13} />{detailTracks ? '收起音频 / 摄像头' : '音频 / 摄像头'}</button>
        <div className="timeline-zoom">
          <button className="studio-track-toggle" aria-label="适应整个时间线" onClick={() => onZoomChange(1)}>适应</button>
          <Icon name="zoomOut" size={12} />
          <input
            type="range"
            min={0.4}
            max={5}
            step={0.1}
            value={zoom}
            aria-label="时间线缩放"
            onChange={(event) => onZoomChange(Number(event.target.value))}
          />
          <Icon name="zoomIn" size={12} />
          <span style={{ fontFamily: 'var(--font-mono)', minWidth: 34, textAlign: 'right' }}>{zoom.toFixed(1)}×</span>
        </div>
      </div>

      {!collapsed && (
        <div className="timeline-body">
          <div className="timeline-gutter">
            <div className="timeline-gutter-head">轨道</div>
            <div className="timeline-gutter-rows">
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
                      className="row-kind-dot"
                      style={{
                        background:
                          row.kind === 'zoom'
                            ? '#77a9ff'
                            : row.kind === 'privacy'
                              ? '#ff5c69'
                              : row.kind === 'step'
                                ? '#4fc08d'
                                : row.kind === 'marker'
                                  ? '#4fc08d'
                                  : TRACK_STYLE[row.kind as TrackKind].accent,
                      }}
                    />
                    <span>{row.label}</span>
                    {isAudioRow && <Icon name={muted ? 'eyeOff' : 'volume'} size={10} />}
                    {row.advanced && <Badge tone="muted">高级</Badge>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="timeline-scroll" ref={scrollRef}>
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
                            aria-label={`运镜 ${params.scale.toFixed(2)} 倍，${formatDuration(effect.range.start)} 到 ${formatDuration(effect.range.end)}`}
                            onClick={() => onSelectEffect(effect.id)}
                            onKeyDown={(event) => event.key === 'Enter' && onSelectEffect(effect.id)}
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
                            aria-label={`遮挡区域，${params.confirmed ? '已确认' : '未确认（未遮挡）'}，样式 ${styleText(params.style)}`}
                            onClick={() => onSelectEffect(effect.id)}
                            onKeyDown={(event) => event.key === 'Enter' && onSelectEffect(effect.id)}
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
                          className="tl-step-band"
                          style={{
                            left: tickToX(band.start),
                            width: Math.max(10, tickToX(band.end - band.start)),
                            ...(selectedStepId === step.id
                              ? { boxShadow: '0 0 0 1px #4c8dff', background: 'rgba(69,192,138,0.28)' }
                              : null),
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`步骤 ${index + 1} ${step.title}`}
                          onClick={() => onSelectStep(step.id)}
                          onKeyDown={(event) => event.key === 'Enter' && onSelectStep(step.id)}
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
                            className={cn('tl-clip', selectedClipId === clip.id && 'is-selected', dragging && 'is-dragging')}
                            style={{
                              left: tickToX(leftTick),
                              width,
                              background: TRACK_STYLE[row.kind as TrackKind].background,
                              ['--clip-accent' as string]: TRACK_STYLE[row.kind as TrackKind].accent,
                            }}
                            role="button"
                            tabIndex={0}
                            // 声明本元素自己处理方向键：全局快捷键先查这个属性并让路
                            data-keys="arrowleft arrowright enter"
                            aria-label={`${TRACK_LABEL[row.kind as TrackKind]} 片段，${formatDuration(leftTick)} 到 ${formatDuration(leftTick + (clipEndTick(clip) - clip.timelineInTicks))}${dragging ? '，正在拖动' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectClip(clip.id);
                            }}
                            onPointerDown={(event) => onClipPointerDown(event, clip)}
                            onPointerMove={onClipPointerMove}
                            onPointerUp={onClipPointerUp}
                            onPointerCancel={onClipPointerUp}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
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
                            {/* 音频轨叠加真实波形（§10.4）；读不到就退回纯色块 */}
                            {!isAudioRow && <VideoThumbnails project={project} clip={clip} width={width} camera={row.kind === 'camera'} media={thumbnailMedia} />}
                            {isAudioRow && clip.assetId && (
                              <AudioWaveform
                                assetId={clip.assetId}
                                relativePath={assetPathOf(clip.assetId) ?? ''}
                                sourceFromSeconds={ticksToSeconds(clip.sourceInTicks)}
                                durationSeconds={ticksToSeconds(clip.sourceDurationTicks)}
                                width={width}
                                height={22}
                                readFile={readAssetBytes}
                                className="tl-waveform"
                              />
                            )}
                            <span className="tl-clip-label">
                              {TRACK_LABEL[row.kind as TrackKind]} {formatDuration(clip.sourceDurationTicks)}
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

function formatShort(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function styleText(style: PrivacyParameters['style']): string {
  return style === 'solid' ? '实色' : style === 'blur' ? '模糊' : '马赛克';
}
