/**
 * 编辑器（§6.1 / §6.3）
 *
 * 布局：预览区 + 属性面板 + 底部时间线。
 *
 * 键盘：
 * - 空格播放/暂停，←/→ 逐帧，Shift+←/→ 逐秒
 * - Ctrl+B 分割，Delete 删除所选片段，Ctrl+Z 撤销，Ctrl+Y 重做，Ctrl+S 保存
 * - 输入框获得焦点时，上述剪辑快捷键不抢文字输入（见 lib/hooks.ts isTextEntryTarget）
 *
 * 隐私遮挡：在预览上拖拽框选矩形 → 创建未确认遮挡 → 在属性面板设时间区间与样式 → 确认。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { useShortcuts, isTextEntryTarget } from '../lib/hooks';
import { Badge, Button, Icon, IconButton, InlineNote, Segmented, Spinner } from '../components/ui';
import { PreviewCanvas, useSourceToDisplay } from '../components/PreviewCanvas';
import { Timeline } from '../components/Timeline';
import { InspectorPanel } from '../components/InspectorPanel';
import { formatDuration, TICKS_PER_SECOND, ticksToSeconds, secondsToTicks } from '@domain/timebase';
import type { PrivacyParameters, PrivacyStyle } from '@domain/project';
import { timelineDuration } from '@domain/project';
import type { SetEffectCommand, DeleteRangeCommand } from '@domain/commands';
import { cn } from '../lib/format';
import type { FrameScene } from '@domain/scene';

type DragState = { kind: 'none' } | { kind: 'creating'; x0: number; y0: number; x1: number; y1: number };

export function EditorView() {
  const {
    project,
    projectLoading,
    projectError,
    projectPath,
    openProject,
    createProject,
    tick,
    setTick,
    playing,
    setPlaying,
    togglePlay,
    duration,
    execute,
    undo,
    redo,
    save,
    selectedClipId,
    selectClip,
    selectedEffectId,
    selectEffect,
    selectedStepId,
    selectStep,
    pushToast,
    apiMode,
    setView,
  } = useApp();

  const [zoom, setZoom] = useState(1);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [drag, setDrag] = useState<DragState>({ kind: 'none' });
  const [scene, setScene] = useState<FrameScene | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapSize, setWrapSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const { toDisplayRect, screenBox } = useSourceToDisplay(project ?? { ...emptyProjectFallback }, tick);

  const totalDuration = project ? timelineDuration(project) : 0;

  /**
   * 预览 contain 尺寸（§P0）。
   *
   * 只把 canvas 的固有尺寸交给 CSS 的 max-width/max-height 是不够的：百分比高度在
   * flex 行里没有确定参照高度，画布会被撑开并被容器裁掉（表现为上方大留白、下方
   * 源画面与摄像头被截断）。这里按「容器可用宽高 + 输出画幅」显式算出 contain 盒，
   * canvas 与遮挡层共用同一个盒子，横屏/竖屏/方形都能完整显示。
   */
  const outputAspect = useMemo(() => {
    if (scene && scene.outputWidth > 0 && scene.outputHeight > 0) return scene.outputWidth / scene.outputHeight;
    const aspect = project?.variants.find((v) => v.id === project.settings.activeVariantId)?.aspect;
    return aspect && aspect[1] > 0 ? aspect[0] / aspect[1] : 16 / 9;
  }, [scene, project]);

  const stageFit = useMemo(() => {
    const availW = Math.max(0, wrapSize.width);
    const availH = Math.max(0, wrapSize.height);
    if (availW <= 0 || availH <= 0) return { width: 0, height: 0 };
    let width = availW;
    let height = width / outputAspect;
    if (height > availH) {
      height = availH;
      width = height * outputAspect;
    }
    return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
  }, [wrapSize, outputAspect]);

  // 舞台可用尺寸：contain 计算的输入。视觉尺寸变化时重算，时间线折叠/展开也会跟着更新。
  // 依赖 hasProject：没有工程时编辑器走空态分支，wrapRef 还是 null，
  // 只写 [] 的话观察器永远不会挂上（表现为预览尺寸恒为 0）。
  const hasProject = !!project;
  useEffect(() => {
    if (!hasProject) return;
    const node = wrapRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      // 用内容盒（去掉 padding）作为可用区域
      const style = getComputedStyle(node);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setWrapSize({
        width: Math.max(0, Math.round(rect.width - padX)),
        height: Math.max(0, Math.round(rect.height - padY)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasProject]);

  // 键盘快捷键
  useShortcuts(
    [
      {
        combo: 'space',
        handler: () => togglePlay(),
      },
      {
        combo: 'arrowright',
        handler: (event) => {
          const fps = project?.settings.fps ?? { num: 30, den: 1 };
          const frameTicks = (fps.den * TICKS_PER_SECOND) / fps.num;
          setTick(Math.min(totalDuration, tick + (event.shiftKey ? TICKS_PER_SECOND : frameTicks)));
        },
      },
      {
        combo: 'arrowleft',
        handler: (event) => {
          const fps = project?.settings.fps ?? { num: 30, den: 1 };
          const frameTicks = (fps.den * TICKS_PER_SECOND) / fps.num;
          setTick(Math.max(0, tick - (event.shiftKey ? TICKS_PER_SECOND : frameTicks)));
        },
      },
      {
        combo: 'shift+arrowright',
        handler: () => setTick(Math.min(totalDuration, tick + TICKS_PER_SECOND)),
      },
      {
        combo: 'shift+arrowleft',
        handler: () => setTick(Math.max(0, tick - TICKS_PER_SECOND)),
      },
      {
        combo: 'home',
        handler: () => setTick(0),
      },
      {
        combo: 'end',
        handler: () => setTick(totalDuration),
      },
      {
        combo: 'ctrl+b',
        handler: () => splitAtPlayhead(),
      },
      {
        combo: 'delete',
        handler: () => deleteSelection(),
      },
      {
        combo: 'backspace',
        handler: () => deleteSelection(),
      },
      {
        combo: 'ctrl+z',
        handler: () => undo(),
      },
      {
        combo: 'ctrl+y',
        handler: () => redo(),
      },
      {
        combo: 'ctrl+shift+z',
        handler: () => redo(),
      },
      {
        combo: 'ctrl+s',
        handler: () => void save(),
      },
      {
        combo: 'escape',
        allowInInput: true,
        handler: () => {
          setPlaying(false);
          selectClip(null);
          selectEffect(null);
          selectStep(null);
        },
      },
    ],
    !!project,
  );

  const splitAtPlayhead = useCallback(() => {
    if (!project) return;
    if (tick <= 0 || tick >= totalDuration) {
      pushToast({ tone: 'warn', title: '播放头不在片段内', message: '把播放头移到要分割的位置再按 Ctrl+B。' });
      return;
    }
    execute({ kind: 'SplitClip', timelineTick: tick }, '分割片段');
  }, [execute, project, pushToast, tick, totalDuration]);

  const deleteSelection = useCallback(() => {
    if (!project) return;
    if (selectedEffectId) {
      execute({ kind: 'DeleteEffect', effectId: selectedEffectId }, '删除效果');
      selectEffect(null);
      return;
    }
    if (selectedStepId) {
      execute({ kind: 'DeleteStep', stepId: selectedStepId }, '删除教程步骤');
      selectStep(null);
      return;
    }
    if (!selectedClipId) {
      pushToast({ tone: 'info', title: '没有选中片段', message: '先在时间线上点选一个片段，或选中一个效果/步骤。' });
      return;
    }
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (!clip) continue;
      execute<DeleteRangeCommand>(
        {
          kind: 'DeleteRange',
          range: { start: clip.timelineInTicks, end: clip.timelineInTicks + clip.sourceDurationTicks },
          ripple: true,
        },
        '删除时间线片段（波纹）',
      );
      selectClip(null);
      pushToast({ tone: 'info', title: '已删除时间线片段', message: '源素材文件仍然保留。' });
      return;
    }
  }, [execute, project, pushToast, selectClip, selectEffect, selectStep, selectedClipId, selectedEffectId, selectedStepId]);

  // ---- 预览上框选遮挡 ----
  const onStagePointerDown = (event: React.PointerEvent) => {
    if (!project || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.stage-privacy-box')) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    setDrag({ kind: 'creating', x0: x, y0: y, x1: x, y1: y });
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onStagePointerMove = (event: React.PointerEvent) => {
    if (drag.kind !== 'creating') return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setDrag({ ...drag, x1: x, y1: y });
  };

  const onStagePointerUp = () => {
    if (drag.kind !== 'creating' || !project) return;
    const x0 = Math.min(drag.x0, drag.x1);
    const x1 = Math.max(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1);
    const y1 = Math.max(drag.y0, drag.y1);
    setDrag({ kind: 'none' });
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) {
      pushToast({ tone: 'info', title: '框选范围太小', message: '按住鼠标在预览上拖出一个矩形来创建遮挡。' });
      return;
    }
    // 显示坐标 → 源坐标（去掉画布内边距与运镜）
    const display = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const sx = screenBox.width > 0 ? (display.x - screenBox.left) / screenBox.width : 0;
    const sy = screenBox.height > 0 ? (display.y - screenBox.top) / screenBox.height : 0;
    const sw = screenBox.width > 0 ? display.width / screenBox.width : 0.2;
    const sh = screenBox.height > 0 ? display.height / screenBox.height : 0.1;
    const id = `privacy-${Date.now().toString(36)}`;
    const effect = {
      id,
      kind: 'privacy' as const,
      range: { start: Math.max(0, tick), end: Math.min(totalDuration, tick + secondsToTicks(5)) },
      anchor: 'screen' as const,
      parameters: {
        x: Math.max(0, Math.min(1 - Math.max(0.01, sw), sx)),
        y: Math.max(0, Math.min(1 - Math.max(0.01, sh), sy)),
        width: Math.max(0.01, Math.min(1, sw)),
        height: Math.max(0.01, Math.min(1, sh)),
        anchor: 'screen' as const,
        style: 'solid' as PrivacyStyle,
        confirmed: false,
      },
      origin: 'manual' as const,
      locked: false,
    };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect, lock: false }, '新建遮挡区域');
    selectEffect(id);
    pushToast({ tone: 'warn', title: '已创建遮挡区域（未确认）', message: '在右侧设置时间区间与样式，确认后才会真正遮挡。' });
  };

  // 拖拽中显示临时框
  const dragRect = useMemo(() => {
    if (drag.kind !== 'creating') return null;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    return {
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
      height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
    };
  }, [drag]);

  const privacyEffects = useMemo(() => (project ? project.effects.filter((e) => e.kind === 'privacy') : []), [project]);

  if (!project) {
    return (
      <div className="view">
        {projectLoading ? (
          <div className="wcs-empty" style={{ padding: 60 }}>
            <Spinner size={22} />
            <h3>正在打开工程…</h3>
          </div>
        ) : (
          <div className="wcs-empty" style={{ padding: 60 }}>
            <span className="wcs-empty-icon">
              <Icon name="editor" size={22} />
            </span>
            <h3>{projectError ? projectError.title : '还没有打开工程'}</h3>
            <p>{projectError ? projectError.message : '先录制一段，或打开一个已有工程。'}</p>
            <div className="wcs-empty-actions">
              <Button variant="primary" icon="record" onClick={() => setView('record')}>
                去录制
              </Button>
              <Button icon="folder" onClick={() => void openProject()}>
                打开工程
              </Button>
              <Button icon="plus" onClick={() => void createProject()}>
                新建空白工程
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const frameStep = (project.settings.fps.den * TICKS_PER_SECOND) / project.settings.fps.num;

  return (
    <div className="editor">
      <section className="editor-stage" aria-label="预览区">
        <div className="stage-toolbar">
          <div className="stage-toolbar-group">
            <IconButton
              icon="skipBack"
              label="回到开头（Home）"
              size="sm"
              onClick={() => {
                setPlaying(false);
                setTick(0);
              }}
            />
            <IconButton
              icon="stepBack"
              label="上一帧（←）"
              size="sm"
              onClick={() => {
                setPlaying(false);
                setTick(Math.max(0, tick - frameStep));
              }}
            />
            <IconButton
              icon={playing ? 'pause' : 'play'}
              label={playing ? '暂停（空格）' : '播放（空格）'}
              variant="secondary"
              size="md"
              onClick={togglePlay}
            />
            <IconButton
              icon="stepForward"
              label="下一帧（→）"
              size="sm"
              onClick={() => {
                setPlaying(false);
                setTick(Math.min(totalDuration, tick + frameStep));
              }}
            />
            <IconButton
              icon="skipForward"
              label="跳到结尾（End）"
              size="sm"
              onClick={() => {
                setPlaying(false);
                setTick(totalDuration);
              }}
            />
          </div>

          <div className="stage-toolbar-spacer" />

          {/* 剪辑工具（分割/删除）集中在时间线工具栏，这里只保留播放与遮挡提示（§P1） */}
          <div className="stage-toolbar-group">
            <Badge tone="muted" title="在预览上拖拽即可框选遮挡区域">
              <Icon name="shield" size={11} /> 拖拽框选遮挡
            </Badge>
            {apiMode === 'mock' && <Badge tone="warn">示例画面</Badge>}
          </div>
        </div>

        <div className="stage-canvas-wrap" ref={wrapRef}>
          <div
            className="stage-canvas-inner"
            style={{ width: stageFit.width, height: stageFit.height, cursor: drag.kind === 'creating' ? 'crosshair' : 'default' }}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={() => setDrag({ kind: 'none' })}
          >
            <PreviewCanvas project={project} tick={tick} onScene={setScene} maxWidth={1280} />
            <div className="stage-overlay-layer">
              {/* 已存在的遮挡区域（显示为框，未确认用虚线） */}
              {privacyEffects.map((effect) => {
                const params = effect.parameters as PrivacyParameters;
                const visible = tick >= effect.range.start && tick < effect.range.end;
                if (!visible) return null;
                const rect = toDisplayRect({ x: params.x, y: params.y, width: params.width, height: params.height });
                const isSelected = selectedEffectId === effect.id;
                return (
                  <div
                    key={effect.id}
                    className={cn(
                      'stage-privacy-box',
                      isSelected && 'is-selected',
                      !params.confirmed && 'is-unconfirmed',
                    )}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`遮挡区域 ${params.confirmed ? '已确认' : '未确认'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectEffect(effect.id);
                    }}
                    onKeyDown={(event) => event.key === 'Enter' && selectEffect(effect.id)}
                  >
                    <span className="stage-privacy-box-label">
                      {params.confirmed ? '已遮挡' : '未确认（未遮挡）'}
                    </span>
                  </div>
                );
              })}

              {/* 拖拽中的临时框 */}
              {dragRect && <div className="stage-privacy-box is-selected" style={{ ...dragRect, pointerEvents: 'none' }} />}
            </div>

            {!scene?.hasSourceFrame && (
              <div className="stage-empty">
                <div style={{ textAlign: 'center' }}>
                  <Icon name="image" size={22} />
                  <div style={{ marginTop: 8 }}>当前时间点没有主视频片段</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="transport">
          <span className="transport-time">
            {formatDuration(tick)} <span className="is-dim">/ {formatDuration(totalDuration)}</span>
          </span>
          <div className="transport-scrub">
            <input
              type="range"
              min={0}
              max={Math.max(1, totalDuration)}
              step={Math.max(1, Math.round(frameStep))}
              value={Math.min(tick, totalDuration)}
              aria-label="播放进度"
              style={{ flex: 1 }}
              onChange={(event) => {
                setPlaying(false);
                setTick(Number(event.target.value));
              }}
            />
          </div>
          <span className="transport-badge">
            {project.settings.fps.num}/{project.settings.fps.den} fps · 帧 {(tick / frameStep).toFixed(0)}
          </span>
          <span className="transport-badge">{scene ? `${scene.outputWidth}×${scene.outputHeight}` : ''}</span>
          <Badge tone={playing ? 'ok' : 'muted'} icon={playing ? 'play' : 'pause'}>
            {playing ? '播放中' : '已暂停'}
          </Badge>
        </div>
      </section>

      <InspectorPanel />

      <Timeline
        project={project}
        tick={tick}
        onSeek={(next) => {
          setPlaying(false);
          setTick(next);
        }}
        selectedClipId={selectedClipId}
        onSelectClip={selectClip}
        selectedEffectId={selectedEffectId}
        onSelectEffect={selectEffect}
        selectedStepId={selectedStepId}
        onSelectStep={selectStep}
        onSplitAtPlayhead={splitAtPlayhead}
        onDeleteSelected={deleteSelection}
        onToggleTrackMute={(kind) => {
          const track = project.tracks.find((t) => t.kind === kind);
          if (!track) return;
          execute({ kind: 'SetTrackAudio', track: kind, muted: !track.muted }, track.muted ? '取消静音' : '静音轨道');
        }}
        zoom={zoom}
        onZoomChange={setZoom}
        collapsed={timelineCollapsed}
        onToggleCollapsed={() => setTimelineCollapsed((v) => !v)}
        projectPath={projectPath}
        onMoveClip={(clipId, timelineInTicks) => {
          execute({ kind: 'MoveClip', clipId, timelineInTicks }, '移动片段');
        }}
      />
    </div>
  );
}

/** 没有工程时给 useSourceToDisplay 的最小占位工程（不会真正渲染）。 */
const emptyProjectFallback = {
  settings: { canvas: { background: '#000', cornerRadius: 0, shadowBlur: 0, shadowOpacity: 0, padding: 0, camera: { x: 0, y: 0, width: 0, height: 0, visible: false, cornerRadius: 0 } }, activeVariantId: 'landscape', fps: { num: 30, den: 1 } },
  variants: [{ id: 'landscape', aspect: [16, 9] as [number, number], layoutOverrides: {} }],
  tracks: [],
  effects: [],
  steps: [],
  markers: [],
  assets: [],
  revision: 0,
  privacyVersion: 0,
  id: '',
  schemaVersion: 1,
  timebase: { ticksPerSecond: TICKS_PER_SECOND },
  name: '',
  createdAt: 0,
  updatedAt: 0,
} as unknown as import('@domain/project').Project;
