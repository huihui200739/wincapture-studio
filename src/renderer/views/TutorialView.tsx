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
import { buildStepDrafts } from '@domain/tutorial';
import { TICKS_PER_SECOND, formatDuration, secondsToTicks, ticksToSeconds, parseDuration } from '@domain/timebase';
import type { SetStepCommand } from '@domain/commands';
import { useApp } from '../lib/store';
import { Badge, Button, EmptyState, Field, Icon, IconButton, InlineNote, Panel, Spinner, TextInput } from '../components/ui';
import { cn, unwrap } from '../lib/format';
import { wcs } from '../lib/wcs';
import { syntheticCamera, syntheticScreen } from '../lib/syntheticMedia';

function stepImageTick(project: Parameters<typeof evaluateScene>[0], step: TutorialStep): number {
  const duration = timelineDuration(project);
  return Math.max(0, Math.min(step.imageTick, Math.max(0, duration - 1)));
}

/** 步骤截图（与预览同一路径）。 */
function StepThumb({ step, tick, maxWidth = 560 }: { step: TutorialStep; tick: number; maxWidth?: number }) {
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
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const seconds = tick / TICKS_PER_SECOND;
    try {
      const scene = evaluateScene(project, tick, { outputWidth: width, outputHeight: height, variantId: variant.id });
      const hasCamera = !!findTrack(project, 'camera')?.clips.length;
      const resources: SceneResources = {
        screen: syntheticScreen(seconds),
        screenWidth: 1600,
        screenHeight: 900,
        camera: hasCamera && scene.camera.visible ? syntheticCamera(seconds) : null,
        cursor: null,
      };
      drawScene(ctx, scene, resources);
    } catch (error) {
      console.error('[tutorial] 截图渲染失败', error);
    }
  }, [project, tick, maxWidth]);

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
  const [editingId, setEditingId] = useState<string | null>(null);

  const steps = project?.steps ?? [];
  const current = useMemo(() => steps.find((s) => s.id === selectedStepId) ?? steps[0] ?? null, [selectedStepId, steps]);
  const duration = useMemo(() => (project ? timelineDuration(project) : 0), [project]);

  useEffect(() => {
    if (!current) {
      setEditingId(null);
      return;
    }
    if (editingId === current.id) return;
    setEditingId(current.id);
    setEditingTitle(current.title);
    setEditingDesc(current.description);
    setEditingImage(formatDuration(current.imageTick));
  }, [current, editingId]);

  const saveStep = useCallback(
    (patch: Partial<TutorialStep>) => {
      if (!current) return;
      execute<SetStepCommand>({ kind: 'SetStep', step: { ...current, ...patch } }, '编辑教程步骤');
    },
    [current, execute],
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
      const drafts = buildStepDrafts(
        { markers: project.markers, clicks, durationTicks: timelineDuration(project) },
        { includeClicks: false },
      );
      if (drafts.length === 0) {
        pushToast({
          tone: 'warn',
          title: '没有可生成步骤的标记',
          message: '录制时按「标记」记录关键操作，或用「新建步骤」手动添加。',
        });
        return;
      }
      for (const draft of drafts) {
        execute<SetStepCommand>({ kind: 'SetStep', step: draft }, '生成教程步骤草稿');
      }
      selectStep(drafts[0].id);
      pushToast({
        tone: 'ok',
        title: `已生成 ${drafts.length} 个步骤草稿`,
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
    const id = `step-manual-${Date.now().toString(36)}`;
    const start = Math.max(0, Math.min(tick, Math.max(0, duration - secondsToTicks(2))));
    const step: TutorialStep = {
      id,
      sourceRange: { start, end: Math.min(duration, start + secondsToTicks(3)) },
      title: `步骤 ${steps.length + 1} 待补充说明`,
      description: '',
      imageTick: Math.min(Math.max(0, duration - 1), start + secondsToTicks(0.6)),
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
    const second: TutorialStep = {
      ...step,
      id: `step-split-${Date.now().toString(36)}`,
      sourceRange: { start: cut, end: step.sourceRange.end },
      title: `${step.title}（续）`,
      description: '',
      imageTick: Math.min(step.sourceRange.end - 1, cut + secondsToTicks(0.4)),
    };
    execute<SetStepCommand>({ kind: 'SetStep', step: first }, '拆分教程步骤');
    execute<SetStepCommand>({ kind: 'SetStep', step: second }, '拆分教程步骤');
    selectStep(second.id);
    pushToast({ tone: 'ok', title: '已拆分步骤', message: '请为新的第二段补充标题与说明。' });
  };

  const syncPrivacyVersion = () => {
    if (!project) return;
    for (const step of steps) {
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
                      setTick(stepImageTick(project, step));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        selectStep(step.id);
                        setTick(stepImageTick(project, step));
                      }
                    }}
                  >
                    <span className="step-num">{index + 1}</span>
                    <span className="step-main">
                      <span className="step-title">{step.title || `步骤 ${index + 1} 待补充说明`}</span>
                      {step.description && <span className="step-desc">{step.description}</span>}
                      <span className="step-meta">
                        <span>{formatDuration(step.sourceRange.start)} → {formatDuration(step.sourceRange.end)}</span>
                        <span>截图 {formatDuration(step.imageTick)}</span>
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
                subtitle={`截图时间 ${formatDuration(current.imageTick)}`}
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
                    <Field label="标题" htmlFor="step-title">
                      <TextInput
                        id="step-title"
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onBlur={() => {
                          const next = editingTitle.trim();
                          if (next && next !== current.title) saveStep({ title: next });
                        }}
                        placeholder="例如：填写联系人信息"
                      />
                    </Field>
                    <Field label="说明" htmlFor="step-desc" hint="说明写清楚「在哪、做什么、会看到什么」，不要编造界面功能">
                      <textarea
                        id="step-desc"
                        className="wcs-textarea"
                        rows={4}
                        value={editingDesc}
                        onChange={(event) => setEditingDesc(event.target.value)}
                        onBlur={() => {
                          if (editingDesc !== current.description) saveStep({ description: editingDesc });
                        }}
                        placeholder="描述这一步的操作与预期结果"
                      />
                    </Field>
                    <Field label="截图时间" htmlFor="step-image" hint="输入 mm:ss.cc 或纯秒数，回车或失焦生效">
                      <div style={{ display: 'flex', gap: 6 }}>
                        <TextInput
                          id="step-image"
                          value={editingImage}
                          onChange={(event) => setEditingImage(event.target.value)}
                          onBlur={() => {
                            const parsed = parseDuration(editingImage);
                            if (parsed == null) {
                              pushToast({ tone: 'warn', title: '时间格式无法识别', message: '请使用 mm:ss.cc 或纯秒数。' });
                              setEditingImage(formatDuration(current.imageTick));
                              return;
                            }
                            const clamped = Math.max(
                              current.sourceRange.start,
                              Math.min(Math.max(0, duration - 1), parsed),
                            );
                            saveStep({ imageTick: clamped });
                            setEditingImage(formatDuration(clamped));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                          }}
                        />
                        <Button
                          size="sm"
                          icon="clock"
                          onClick={() => {
                            const clamped = Math.max(current.sourceRange.start, Math.min(Math.max(0, duration - 1), tick));
                            saveStep({ imageTick: clamped });
                            setEditingImage(formatDuration(clamped));
                          }}
                        >
                          取播放头
                        </Button>
                      </div>
                    </Field>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      <Button
                        size="sm"
                        icon="play"
                        onClick={() => {
                          setTick(stepImageTick(project, current));
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
                      <StepThumb step={current} tick={stepImageTick(project, current)} maxWidth={560} />
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
                    onClick={() =>
                      saveStep({
                        sourceRange: { start: Math.min(tick, current.sourceRange.end), end: current.sourceRange.end },
                      })
                    }
                  >
                    开始设为播放头
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      saveStep({
                        sourceRange: { start: current.sourceRange.start, end: Math.max(tick, current.sourceRange.start + secondsToTicks(0.2)) },
                      })
                    }
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
