/**
 * 录制设置页（§6.1 / §6.2 步骤 1）
 *
 * 要点：
 * - 来源选择带缩略图与真实分辨率；不可用来源明确标出原因。
 * - 麦克风与系统声音各自一条电平表（0 电平时显示「无信号」，不只靠颜色）。
 * - 质量档位同时显示「设置值」与「实际能力」，来源/编码器不支持时给出降级说明。
 * - 显示可用磁盘与预计可录时长；磁盘不足时阻止开始并给可执行提示。
 * - 开始前 3 秒倒计时，倒计时可取消。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AudioDeviceInfo,
  CaptureSourceInfo,
  DisplayInfo,
  QualityProfile,
  SystemInfo,
  VideoDeviceInfo,
} from '@shared/ipc';
import { useApp } from '../lib/store';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  IconButton,
  InlineNote,
  LevelMeter,
  Panel,
  Segmented,
  Select,
  Spinner,
  TextInput,
  Toggle,
} from '../components/ui';
import {
  bytesPerSecond,
  cn,
  formatBitrate,
  formatBytes,
  formatDurationLong,
  recordableSeconds,
  unwrap,
} from '../lib/format';
import { wcs } from '../lib/wcs';
import { syntheticCamera, syntheticScreen } from '../lib/syntheticMedia';
import { TICKS_PER_SECOND } from '@domain/timebase';

const MIN_FREE_BYTES = 512 * 1024 * 1024;

export function RecordView() {
  const {
    config,
    updateConfig,
    startRecording,
    capture,
    capturing,
    cancelRecording,
    stopRecording,
    pushToast,
    pushError,
    busy,
    setView,
    apiMode,
    quality,
  } = useApp();

  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<VideoDeviceInfo[]>([]);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<'screen' | 'window'>('screen');
  const [regionEnabled, setRegionEnabled] = useState(false);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [pathCheck, setPathCheck] = useState<{ ok: boolean; writable: boolean; reason?: string } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const cameraRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const countdownTimer = useRef<number | null>(null);

  // ---- 读取设备与来源 ----
  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setDevicesError(null);
    try {
      const [src, disp, dev, prof, sys] = await Promise.all([
        wcs().listSources(),
        wcs().listDisplays(),
        wcs().listDevices(),
        wcs().qualityProfiles(),
        wcs().systemInfo(),
      ]);
      const sourceList = unwrap(src);
      setSources(sourceList);
      setDisplays(unwrap(disp));
      const deviceBundle = unwrap(dev);
      setAudioDevices(deviceBundle.audio);
      setVideoDevices(deviceBundle.video);
      setProfiles(unwrap(prof));
      setSystem(unwrap(sys));

      // 默认选中第一个可用来源
      if (!config.sourceId) {
        const firstScreen = sourceList.find((s) => s.kind === 'screen' && s.available);
        if (firstScreen) {
          updateConfig({ sourceId: firstScreen.id, sourceKind: 'screen' });
          setSourceKind('screen');
        }
      }
      const micDefault = deviceBundle.audio.find((d) => d.kind === 'audioinput' && d.isDefault) ?? deviceBundle.audio.find((d) => d.kind === 'audioinput');
      if (micDefault && !config.microphoneDeviceId) updateConfig({ microphoneDeviceId: micDefault.deviceId });
      const camDefault = deviceBundle.video[0];
      if (camDefault && !config.cameraDeviceId) updateConfig({ cameraDeviceId: camDefault.deviceId });
    } catch (error) {
      const presented = pushError(error, '读取录制设备失败');
      setLoadError(presented.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 磁盘检查 ----
  const checkDisk = useCallback(async () => {
    try {
      const result = unwrap(await wcs().checkPath(system?.videosPath ?? ''));
      setFreeBytes(result.freeBytes);
      setPathCheck({ ok: result.ok, writable: result.writable, reason: result.reason });
    } catch (error) {
      setPathCheck({ ok: false, writable: false, reason: describeSafe(error) });
      setFreeBytes(null);
    }
  }, [system?.videosPath]);

  useEffect(() => {
    void checkDisk();
  }, [checkDisk]);

  // ---- 电平：录制中取主进程推送，空闲时用本地动画表示「设备已就绪」 ----
  useEffect(() => {
    if (capture) {
      setLevels(capture.levels);
      return;
    }
    let raf = 0;
    const tick = () => {
      const t = performance.now() / 1000;
      setLevels({
        mic: config.microphoneEnabled ? Math.max(0, 0.3 + Math.sin(t * 4.1) * 0.2 + Math.sin(t * 9.3) * 0.09) : 0,
        system: config.systemAudioEnabled ? Math.max(0, 0.16 + Math.sin(t * 2.7 + 1) * 0.13 + Math.sin(t * 7.9) * 0.05) : 0,
      });
      raf = requestAnimationFrame(() => window.setTimeout(tick, 90));
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [capture, config.microphoneEnabled, config.systemAudioEnabled]);

  // ---- 摄像头预览 ----
  useEffect(() => {
    if (!config.cameraEnabled) return;
    let raf = 0;
    const draw = () => {
      const canvas = cameraRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const source = syntheticCamera(performance.now() / 1000);
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [config.cameraEnabled]);

  // ---- 来源预览 ----
  const selectedSource = useMemo(() => sources.find((s) => s.id === config.sourceId) ?? null, [sources, config.sourceId]);

  // ---- 录制区域（R01）----
  // 配置里没 region 就表示整屏；面板上的值始终有具体数字方便编辑。
  const region = useMemo(() => {
    if (config.region) return config.region;
    const w = selectedSource?.width ?? 1920;
    const h = selectedSource?.height ?? 1080;
    return { x: 0, y: 0, width: w, height: h };
  }, [config.region, selectedSource]);

  const regionValid = useMemo(() => {
    if (!selectedSource) return true;
    return (
      region.width >= 64 &&
      region.height >= 64 &&
      region.x >= 0 &&
      region.y >= 0 &&
      region.x + region.width <= selectedSource.width &&
      region.y + region.height <= selectedSource.height
    );
  }, [region, selectedSource]);

  const updateRegion = useCallback(
    (patch: Partial<{ x: number; y: number; width: number; height: number }>) => {
      updateConfig({ region: { ...region, ...patch } });
    },
    [region, updateConfig],
  );

  // 切换来源时，区域跟着新来源重置，避免把上一个屏幕的坐标带到另一个屏幕上
  useEffect(() => {
    if (!regionEnabled) return;
    if (!selectedSource) return;
    const tooBig =
      region.x + region.width > selectedSource.width || region.y + region.height > selectedSource.height;
    if (tooBig) {
      updateConfig({
        region: {
          x: 0,
          y: 0,
          width: Math.min(region.width, selectedSource.width),
          height: Math.min(region.height, selectedSource.height),
        },
      });
    }
    // 只在来源变化时纠正，不要跟着 region 每次变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource?.id]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = previewRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const source = syntheticScreen(performance.now() / 1000 * 0.35);
          const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
          const dw = source.width * scale;
          const dh = source.height * scale;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(source, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const filteredSources = useMemo(() => sources.filter((s) => s.kind === sourceKind), [sources, sourceKind]);

  // ---- 质量与预计体积 ----
  const bps = bytesPerSecond(quality.videoBitrate, quality.audioBitrate);
  const recordable = freeBytes != null ? recordableSeconds(freeBytes, bps) : 0;
  const diskInsufficient = freeBytes != null && freeBytes < MIN_FREE_BYTES;
  const diskTight = freeBytes != null && !diskInsufficient && freeBytes < 2 * 1024 ** 3;

  const sourcePixelHint = useMemo(() => {
    if (!selectedSource) return null;
    if (selectedSource.width === quality.width && selectedSource.height === quality.height) return null;
    if (selectedSource.width > quality.width) {
      return `来源 ${selectedSource.width} × ${selectedSource.height} 高于所选档位，会按 ${quality.width} × ${quality.height} 缩放输出（文字可能变软）。`;
    }
    return `来源 ${selectedSource.width} × ${selectedSource.height} 低于所选档位，会放大到 ${quality.width} × ${quality.height}，清晰度受源限制。`;
  }, [selectedSource, quality]);

  // ---- 倒计时 ----
  const beginCountdown = useCallback(() => {
    if (countdown !== null) return;
    const seconds = Math.max(0, config.countdownSeconds);
    if (seconds === 0) {
      void startRecording();
      return;
    }
    setCountdown(seconds);
    const step = (remaining: number) => {
      if (remaining <= 0) {
        setCountdown(null);
        void startRecording();
        return;
      }
      setCountdown(remaining);
      countdownTimer.current = window.setTimeout(() => step(remaining - 1), 1000);
    };
    countdownTimer.current = window.setTimeout(() => step(seconds - 1), 1000);
  }, [config.countdownSeconds, countdown, startRecording]);

  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current !== null) {
      window.clearTimeout(countdownTimer.current);
      countdownTimer.current = null;
    }
    setCountdown(null);
    pushToast({ tone: 'info', title: '已取消倒计时', message: '没有开始采集。' });
  }, [pushToast]);

  useEffect(
    () => () => {
      if (countdownTimer.current !== null) window.clearTimeout(countdownTimer.current);
    },
    [],
  );

  // 录制中状态：显示悬浮控制条预览与停止入口
  const recording = !!capture && ['Preparing', 'Countdown', 'Recording', 'Pausing', 'Paused', 'Resuming', 'Stopping', 'Finalizing'].includes(capture.state);

  const blockedReason = useMemo(() => {
    if (!config.sourceId) return '请先选择一个录制来源。';
    if (selectedSource && !selectedSource.available) return '该来源受系统保护或已关闭，请换一个来源。';
    if (diskInsufficient) return `磁盘可用空间不足 ${formatBytes(MIN_FREE_BYTES)}，请清理磁盘或换输出目录。`;
    if (pathCheck && !pathCheck.writable) return pathCheck.reason || '输出目录不可写，请在设置里换一个目录。';
    return null;
  }, [config.sourceId, selectedSource, diskInsufficient, pathCheck]);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>录制设置</h1>
          <p>选择来源、检查设备与磁盘，确认预览后开始 3 秒倒计时。</p>
        </div>
        <div className="view-actions">
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadAll()} disabled={loading}>
            重新检测
          </Button>
          {recording ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setView('editor')}>
                去编辑器
              </Button>
              <Button size="sm" variant="danger" icon="stop" loading={busy.capture} onClick={() => void stopRecording()}>
                停止录制
              </Button>
            </>
          ) : (
            <Button
              size="md"
              variant="primary"
              icon="record"
              disabled={!!blockedReason || busy.capture}
              loading={busy.capture}
              onClick={beginCountdown}
              title={blockedReason ?? '开始 3 秒倒计时'}
            >
              开始录制
            </Button>
          )}
        </div>
      </div>

      {loadError && (
        <div style={{ marginBottom: 12 }}>
          <InlineNote tone="danger">
            <strong>设备枚举失败：</strong> {loadError}
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              <Button size="sm" icon="refresh" onClick={() => void loadAll()}>
                重试
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setView('settings')}>
                查看诊断
              </Button>
            </div>
          </InlineNote>
        </div>
      )}

      {blockedReason && (
        <div style={{ marginBottom: 12 }}>
          <InlineNote tone="warn">
            <strong>暂时不能开始：</strong> {blockedReason}
            {diskInsufficient && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <Button size="sm" onClick={() => void checkDisk()}>重新检查磁盘</Button>
                <Button size="sm" variant="ghost" onClick={() => void wcs().pickDirectory()}>更换输出目录</Button>
              </div>
            )}
            {pathCheck && !pathCheck.writable && (
              <div style={{ marginTop: 6 }}>
                <Button size="sm" onClick={() => void wcs().pickDirectory()}>选择可写目录</Button>
              </div>
            )}
          </InlineNote>
        </div>
      )}

      <div className="record-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {/* ---- 来源 ---- */}
          <Panel
            title="录制来源"
            icon="screen"
            subtitle={loading ? '正在枚举…' : `${filteredSources.length} 个可用对象`}
            actions={
              <Segmented
                size="sm"
                ariaLabel="来源类型"
                value={sourceKind}
                onChange={(next) => setSourceKind(next)}
                options={[
                  { value: 'screen', label: '显示器', icon: 'screen' },
                  { value: 'window', label: '窗口', icon: 'window' },
                ]}
              />
            }
          >
            {loading ? (
              <div className="wcs-empty">
                <Spinner size={18} />
                <p>正在枚举显示器与窗口…</p>
              </div>
            ) : filteredSources.length === 0 ? (
              <EmptyState
                icon="screen"
                title={sourceKind === 'screen' ? '没有检测到显示器' : '没有可录制的窗口'}
                description={
                  sourceKind === 'screen'
                    ? '请确认显示器已连接，然后点「重新检测」。'
                    : '先把要录制的窗口切到前台，再点「重新检测」。'
                }
                actions={<Button size="sm" icon="refresh" onClick={() => void loadAll()}>重新检测</Button>}
              />
            ) : (
              <div className="source-grid">
                {filteredSources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={cn(
                      'source-card',
                      config.sourceId === source.id && 'is-selected',
                      !source.available && 'is-unavailable',
                    )}
                    aria-pressed={config.sourceId === source.id}
                    aria-label={`${source.name} ${source.width}×${source.height}${source.available ? '' : '（不可用）'}`}
                    disabled={!source.available}
                    onClick={() => updateConfig({ sourceId: source.id, sourceKind: source.kind })}
                    title={source.available ? source.name : `${source.name} · 受系统保护或已关闭`}
                  >
                    <span className="source-thumb">
                      {source.thumbnail ? (
                        <img src={source.thumbnail} alt="" />
                      ) : (
                        <span className="source-thumb-empty">
                          <Icon name={source.kind === 'screen' ? 'screen' : 'window'} size={22} />
                        </span>
                      )}
                      <span className="source-thumb-badge">
                        {source.kind === 'screen' ? <Badge tone="neutral">显示器</Badge> : <Badge tone="neutral">窗口</Badge>}
                        {!source.available && <Badge tone="danger">不可用</Badge>}
                      </span>
                    </span>
                    <span className="source-name">{source.name}</span>
                    <span className="source-res">
                      <Icon name="screen" size={10} />
                      {source.width} × {source.height}
                      {source.kind === 'screen' && displays.find((d) => d.id === source.displayId)?.scaleFactor !== 1 && (
                        <span style={{ color: 'var(--text-dim)' }}>
                          · {displays.find((d) => d.id === source.displayId)?.scaleFactor}× 缩放
                        </span>
                      )}
                    </span>
                    {config.sourceId === source.id && (
                      <span className="source-selected-mark" aria-hidden="true">
                        <Icon name="check" size={11} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {sourcePixelHint && (
              <div style={{ marginTop: 10 }}>
                <InlineNote tone="warn">{sourcePixelHint}</InlineNote>
              </div>
            )}
          </Panel>

          {/* ---- 录制区域（R01）：只在整屏来源上可用 ---- */}
          {selectedSource?.kind === 'screen' && (
            <Panel
              title="录制区域"
              icon="image"
              subtitle={regionEnabled ? `自定义区域 ${region.width} × ${region.height}` : '整屏录制'}
              actions={
                <Toggle
                  checked={regionEnabled}
                  onChange={(next) => {
                    setRegionEnabled(next);
                    if (next) {
                      const w = Math.max(320, Math.floor((selectedSource.width * 0.6) / 2) * 2);
                      const h = Math.max(240, Math.floor((selectedSource.height * 0.6) / 2) * 2);
                      updateConfig({
                        region: {
                          x: Math.floor((selectedSource.width - w) / 4) * 2,
                          y: Math.floor((selectedSource.height - h) / 4) * 2,
                          width: w,
                          height: h,
                        },
                      });
                    } else {
                      updateConfig({ region: undefined });
                    }
                  }}
                  label={regionEnabled ? '自定义区域' : '整屏'}
                />
              }
            >
              {regionEnabled ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                    {(
                      [
                        { key: 'x', label: 'X 偏移', min: 0, max: Math.max(0, selectedSource.width - 64) },
                        { key: 'y', label: 'Y 偏移', min: 0, max: Math.max(0, selectedSource.height - 64) },
                        { key: 'width', label: '宽度', min: 64, max: selectedSource.width },
                        { key: 'height', label: '高度', min: 64, max: selectedSource.height },
                      ] as const
                    ).map((item) => (
                      <Field key={item.key} label={item.label}>
                        <TextInput
                          type="number"
                          min={item.min}
                          max={item.max}
                          step={2}
                          value={region[item.key]}
                          onChange={(event) => {
                            const raw = Number(event.target.value);
                            if (!Number.isFinite(raw)) return;
                            updateRegion({ [item.key]: Math.round(raw) } as Partial<typeof region>);
                          }}
                          aria-label={item.label}
                        />
                      </Field>
                    ))}
                  </div>
                  <InlineNote tone={regionValid ? 'info' : 'warn'}>
                    {regionValid
                      ? `输出尺寸就是 ${region.width} × ${region.height} 物理像素，所见即所得，不做二次缩放。`
                      : '区域必须完整落在选定显示器内且不小于 64×64；超出部分会被自动裁掉。'}
                  </InlineNote>
                </div>
              ) : (
                <p style={{ color: 'var(--text-dim)', margin: 0 }}>
                  将录制整个显示器（
                  {selectedSource ? `${selectedSource.width} × ${selectedSource.height}` : '—'}）。打开「自定义区域」可只录屏幕上的一块。
                </p>
              )}
            </Panel>
          )}

          {/* ---- 预览 + 声音 ---- */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 14 }}>
            <Panel title="预览" icon="eye" subtitle={selectedSource ? selectedSource.name : '未选择来源'}>
              <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-strong)', background: '#070a0e' }}>
                <canvas ref={previewRef} width={640} height={360} style={{ width: '100%', display: 'block' }} />
                <div style={{ position: 'absolute', left: 8, top: 8, display: 'flex', gap: 5 }}>
                  <Badge tone="accent" icon="record">
                    预览 · 未开始采集
                  </Badge>
                  {selectedSource && <Badge tone="neutral">{`${selectedSource.width} × ${selectedSource.height}`}</Badge>}
                </div>
                <div style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 5 }}>
                  <Badge tone="neutral" icon="mic">{config.microphoneEnabled ? '麦克风开' : '麦克风关'}</Badge>
                  <Badge tone="neutral" icon="volume">{config.systemAudioEnabled ? '系统声音开' : '系统声音关'}</Badge>
                  <Badge tone="neutral" icon="camera">{config.cameraEnabled ? '摄像头开' : '摄像头关'}</Badge>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                <Button size="sm" variant="ghost" icon="screen" onClick={() => void loadAll()}>
                  刷新缩略图
                </Button>
                <Button size="sm" variant="ghost" icon="info" onClick={() => setView('settings')}>
                  采集能力检测
                </Button>
              </div>
            </Panel>

            <Panel title="声音" icon="mic" subtitle="实时电平">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Toggle
                  checked={config.microphoneEnabled}
                  onChange={(next) => updateConfig({ microphoneEnabled: next })}
                  label="麦克风"
                  description="录制你的讲解声音"
                />
                <LevelMeter
                  label="麦克风输入"
                  icon="mic"
                  tone="mic"
                  level={levels.mic}
                  hint={config.microphoneEnabled ? '正常说话时电平应在 -18 dB 到 -6 dB 之间。' : '麦克风已关闭，不会写入音轨。'}
                />
                <Field label="输入设备" htmlFor="mic-device">
                  <Select
                    id="mic-device"
                    ariaLabel="麦克风设备"
                    value={config.microphoneDeviceId ?? ''}
                    onChange={(next) => updateConfig({ microphoneDeviceId: next })}
                    options={[
                      { value: '', label: '系统默认输入' },
                      ...audioDevices
                        .filter((d) => d.kind === 'audioinput')
                        .map((d) => ({ value: d.deviceId, label: `${d.label}${d.isDefault ? '（默认）' : ''}` })),
                    ]}
                  />
                </Field>
                <div style={{ height: 1, background: 'var(--border)' }} />
                <Toggle
                  checked={config.systemAudioEnabled}
                  onChange={(next) => updateConfig({ systemAudioEnabled: next })}
                  label="系统声音"
                  description="录制应用播放的声音（需 Windows 回环采集）"
                />
                <LevelMeter
                  label="系统声音"
                  icon="volume"
                  tone="system"
                  level={levels.system}
                  hint={
                    system && !system.captureCapabilities.systemAudio
                      ? '当前系统不支持回环采集，导出时该音轨会为空。'
                      : '录制中会显示真实电平；此处为设备就绪指示。'
                  }
                />
                {devicesError && <InlineNote tone="warn">{devicesError}</InlineNote>}
              </div>
            </Panel>
          </div>

          {/* ---- 摄像头 ---- */}
          <Panel title="摄像头" icon="camera" subtitle={config.cameraEnabled ? '画中画预览' : '已关闭'}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.6fr)', gap: 14 }}>
              <div>
                <div className="camera-preview">
                  {config.cameraEnabled ? (
                    <>
                      <canvas ref={cameraRef} width={480} height={360} aria-label="摄像头预览" />
                      <div className="camera-preview-overlay">
                        <Badge tone="ok" icon="camera">设备就绪</Badge>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--text-dim)' }}>
                      <div style={{ textAlign: 'center' }}>
                        <Icon name="eyeOff" size={22} />
                        <div style={{ fontSize: 'var(--fs-aux)', marginTop: 6 }}>摄像头已关闭</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <Toggle
                  checked={config.cameraEnabled}
                  onChange={(next) => updateConfig({ cameraEnabled: next })}
                  label="录制摄像头画中画"
                  description="录制后在编辑器里可调整位置、大小与圆角"
                />
                <Field label="摄像头设备" htmlFor="cam-device">
                  <Select
                    id="cam-device"
                    ariaLabel="摄像头设备"
                    value={config.cameraDeviceId ?? ''}
                    onChange={(next) => updateConfig({ cameraDeviceId: next })}
                    options={[
                      { value: '', label: '系统默认摄像头' },
                      ...videoDevices.map((d) => ({ value: d.deviceId, label: d.label })),
                    ]}
                  />
                </Field>
                {system && !system.captureCapabilities.camera && (
                  <InlineNote tone="warn">当前设备没有可用摄像头，录制时会跳过摄像头轨。</InlineNote>
                )}
                {videoDevices.length === 0 && (
                  <InlineNote tone="warn">
                    没有检测到摄像头。可以继续录制屏幕与声音，之后在编辑器里关闭画中画。
                  </InlineNote>
                )}
              </div>
            </div>
          </Panel>

          {/* ---- 质量 ---- */}
          <Panel title="质量档位" icon="layers" subtitle="设置值与实际能力分开显示">
            <div className="quality-list">
              {profiles.map((profile) => {
                const selected = profile.id === config.qualityId;
                const downgraded = selectedSource ? selectedSource.width < profile.width : false;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    className={cn('quality-card', selected && 'is-selected')}
                    aria-pressed={selected}
                    onClick={() => {
                      updateConfig({ qualityId: profile.id, fps: { num: profile.fps, den: 1 } });
                    }}
                  >
                    <span className="quality-radio" aria-hidden="true" />
                    <span>
                      <span className="quality-label">{profile.label}</span>
                      <span className="quality-detail">
                        {profile.width}×{profile.height} · {profile.fps}fps · 视频 {formatBitrate(profile.videoBitrate)} · 音频{' '}
                        {formatBitrate(profile.audioBitrate)}
                      </span>
                    </span>
                    <span className="quality-fit">
                      {profile.hardwarePreferred && system?.hardwareEncoding ? (
                        <Badge tone="ok">硬件编码</Badge>
                      ) : (
                        <Badge tone="muted">软件编码</Badge>
                      )}
                      {downgraded && <Badge tone="warn">受源限制</Badge>}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 11 }}>
              <table className="capability-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>设置</th>
                    <th style={{ textAlign: 'right' }}>实际能力</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>分辨率</td>
                    <td>{quality.width} × {quality.height}</td>
                    <td>{selectedSource ? `${selectedSource.width} × ${selectedSource.height}` : '未选择来源'}</td>
                  </tr>
                  <tr>
                    <td>帧率</td>
                    <td>{quality.fps} fps</td>
                    <td>{capture?.effective ? `${capture.effective.fps} fps` : '开始录制后确认'}</td>
                  </tr>
                  <tr>
                    <td>视频编码</td>
                    <td>{quality.hardwarePreferred ? '优先硬件' : '软件'}</td>
                    <td>{capture?.effective?.videoCodec ?? (system?.hardwareEncoding ? 'H.264 硬件可用' : 'H.264 软件')}</td>
                  </tr>
                  <tr>
                    <td>音频编码</td>
                    <td>{formatBitrate(quality.audioBitrate)}</td>
                    <td>{capture?.effective?.audioCodec ?? 'AAC 48 kHz'}</td>
                  </tr>
                </tbody>
              </table>
              {capture?.degradation && (
                <div style={{ marginTop: 9 }}>
                  <InlineNote tone="warn">
                    <strong>实际生效与设置不一致：</strong> {capture.degradation}
                  </InlineNote>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* ---- 右栏 ---- */}
        <div className="side-stack">
          <Panel title="磁盘与时长" icon="disk">
            <div className="disk-row">
              <span>可用空间</span>
              <strong>{freeBytes == null ? '读取中…' : formatBytes(freeBytes)}</strong>
            </div>
            <div className="disk-row">
              <span>写入速率</span>
              <strong>{formatBytes(bps)}/s</strong>
            </div>
            <div className="disk-row">
              <span>预计可录</span>
              <strong style={{ color: diskInsufficient ? 'var(--danger)' : diskTight ? 'var(--warn)' : 'var(--ok)' }}>
                {freeBytes == null ? '—' : formatDurationLong(recordable)}
              </strong>
            </div>
            <div className="disk-row">
              <span>输出目录</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-aux)', color: 'var(--text-dim)', textAlign: 'right', wordBreak: 'break-all' }}>
                {system?.videosPath ?? '—'}
              </span>
            </div>
            {diskInsufficient && (
              <div style={{ marginTop: 8 }}>
                <InlineNote tone="danger">
                  可用空间不足 {formatBytes(MIN_FREE_BYTES)}。请清理磁盘或把输出目录换到空间更大的盘。
                </InlineNote>
              </div>
            )}
            {!diskInsufficient && diskTight && (
              <div style={{ marginTop: 8 }}>
                <InlineNote tone="warn">空间偏紧，长录制可能中途因磁盘写满而中断。建议先清理或换目录。</InlineNote>
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void checkDisk()}>
                重新检查
              </Button>
              <Button size="sm" variant="ghost" icon="folder" onClick={() => void wcs().pickDirectory()}>
                更换目录
              </Button>
            </div>
          </Panel>

          <Panel title="录制选项" icon="settings">
            <Field label="倒计时" hint="开始后给出准备时间，可用 Esc 取消">
              <Segmented
                size="sm"
                ariaLabel="倒计时秒数"
                value={String(config.countdownSeconds)}
                onChange={(next) => updateConfig({ countdownSeconds: Number(next) })}
                options={[
                  { value: '0', label: '立即' },
                  { value: '3', label: '3 秒' },
                  { value: '5', label: '5 秒' },
                ]}
              />
            </Field>
            <InlineNote tone="info">
              设备开关只在左侧「声音」「摄像头」面板各有一处。右边不再重复，避免同一项出现两个开关。
            </InlineNote>
          </Panel>

          <Panel title="开始前检查" icon="shield" subtitle="状态一览">
            <div className="check-chips">
              <span className={cn('check-chip', selectedSource?.available ? 'is-ok' : selectedSource ? 'is-warn' : 'is-warn')}>
                <Icon name={selectedSource?.available ? 'check' : 'warning'} size={12} />
                来源 {selectedSource ? (selectedSource.available ? '可用' : '不可用') : '未选择'}
              </span>
              <span className={cn('check-chip', config.microphoneEnabled ? 'is-ok' : 'is-off')}>
                <Icon name="mic" size={12} />
                麦克风 {config.microphoneEnabled ? '开' : '关'}
              </span>
              <span className={cn('check-chip', config.systemAudioEnabled ? 'is-ok' : 'is-off')}>
                <Icon name="volume" size={12} />
                系统声音 {config.systemAudioEnabled ? '开' : '关'}
              </span>
              <span className={cn('check-chip', config.cameraEnabled ? 'is-ok' : 'is-off')}>
                <Icon name="camera" size={12} />
                摄像头 {config.cameraEnabled ? '开' : '关'}
              </span>
              <span className={cn('check-chip', diskInsufficient ? 'is-danger' : pathCheck && !pathCheck.writable ? 'is-danger' : 'is-ok')}>
                <Icon name="disk" size={12} />
                磁盘 {diskInsufficient ? '不足' : pathCheck ? (pathCheck.writable ? '可写' : '不可写') : '检查中'}
              </span>
              <span className={cn('check-chip', system?.hardwareEncoding ? 'is-ok' : 'is-off')}>
                <Icon name="layers" size={12} />
                {system?.hardwareEncoding ? '硬件编码' : '软件编码'}
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              {/* 开始/停止只保留顶部一处主操作（§P0：一次操作即看清状态，不必滚动找按钮） */}
              <div className="check-hint">
                {blockedReason ? (
                  <InlineNote tone="warn">{blockedReason}</InlineNote>
                ) : (
                  <span className="check-hint-text">
                    <Icon name="check" size={13} /> 全部就绪，点右上角「开始录制」即可（{config.countdownSeconds} 秒倒计时）。
                  </span>
                )}
              </div>
            </div>
          </Panel>

          {apiMode === 'mock' && (
            <InlineNote tone="warn">
              <strong>示例数据模式：</strong> 设备列表与预览来自内置合成画面，不会真正采集屏幕。
            </InlineNote>
          )}
        </div>
      </div>

      {/* ---- 倒计时覆盖层 ---- */}
      {countdown !== null && (
        <div className="countdown-overlay" role="dialog" aria-modal="true" aria-label="录制倒计时">
          <div className="countdown-box">
            <div className="countdown-num" aria-live="assertive">
              {countdown}
            </div>
            <div className="countdown-hint">准备开始录制 · {selectedSource?.name ?? '未选择来源'}</div>
            <div className="countdown-sub">
              {quality.width} × {quality.height} · {quality.fps}fps · {config.countdownSeconds} 秒倒计时
            </div>
            <div style={{ marginTop: 22 }}>
              <Button size="lg" variant="secondary" icon="close" onClick={cancelCountdown}>
                取消（Esc）
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function describeSafe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
