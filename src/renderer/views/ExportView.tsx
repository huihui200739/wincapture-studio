/**
 * 导出面板（§6.2 步骤 5–6）
 *
 * - 先选产物类型：视频 / 图文教程（可同时导出）。
 * - 显示输出路径、画幅、预计体积与导出前检查结果。
 * - 进度条（阶段 + 帧数 + 已写字节）、取消、失败后重试、完成后打开文件夹。
 * - 导出失败保留工程与素材，文案明确说明「数据已保留」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExportProgress, ExportProfile } from '@shared/ipc';
import type { ExportBundleResult } from '@shared/api';
import type { ErrorCode } from '@shared/errors';
import { useApp } from '../lib/store';
import { Badge, Button, EmptyState, Field, Icon, InlineNote, Panel, ProgressBar, Spinner, TextInput } from '../components/ui';
import {
  bytesPerSecond,
  cn,
  describeError,
  formatBitrate,
  formatBytes,
  formatClock,
  unwrap,
  type PresentedError,
} from '../lib/format';
import { wcs } from '../lib/wcs';
import { timelineDuration } from '@domain/project';
import { TICKS_PER_SECOND } from '@domain/timebase';
import { createExportProfile, type ExportResolution, type ExportFrameRate, type ExportQuality } from '../lib/exportSettings';
import {
  classifyExportBundle,
  deriveDefaultOutputPath,
  normalizeOutputPath,
  validateOutputPath,
  type ExportBundleLike,
} from '../uiSync';

type Kind = 'video' | 'tutorial' | 'both';
type Status = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

const PHASE_TEXT: Record<ExportProgress['phase'], string> = {
  preparing: '准备工程快照',
  rendering: '渲染画面',
  encoding: '编码视频',
  muxing: '封装 MP4',
  finalizing: '收尾与校验',
  done: '完成',
  cancelled: '已取消',
  failed: '失败',
};

const VARIANTS = [
  { id: 'landscape', label: '16:9 横屏', w: 34, h: 19 },
  { id: 'square', label: '1:1 方形', w: 24, h: 24 },
  { id: 'portrait', label: '9:16 竖屏', w: 17, h: 30 },
];

export function ExportView() {
  const { project, systemInfo, pushToast, pushError, apiMode, setView, selectEffect } = useApp();

  const [kind, setKind] = useState<Kind>('video');
  const [variantId, setVariantId] = useState('landscape');
  const [resolution, setResolution] = useState<ExportResolution>('1080');
  const [outputFps, setOutputFps] = useState<ExportFrameRate>('project');
  const [quality, setQuality] = useState<ExportQuality>('balanced');
  const [outputPath, setOutputPath] = useState('');
  /**
   * 用户手动改过输出路径的「工程 ID」。
   * 只记布尔值不够：换工程后仍是 true，默认路径不再重新推导，
   * 于是工程 B 的导出会直接写到工程 A 的 xxx.mp4 上，静默覆盖上一份产物。
   */
  const [pathTouchedFor, setPathTouchedFor] = useState<string | null>(null);
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (project) setVariantId(project.settings.activeVariantId);
  }, [projectId]);
  const pathTouched = pathTouchedFor !== null && pathTouchedFor === projectId;
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportBundleResult | null>(null);
  /** 成功但有非致命问题（教程包失败、完整性校验未过等），必须显示出来 */
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<PresentedError | null>(null);
  const [picking, setPicking] = useState(false);
  /** 已发出取消请求、还没收到终态：按钮显示「正在取消」而不是立刻宣称已取消 */
  const [cancelling, setCancelling] = useState(false);
  const jobRef = useRef<{ cancelled: boolean } | null>(null);
  /** 同步挡重复启动：两个按钮在同一 tick 连点会都通过 status 判断 */
  const runningRef = useRef(false);
  /** 当前任务的 jobId：过滤上一任务迟到的进度事件 */
  const jobIdRef = useRef<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const duration = useMemo(() => (project ? timelineDuration(project) : 0), [project]);
  const unconfirmedPrivacy = useMemo(
    () =>
      project
        ? project.effects.filter((e) => e.kind === 'privacy' && !(e.parameters as { confirmed?: boolean }).confirmed)
        : [],
    [project],
  );

  const pathCheck = useMemo(() => validateOutputPath(outputPath), [outputPath]);

  /**
   * 默认输出路径：跟着「视频目录 + 当前工程名」走。
   * 旧实现只在 outputPath 为空时算一次，换了工程后仍然沿用一个工程的路径，
   * 二次导出会静默覆盖上一份产物；带非法字符的工程名也可能拼出无效路径。
   */
  useEffect(() => {
    if (pathTouched) return;
    const derived = deriveDefaultOutputPath(systemInfo?.videosPath, project?.name);
    if (derived) setOutputPath(derived);
  }, [pathTouched, project?.name, systemInfo?.videosPath]);

  // 进度订阅
  useEffect(() => {
    const off = wcs().onExportProgress((next) => {
      // 旧任务的迟到事件不能污染新任务进度
      if (jobIdRef.current !== null && next.jobId !== jobIdRef.current) return;
      if (statusRef.current !== 'running') return;
      if (jobIdRef.current === null) jobIdRef.current = next.jobId;
      setProgress(next);
      if (next.phase === 'cancelled') {
        setStatus('cancelled');
        setCancelling(false);
      }
      if (next.phase === 'failed') {
        setStatus('failed');
        setCancelling(false);
      }
    });
    return off;
  }, []);

  const profile = useMemo<ExportProfile | null>(() => {
    if (!project) return null;
    return createExportProfile(project, { variantId, resolution, fps: outputFps, quality,
      includeTutorial: kind === 'tutorial' || kind === 'both' });
  }, [kind, project, variantId, resolution, outputFps, quality]);

  const estimatedBytes = useMemo(() => {
    if (!profile || duration <= 0) return 0;
    const seconds = duration / TICKS_PER_SECOND;
    return bytesPerSecond(profile.videoBitrate, profile.audioBitrate) * seconds;
  }, [duration, profile]);

  const pickPath = async () => {
    setPicking(true);
    try {
      const picked = unwrap(
        await wcs().pickSavePath(`${project?.name ?? 'WinCapture 录制'}.mp4`, [
          { name: 'MP4 视频', extensions: ['mp4'] },
        ]),
      );
      if (picked) {
        setOutputPath(normalizeOutputPath(picked));
        setPathTouchedFor(projectId);
      }
    } catch (err) {
      pushError(err, '选择输出路径失败');
    } finally {
      setPicking(false);
    }
  };

  /** 把导出结果归类后的失败转成界面统一的错误展示。 */
  const presentedFromOutcome = (outcome: Extract<ReturnType<typeof classifyExportBundle>, { kind: 'failed' }>): PresentedError =>
    describeError({
      code: outcome.code as ErrorCode,
      message: outcome.message,
      retryable: outcome.retryable,
      preservedData: outcome.preservedData,
    });

  const startExport = useCallback(async () => {
    if (!project || !profile || runningRef.current) return;
    const validation = validateOutputPath(outputPath);
    if (!validation.ok) {
      pushToast({ tone: 'warn', title: '输出路径不可用', message: validation.reason ?? '请检查输出路径。' });
      return;
    }
    runningRef.current = true;
    setStatus('running');
    setProgress(null);
    setResult(null);
    setWarnings([]);
    setError(null);
    setCancelling(false);
    jobIdRef.current = null;
    const job = { cancelled: false };
    jobRef.current = job;
    try {
      const bundle = unwrap(
        await wcs().startExport({
          project,
          profile,
          outputPath: validation.normalized,
          includeTutorial: kind === 'tutorial' || kind === 'both',
        }),
      );
      // 用户已点取消：即便隐藏窗口最终跑完并写出了文件，也不能显示成「导出完成」
      if (job.cancelled) {
        setStatus('cancelled');
        return;
      }
      const outcome = classifyExportBundle(bundle as unknown as ExportBundleLike);
      if (outcome.kind === 'cancelled') {
        setStatus('cancelled');
        return;
      }
      if (outcome.kind === 'failed') {
        // 关键修复：导出窗口把异常当正常返回值带回（IPC 外层 ok:true），
        // 旧实现直接 setStatus('done')，编码失败/取消都会显示「导出完成」。
        const presented = presentedFromOutcome(outcome);
        setError(presented);
        setStatus('failed');
        pushToast({ tone: 'danger', title: presented.title, message: presented.message, detail: presented.detail });
        return;
      }
      setResult(bundle);
      setWarnings(outcome.warnings);
      setStatus('done');
      const video = bundle.video;
      pushToast({
        tone: outcome.warnings.length > 0 ? 'warn' : 'ok',
        title: outcome.warnings.length > 0 ? '导出完成（有告警）' : '导出完成',
        message: video
          ? `${formatBytes(video.bytes)} · ${video.frames} 帧 · 完整性校验${video.verified ? '通过' : '未通过'}`
          : '教程包已生成',
      });
      if (outcome.warnings.length > 0) {
        pushToast({ tone: 'warn', title: '需要注意', message: outcome.warnings.join('；') });
      }
    } catch (err) {
      if (job.cancelled) {
        setStatus('cancelled');
        return;
      }
      const presented = describeError(err);
      setError(presented);
      setStatus('failed');
      pushToast({ tone: 'danger', title: presented.title, message: presented.message, detail: presented.detail });
    } finally {
      jobRef.current = null;
      runningRef.current = false;
      setCancelling(false);
    }
  }, [kind, outputPath, profile, project, pushToast]);

  /**
   * 取消导出。
   *
   * 旧实现点了取消就立刻把界面切成「已取消」并宣称临时文件已清理，
   * 但取消信号可能到达得太晚（导出窗口还没注册 AbortController），
   * 实际导出仍在跑、甚至写完了文件。现在只标记「正在取消」，
   * 等 startExport 的 Promise 结算后由结果决定最终状态。
   */
  const cancelExport = async () => {
    if (!runningRef.current || cancelling) return;
    setCancelling(true);
    if (jobRef.current) jobRef.current.cancelled = true;
    try {
      unwrap(await wcs().cancelExport());
      pushToast({ tone: 'info', title: '已请求取消导出', message: '正在等待导出进程停止，临时文件会被清理。' });
    } catch (err) {
      pushError(err, '取消导出失败');
      setCancelling(false);
    }
  };

  const revealOutput = async (path: string) => {
    try {
      unwrap(await wcs().showInFolder(path));
    } catch (err) {
      pushError(err, '打开文件夹失败');
    }
  };

  const playOutput = async (path: string) => {
    try {
      unwrap(await wcs().openPath(path));
    } catch (err) {
      pushError(err, '播放视频失败');
    }
  };

  const openTutorial = async (path: string) => {
    try {
      unwrap(await wcs().openPath(path));
    } catch (err) {
      pushError(err, '打开教程失败');
    }
  };

  /** 回到可重新导出的初始状态（清掉上一轮的结果/进度/告警，避免二次导出残留）。 */
  const resetToIdle = () => {
    setStatus('idle');
    setProgress(null);
    setError(null);
    setWarnings([]);
  };

  if (!project) {
    return (
      <div className="view">
        <div className="view-head">
          <div>
            <h1>导出</h1>
            <p>先打开或创建一个工程。</p>
          </div>
        </div>
        <EmptyState
          icon="export"
          title="没有可导出的工程"
          description="录制一段或打开已有工程后，再回到这里选择产物与画幅。"
          actions={
            <>
              <Button variant="primary" icon="record" onClick={() => setView('record')}>
                去录制
              </Button>
              <Button icon="home" onClick={() => setView('home')}>
                回首页
              </Button>
            </>
          }
        />
      </div>
    );
  }

  const running = status === 'running';

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>导出</h1>
          <p>选择产物类型与画幅，确认输出路径后开始导出；导出不修改工程。</p>
        </div>
        <div className="view-actions">
          {running ? (
            <Button variant="danger" icon="close" onClick={() => void cancelExport()} loading={cancelling} disabled={cancelling}>
              {cancelling ? '正在取消…' : '取消导出'}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="export"
              onClick={() => void startExport()}
              disabled={!pathCheck.ok}
              title={pathCheck.ok ? undefined : pathCheck.reason}
            >
              {status === 'failed' ? '重试导出' : status === 'done' ? '再导出一份' : '开始导出'}
            </Button>
          )}
        </div>
      </div>

      {unconfirmedPrivacy.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <InlineNote tone="warn">
            <strong>{unconfirmedPrivacy.length} 处遮挡未确认。</strong> 这些区域不会被遮挡，导出后仍可能暴露敏感信息。
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                onClick={() => {
                  selectEffect(unconfirmedPrivacy[0].id);
                  setView('editor');
                }}
              >
                去编辑器确认
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setView('editor')}>
                打开编辑器
              </Button>
            </div>
          </InlineNote>
        </div>
      )}

      <div className="export-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <Panel title="产物类型" icon="export" subtitle="视频与教程可以同时导出">
            <div className="kind-cards">
              {[
                { id: 'video' as Kind, icon: 'editor', title: '视频', desc: 'MP4 · H.264 + AAC，含运镜、遮挡与画布样式' },
                { id: 'tutorial' as Kind, icon: 'book', title: '图文教程', desc: '静态 HTML + Markdown + 步骤截图' },
                { id: 'both' as Kind, icon: 'layers', title: '视频 + 教程', desc: '同时生成，共享同一份遮挡确认结果' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn('kind-card', kind === item.id && 'is-selected')}
                  aria-pressed={kind === item.id}
                  onClick={() => setKind(item.id)}
                  style={item.id === 'both' ? { gridColumn: 'span 2' } : undefined}
                >
                  <span className="kind-icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span>
                    <span className="kind-title">{item.title}</span>
                    <span className="kind-desc" style={{ display: 'block', marginTop: 2 }}>
                      {item.desc}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="输出设置" icon="settings">
            <Field
              label="输出路径"
              htmlFor="export-path"
              hint={
                pathCheck.ok
                  ? '导出前会检查目录可写与磁盘余量。'
                  : pathCheck.reason ?? '导出前会检查目录可写与磁盘余量。'
              }
            >
              <div className="path-row">
                <TextInput
                  id="export-path"
                  value={outputPath}
                  onChange={(event) => {
                    setOutputPath(event.target.value);
                    setPathTouchedFor(projectId);
                  }}
                  onBlur={() => {
                    // 用户手输路径时补全 .mp4，避免主进程写出没有扩展名的文件
                    if (outputPath.trim()) setOutputPath(normalizeOutputPath(outputPath));
                  }}
                  placeholder="选择 .mp4 输出路径"
                  disabled={running}
                  aria-invalid={!pathCheck.ok}
                />
                <Button size="sm" icon="folder" loading={picking} onClick={() => void pickPath()} disabled={running}>
                  浏览
                </Button>
              </div>
            </Field>

            <Field label="画幅">
              <div className="variant-row">
                {VARIANTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn('variant-card', variantId === item.id && 'is-selected')}
                    aria-pressed={variantId === item.id}
                    onClick={() => setVariantId(item.id)}
                    disabled={running}
                  >
                    <span className="variant-shape" style={{ width: item.w, height: item.h }} />
                    <span className="variant-label">{item.label}</span>
                  </button>
                ))}
              </div>
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Field label="分辨率" htmlFor="export-resolution" hint={profile ? `${profile.width} × ${profile.height} 像素；放大输出不会增加源素材细节。` : undefined}>
                <select id="export-resolution" className="wcs-select" value={resolution} disabled={running}
                  aria-label="输出分辨率" onChange={(e) => setResolution(e.target.value as ExportResolution)}>
                  <option value="source">原始素材尺寸</option>
                  <option value="720">720p · 轻量分享</option>
                  <option value="1080">1080p · 全高清</option>
                  <option value="1440">1440p · 2K</option>
                  <option value="2160">2160p · 4K</option>
                </select>
              </Field>
              <Field label="帧率" htmlFor="export-fps">
                <select id="export-fps" className="wcs-select" value={outputFps} disabled={running}
                  aria-label="输出帧率" onChange={(e) => setOutputFps(e.target.value as ExportFrameRate)}>
                  <option value="project">跟随工程 · {project.settings.fps.num / project.settings.fps.den} FPS</option>
                  <option value="30">30 FPS</option><option value="60">60 FPS</option>
                </select>
              </Field>
              <Field label="画质" htmlFor="export-quality">
                <select id="export-quality" className="wcs-select" value={quality} disabled={running}
                  aria-label="输出画质" onChange={(e) => setQuality(e.target.value as ExportQuality)}>
                  <option value="compact">小体积</option><option value="balanced">均衡（推荐）</option><option value="high">高画质</option>
                </select>
              </Field>
              <Field label="视频码率">
                <TextInput value={profile ? formatBitrate(profile.videoBitrate) : '—'} readOnly aria-label="视频码率" />
              </Field>
              <Field label="音频码率">
                <TextInput value={profile ? formatBitrate(profile.audioBitrate) : '—'} readOnly aria-label="音频码率" />
              </Field>
            </div>
          </Panel>

          <Panel title="导出进度" icon="clock" subtitle={status === 'idle' ? '尚未开始' : undefined}>
            {status === 'idle' && (
              <div className="wcs-empty" style={{ padding: '18px 12px' }}>
                <Icon name="export" size={20} />
                <p>点右上角「开始导出」后，这里会显示阶段、帧数与已写字节。</p>
              </div>
            )}

            {(status === 'running' || status === 'cancelled') && (
              <div className="progress-card">
                <div className="progress-head">
                  <div className="progress-phase">
                    {status === 'running' ? <Spinner size={13} /> : <Icon name="close" size={14} />}
                    {status === 'cancelled'
                      ? '导出已取消'
                      : cancelling
                        ? '正在取消…'
                        : progress
                          ? PHASE_TEXT[progress.phase]
                          : '准备中'}
                  </div>
                  <span className="progress-msg">
                    {status === 'cancelled' ? '导出已停止，未完成的临时文件已被清理。' : progress?.message ?? '正在准备工程快照'}
                  </span>
                </div>
                <ProgressBar
                  value={progress?.progress ?? 0}
                  label="导出进度"
                  tone={status === 'cancelled' ? 'warn' : 'accent'}
                  indeterminate={status === 'running' && !progress}
                />
                <div className="progress-facts">
                  <span>帧 {progress?.framesDone ?? 0} / {progress?.framesTotal ?? 0}</span>
                  <span>已写 {formatBytes(progress?.bytesWritten ?? 0)}</span>
                  <span>阶段 {progress ? PHASE_TEXT[progress.phase] : '准备'}</span>
                </div>
                {status === 'running' && (
                  <div>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="close"
                      onClick={() => void cancelExport()}
                      loading={cancelling}
                      disabled={cancelling}
                    >
                      {cancelling ? '正在取消…' : '取消导出'}
                    </Button>
                  </div>
                )}
                {status === 'cancelled' && (
                  <InlineNote tone="warn">
                    已取消。工程与素材保持原样；导出过程中产生的临时文件会在导出进程退出时清理。
                  </InlineNote>
                )}
              </div>
            )}

            {status === 'failed' && error && (
              <div className="progress-card">
                <InlineNote tone="danger">
                  <strong>{error.title}</strong>
                  <div style={{ marginTop: 3 }}>{error.message}</div>
                  {error.preservedData && (
                    <div style={{ marginTop: 5, color: 'var(--text-muted)' }}>已完成的素材与工程数据均已保留，可以直接重试。</div>
                  )}
                  {error.detail && <div className="toast-detail" style={{ marginTop: 5 }}>{error.detail}</div>}
                </InlineNote>
                <div style={{ display: 'flex', gap: 7 }}>
                  <Button size="sm" variant="primary" icon="refresh" onClick={() => void startExport()} disabled={!pathCheck.ok}>
                    重试导出
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetToIdle}>
                    返回
                  </Button>
                </div>
              </div>
            )}

            {status === 'done' && result && (
              <div className="result-card">
                <div className="result-head">
                  <Icon name={warnings.length > 0 ? 'warning' : 'check'} size={15} />
                  {warnings.length > 0 ? '导出完成（有告警）' : '导出完成'}
                </div>
                {warnings.length > 0 && (
                  <InlineNote tone="warn">
                    {warnings.map((warning, index) => (
                      <div key={`${index}-${warning}`}>{warning}</div>
                    ))}
                  </InlineNote>
                )}
                {result.video && (
                  <div className="result-facts">
                    <span>视频：{result.video.outputPath ?? '（未返回路径）'}</span>
                    <span>
                      {formatBytes(result.video.bytes)} · {result.video.frames} 帧 · {formatClock(result.video.durationTicks)} ·{' '}
                      {result.video.encoder}
                    </span>
                    <span>完整性校验：{result.video.verified ? '通过' : '未通过'}</span>
                  </div>
                )}
                {result.tutorial && (
                  <div className="result-facts">
                    <span>教程：{result.tutorial.indexPath}</span>
                    <span>
                      Markdown {result.tutorial.markdownPath} · {result.tutorial.imageCount} 张截图
                    </span>
                  </div>
                )}
                <div className="result-facts">
                  <span>工程快照哈希：{result.snapshotHash || '（未返回）'}</span>
                </div>
                <div className="result-actions">
                  {result.video?.outputPath && (
                    <Button size="sm" icon="folder" onClick={() => void revealOutput(result.video!.outputPath as string)}>
                      打开所在文件夹
                    </Button>
                  )}
                  {result.video?.outputPath && (
                    <Button size="sm" variant="ghost" icon="play" onClick={() => void playOutput(result.video!.outputPath as string)}>
                      播放视频
                    </Button>
                  )}
                  {result.tutorial?.indexPath && (
                    <Button size="sm" variant="ghost" icon="book" onClick={() => void openTutorial(result.tutorial!.indexPath)}>
                      打开教程
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon="refresh" onClick={resetToIdle}>
                    再导出一份
                  </Button>
                </div>
              </div>
            )}
          </Panel>
        </div>

        <div className="side-stack">
          <Panel title="导出前检查" icon="shield">
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-key">工程</span>
                <span className="kv-value" style={{ fontFamily: 'inherit' }}>{project.name}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">时长</span>
                <span className="kv-value">{formatClock(duration)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">预计体积</span>
                <span className="kv-value">{formatBytes(estimatedBytes)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">遮挡确认</span>
                <span className="kv-value">
                  {unconfirmedPrivacy.length === 0 ? (
                    <Badge tone="ok" icon="check">全部已确认</Badge>
                  ) : (
                    <Badge tone="warn" icon="warning">{unconfirmedPrivacy.length} 处未确认</Badge>
                  )}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">教程步骤</span>
                <span className="kv-value">{project.steps.length}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">输出路径</span>
                <span className="kv-value">
                  {pathCheck.ok ? (
                    <Badge tone="ok" icon="check">可用于导出</Badge>
                  ) : (
                    <Badge tone="warn" icon="warning">{pathCheck.reason ?? '待填写'}</Badge>
                  )}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">磁盘可写</span>
                <span className="kv-value">{systemInfo ? '导出时由主进程检查' : '读取中…'}</span>
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <InlineNote tone={unconfirmedPrivacy.length > 0 ? 'warn' : 'ok'}>
                {unconfirmedPrivacy.length > 0
                  ? '未确认的遮挡不会生效。建议先在编辑器里核对并确认，再导出。'
                  : '遮挡全部确认，教程截图与视频会使用同一份遮挡结果。'}
              </InlineNote>
            </div>
          </Panel>

          <Panel title="产物说明" icon="info">
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-key">视频</span>
                <span className="kv-value">MP4 / H.264 / AAC</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">教程</span>
                <span className="kv-value">HTML + Markdown + PNG</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">预览一致</span>
                <span className="kv-value">与预览同一 drawScene</span>
              </div>
            </div>
            <p className="wcs-field-hint" style={{ marginTop: 8 }}>
              导出使用工程快照，不阻塞继续编辑；导出过程中修改工程不会影响本次产物。
            </p>
          </Panel>

          {apiMode === 'mock' && (
            <InlineNote tone="warn">
              <strong>示例数据模式：</strong> 导出流程会模拟进度与结果，不会真正写出 MP4 文件。
            </InlineNote>
          )}
        </div>
      </div>
    </div>
  );
}
