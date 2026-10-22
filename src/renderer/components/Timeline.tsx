/**
 * 时间线（§6.1）
 *
 * - 轨道顺序：主视频 / 摄像头 / 麦克风 / 系统声音 / 运镜 / 遮挡 / 步骤标记。
 * - 初始只展开常用轨道（画面 + 两条音频），运镜、遮挡、步骤标记等高级轨道按需展开。
 * - 片段块、播放头、可拖拽 seek、可缩放。
 * - 删除时间线片段 ≠ 删除源素材：这里只做前者，文案也明确区分。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Clip, Effect, Project, Track, TrackKind } from '@domain/project';
import { findTrack, timelineDuration } from '@domain/project';
import { TICKS_PER_SECOND, formatDuration, ticksToSeconds } from '@domain/timebase';
import type { PrivacyParameters, ZoomParameters } from '@domain/project';
import { cn } from '../lib/format';
import { Badge, Icon, IconButton } from './ui';
import { AudioWaveform } from './AudioWaveform';

const TRACK_LABEL: Record<TrackKind, string> = {
  primaryVideo: '主视频',
  camera: '摄像头',
  mic: '麦克风',
  system: '系统声音',
};

const TRACK_COLOR: Record<TrackKind, string> = {
  primaryVideo: 'linear-gradient(180deg, #2f6df6, #2757c4)',
  camera: 'linear-gradient(180deg, #7b5cd6, #5f45b4)',
  mic: 'linear-gradient(180deg, #2f9c72, #257a5a)',
  system: 'linear-gradient(180deg, #2b8fa8, #22718a)',
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

const GUTTER_WIDTH = 132;
const BASE_PX_PER_SECOND = 34;

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
  zoom,
  onZoomChange,
  collapsed,
  onToggleCollapsed,
  projectPath,
}: TimelineProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [mutedTracks, setMutedTracks] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);

  const duration = useMemo(() => Math.max(timelineDuration(project), TICKS_PER_SECOND), [project]);
  const pxPerTick = (BASE_PX_PER_SECOND * zoom) / TICKS_PER_SECOND;
  const contentWidth = Math.max(600, (duration / TICKS_PER_SECOND) * BASE_PX_PER_SECOND * zoom + 80);

  const rows = useMemo(() => ROWS.filter((row) => showAdvanced || !row.advanced), [showAdvanced]);

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
  const dragRef = useRef<{ clipId: string; startX: number; originTick: number; currentTick: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ clipId: string; tick: number } | null>(null);

  const onClipPointerDown = useCallback(
    (event: React.PointerEvent, clip: Clip) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      onSelectClip(clip.id);
      dragRef.current = {
        clipId: clip.id,
        startX: event.clientX,
        originTick: clip.timelineInTicks,
        currentTick: clip.timelineInTicks,
      };
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [onSelectClip],
  );

  const onClipPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaTicks = Math.round((event.clientX - drag.startX) / pxPerTick);
      // 吸附到 10ms 网格，避免拖出无法复现的零头
      const snapped = Math.round((drag.originTick + deltaTicks) / 100_000) * 100_000;
      const next = Math.max(0, snapped);
      if (next === drag.currentTick) return;
      drag.currentTick = next;
      setDragPreview({ clipId: drag.clipId, tick: next });
    },
    [pxPerTick],
  );

  const onClipPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    if (!drag) return;
    if (drag.currentTick === drag.originTick) return;
    onMoveClip(drag.clipId, drag.currentTick);
  }, [onMoveClip]);

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
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>时间线</span>
        <Badge tone="muted">{`${project.tracks.reduce((acc, t) => acc + t.clips.length, 0)} 片段`}</Badge>
        <div className="stage-toolbar-divider" />
        <IconButton icon="split" label="在播放头分割（Ctrl+B）" size="sm" onClick={onSplitAtPlayhead} />
        <IconButton icon="trash" label="删除所选时间线片段（Delete，不删除源素材）" size="sm" variant="danger" onClick={onDeleteSelected} />
        <button type="button" className="advanced-tracks-toggle" onClick={() => setShowAdvanced((v) => !v)} aria-pressed={showAdvanced}>
          <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} size={11} />
          {showAdvanced ? '隐藏高级轨道' : '显示高级轨道（运镜 / 遮挡 / 步骤）'}
        </button>
        <div className="timeline-toolbar-spacer" />
        <div className="timeline-zoom">
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
              {rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className={cn('timeline-row-label', (row.kind === 'mic' || row.kind === 'system') && 'is-audio')}
                  onClick={() => {
                    if (row.kind === 'mic' || row.kind === 'system') {
                      onToggleTrackMute(row.kind);
                      setMutedTracks((prev) => ({ ...prev, [row.kind]: !prev[row.kind] }));
                    }
                  }}
                  title={
                    row.kind === 'mic' || row.kind === 'system'
                      ? '点击切换该轨道静音'
                      : row.advanced
                        ? '高级轨道'
                        : '点击选中该轨道片段'
                  }
                >
                  <span
                    className="row-kind-dot"
                    style={{
                      background:
                        row.kind === 'zoom'
                          ? '#4c8dff'
                          : row.kind === 'privacy'
                            ? '#ef5f5f'
                            : row.kind === 'step'
                              ? '#45c08a'
                              : row.kind === 'marker'
                                ? '#45c08a'
                                : undefined,
                    }}
                  />
                  <span>{row.label}</span>
                  {(row.kind === 'mic' || row.kind === 'system') && (
                    <Icon name={mutedTracks[row.kind] ? 'eyeOff' : 'volume'} size={10} className="" />
                  )}
                  {row.advanced && <Badge tone="muted">高级</Badge>}
                </button>
              ))}
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
                const isAudio = row.kind === 'mic' || row.kind === 'system';
                return (
                  <div key={row.key} className={cn('timeline-row', isAudio && 'is-audio')}>
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
                      project.steps.map((step, index) => (
                        <div
                          key={step.id}
                          className="tl-step-band"
                          style={{
                            left: tickToX(step.sourceRange.start),
                            width: Math.max(10, tickToX(step.sourceRange.end - step.sourceRange.start)),
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
                      ))}

                    {(row.kind === 'primaryVideo' || row.kind === 'camera' || row.kind === 'mic' || row.kind === 'system') &&
                      clipsOf(row.kind).map((clip) => {
                        const width = Math.max(6, tickToX(clip.sourceDurationTicks));
                        const isAudio = row.kind === 'mic' || row.kind === 'system';
                        const dragging = dragPreview?.clipId === clip.id;
                        const leftTick = dragging ? dragPreview!.tick : clip.timelineInTicks;
                        return (
                          <div
                            key={clip.id}
                            className={cn('tl-clip', selectedClipId === clip.id && 'is-selected', dragging && 'is-dragging')}
                            style={{
                              left: tickToX(leftTick),
                              width,
                              background: TRACK_COLOR[row.kind as TrackKind],
                            }}
                            role="button"
                            tabIndex={0}
                            aria-label={`${TRACK_LABEL[row.kind as TrackKind]} 片段，${formatDuration(leftTick)} 到 ${formatDuration(leftTick + clip.sourceDurationTicks)}${dragging ? '，正在拖动' : ''}`}
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
                                const stepTicks = event.shiftKey ? TICKS_PER_SECOND / 30 : TICKS_PER_SECOND / 2;
                                const delta = event.key === 'ArrowLeft' ? -stepTicks : stepTicks;
                                const nextTick = Math.max(0, Math.round(clip.timelineInTicks + delta));
                                onMoveClip(clip.id, nextTick);
                              }
                            }}
                            title={`${TRACK_LABEL[row.kind as TrackKind]} · ${formatDuration(clip.sourceDurationTicks)} · 拖动重排，双击定位`}
                            onDoubleClick={() => onSeek(clip.timelineInTicks)}
                          >
                            {/* 音频轨叠加真实波形（§10.4）；读不到就退回纯色块 */}
                            {isAudio && clip.assetId && (
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

              {/* 播放头 */}
              <div className="tl-playhead" style={{ left: tickToX(tick) }} aria-hidden="true" />

              {/* 覆盖整层的拖拽 seek 层（在播放头之下、片段之上不可行，改为事件冒泡处理） */}
              <div
                className="tl-scrub-layer"
                style={{ pointerEvents: 'none' }}
                aria-hidden="true"
              />
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
