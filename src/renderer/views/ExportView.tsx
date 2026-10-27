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
import { Badge, Button, EmptyState, Field, Icon, InlineNote, Panel, ProgressBar, Spinner, TextInput, Modal, Segmented } from '../components/ui';
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
import { PreviewCanvas } from '../components/PreviewCanvas';
import { loadSettings } from '../lib/settings';
import { playExportSound } from '../lib/appearance';
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

type Kind = 'video' | 'audio' | 'tutorial' | 'both';
type Status = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

const PHASE_TEXT: Record<ExportProgress['phase'], string> = {
  preparing: '准备工程快照',
  rendering: '渲染画面',
  encoding: '编码媒体',
  muxing: '封装输出文件',
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

export function ExportView({ onClose }: { onClose?: () => void }) {
  const { project, projectPath, tick, systemInfo, pushToast, pushError, apiMode, setView, selectEffect } = useApp();

  const [kind, setKind] = useState<Kind>('video');
  const extension = kind === 'audio' ? 'm4a' : 'mp4';
  useEffect(() => setOutputPath((previous) => previous.replace(/\.(mp4|m4a)$/i, `.${extension}`)), [extension]);
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

  const pathCheck = useMemo(() => validateOutputPath(outputPath, extension), [outputPath, extension]);

  /**
   * 默认输出路径：跟着「视频目录 + 当前工程名」走。
   * 旧实现只在 outputPath 为空时算一次，换了工程后仍然沿用一个工程的路径，
   * 二次导出会静默覆盖上一份产物；带非法字符的工程名也可能拼出无效路径。
   */
  useEffect(() => {
    if (pathTouched) return;
    const derived = deriveDefaultOutputPath(loadSettings().exportDirectory || systemInfo?.videosPath, project?.name);
    if (derived) setOutputPath(derived.replace(/\.mp4$/i, `.${extension}`));
  }, [pathTouched, project?.name, systemInfo?.videosPath, extension]);

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
    const result = createExportProfile(project, { variantId, resolution, fps: outputFps, quality,
      includeTutorial: kind === 'tutorial' || kind === 'both' });
    return { ...result, audioOnly: kind === 'audio', videoBitrate: kind === 'audio' ? 0 : result.videoBitrate };
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
        await wcs().pickSavePath(`${project?.name ?? 'WinCapture 录制'}.${extension}`, [
          { name: kind === 'audio' ? 'M4A 音频' : 'MP4 视频', extensions: [extension] },
        ]),
      );
      if (picked) {
        setOutputPath(normalizeOutputPath(picked, extension));
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
    const validation = validateOutputPath(outputPath, extension);
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
            ? `${formatBytes(video.bytes)} · ${kind === 'audio' ? 'AAC 音频' : `${video.frames} 帧`} · 完整性校验${video.verified ? '通过' : '未通过'}`
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
  }, [kind, outputPath, profile, project, pushToast, extension]);

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

  const close = onClose ?? (() => setView('editor'));
  const running = status === 'running';
  if (!project) return <Modal title="导出作品" onClose={close}><EmptyState icon="editor" title="先打开一个工程" description="录制或打开工程后，即可导出作品。" actions={<Button onClick={() => setView('home')}>打开工程</Button>} /></Modal>;
  const fileName = outputPath.split(/[\\/]/).at(-1) ?? '';
  const directory = outputPath.slice(0, Math.max(0, outputPath.length-fileName.length)).replace(/[\\/]+$/, '');
  const previewProject = { ...project, settings: { ...project.settings, activeVariantId: variantId } };
  return <Modal title={<span className="export-dialog-title">导出作品 <small>{project.name}</small></span>} className="export-dialog" width={860}
    dismissible={!running} onClose={() => { if (!runningRef.current) close(); }}
    footer={<><span className="export-estimate">预计大小 · 约 {formatBytes(estimatedBytes)}</span><Button variant="ghost" onClick={() => running ? void cancelExport() : close()} loading={cancelling}>{running ? '取消导出' : '取消'}</Button>{!running && <Button variant="primary" icon="export" onClick={() => void startExport()} disabled={!pathCheck.ok}>{status === 'done' ? '再导出一份' : status === 'failed' ? '重试导出' : kind === 'audio' ? '开始导出音频' : '开始导出视频'}</Button>}</>}>
    <div className="export-sheet-layout">
      <div className="export-options">
        <h3 className="section-caption">文件</h3><div className="export-file-card">
          <TextInput aria-label="导出文件名" value={fileName} disabled={running} onChange={event => { setOutputPath((directory ? directory + String.fromCharCode(92) : '') + event.target.value); setPathTouchedFor(projectId); }} onBlur={() => setOutputPath(previous => normalizeOutputPath(previous,extension))} />
          <button className="export-directory" disabled={running || picking} onClick={() => void pickPath()} title={directory}><Icon name="folder" size={15} /><span>{directory || '选择保存位置'}</span><Icon name="chevronRight" size={13} /></button>
        </div>{!pathCheck.ok && <p className="settings-hint is-error">{pathCheck.reason}</p>}
        <h3 className="section-caption">导出内容</h3><Segmented className="sheet-segmented" ariaLabel="导出内容" options={[{value:'video',label:'视频成片',icon:'editor'},{value:'audio',label:'仅音频',icon:'volume'}]} value={kind} disabled={running} onChange={next => {setKind(next as Kind);resetToIdle();}} />
        {kind !== 'audio' && <><h3 className="section-caption">规格</h3><div className="export-spec-card">
          <span className="export-field-label">分辨率</span><Segmented className="sheet-segmented" ariaLabel="输出分辨率" options={[{value:'source',label:'原始素材'},{value:'1080',label:'1080p'},{value:'1440',label:'1440p'},{value:'2160',label:'4K'}]} value={resolution} disabled={running} onChange={next => setResolution(next as ExportResolution)} />
          <span className="export-field-label">帧率</span><Segmented className="sheet-segmented" ariaLabel="输出帧率" options={[{value:'project',label:'跟随工程'},{value:'30',label:'30 FPS'},{value:'60',label:'60 FPS'}]} value={outputFps} disabled={running} onChange={next => setOutputFps(next as ExportFrameRate)} />
        </div></>}
        <details className="export-advanced"><summary>更多选项<Icon name="chevronDown" size={13} /></summary><div>
          <Field label="产物类型"><select className="wcs-select" aria-label="产物类型" value={kind} disabled={running} onChange={event => {setKind(event.target.value as Kind);resetToIdle();}}><option value="video">视频成片</option><option value="audio">仅音频</option><option value="tutorial">图文教程</option><option value="both">视频 + 教程</option></select></Field>
          {kind !== 'audio' && <><Field label="画幅"><Segmented className="sheet-segmented" ariaLabel="导出画幅" options={VARIANTS.map(item => ({value:item.id,label:item.label}))} value={variantId} disabled={running} onChange={setVariantId} /></Field>
          <Field label="画质"><select className="wcs-select" aria-label="输出画质" value={quality} disabled={running} onChange={event => setQuality(event.target.value as ExportQuality)}><option value="compact">小体积</option><option value="balanced">均衡</option><option value="high">高画质</option></select></Field>
          <Field label="分辨率"><select className="wcs-select" aria-label="输出分辨率详细选项" value={resolution} disabled={running} onChange={event => setResolution(event.target.value as ExportResolution)}><option value="source">原始素材</option><option value="720">720p</option><option value="1080">1080p</option><option value="1440">1440p</option><option value="2160">4K</option></select></Field></>}
          <Field label="完整输出路径"><TextInput id="export-path" value={outputPath} disabled={running} onChange={event => {setOutputPath(event.target.value);setPathTouchedFor(projectId);}} onBlur={() => setOutputPath(previous => normalizeOutputPath(previous,extension))} /></Field>
        </div></details>
      </div>
      <aside className="export-summary">
        <div className="export-preview"><PreviewCanvas project={previewProject} projectPath={projectPath} tick={tick} maxWidth={800} includeOverlays={false} /></div>
        <dl><div><dt>格式</dt><dd>{kind === 'audio' ? 'M4A' : kind === 'tutorial' ? 'HTML + Markdown' : 'MP4'}</dd></div>{kind !== 'audio' && <><div><dt>分辨率</dt><dd>{profile?.width} × {profile?.height}</dd></div><div><dt>帧率</dt><dd>{profile ? profile.fps.num/profile.fps.den : 0} fps</dd></div></>}<div><dt>时长</dt><dd>{formatClock(duration)}</dd></div><div><dt>预计大小</dt><dd>{formatBytes(estimatedBytes)}</dd></div></dl>
        {kind !== 'audio' && unconfirmedPrivacy.length > 0 && <InlineNote tone="warn"><strong>{unconfirmedPrivacy.length} 处遮挡未确认</strong><p>这些区域不会被遮挡。</p><Button size="sm" variant="ghost" onClick={() => {selectEffect(unconfirmedPrivacy[0].id);setView('editor');}}>去确认遮挡</Button></InlineNote>}
        {apiMode === 'mock' && <p className="settings-hint">示例工程 · 未连接录制进程，无法导出文件</p>}
      </aside>
    </div>
    {status !== 'idle' && <div className="export-progress-area"><Panel title="导出进度" icon="clock">

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
                  {kind !== 'audio' && <span>帧 {progress?.framesDone ?? 0} / {progress?.framesTotal ?? 0}</span>}
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
                    <span>{kind === 'audio' ? '音频' : '视频'}：{result.video.outputPath ?? '（未返回路径）'}</span>
                    <span>
                      {formatBytes(result.video.bytes)} · {kind !== 'audio' && `${result.video.frames} 帧 · `}{formatClock(result.video.durationTicks)} ·{' '}
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
                      播放{kind === 'audio' ? '音频' : '视频'}
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
          </Panel></div>}
  </Modal>;
}
