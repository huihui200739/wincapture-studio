/**
 * 教程步骤编辑（§12.1 / §5.2）
 *
 * - 由录制标记生成步骤草稿（buildStepDrafts），生成后仍是草稿，需要用户确认。
 * - 每个步骤可编辑标题、说明、截图时间；支持合并、拆分、删除、重排。
 * - 截图预览直接走 evaluateScene + drawScene，与视频导出使用同一份遮挡结果。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TutorialStep } from '@domain/project';
import type { PointerEventLike } from '@domain/types';
import { findTrack, timelineDuration } from '@domain/project';
import { evaluateScene } from '@domain/scene';
import { drawScene, type SceneResources } from '../../media/compositor';
import { buildStepDrafts, stepTimelineTick, timelineTickToStepSource } from '@domain/tutorial';
import { TimeMap } from '@domain/timeMap';
import { TICKS_PER_SECOND, formatDuration, secondsToTicks, parseDuration } from '@domain/timebase';
import type { SetStepCommand } from '@domain/commands';
import { useApp } from '../lib/store';
import { Badge, Button, EmptyState, Field, IconButton, InlineNote, Panel, TextInput } from '../components/ui';
import { cn, unwrap } from '../lib/format';
import { wcs } from '../lib/wcs';
import { syntheticCamera, syntheticScreen } from '../lib/syntheticMedia';
import {
  paintPreviewPlaceholder,
  shouldUseSyntheticPreview,
  usePreviewMedia,
  type PreviewMediaCache,
} from '../lib/previewSource';

/** 步骤标题上限：Markdown 标题/步骤卡片都会展示，过长会破坏排版。 */
export const MAX_STEP_TITLE_LENGTH = 120;
/** 步骤说明上限。 */
export const MAX_STEP_DESCRIPTION_LENGTH = 2000;

/**
 * 截图时间夹紧：落在 [步骤开始, 步骤结束) 内，且不超过工程时长。
 *
 * 领域层在删除区间时会把 imageTick 收进保留下来的步骤区间
 * （commands.ts deleteRange），说明截图本就应与步骤区间绑定；
 * 这里用同一口径，避免出现「步骤 2 的截图拍到步骤 5 的画面」。
 */
export function clampImageTickForStep(
  intended: number,
  sourceRange: { start: number; end: number },
  durationTicks: number,
): number {
  const maxTick = Math.max(0, Math.round(durationTicks) - 1);
  const lower = Math.max(0, Math.min(maxTick, Math.round(sourceRange.start)));
  const upper = Math.max(lower, Math.min(maxTick, Math.round(sourceRange.end) - 1));
  const value = Number.isFinite(intended) ? Math.round(intended) : lower;
  return Math.max(lower, Math.min(upper, value));
}

/**
 * 截图时刻在成片时间线上的位置。
 *
 * step.imageTick 存的是源时间（与标记、指针日志同一时间轴），播放头/预览都是成片时间，
 * 必须经 TimeMap 映射。旧实现直接拿源时间当时间线时间用，一旦修剪或删除过前段，
 * 缩略图与「定位」都会拍到错位的画面。
 */
function stepImageTick(project: Parameters<typeof evaluateScene>[0], step: TutorialStep): number {
  const duration = timelineDuration(project);
  const maxTick = Math.max(0, duration - 1);
  const mapped = stepTimelineTick(project, step);
  if (mapped === null) {
    // 该时刻已被剪掉：退化为按源时间夹紧，界面另有「截图待更新」提示
    return clampImageTickForStep(step.imageTick, step.sourceRange, duration);
  }
  return Math.max(0, Math.min(maxTick, Math.round(mapped)));
}

/** 步骤截图（与预览/导出同一路径：真实工程解真实素材，mock 才用合成画面）。 */
function StepThumb({
  step,
  tick,
  media,
  maxWidth = 560,
}: {
  step: TutorialStep;
  tick: number;
  /** 真实模式的共享解码缓存；null 表示 mock 或工程未打开 */
  media: PreviewMediaCache | null;
  maxWidth?: number;
}) {
  const { project } = useApp();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !project) return;
    const variant = project.variants.find((v) => v.id === project.settings.activeVariantId) ?? project.variants[0];
    const [aw, ah] = variant.aspect;
    const width = maxWidth;
    const height = Math.round((maxWidth * ah) / aw);
    canvas.width = width;
    canvas.height = height;
    let cancelled = false;

    const drawWith = (
      ctx: CanvasRenderingContext2D,
      scene: Parameters<typeof drawScene>[1],
      screen: CanvasImageSource | null,
      screenWidth: number,
      screenHeight: number,
      camera: CanvasImageSource | null,
    ) => {
      const resources: SceneResources = {
        screen,
        screenWidth,
        screenHeight,
        camera,
        cursor: null,
      };
      drawScene(ctx, scene, resources);
    };

    try {
      const scene = evaluateScene(project, tick, { outputWidth: width, outputHeight: height, variantId: variant.id });
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      // mock 模式：合成演示画面（无 window.wcs 时的独立演示）
      if (shouldUseSyntheticPreview()) {
        const seconds = tick / TICKS_PER_SECOND;
        const hasCamera = !!findTrack(project, 'camera')?.clips.length;
        drawWith(
          ctx,
          scene,
          syntheticScreen(seconds),
          1600,
          900,
          hasCamera && scene.camera.visible ? syntheticCamera(seconds) : null,
        );
        return;
      }

      // 真实模式：异步解码工程里的真实源帧，绝不回退到合成画面
      if (!media) {
        paintPreviewPlaceholder(ctx, width, height, '预览解码准备中…');
        return;
      }
      paintPreviewPlaceholder(ctx, width, height, '正在解码截图…');
      void media
        .resolve(project, scene, tick, canvas)
        .then((result) => {
          if (cancelled || canvasRef.current !== canvas) return;
          const target = canvas.getContext('2d', { alpha: false });
          if (!target) return;
          if (result && (result.screen || !scene.hasSourceFrame)) {
            drawWith(
              target,
              evaluateScene(project, tick, { outputWidth: width, outputHeight: height,
                variantId: variant.id, pointer: result.pointer }),
              result.screen,
              result.screenWidth || width,
              result.screenHeight || height,
              result.camera,
            );
          } else {
            paintPreviewPlaceholder(target, width, height, result?.message ?? '正在解码截图…');
          }
        })
        .catch((error) => {
          if (cancelled || canvasRef.current !== canvas) return;
          console.error('[tutorial] 截图解码失败', error);
          const target = canvas.getContext('2d', { alpha: false });
          if (target) paintPreviewPlaceholder(target, width, height, '截图解码失败，导出画面不受影响');
        });
    } catch (error) {
      console.error('[tutorial] 截图渲染失败', error);
    }

    return () => {
      cancelled = true;
    };
  }, [project, tick, maxWidth, media]);

  return <canvas ref={canvasRef} width={maxWidth} height={Math.round((maxWidth * 9) / 16)} aria-label={`步骤 ${step.title} 截图`} />;
}

export function TutorialView() {
  const {
    project,
    execute,
    selectedStepId,
    selectStep,
    tick,
    setTick,
    setView,
    pushToast,
    pushError,
    save,
    dirty,
    projectPath,
  } = useApp();

  const [drafting, setDrafting] = useState(false);
  const [editingTitle, setEditingTitle] = useState('');
  const [editingDesc, setEditingDesc] = useState('');
  const [editingImage, setEditingImage] = useState('');

  /** 真实模式的共享解码缓存（mock 模式为 null，截图用合成演示画面）。 */
  const previewMedia = usePreviewMedia(projectPath);

  const steps = project?.steps ?? [];
  const current = useMemo(() => steps.find((s) => s.id === selectedStepId) ?? steps[0] ?? null, [selectedStepId, steps]);
  const duration = useMemo(() => (project ? timelineDuration(project) : 0), [project]);
  /** 步骤截图在成片时间线上的位置（源时间 → 时间线时间映射的唯一入口） */
  const displayImageTickOf = useCallback(
    (step: TutorialStep) => (project ? stepImageTick(project, step) : 0),
    [project],
  );

  /**
   * 编辑器字段与工程数据的同步基准。
   *
   * 只在「切换步骤」或「工程里的值真的变了」时重置输入框；用户正在输入时
   * 工程值没变，所以不会被覆盖。撤销/重做会改变 current.title 等值，
   * 这里会跟着回填——否则撤销之后输入框仍显示被撤销的新文案，
   * 用户一失焦又会把旧值重新写回去。
   */
  const syncedStepRef = useRef<{ id: string; title: string; description: string; imageTick: number } | null>(null);

  useEffect(() => {
    if (!current) {
      syncedStepRef.current = null;
      return;
    }
    const prev = syncedStepRef.current;
    const sameStep = prev !== null && prev.id === current.id;
    if (
      sameStep &&
      prev.title === current.title &&
      prev.description === current.description &&
      prev.imageTick === current.imageTick
    ) {
      return;
    }
    syncedStepRef.current = {
      id: current.id,
      title: current.title,
      description: current.description,
      imageTick: current.imageTick,
    };
    setEditingTitle(current.title);
    setEditingDesc(current.description);
    setEditingImage(formatDuration(displayImageTickOf(current)));
  }, [current, displayImageTickOf]);

  const saveStep = useCallback(
    (patch: Partial<TutorialStep>) => {
      if (!current) return;
      execute<SetStepCommand>({ kind: 'SetStep', step: { ...current, ...patch } }, '编辑教程步骤');
    },
    [current, execute],
  );

  /** 提交截图时间：输入是成片时间，转回步骤的源时间后夹紧到步骤区间内。 */
  const commitImageTick = useCallback(
    (intended: number) => {
      if (!current || !project) return;
      const mapped = timelineTickToStepSource(project, current, intended);
      if (mapped === null) {
        // 输入落在片段之间的空隙：不能猜一个位置，明确告诉用户
        pushToast({
          tone: 'warn',
          title: '这个时间点没有画面',
          message: '请填一个有视频画面的时间，或先把播放头移到目标位置再读当前时间。',
        });
        setEditingImage(formatDuration(displayImageTickOf(current)));
        return;
      }
      const clamped = clampImageTickForStep(mapped, current.sourceRange, Number.MAX_SAFE_INTEGER);
      setEditingImage(formatDuration(stepImageTick(project, { ...current, imageTick: clamped })));
      if (clamped === current.imageTick) return;
      execute<SetStepCommand>({ kind: 'SetStep', step: { ...current, imageTick: clamped } }, '编辑教程步骤');
    },
    [current, displayImageTickOf, execute, project, pushToast],
  );

  const generateDrafts = async () => {
    if (!project) return;
    setDrafting(true);
    try {
      // 优先使用真实指针日志；mock 模式没有时用标记本身生成
      let clicks: PointerEventLike[] = [];
      try {
        const pointer = unwrap(await wcs().readPointerLog(projectPath ?? ''));
        if (pointer && pointer.events?.length) {
          clicks = pointer.events.filter((event) => event.kind === 'down');
        }
      } catch {
        clicks = [];
      }
      // markers/clicks 是录制期的源时间，可能大于成片时长（前面被剪掉了）。
      // 这里不按成片时长预过滤，先生成再按 TimeMap 映射判断是否还在成片里。
      const drafts = buildStepDrafts(
        { markers: project.markers, clicks, durationTicks: Number.MAX_SAFE_INTEGER },
        { includeClicks: false },
      ).filter((draft) => stepTimelineTick(project, draft) !== null);
      if (drafts.length === 0) {
        pushToast({
          tone: 'warn',
          title: '没有可生成步骤的标记',
          message: '录制时按「标记」记录关键操作，或用「新建步骤」手动添加。',
        });
        return;
      }
      // 重复点「由标记生成草稿」不应该把同一条标记变成两个步骤：
      // 同一个标记时间点已有步骤时跳过（domain 生成的 id 带随机后缀，无法靠 id 去重）。
      const existingStarts = new Set(
        project.steps.filter((step) => step.source === 'marker').map((step) => step.sourceRange.start),
      );
      const fresh = drafts.filter((draft) => !existingStarts.has(draft.sourceRange.start));
      if (fresh.length === 0) {
        pushToast({
          tone: 'info',
          title: '步骤已是最新',
          message: `这 ${drafts.length} 个标记都已经有对应步骤，没有新增。`,
        });
        return;
      }
      for (const draft of fresh) {
        // 截图是实时按当前遮挡生成的，新建步骤的隐私版本必须跟随工程，
        // 否则 buildStepDrafts 写死的 0 会让步骤立刻显示「截图待更新」。
        execute<SetStepCommand>(
          { kind: 'SetStep', step: { ...draft, privacyVersion: project.privacyVersion } },
          '生成教程步骤草稿',
        );
      }
      selectStep(fresh[0].id);
      pushToast({
        tone: 'ok',
        title: `已生成 ${fresh.length} 个步骤草稿${fresh.length < drafts.length ? `（跳过 ${drafts.length - fresh.length} 个已存在）` : ''}`,
        message: '草稿标题来自标记备注，请逐个核对标题、说明与截图时间。',
      });
    } catch (error) {
      pushError(error, '生成步骤草稿失败');
    } finally {
      setDrafting(false);
    }
  };

  const addManualStep = () => {
    if (!project) return;
    if (duration <= 0) {
      pushToast({ tone: 'warn', title: '工程里还没有画面', message: '先录制或导入素材，再新建教程步骤。' });
      return;
    }
    const id = `step-manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    // 播放头是成片时间，而步骤存的是源时间：先换回源时间，否则剪辑后新步骤会指向错画面
    const hit = new TimeMap(project).toSource('primaryVideo', Math.max(0, Math.round(tick)));
    if (!hit) {
      pushToast({ tone: 'warn', title: '播放头不在视频片段内', message: '把播放头移到有画面的位置再新建步骤。' });
      return;
    }
    // 区间必须保证 start < end，且不越过源片段末尾，否则会写出校验判为 error 的步骤
    const clipSourceEnd = hit.clip.sourceInTicks + hit.clip.sourceDurationTicks;
    const start = Math.max(0, Math.min(hit.sourceTick, clipSourceEnd - 1));
    const end = Math.max(start + 1, Math.min(clipSourceEnd, start + secondsToTicks(3)));
    const sourceRange = { start, end };
    const step: TutorialStep = {
      id,
      sourceRange,
      title: `步骤 ${steps.length + 1} 待补充说明`,
      description: '',
      imageTick: clampImageTickForStep(start + secondsToTicks(0.6), sourceRange, Number.MAX_SAFE_INTEGER),
      actionRect: null,
      source: 'manual',
      privacyVersion: project.privacyVersion,
    };
    execute<SetStepCommand>({ kind: 'SetStep', step }, '新建教程步骤');
    selectStep(id);
  };

  const deleteStep = (id: string) => {
    execute({ kind: 'DeleteStep', stepId: id }, '删除教程步骤');
    if (selectedStepId === id) selectStep(null);
    pushToast({ tone: 'info', title: '已删除教程步骤', message: '视频与素材不受影响。' });
  };

  const moveStep = (id: string, direction: -1 | 1) => {
    const index = steps.findIndex((s) => s.id === id);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const ordered = steps.map((s) => s.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    execute({ kind: 'ReorderSteps', orderedIds: ordered }, '重排教程步骤');
  };

  /** 合并：把当前步骤与下一个步骤合并成一段（时间区间取并集，说明拼接）。 */
  const mergeWithNext = (id: string) => {
    const index = steps.findIndex((s) => s.id === id);
    if (index < 0 || index >= steps.length - 1) {
      pushToast({ tone: 'info', title: '没有可合并的下一个步骤' });
      return;
    }
    const first = steps[index];
    const second = steps[index + 1];
    const merged: TutorialStep = {
      ...first,
      title: first.title || second.title,
      description: [first.description, second.description].filter(Boolean).join('\n'),
      sourceRange: {
        start: Math.min(first.sourceRange.start, second.sourceRange.start),
        end: Math.max(first.sourceRange.end, second.sourceRange.end),
      },
      imageTick: first.imageTick,
    };
    execute<SetStepCommand>({ kind: 'SetStep', step: merged }, '合并教程步骤');
    execute({ kind: 'DeleteStep', stepId: second.id }, '合并教程步骤');
    selectStep(first.id);
    pushToast({ tone: 'ok', title: '已合并步骤', message: '合并后的说明已拼接，请检查文案是否连贯。' });
  };

  /** 拆分：以截图时间为界拆成两段。 */
  const splitStep = (id: string) => {
    const index = steps.findIndex((s) => s.id === id);
    if (index < 0) return;
    const step = steps[index];
    const cut = Math.max(step.sourceRange.start + secondsToTicks(0.2), Math.min(step.imageTick, step.sourceRange.end - secondsToTicks(0.2)));
    if (cut <= step.sourceRange.start || cut >= step.sourceRange.end) {
      pushToast({ tone: 'warn', title: '无法拆分', message: '截图时间需要落在步骤区间内部。' });
      return;
    }
    const first: TutorialStep = { ...step, sourceRange: { start: step.sourceRange.start, end: cut } };
    const secondRange = { start: cut, end: step.sourceRange.end };
    const second: TutorialStep = {
      ...step,
      id: `step-split-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      sourceRange: secondRange,
      title: `${step.title}（续）`,
      description: '',
      imageTick: clampImageTickForStep(cut + secondsToTicks(0.4), secondRange, Number.MAX_SAFE_INTEGER),
    };
    execute<SetStepCommand>({ kind: 'SetStep', step: first }, '拆分教程步骤');
    execute<SetStepCommand>({ kind: 'SetStep', step: second }, '拆分教程步骤');
    selectStep(second.id);
    pushToast({ tone: 'ok', title: '已拆分步骤', message: '请为新的第二段补充标题与说明。' });
  };

  const syncPrivacyVersion = () => {
    if (!project) return;
    const stale = steps.filter((step) => step.privacyVersion !== project.privacyVersion);
    if (stale.length === 0) {
      pushToast({ tone: 'info', title: '遮挡版本已是最新', message: '没有需要同步的步骤截图。' });
      return;
    }
    for (const step of stale) {
      execute<SetStepCommand>(
        { kind: 'SetStep', step: { ...step, privacyVersion: project.privacyVersion } },
        '同步遮挡版本',
      );
    }
    pushToast({ tone: 'ok', title: '已同步遮挡版本', message: `步骤截图缓存已失效，会按当前遮挡（v${project.privacyVersion}）重新生成。` });
  };

  if (!project) {
    return (
      <div className="view">
        <EmptyState
          icon="book"
          title="还没有工程"
          description="教程步骤来自录制的标记。先录制一段，或打开已有工程。"
          actions={
            <Button variant="primary" icon="record" onClick={() => setView('record')}>
              去录制
            </Button>
          }
        />
      </div>
    );
  }

  const staleSteps = steps.filter((s) => s.privacyVersion !== project.privacyVersion);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>图文教程</h1>
          <p>由标记生成步骤草稿，逐条核对标题、说明与截图时间；导出前会与视频共用同一份遮挡结果。</p>
        </div>
        <div className="view-actions">
          <Button size="sm" variant="ghost" icon="flag" onClick={() => setView('record')}>
            查看标记
          </Button>
          <Button size="sm" icon="plus" onClick={addManualStep}>
            新建步骤
          </Button>
          <Button size="sm" variant="primary" icon="refresh" loading={drafting} onClick={() => void generateDrafts()}>
            由标记生成草稿
          </Button>
        </div>
      </div>

      {staleSteps.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <InlineNote tone="warn">
            <strong>{staleSteps.length} 个步骤的截图版本落后于当前遮挡（v{project.privacyVersion}）。</strong>{' '}
            导出时会按最新遮挡重新生成截图。
            <div style={{ marginTop: 6 }}>
              <Button size="sm" onClick={syncPrivacyVersion}>
                同步遮挡版本
              </Button>
            </div>
          </InlineNote>
        </div>
      )}

      <div className="tutorial-layout">
        <Panel
          title="步骤列表"
          icon="book"
          subtitle={`${steps.length} 个步骤`}
          actions={
            <>
              <IconButton icon="save" label="保存工程" size="sm" onClick={() => void save()} disabled={!dirty} />
              <Button size="sm" variant="ghost" icon="export" onClick={() => setView('export')}>
                去导出
              </Button>
            </>
          }
          bodyClassName=""
        >
          {steps.length === 0 ? (
            <EmptyState
              icon="flag"
              title="还没有步骤"
              description="录制时按「标记」记录关键操作，然后点「由标记生成草稿」。也可以手动新建一个步骤。"
              actions={
                <>
                  <Button size="sm" variant="primary" icon="refresh" loading={drafting} onClick={() => void generateDrafts()}>
                    由标记生成草稿
                  </Button>
                  <Button size="sm" icon="plus" onClick={addManualStep}>
                    手动新建
                  </Button>
                </>
              }
            />
          ) : (
            <div className="step-list">
              {steps.map((step, index) => {
                const active = current?.id === step.id;
                const stale = step.privacyVersion !== project.privacyVersion;
                return (
                  <div
                    key={step.id}
                    className={cn('step-card', active && 'is-selected')}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      selectStep(step.id);
                      setTick(displayImageTickOf(step));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        selectStep(step.id);
                        setTick(displayImageTickOf(step));
                      }
                    }}
                  >
                    <span className="step-num">{index + 1}</span>
                    <span className="step-main">
                      <span className="step-title">{step.title || `步骤 ${index + 1} 待补充说明`}</span>
                      {step.description && <span className="step-desc">{step.description}</span>}
                      <span className="step-meta">
                        <span>{formatDuration(step.sourceRange.start)} → {formatDuration(step.sourceRange.end)}</span>
                        <span>截图 {formatDuration(displayImageTickOf(step))}</span>
                        {step.source === 'marker' && <Badge tone="muted">标记</Badge>}
                        {step.source === 'manual' && <Badge tone="muted">手动</Badge>}
                        {step.source === 'click' && <Badge tone="muted">点击</Badge>}
                        {stale && <Badge tone="warn">截图待更新</Badge>}
                      </span>
                    </span>
                    <span className="step-actions" onClick={(event) => event.stopPropagation()}>
                      <IconButton icon="chevronRight" label="上移" size="sm" onClick={() => moveStep(step.id, -1)} />
                      <IconButton icon="chevronDown" label="下移" size="sm" onClick={() => moveStep(step.id, 1)} />
                      <IconButton icon="trash" label="删除步骤" size="sm" variant="danger" onClick={() => deleteStep(step.id)} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {current ? (
            <>
              <Panel
                title={`步骤 ${steps.findIndex((s) => s.id === current.id) + 1} · 编辑`}
                icon="editor"
                subtitle={`截图时间 ${formatDuration(displayImageTickOf(current))}`}
                actions={
                  <>
                    <Button size="sm" variant="ghost" icon="merge" onClick={() => mergeWithNext(current.id)}>
                      与下一步合并
                    </Button>
                    <Button size="sm" variant="ghost" icon="split" onClick={() => splitStep(current.id)}>
                      拆分
                    </Button>
                  </>
                }
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
                  <div>
                    <Field
                      label="标题"
                      htmlFor="step-title"
                      hint={`最多 ${MAX_STEP_TITLE_LENGTH} 个字符；清空后失焦会恢复原标题。`}
                    >
                      <TextInput
                        id="step-title"
                        value={editingTitle}
                        maxLength={MAX_STEP_TITLE_LENGTH}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onBlur={() => {
                          const next = editingTitle.trim().slice(0, MAX_STEP_TITLE_LENGTH);
                          if (!next) {
                            // 空标题直接丢弃会让输入框看起来「已清空」、工程里却还是旧标题
                            setEditingTitle(current.title);
                            pushToast({ tone: 'warn', title: '标题不能为空', message: '已恢复原标题。' });
                            return;
                          }
                          if (next !== current.title) saveStep({ title: next });
                          else if (next !== editingTitle) setEditingTitle(next);
                        }}
                        placeholder="例如：填写联系人信息"
                      />
                    </Field>
                    <Field
                      label="说明"
                      htmlFor="step-desc"
                      hint="说明写清楚「在哪、做什么、会看到什么」，不要编造界面功能"
                    >
                      <textarea
                        id="step-desc"
                        className="wcs-textarea"
                        rows={4}
                        value={editingDesc}
                        maxLength={MAX_STEP_DESCRIPTION_LENGTH}
                        onChange={(event) => setEditingDesc(event.target.value)}
                        onBlur={() => {
                          if (editingDesc !== current.description) {
                            saveStep({ description: editingDesc.slice(0, MAX_STEP_DESCRIPTION_LENGTH) });
                          }
                        }}
                        placeholder="描述这一步的操作与预期结果"
                      />
                    </Field>
                    <Field label="截图时间" htmlFor="step-image" hint="输入 mm:ss.cc 或纯秒数，回车或失焦生效；会夹紧到步骤区间内">
                      <div style={{ display: 'flex', gap: 6 }}>
                        <TextInput
                          id="step-image"
                          value={editingImage}
                          onChange={(event) => setEditingImage(event.target.value)}
                          onBlur={() => {
                            const parsed = parseDuration(editingImage);
                            if (parsed == null) {
                              pushToast({ tone: 'warn', title: '时间格式无法识别', message: '请使用 mm:ss.cc 或纯秒数。' });
                              setEditingImage(formatDuration(displayImageTickOf(current)));
                              return;
                            }
                            commitImageTick(parsed);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                          }}
                        />
                        <Button size="sm" icon="clock" onClick={() => commitImageTick(tick)}>
                          取播放头
                        </Button>
                      </div>
                    </Field>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      <Button
                        size="sm"
                        icon="play"
                        onClick={() => {
                          setTick(displayImageTickOf(current));
                          setView('editor');
                        }}
                      >
                        在编辑器中定位
                      </Button>
                      <Button size="sm" variant="ghost" icon="flag" onClick={() => setView('record')}>
                        去录制页
                      </Button>
                    </div>
                  </div>
                  <div>
                    <div className="step-editor-preview">
                      <StepThumb step={current} tick={displayImageTickOf(current)} media={previewMedia} maxWidth={560} />
                    </div>
                    <p className="wcs-field-hint" style={{ marginTop: 6 }}>
                      截图由 evaluateScene + drawScene 生成，与视频导出使用同一份遮挡结果（当前遮挡版本 v
                      {project.privacyVersion}）。
                    </p>
                    {current.actionRect && (
                      <div className="kv-list" style={{ marginTop: 8 }}>
                        <div className="kv-row">
                          <span className="kv-key">操作区域</span>
                          <span className="kv-value">
                            x {(current.actionRect.x * 100).toFixed(1)}% · y {(current.actionRect.y * 100).toFixed(1)}% · w{' '}
                            {(current.actionRect.width * 100).toFixed(1)}% · h {(current.actionRect.height * 100).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>

              <Panel title="步骤时间区间" icon="clock">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <Field label="开始" htmlFor="step-start">
                    <TextInput
                      id="step-start"
                      value={formatDuration(current.sourceRange.start)}
                      readOnly
                      aria-label="步骤开始时间"
                    />
                  </Field>
                  <Field label="结束" htmlFor="step-end">
                    <TextInput
                      id="step-end"
                      value={formatDuration(current.sourceRange.end)}
                      readOnly
                      aria-label="步骤结束时间"
                    />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      // 区间必须保持 start < end：若播放头已经越过结束点，
                      // 直接取 tick 会写出零长度/反向区间（domain 校验判为 error）
                      const end = Math.max(1, current.sourceRange.end);
                      const start = Math.max(0, Math.min(Math.round(tick), end - 1));
                      const range = { start, end };
                      saveStep({
                        sourceRange: range,
                        imageTick: clampImageTickForStep(current.imageTick, range, duration),
                      });
                    }}
                  >
                    开始设为播放头
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const start = current.sourceRange.start;
                      const desiredEnd = Math.max(Math.round(tick), start + 1, start + secondsToTicks(0.2));
                      const maxEnd = Math.max(start + 1, duration);
                      const end = Math.min(desiredEnd, maxEnd);
                      const range = { start, end };
                      saveStep({
                        sourceRange: range,
                        imageTick: clampImageTickForStep(current.imageTick, range, duration),
                      });
                    }}
                  >
                    结束设为播放头
                  </Button>
                  <Button size="sm" variant="ghost" icon="refresh" onClick={syncPrivacyVersion}>
                    同步遮挡版本
                  </Button>
                </div>
              </Panel>
            </>
          ) : (
            <Panel title="步骤详情" icon="info">
              <div className="wcs-empty">
                <p>在左侧选择一个步骤，或点「由标记生成草稿」。</p>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
