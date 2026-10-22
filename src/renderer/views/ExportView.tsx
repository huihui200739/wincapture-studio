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
import { useApp } from '../lib/store';
import { Badge, Button, EmptyState, Field, Icon, InlineNote, Panel, ProgressBar, Segmented, Spinner, TextInput } from '../components/ui';
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
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportBundleResult | null>(null);
  const [error, setError] = useState<PresentedError | null>(null);
  const [picking, setPicking] = useState(false);
  const jobRef = useRef<{ cancelled: boolean } | null>(null);

  const duration = useMemo(() => (project ? timelineDuration(project) : 0), [project]);
  const unconfirmedPrivacy = useMemo(
    () =>
      project
        ? project.effects.filter((e) => e.kind === 'privacy' && !(e.parameters as { confirmed?: boolean }).confirmed)
        : [],
    [project],
  );

  // 默认输出路径
  useEffect(() => {
    if (outputPath) return;
    const base = systemInfo?.videosPath ?? 'C:\\Users\\huihui\\Videos\\WinCapture Studio';
    const name = project?.name?.replace(/[\\/:*?"<>|]/g, '-') ?? 'WinCapture 录制';
    setOutputPath(`${base}\\${name}.mp4`);
  }, [outputPath, project?.name, systemInfo?.videosPath]);

  // 进度订阅
  useEffect(() => {
    const off = wcs().onExportProgress((next) => {
      setProgress(next);
      if (next.phase === 'cancelled') setStatus('cancelled');
      if (next.phase === 'failed') setStatus('failed');
    });
    return off;
  }, []);

  const profile = useMemo<ExportProfile | null>(() => {
    if (!project) return null;
    const variant = project.variants.find((v) => v.id === variantId) ?? project.variants[0];
    const [aw, ah] = variant.aspect;
    const longEdge = 1920;
    const rawW = aw >= ah ? longEdge : Math.round((longEdge * aw) / ah);
    const rawH = aw >= ah ? Math.round((longEdge * ah) / aw) : longEdge;
    return {
      variantId: variant.id,
      width: rawW % 2 === 0 ? rawW : rawW + 1,
      height: rawH % 2 === 0 ? rawH : rawH + 1,
      fps: { ...project.settings.fps },
      videoBitrate: 12_000_000,
      audioBitrate: 192_000,
      audioOnly: false,
      includeTutorial: kind === 'tutorial' || kind === 'both',
    };
  }, [kind, project, variantId]);

  const estimatedBytes = useMemo(() => {
    if (!profile || duration <= 0) return 0;
    const seconds = duration / TICKS_PER_SECOND;
    return bytesPerSecond(profile.videoBitrate, profile.audioBitrate) * seconds;
  }, [duration, profile]);

  const pickPath = async () => {
    setPicking(true);
    try {
      const picked = unwrap(await wcs().pickSavePath(`${project?.name ?? 'WinCapture 录制'}.mp4`));
      if (picked) setOutputPath(picked);
    } catch (err) {
      pushError(err, '选择输出路径失败');
    } finally {
      setPicking(false);
    }
  };

  const startExport = useCallback(async () => {
    if (!project || !profile) return;
    if (!outputPath.trim()) {
      pushToast({ tone: 'warn', title: '请先选择输出路径' });
      return;
    }
    setStatus('running');
    setProgress(null);
    setResult(null);
    setError(null);
    const job = { cancelled: false };
    jobRef.current = job;
    try {
      const bundle = unwrap(
        await wcs().startExport({
          project,
          profile,
          outputPath: outputPath.trim(),
          includeTutorial: kind === 'tutorial' || kind === 'both',
        }),
      );
      if (job.cancelled) {
        setStatus('cancelled');
        return;
      }
      setResult(bundle);
      setStatus('done');
      pushToast({
        tone: 'ok',
        title: '导出完成',
        message: bundle.video ? `${formatBytes(bundle.video.bytes)} · ${bundle.video.frames} 帧 · 完整性校验${bundle.video.verified ? '通过' : '未通过'}` : '教程包已生成',
      });
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
    }
  }, [kind, outputPath, profile, project, pushToast]);

  const cancelExport = async () => {
    if (jobRef.current) jobRef.current.cancelled = true;
    try {
      await wcs().cancelExport();
      setStatus('cancelled');
      pushToast({ tone: 'info', title: '已请求取消导出', message: '临时文件会被清理，工程与素材保持原样。' });
    } catch (err) {
      pushError(err, '取消导出失败');
    }
  };

  const revealOutput = async (path: string) => {
    try {
      await wcs().showInFolder(path);
    } catch (err) {
      pushError(err, '打开文件夹失败');
    }
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
            <Button variant="danger" icon="close" onClick={() => void cancelExport()}>
              取消导出
            </Button>
          ) : (
            <Button variant="primary" icon="export" onClick={() => void startExport()}>
              {status === 'failed' ? '重试导出' : '开始导出'}
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
            <Field label="输出路径" htmlFor="export-path" hint="导出前会检查目录可写与磁盘余量">
              <div className="path-row">
                <TextInput
                  id="export-path"
                  value={outputPath}
                  onChange={(event) => setOutputPath(event.target.value)}
                  placeholder="选择 .mp4 输出路径"
                  disabled={running}
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
              <Field label="分辨率">
                <TextInput value={profile ? `${profile.width} × ${profile.height}` : '—'} readOnly aria-label="输出分辨率" />
              </Field>
              <Field label="帧率">
                <TextInput value={profile ? `${profile.fps.num}/${profile.fps.den} fps` : '—'} readOnly aria-label="输出帧率" />
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
                    {status === 'cancelled' ? '导出已取消' : progress ? PHASE_TEXT[progress.phase] : '准备中'}
                  </div>
                  <span className="progress-msg">{progress?.message ?? '正在准备工程快照'}</span>
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
                    <Button size="sm" variant="danger" icon="close" onClick={() => void cancelExport()}>
                      取消导出
                    </Button>
                  </div>
                )}
                {status === 'cancelled' && (
                  <InlineNote tone="warn">
                    已取消。临时文件已清理，工程与素材保持原样，可以修改后重新导出。
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
                  <Button size="sm" variant="primary" icon="refresh" onClick={() => void startExport()}>
                    重试导出
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setStatus('idle')}>
                    返回
                  </Button>
                </div>
              </div>
            )}

            {status === 'done' && result && (
              <div className="result-card">
                <div className="result-head">
                  <Icon name="check" size={15} />
                  导出完成
                </div>
                {result.video && (
                  <div className="result-facts">
                    <span>视频：{result.video.outputPath}</span>
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
                  <span>工程快照哈希：{result.snapshotHash}</span>
                </div>
                <div className="result-actions">
                  {result.video?.outputPath && (
                    <Button size="sm" icon="folder" onClick={() => void revealOutput(result.video!.outputPath!)}>
                      打开所在文件夹
                    </Button>
                  )}
                  {result.video?.outputPath && (
                    <Button size="sm" variant="ghost" icon="play" onClick={() => void wcs().openPath(result.video!.outputPath!)}>
                      播放视频
                    </Button>
                  )}
                  {result.tutorial?.indexPath && (
                    <Button size="sm" variant="ghost" icon="book" onClick={() => void wcs().openPath(result.tutorial!.indexPath)}>
                      打开教程
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => setStatus('idle')}>
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
                <span className="kv-key">磁盘可写</span>
                <span className="kv-value">{systemInfo ? '已检测' : '未知'}</span>
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
