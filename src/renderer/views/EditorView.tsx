/**
 * 编辑器（§6.1 / §6.3）
 *
 * 布局：预览区 + 属性面板 + 底部时间线。
 *
 * 键盘：
 * - 空格播放/暂停，←/→ 逐帧，Shift+←/→ 逐秒
 * - Ctrl+B 分割，Delete 删除所选片段，Ctrl+Z 撤销，Ctrl+Y 重做，Ctrl+S 保存
 * - F 切换专注预览，Esc 优先退出专注预览并保留选择
 * - 输入框获得焦点时，上述剪辑快捷键不抢文字输入（见 lib/hooks.ts isTextEntryTarget）
 *
 * 隐私遮挡：在预览上拖拽框选矩形 → 创建未确认遮挡 → 在属性面板设时间区间与样式 → 确认。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { useShortcuts } from '../lib/hooks';
import { POPOVER_MENU_KEYS, usePopoverMenu } from '../lib/usePopoverMenu';
import { Badge, Button, Icon, IconButton, Spinner } from '../components/ui';
import { LineIcon } from '../components/LineIcon';
import { PreviewCanvas, useSourceToDisplay } from '../components/PreviewCanvas';
import { Timeline, planClipMove, splittableTick, clipEndTick } from '../components/Timeline';
import { InspectorPanel, clampPrivacyRect } from '../components/InspectorPanel';
import { formatDuration, TICKS_PER_SECOND, secondsToTicks, ticksToFrameIndex } from '@domain/timebase';
import type { Effect, PrivacyParameters, PrivacyStyle } from '@domain/project';
import { pasteEffect } from '@domain/effectClipboard';
import { timelineDuration } from '@domain/project';
import type { SetEffectCommand, DeleteRangeCommand } from '@domain/commands';
import { cn } from '../lib/format';
import type { FrameScene } from '@domain/scene';
import { useAudioPreview } from '../lib/audioPreview';

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
  const [audioPreviewEnabled, setAudioPreviewEnabled] = useState(true);
  const audioPreviewError = useAudioPreview(project, apiMode === 'mock' ? null : projectPath, tick, playing, audioPreviewEnabled);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [previewFocused, setPreviewFocused] = useState(false);
  const previewFocusTrigger = useRef<HTMLButtonElement>(null);
  const [hudMenu, setHudMenu] = useState<'none' | 'add' | 'ratio'>('none');
  const ratioMenu = usePopoverMenu({ open: hudMenu === 'ratio', onOpen: () => setHudMenu('ratio'), onClose: () => setHudMenu('none') });
  const effectMenu = usePopoverMenu({ open: hudMenu === 'add', onOpen: () => setHudMenu('add'), onClose: () => setHudMenu('none') });
  const [drag, setDrag] = useState<DragState>({ kind: 'none' });
  const [scene, setScene] = useState<FrameScene | null>(null);
  const [effectClipboard, setEffectClipboard] = useState<Effect | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapSize, setWrapSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const togglePreviewFocus = useCallback(() => {
    // Move focus before hiding the inspector so keyboard focus stays visible.
    previewFocusTrigger.current?.focus();
    setHudMenu('none');
    setDrag({ kind: 'none' });
    setPreviewFocused(focused => !focused);
  }, []);

  const { toDisplayRect, toSourceRect, scene: previewScene } = useSourceToDisplay(
    project ?? emptyProjectFallback,
    tick,
  );

  const totalDuration = project ? timelineDuration(project) : 0;
  useEffect(() => setEffectClipboard(null), [project?.id]);

  const copySelectedEffect = () => {
    const effect = project?.effects.find((item) => item.id === selectedEffectId);
    if (!effect) return;
    setEffectClipboard(structuredClone(effect));
    pushToast({ tone: 'info', title: '效果已复制', message: '在目标时间按 Ctrl+V；选中同类效果后按 Ctrl+Shift+V 只粘贴属性。' });
  };
  const pasteCopiedEffect = (attributesOnly = false) => {
    if (!project || !effectClipboard) return;
    const target = attributesOnly ? project.effects.find((item) => item.id === selectedEffectId) : undefined;
    if (attributesOnly && !target) {
      pushToast({ tone: 'warn', title: '请先选择目标效果', message: '只粘贴属性需要选中一个同类型的效果。' });
      return;
    }
    try {
      const effect = pasteEffect(effectClipboard, project, tick, `effect-${crypto.randomUUID()}`, target);
      execute({ kind: 'SetEffect', effect }, attributesOnly ? '粘贴效果属性' : '粘贴效果');
      selectEffect(effect.id);
      if (effect.kind === 'privacy') pushToast({ tone: 'warn', title: '遮挡已粘贴，请重新确认', message: '核对新位置的内容后，再确认遮挡。' });
    } catch (error) {
      pushToast({ tone: 'warn', title: '无法粘贴效果', message: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * 播放头夹紧：删除/波纹删除/撤销重做都可能让时间线变短，
   * 而 store 里的 tick 不会自动回退。不夹紧的话播放头会停在内容之外，
   * 预览显示空画面、时间码超过总时长（用户会以为工程坏了）。
   */
  useEffect(() => {
    if (!project) return;
    if (tick > totalDuration) setTick(totalDuration);
  }, [project, setTick, tick, totalDuration]);

  /**
   * 清理失效选择：撤销一个「新建遮挡/运镜/步骤」或删除效果后，
   * store 里的 selectedEffectId 仍指向已不存在的实体。若不清掉，
   * 按 Delete 会执行一条注定失败的命令（弹出 E_INVALID_COMMAND 错误），
   * 属性面板也一直显示空状态而用户以为还选中着什么。
   */
  useEffect(() => {
    if (!project) return;
    if (selectedClipId && !project.tracks.some((track) => track.clips.some((clip) => clip.id === selectedClipId))) {
      selectClip(null);
    }
    if (selectedEffectId && !project.effects.some((effect) => effect.id === selectedEffectId)) {
      selectEffect(null);
    }
    if (selectedStepId && !project.steps.some((step) => step.id === selectedStepId)) {
      selectStep(null);
    }
  }, [project, selectClip, selectEffect, selectStep, selectedClipId, selectedEffectId, selectedStepId]);

  /**
   * 预览 contain 尺寸（§P0）。
   *
   * 只把 canvas 的固有尺寸交给 CSS 的 max-width/max-height 是不够的：百分比高度在
   * flex 行里没有确定参照高度，画布会被撑开并被容器裁掉（表现为上方大留白、下方
   * 源画面与摄像头被截断）。这里按「容器可用宽高 + 输出画幅」显式算出 contain 盒，
   * canvas 与遮挡层共用同一个盒子，横屏/竖屏/方形都能完整显示。
   */
  const outputAspect = useMemo(() => {
    const aspect = project?.variants.find((v) => v.id === project.settings.activeVariantId)?.aspect;
    // Geometry must follow the project even before the next asynchronous preview draw.
    return aspect && aspect[1] > 0 ? aspect[0] / aspect[1] : 16 / 9;
  }, [project]);

  const activeVariant = useMemo(
    () => project?.variants.find((v) => v.id === project.settings.activeVariantId) ?? project?.variants[0],
    [project],
  );

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
  }, [hasProject, timelineCollapsed]);

  // 键盘快捷键
  useShortcuts(
    [
      { combo: 'f', handler: togglePreviewFocus },
      { combo: 'ctrl+c', handler: copySelectedEffect },
      { combo: 'ctrl+v', handler: () => pasteCopiedEffect() },
      { combo: 'ctrl+shift+v', handler: () => pasteCopiedEffect(true) },
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
          if (previewFocused) {
            setPreviewFocused(false);
            previewFocusTrigger.current?.focus();
            return;
          }
          setPlaying(false);
          // 拖拽框选途中按 Escape：取消临时框，避免松手时才「突然」创建遮挡
          setDrag({ kind: 'none' });
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
    // domain 在片段边界/距端点不足 1ms 时会静默跳过，但仍会压入一条空撤销记录。
    if (!splittableTick(project, tick)) {
      pushToast({
        tone: 'warn',
        title: '这里无法分割',
        message: '播放头需要落在某个片段内部（距片段两端至少 1 毫秒）。',
      });
      return;
    }
    execute({ kind: 'SplitClip', timelineTick: tick }, '分割片段');
  }, [execute, project, pushToast, tick, totalDuration]);

  const deleteSelection = useCallback(() => {
    if (!project) return;
    if (selectedEffectId) {
      if (!project.effects.some((effect) => effect.id === selectedEffectId)) {
        selectEffect(null);
        pushToast({ tone: 'info', title: '所选效果已不存在', message: '它可能已被删除或撤销，选择已清除。' });
        return;
      }
      execute({ kind: 'DeleteEffect', effectId: selectedEffectId }, '删除效果');
      selectEffect(null);
      return;
    }
    if (selectedStepId) {
      if (!project.steps.some((step) => step.id === selectedStepId)) {
        selectStep(null);
        pushToast({ tone: 'info', title: '所选步骤已不存在', message: '它可能已被删除或撤销，选择已清除。' });
        return;
      }
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
          range: { start: clip.timelineInTicks, end: clipEndTick(clip) },
          ripple: true,
        },
        '删除时间线片段（波纹）',
      );
      selectClip(null);
      pushToast({ tone: 'info', title: '已删除时间线片段', message: '源素材文件仍然保留。' });
      return;
    }
    // 选中的片段已经不在了（撤销/删除后选中状态滞后）
    selectClip(null);
    pushToast({ tone: 'info', title: '所选片段已不存在', message: '选择已清除，请在时间线上重新点选。' });
  }, [execute, project, pushToast, selectClip, selectEffect, selectStep, selectedClipId, selectedEffectId, selectedStepId]);

  // ---- 预览上框选遮挡 ----
  /** 按下时的屏幕坐标：用来区分「单击」与「拖拽」，避免每次点预览都弹提示 */
  const stageDragStart = useRef<{ x: number; y: number } | null>(null);
  const onStagePointerDown = (event: React.PointerEvent) => {
    if (!project || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.stage-privacy-box')) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    stageDragStart.current = { x: event.clientX, y: event.clientY };
    setDrag({ kind: 'creating', x0: x, y0: y, x1: x, y1: y });
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onStagePointerMove = (event: React.PointerEvent) => {
    if (drag.kind !== 'creating') return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setDrag({ ...drag, x1: x, y1: y });
  };

  const onStagePointerUp = (event?: React.PointerEvent) => {
    if (drag.kind !== 'creating' || !project) return;
    const dragStart = stageDragStart.current;
    stageDragStart.current = null;
    // 单击（没有真正的拖拽）不该被当成「框选范围太小」：编辑时点一下预览很常见，
    // 每次弹一条 info 会把真正重要的提示挤掉。
    const moved =
      !dragStart || !event ? true : Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) >= 3;
    const x0 = Math.min(drag.x0, drag.x1);
    const x1 = Math.max(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1);
    const y1 = Math.max(drag.y0, drag.y1);
    setDrag({ kind: 'none' });
    if (!moved) return;
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) {
      pushToast({ tone: 'info', title: '框选范围太小', message: '按住鼠标在预览上拖出一个矩形来创建遮挡。' });
      return;
    }
    if (totalDuration <= 0) {
      pushToast({ tone: 'warn', title: '工程里还没有画面', message: '先录制或导入一段素材，再来创建遮挡区域。' });
      return;
    }
    if (!previewScene) {
      pushToast({ tone: 'warn', title: '预览尚未就绪', message: '稍等一下再框选，遮挡会按当前画面坐标记录。' });
      return;
    }
    // 显示坐标 → 源坐标：必须走 useSourceToDisplay 的逆变换（含运镜缩放/焦点），
    // 否则有运镜时创建的遮挡框会与用户框选的区域错位，确认后可能遮不住敏感内容。
    const display = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const raw = toSourceRect(display);
    // 先与 [0,1] 求交再夹紧：如果先夹紧，拖出画面外的框会被平移而不是被裁掉
    const ix0 = Math.max(0, raw.x);
    const iy0 = Math.max(0, raw.y);
    const ix1 = Math.min(1, raw.x + raw.width);
    const iy1 = Math.min(1, raw.y + raw.height);
    if (ix1 - ix0 < 0.01 || iy1 - iy0 < 0.01) {
      pushToast({ tone: 'info', title: '框选区域不在画面内', message: '请在预览的画面区域内拖拽，画布留白/背景不算画面。' });
      return;
    }
    const rect = clampPrivacyRect({ x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 });
    // 时间区间夹紧：播放头在结尾时若直接用 [tick, tick+5s) 会产生零长区间，
    // 效果永远不生效（确认了也看不到遮挡）。
    const minSpan = Math.min(secondsToTicks(0.2), totalDuration);
    const start = Math.max(0, Math.min(tick, totalDuration - minSpan));
    const end = Math.min(totalDuration, Math.max(start + minSpan, tick + secondsToTicks(5)));
    const id = `privacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const effect = {
      id,
      kind: 'privacy' as const,
      range: { start, end },
      anchor: 'screen' as const,
      parameters: {
        ...rect,
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
    <div className={cn('editor', previewFocused && 'is-preview-focused')}>
      <section className="editor-stage" aria-label="预览区">
        <div className="stage-canvas-wrap" ref={wrapRef}>
          <div
            className="stage-canvas-inner"
            style={{ width: stageFit.width, height: stageFit.height, cursor: drag.kind === 'creating' ? 'crosshair' : playing ? 'none' : 'default' }}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={() => setDrag({ kind: 'none' })}
          >
            <PreviewCanvas project={project} tick={tick} playing={playing} projectPath={projectPath} onScene={setScene}
              maxWidth={Math.min(3840, Math.max(1280, Math.ceil(Math.max(stageFit.width, stageFit.height) * (window.devicePixelRatio || 1) / 64) * 64))} />
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

        {/* 画布下方的悬浮 HUD：画面工具与传输共用一枚材质胶囊。 */}
        <div className="stage-toolbar">
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="stage-ratio-trigger"
              aria-label="选择画幅"
              title="切换输出画幅"
              ref={ratioMenu.triggerRef}
              aria-haspopup="menu"
              aria-controls={hudMenu === 'ratio' ? ratioMenu.id : undefined}
              data-keys={ratioMenu.triggerKeys}
              onKeyDown={ratioMenu.onTriggerKeyDown}
              aria-expanded={hudMenu === 'ratio'}
              onClick={() => setHudMenu(hudMenu === 'ratio' ? 'none' : 'ratio')}
            >
              <LineIcon kind="aspect" size={12} />
              {activeVariant ? `${activeVariant.aspect[0]}:${activeVariant.aspect[1]}` : '16:9'}
              <LineIcon kind="chevronDown" size={9} />
            </button>
            {hudMenu === 'ratio' && (
              <>
                <button type="button" tabIndex={-1} className="hud-scrim" aria-label="关闭画幅选择" onClick={() => ratioMenu.close()} />
                <div id={ratioMenu.id} ref={ratioMenu.menuRef} className="stage-hud-popover" role="menu" aria-label="画幅" tabIndex={-1} data-keys={POPOVER_MENU_KEYS} onKeyDown={ratioMenu.onMenuKeyDown}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 7 }}>
                  {project.variants.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitemradio"
                      tabIndex={-1}
                      className={cn('variant-card', project.settings.activeVariantId === item.id && 'is-selected')}
                      aria-checked={project.settings.activeVariantId === item.id}
                      aria-label={`${item.aspect[0]}:${item.aspect[1]}`}
                      onClick={() => {
                        execute({ kind: 'SetActiveVariant', variantId: item.id }, '切换画幅');
                        ratioMenu.close();
                      }}
                    >
                      <span className="variant-shape" style={{ aspectRatio: `${item.aspect[0]}/${item.aspect[1]}`, width: 40, display: 'block', borderRadius: 5, border: '1px solid currentColor', margin: '4px auto' }} />
                      <span style={{ fontSize: 11 }}>{`${item.aspect[0]}:${item.aspect[1]}`}</span>
                    </button>
                  ))}
                </div>
              </div>
              </>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="stage-ratio-trigger"
              aria-label="效果操作"
              title="复制与粘贴效果"
              ref={effectMenu.triggerRef}
              aria-haspopup="menu"
              aria-controls={hudMenu === 'add' ? effectMenu.id : undefined}
              data-keys={effectMenu.triggerKeys}
              onKeyDown={effectMenu.onTriggerKeyDown}
              aria-expanded={hudMenu === 'add'}
              onClick={() => setHudMenu(hudMenu === 'add' ? 'none' : 'add')}
            >
              <LineIcon kind="layers" size={15} />
            </button>
            {hudMenu === 'add' && (
              <>
                <button type="button" tabIndex={-1} className="hud-scrim" aria-label="关闭效果菜单" onClick={() => effectMenu.close()} />
                <div id={effectMenu.id} ref={effectMenu.menuRef} className="stage-hud-menu" role="menu" aria-label="效果操作" tabIndex={-1} data-keys={POPOVER_MENU_KEYS} onKeyDown={effectMenu.onMenuKeyDown}>
                  {!selectedEffectId && !effectClipboard && <p className="hud-menu-hint">先在时间线选择一个效果，即可复制并在其他位置粘贴。</p>}
                  <button type="button" role="menuitem" tabIndex={-1} disabled={!selectedEffectId} onClick={() => { copySelectedEffect(); effectMenu.close(); }}>
                    <LineIcon kind="box" size={15} />复制效果
                  </button>
                  <button type="button" role="menuitem" tabIndex={-1} disabled={!effectClipboard} onClick={() => { pasteCopiedEffect(); effectMenu.close(); }}>
                    <LineIcon kind="paste" size={15} />粘贴效果
                  </button>
                  <button type="button" role="menuitem" tabIndex={-1} disabled={!effectClipboard || !selectedEffectId} onClick={() => { pasteCopiedEffect(true); effectMenu.close(); }}>
                    <LineIcon kind="swap" size={15} />只粘贴属性
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="stage-toolbar-spacer" />

          <IconButton
            icon="stepBack"
            label="上一帧（←）"
            size="sm"
            disabled={tick <= 0}
            title={tick <= 0 ? '已经在开头' : '上一帧（←）'}
            onClick={() => {
              setPlaying(false);
              setTick(Math.max(0, tick - frameStep));
            }}
          />
          <button
            type="button"
            className={cn('transport-play', playing && 'is-playing')}
            aria-label={playing ? '暂停（空格）' : '播放（空格）'}
            title={playing ? '暂停（空格）' : '播放（空格）'}
            onClick={togglePlay}
          >
            <LineIcon kind="play" size={15} className="icon-play" />
            <LineIcon kind="pause" size={15} className="icon-pause" />
          </button>
          <IconButton
            icon="stepForward"
            label="下一帧（→）"
            size="sm"
            disabled={tick >= totalDuration}
            title={tick >= totalDuration ? '已经在结尾' : '下一帧（→）'}
            onClick={() => {
              setPlaying(false);
              setTick(Math.min(totalDuration, tick + frameStep));
            }}
          />
          <span className="player-time" title={`${project.settings.fps.num / project.settings.fps.den} fps · 帧 ${ticksToFrameIndex(Math.min(tick, totalDuration), project.settings.fps)}`}>
            {formatDuration(tick)} <span>/ {formatDuration(totalDuration)}</span>
          </span>
          <IconButton icon="volume" size="sm" label={audioPreviewEnabled ? '关闭音频试听' : '开启音频试听'}
            variant="ghost" onClick={() => setAudioPreviewEnabled(v => !v)} />
          {audioPreviewError && <Badge tone="warn" title={audioPreviewError}>试听失败</Badge>}
          <div className="stage-toolbar-spacer" />
          <button
            type="button"
            ref={previewFocusTrigger}
            className="stage-preview-toggle"
            aria-label={previewFocused ? '退出专注预览（F / Esc）' : '专注预览（F）'}
            aria-pressed={previewFocused}
            aria-controls="editor-inspector"
            aria-keyshortcuts={previewFocused ? 'f Escape' : 'f'}
            title={previewFocused ? '返回编辑，恢复原布局（F / Esc）' : '收起属性面板与时间线轨道（F）'}
            onClick={togglePreviewFocus}
          >
            <LineIcon kind={previewFocused ? 'layout' : 'expand'} size={14} />
            <span>{previewFocused ? '返回编辑' : '专注预览'}</span>
            <kbd aria-hidden="true">F</kbd>
          </button>
        </div>

        <div className="transport">
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
        </div>
      </section>

      <InspectorPanel hidden={previewFocused} />

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
        effectClipboardKind={effectClipboard?.kind ?? null}
        onCopyEffect={copySelectedEffect}
        onPasteEffect={pasteCopiedEffect}
        onToggleTrackMute={(kind) => {
          const track = project.tracks.find((t) => t.kind === kind);
          if (!track) return;
          execute({ kind: 'SetTrackAudio', track: kind, muted: !track.muted }, track.muted ? '取消静音' : '静音轨道');
        }}
        zoom={zoom}
        onZoomChange={setZoom}
        collapsed={previewFocused || timelineCollapsed}
        onToggleCollapsed={() => {
          if (previewFocused) {
            setPreviewFocused(false);
            setTimelineCollapsed(false);
          } else setTimelineCollapsed(collapsed => !collapsed);
        }}
        projectPath={projectPath}
        onMoveClip={(clipId, timelineInTicks) => {
          const plan = planClipMove(project, clipId, timelineInTicks);
          if (!plan) return;
          if (plan.adjusted) {
            pushToast({
              tone: 'warn',
              title: '目标位置与同轨片段重叠',
              message:
                plan.tick === plan.originTick
                  ? '片段未移动：目标位置会和同轨其它片段叠在一起。'
                  : '已把片段放到最近的不重叠位置。',
            });
          }
          if (plan.tick === plan.originTick) return;
          execute({ kind: 'MoveClip', clipId, timelineInTicks: plan.tick }, '移动片段');
        }}
        onMoveBlocked={(message) => pushToast({ tone: 'warn', title: '移动受限', message })}
        onTrimClip={(clipId, patch) => {
          // 手柄裁剪：只改源入点/源时长/时间线起点，不碰同轨其它片段（非波纹）
          execute(
            {
              kind: 'TrimClip',
              clipId,
              sourceInTicks: patch.sourceInTicks,
              sourceDurationTicks: patch.sourceDurationTicks,
              timelineInTicks: patch.timelineInTicks,
            },
            '裁剪片段',
          );
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
