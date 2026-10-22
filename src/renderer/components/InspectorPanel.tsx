/**
 * 属性面板（§6.1 / §10.2 / §12.2 / R06）
 *
 * 分五个页签：
 * - 片段：所选片段的裁剪/移动/分割/删除（时间线），以及轨道音量。
 * - 运镜：缩放、焦点、过渡时长、锁定。
 * - 遮挡：矩形、样式、时间区间、确认状态（未确认明确显示「未遮挡」）。
 * - 光标：光标大小、点击反馈、显示/隐藏、烧录模式（烧录时禁用滑杆避免双光标）。
 * - 画布：画幅切换（16:9 / 1:1 / 9:16）、背景、圆角、阴影、内边距、摄像头布局。
 *
 * 注意文案：这里删除的是「时间线片段」，与「删除源素材」是两件事。
 */

import { useMemo, useState } from 'react';
import type {
  CanvasStyle,
  CursorParameters,
  Effect,
  PrivacyParameters,
  PrivacyStyle,
  Project,
  TrackKind,
  ZoomParameters,
} from '@domain/project';
import type { SetEffectCommand, SetCanvasStyleCommand, SetTrackAudioCommand, TrimClipCommand, MoveClipCommand } from '@domain/commands';
import { findTrack, timelineDuration } from '@domain/project';
import { TICKS_PER_SECOND, formatDuration, parseDuration, secondsToTicks, ticksToSeconds } from '@domain/timebase';
import { useApp } from '../lib/store';
import { Badge, Button, Field, Icon, IconButton, InlineNote, Segmented, Slider, TextInput, Toggle } from './ui';
import { cn } from '../lib/format';

type Tab = 'clip' | 'zoom' | 'privacy' | 'cursor' | 'canvas';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'clip', label: '片段', icon: 'layers' },
  { id: 'zoom', label: '运镜', icon: 'zoomIn' },
  { id: 'privacy', label: '遮挡', icon: 'shield' },
  { id: 'cursor', label: '光标', icon: 'cursor' },
  { id: 'canvas', label: '画布', icon: 'image' },
];

const BACKGROUND_SWATCHES = [
  { value: '#101418', label: '近黑' },
  { value: '#0b1220', label: '深蓝' },
  { value: '#1a1d21', label: '石墨' },
  { value: 'linear-gradient(150deg, #1b2432, #0d1219)', label: '深色渐变' },
  { value: 'linear-gradient(150deg, #24303f, #151c25)', label: '蓝灰渐变' },
  { value: '#f2f4f7', label: '浅色' },
];

function styleLabel(style: PrivacyStyle): string {
  return style === 'solid' ? '实色' : style === 'blur' ? '模糊' : '马赛克';
}

export function InspectorPanel() {
  const {
    project,
    execute,
    selectedClipId,
    selectClip,
    selectedEffectId,
    selectEffect,
    tick,
    pushToast,
  } = useApp();
  const [tab, setTab] = useState<Tab>('clip');

  const selectedClip = useMemo(() => {
    if (!project || !selectedClipId) return null;
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) return { clip, track };
    }
    return null;
  }, [project, selectedClipId]);

  const selectedEffect = useMemo(() => {
    if (!project || !selectedEffectId) return null;
    return project.effects.find((e) => e.id === selectedEffectId) ?? null;
  }, [project, selectedEffectId]);

  if (!project) {
    return (
      <aside className="editor-inspector" aria-label="属性面板">
        <div className="inspector-body">
          <div className="wcs-empty">
            <p>还没有打开的工程。</p>
          </div>
        </div>
      </aside>
    );
  }

  const duration = timelineDuration(project);

  return (
    <aside className="editor-inspector" aria-label="属性面板">
      <div className="inspector-tabs" role="tablist" aria-label="属性分类">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={cn('inspector-tab', tab === item.id && 'is-active')}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={12} />
            {item.label}
          </button>
        ))}
      </div>

      <div className="inspector-body">
        {tab === 'clip' && (
          <ClipTab
            project={project}
            duration={duration}
            tick={tick}
            selectedClip={selectedClip}
            onSelectClip={selectClip}
            execute={execute}
            pushToast={pushToast}
          />
        )}
        {tab === 'zoom' && (
          <ZoomTab
            project={project}
            tick={tick}
            selectedEffectId={selectedEffectId}
            onSelectEffect={selectEffect}
            execute={execute}
          />
        )}
        {tab === 'privacy' && (
          <PrivacyTab
            project={project}
            tick={tick}
            selectedEffectId={selectedEffectId}
            onSelectEffect={selectEffect}
            execute={execute}
            pushToast={pushToast}
          />
        )}
        {tab === 'cursor' && (
          <CursorTab
            project={project}
            selectedEffectId={selectedEffectId}
            onSelectEffect={selectEffect}
            execute={execute}
          />
        )}
        {tab === 'canvas' && (
          <CanvasTab project={project} selectedEffect={selectedEffect} execute={execute} />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 片段
// ---------------------------------------------------------------------------

function ClipTab({
  project,
  duration,
  tick,
  selectedClip,
  onSelectClip,
  execute,
  pushToast,
}: {
  project: Project;
  duration: number;
  tick: number;
  selectedClip: { clip: import('@domain/project').Clip; track: import('@domain/project').Track } | null;
  onSelectClip: (id: string | null) => void;
  execute: ReturnType<typeof useApp>['execute'];
  pushToast: ReturnType<typeof useApp>['pushToast'];
}) {
  const [startText, setStartText] = useState('');
  const [editingStart, setEditingStart] = useState(false);

  const mic = findTrack(project, 'mic');
  const system = findTrack(project, 'system');

  const applyTrim = (patch: Partial<TrimClipCommand>) => {
    if (!selectedClip) return;
    execute<TrimClipCommand>(
      { kind: 'TrimClip', clipId: selectedClip.clip.id, ...patch },
      '裁剪片段',
    );
  };

  return (
    <>
      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="layers" size={12} />
            所选片段
          </h3>
          {selectedClip && <Badge tone="accent">{selectedClip.track.kind === 'primaryVideo' ? '主视频' : selectedClip.track.kind === 'camera' ? '摄像头' : selectedClip.track.kind === 'mic' ? '麦克风' : '系统声音'}</Badge>}
        </div>

        {!selectedClip ? (
          <div className="wcs-empty" style={{ padding: '16px 8px' }}>
            <Icon name="info" size={18} />
            <p>在时间线上点选一个片段，即可裁剪、移动或删除它。</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-aux)' }}>提示：删除时间线片段不会删除源素材文件。</p>
          </div>
        ) : (
          <>
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-key">片段 ID</span>
                <span className="kv-value">{selectedClip.clip.id}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">时间线起点</span>
                <span className="kv-value">{formatDuration(selectedClip.clip.timelineInTicks)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">源入点</span>
                <span className="kv-value">{formatDuration(selectedClip.clip.sourceInTicks)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">时长</span>
                <span className="kv-value">{formatDuration(selectedClip.clip.sourceDurationTicks)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">关联组</span>
                <span className="kv-value">{selectedClip.clip.linkGroupId}</span>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <Field label="时间线起点" htmlFor="clip-start" hint="输入 mm:ss.cc 后回车或失焦生效">
                <TextInput
                  id="clip-start"
                  value={editingStart ? startText : formatDuration(selectedClip.clip.timelineInTicks)}
                  onChange={(event) => {
                    setEditingStart(true);
                    setStartText(event.target.value);
                  }}
                  onBlur={() => {
                    if (!editingStart) return;
                    const parsed = parseDuration(startText);
                    setEditingStart(false);
                    if (parsed == null) {
                      pushToast({ tone: 'warn', title: '时间格式无法识别', message: '请使用 mm:ss.cc 或纯秒数。' });
                      return;
                    }
                    execute<MoveClipCommand>(
                      { kind: 'MoveClip', clipId: selectedClip.clip.id, timelineInTicks: Math.min(parsed, Math.max(0, duration)) },
                      '移动片段',
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                  }}
                />
              </Field>

              <Slider
                label="时长"
                min={0.2}
                max={Math.max(1, ticksToSeconds(duration))}
                step={0.1}
                value={ticksToSeconds(selectedClip.clip.sourceDurationTicks)}
                format={(v) => `${v.toFixed(1)} 秒`}
                onCommit={(next) => applyTrim({ sourceDurationTicks: secondsToTicks(next) })}
              />
              <Slider
                label="源入点"
                min={0}
                max={Math.max(1, ticksToSeconds(duration))}
                step={0.1}
                value={ticksToSeconds(selectedClip.clip.sourceInTicks)}
                format={(v) => `${v.toFixed(1)} 秒`}
                onCommit={(next) => applyTrim({ sourceInTicks: secondsToTicks(next) })}
              />

              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <Button
                  size="sm"
                  icon="split"
                  onClick={() => execute({ kind: 'SplitClip', timelineTick: tick }, '分割片段')}
                >
                  在播放头分割
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onSelectClip(null)}>
                  取消选择
                </Button>
              </div>
              <div style={{ marginTop: 8 }}>
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  block
                  onClick={() => {
                    const clip = selectedClip.clip;
                    execute(
                      {
                        kind: 'DeleteRange',
                        range: { start: clip.timelineInTicks, end: clip.timelineInTicks + clip.sourceDurationTicks },
                        ripple: true,
                      },
                      '删除时间线片段（波纹）',
                    );
                    onSelectClip(null);
                    pushToast({
                      tone: 'info',
                      title: '已删除时间线片段',
                      message: '源素材文件没有被删除，仍保留在工程目录中。',
                    });
                  }}
                >
                  删除此时间线片段
                </Button>
                <p className="wcs-field-hint" style={{ marginTop: 5 }}>
                  只删除时间线上的这一段（波纹删除，后续片段前移）。源素材保持完整，可从素材重新引用。
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="volume" size={12} />
            轨道音量
          </h3>
        </div>
        {[mic, system].filter(Boolean).map((track) => (
          <div key={track!.kind} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 'var(--fs-aux)', color: 'var(--text-soft)' }}>
                {track!.kind === 'mic' ? '麦克风' : '系统声音'}
              </span>
              <button
                type="button"
                className={cn('wcs-btn is-sm is-ghost', track!.muted && 'is-danger')}
                onClick={() =>
                  execute<SetTrackAudioCommand>(
                    { kind: 'SetTrackAudio', track: track!.kind, muted: !track!.muted },
                    track!.muted ? '取消静音' : '静音轨道',
                  )
                }
              >
                <Icon name={track!.muted ? 'eyeOff' : 'volume'} size={12} />
                {track!.muted ? '已静音' : '静音'}
              </button>
            </div>
            <Slider
              label="增益"
              min={0}
              max={2}
              step={0.02}
              value={track!.gain}
              disabled={track!.muted}
              format={(v) => `${(20 * Math.log10(Math.max(0.0001, v))).toFixed(1)} dB`}
              onCommit={(next) => execute<SetTrackAudioCommand>({ kind: 'SetTrackAudio', track: track!.kind, gain: next }, '调整轨道音量')}
            />
          </div>
        ))}
      </div>

      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="clock" size={12} />
            工程信息
          </h3>
        </div>
        <div className="kv-list">
          <div className="kv-row">
            <span className="kv-key">总时长</span>
            <span className="kv-value">{formatDuration(duration)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">帧率</span>
            <span className="kv-value">{project.settings.fps.num}/{project.settings.fps.den} fps</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">版本</span>
            <span className="kv-value">{project.revision}</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 运镜
// ---------------------------------------------------------------------------

function ZoomTab({
  project,
  tick,
  selectedEffectId,
  onSelectEffect,
  execute,
}: {
  project: Project;
  tick: number;
  selectedEffectId: string | null;
  onSelectEffect: (id: string | null) => void;
  execute: ReturnType<typeof useApp>['execute'];
}) {
  const zooms = project.effects.filter((e) => e.kind === 'zoom');
  const current = zooms.find((e) => e.id === selectedEffectId) ?? zooms.find((e) => tick >= e.range.start && tick < e.range.end) ?? null;

  const update = (patch: Partial<ZoomParameters>, lock?: boolean) => {
    if (!current) return;
    const params = { ...(current.parameters as ZoomParameters), ...patch };
    const next: Effect = { ...current, parameters: params, locked: lock ?? current.locked, origin: 'manual' };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect: next, lock: next.locked }, '调整运镜');
  };

  const addZoom = () => {
    const id = `zoom-manual-${Date.now().toString(36)}`;
    const effect: Effect = {
      id,
      kind: 'zoom',
      range: { start: tick, end: Math.min(timelineDuration(project), tick + secondsToTicks(3)) },
      parameters: {
        scale: 1.6,
        focusX: 0.5,
        focusY: 0.5,
        easeInTicks: secondsToTicks(0.45),
        easeOutTicks: secondsToTicks(0.5),
        focusSource: 'manual',
      },
      origin: 'manual',
      locked: true,
    };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect, lock: true }, '新建运镜');
    onSelectEffect(id);
  };

  return (
    <>
      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="zoomIn" size={12} />
            运镜片段
          </h3>
          <IconButton icon="plus" label="在播放头新建运镜" size="sm" onClick={addZoom} />
        </div>
        {zooms.length === 0 ? (
          <div className="wcs-empty" style={{ padding: '14px 8px' }}>
            <p>还没有运镜。可以新建一个，或让自动运镜在录制后生成。</p>
            <Button size="sm" icon="plus" onClick={addZoom}>
              新建运镜
            </Button>
          </div>
        ) : (
          <div className="effect-list">
            {zooms.map((effect) => {
              const params = effect.parameters as ZoomParameters;
              return (
                <div
                  key={effect.id}
                  className={cn('effect-item', current?.id === effect.id && 'is-selected')}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEffect(effect.id)}
                  onKeyDown={(event) => event.key === 'Enter' && onSelectEffect(effect.id)}
                >
                  <span className="effect-item-main">
                    <span className="effect-item-title">
                      <Icon name="zoomIn" size={11} />
                      {params.scale.toFixed(2)}× 运镜
                      {effect.locked && <Icon name="lock" size={9} />}
                      {effect.origin === 'automatic' ? <Badge tone="muted">自动</Badge> : <Badge tone="accent">手动</Badge>}
                    </span>
                    <span className="effect-item-sub">
                      {formatDuration(effect.range.start)} → {formatDuration(effect.range.end)} ·{' '}
                      {params.focusSource === 'control' ? '控件焦点' : params.focusSource === 'pointer' ? '指针焦点' : '手动焦点'}
                    </span>
                  </span>
                  <span className="effect-item-actions">
                    <IconButton
                      icon="trash"
                      label="删除运镜"
                      size="sm"
                      variant="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        execute({ kind: 'DeleteEffect', effectId: effect.id }, '删除运镜');
                        if (current?.id === effect.id) onSelectEffect(null);
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {current ? (
        <>
          <div className="inspector-section">
            <div className="inspector-section-head">
              <h3>缩放与焦点</h3>
              <button
                type="button"
                className={cn('wcs-btn is-sm is-ghost', current.locked && 'is-primary')}
                onClick={() => update({}, !current.locked)}
                title="锁定后自动运镜重生成不会覆盖该片段"
              >
                <Icon name={current.locked ? 'lock' : 'unlock'} size={11} />
                {current.locked ? '已锁定' : '未锁定'}
              </button>
            </div>
            <Slider
              label="缩放倍数"
              min={1}
              max={4}
              step={0.05}
              value={(current.parameters as ZoomParameters).scale}
              format={(v) => `${v.toFixed(2)}×`}
              onCommit={(next) => update({ scale: next })}
              hint="放大过多会让文字变软；1080p 源建议不超过 2.4×。"
            />
            <Slider
              label="焦点 X"
              min={0}
              max={1}
              step={0.01}
              value={(current.parameters as ZoomParameters).focusX}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              onCommit={(next) => update({ focusX: next })}
            />
            <Slider
              label="焦点 Y"
              min={0}
              max={1}
              step={0.01}
              value={(current.parameters as ZoomParameters).focusY}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              onCommit={(next) => update({ focusY: next })}
            />
          </div>

          <div className="inspector-section">
            <div className="inspector-section-head">
              <h3>过渡</h3>
            </div>
            <Slider
              label="进入过渡"
              min={0}
              max={2}
              step={0.05}
              value={ticksToSeconds((current.parameters as ZoomParameters).easeInTicks)}
              format={(v) => `${v.toFixed(2)} 秒`}
              onCommit={(next) => update({ easeInTicks: secondsToTicks(next) })}
            />
            <Slider
              label="退出过渡"
              min={0}
              max={2}
              step={0.05}
              value={ticksToSeconds((current.parameters as ZoomParameters).easeOutTicks)}
              format={(v) => `${v.toFixed(2)} 秒`}
              onCommit={(next) => update({ easeOutTicks: secondsToTicks(next) })}
            />
            <Field label="焦点依据">
              <Segmented
                size="sm"
                ariaLabel="焦点依据"
                value={(current.parameters as ZoomParameters).focusSource ?? 'manual'}
                onChange={(next) => update({ focusSource: next as ZoomParameters['focusSource'] })}
                options={[
                  { value: 'manual', label: '手动' },
                  { value: 'pointer', label: '指针' },
                  { value: 'control', label: '控件' },
                ]}
              />
            </Field>
          </div>
        </>
      ) : (
        <InlineNote tone="info">在时间线上选择一个运镜片段，或把播放头移到某个运镜区间内。</InlineNote>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 遮挡
// ---------------------------------------------------------------------------

function PrivacyTab({
  project,
  tick,
  selectedEffectId,
  onSelectEffect,
  execute,
  pushToast,
}: {
  project: Project;
  tick: number;
  selectedEffectId: string | null;
  onSelectEffect: (id: string | null) => void;
  execute: ReturnType<typeof useApp>['execute'];
  pushToast: ReturnType<typeof useApp>['pushToast'];
}) {
  const privacy = project.effects.filter((e) => e.kind === 'privacy');
  const current = privacy.find((e) => e.id === selectedEffectId) ?? null;
  const unconfirmed = privacy.filter((e) => !(e.parameters as PrivacyParameters).confirmed);

  const update = (patch: Partial<PrivacyParameters>) => {
    if (!current) return;
    const params = { ...(current.parameters as PrivacyParameters), ...patch };
    const next: Effect = { ...current, parameters: params };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect: next, lock: true }, patch.confirmed !== undefined ? '确认遮挡' : '调整遮挡');
  };

  const addPrivacy = () => {
    const id = `privacy-${Date.now().toString(36)}`;
    const effect: Effect = {
      id,
      kind: 'privacy',
      range: { start: Math.max(0, tick - secondsToTicks(1)), end: Math.min(timelineDuration(project), tick + secondsToTicks(4)) },
      anchor: 'screen',
      parameters: {
        x: 0.32,
        y: 0.32,
        width: 0.22,
        height: 0.08,
        anchor: 'screen',
        style: 'solid',
        confirmed: false,
      },
      origin: 'manual',
      locked: false,
    };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect, lock: false }, '新建遮挡');
    onSelectEffect(id);
    pushToast({ tone: 'warn', title: '遮挡区域尚未确认', message: '在预览上调整位置，确认后才会真正遮挡。' });
  };

  return (
    <>
      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="shield" size={12} />
            遮挡区域
          </h3>
          <IconButton icon="plus" label="新建遮挡区域" size="sm" onClick={addPrivacy} />
        </div>

        {unconfirmed.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <InlineNote tone="warn">
              <strong>{unconfirmed.length} 处未确认遮挡。</strong> 未确认不等于已遮挡，导出前必须确认。
            </InlineNote>
          </div>
        )}

        {privacy.length === 0 ? (
          <div className="wcs-empty" style={{ padding: '14px 8px' }}>
            <p>还没有遮挡区域。可以新建一个，或在预览上直接框选。</p>
            <Button size="sm" icon="plus" onClick={addPrivacy}>
              新建遮挡
            </Button>
          </div>
        ) : (
          <div className="effect-list">
            {privacy.map((effect, index) => {
              const params = effect.parameters as PrivacyParameters;
              return (
                <div
                  key={effect.id}
                  className={cn('effect-item', current?.id === effect.id && 'is-selected')}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEffect(effect.id)}
                  onKeyDown={(event) => event.key === 'Enter' && onSelectEffect(effect.id)}
                >
                  <span className="effect-item-main">
                    <span className="effect-item-title">
                      <Icon name={params.confirmed ? 'shield' : 'warning'} size={11} />
                      遮挡 {index + 1}
                      {params.confirmed ? <Badge tone="ok">已遮挡</Badge> : <Badge tone="warn">未确认（未遮挡）</Badge>}
                    </span>
                    <span className="effect-item-sub">
                      {styleLabel(params.style)} · {formatDuration(effect.range.start)} → {formatDuration(effect.range.end)}
                    </span>
                  </span>
                  <span className="effect-item-actions">
                    <IconButton
                      icon="trash"
                      label="删除遮挡"
                      size="sm"
                      variant="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        execute({ kind: 'DeleteEffect', effectId: effect.id }, '删除遮挡');
                        if (current?.id === effect.id) onSelectEffect(null);
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {current ? (
        <>
          <div className="inspector-section">
            <div className="inspector-section-head">
              <h3>样式</h3>
            </div>
            <Field label="遮挡样式">
              <Segmented
                size="sm"
                ariaLabel="遮挡样式"
                value={(current.parameters as PrivacyParameters).style}
                onChange={(next) => update({ style: next as PrivacyStyle })}
                options={[
                  { value: 'solid', label: '实色' },
                  { value: 'blur', label: '模糊' },
                  { value: 'mosaic', label: '马赛克' },
                ]}
              />
            </Field>
            <p className="wcs-field-hint">
              高敏感信息建议用实色：模糊与马赛克只是视觉样式，不保证不可恢复。
            </p>
          </div>

          <div className="inspector-section">
            <div className="inspector-section-head">
              <h3>区域（源坐标归一化）</h3>
            </div>
            <Slider
              label="X"
              min={0}
              max={1}
              step={0.005}
              value={(current.parameters as PrivacyParameters).x}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              onCommit={(next) => update({ x: next })}
            />
            <Slider
              label="Y"
              min={0}
              max={1}
              step={0.005}
              value={(current.parameters as PrivacyParameters).y}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              onCommit={(next) => update({ y: next })}
            />
            <Slider
              label="宽"
              min={0.01}
              max={1}
              step={0.005}
              value={(current.parameters as PrivacyParameters).width}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              onCommit={(next) => update({ width: next })}
            />
            <Slider
              label="高"
              min={0.01}
              max={1}
              step={0.005}
              value={(current.parameters as PrivacyParameters).height}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              onCommit={(next) => update({ height: next })}
            />
          </div>

          <div className="inspector-section">
            <div className="inspector-section-head">
              <h3>时间区间</h3>
            </div>
            <Slider
              label="开始"
              min={0}
              max={Math.max(1, ticksToSeconds(timelineDuration(project)))}
              step={0.1}
              value={ticksToSeconds(current.range.start)}
              format={(v) => `${v.toFixed(1)} 秒`}
              onCommit={(next) => {
                const start = secondsToTicks(next);
                const end = Math.max(start + secondsToTicks(0.2), current.range.end);
                execute<SetEffectCommand>(
                  { kind: 'SetEffect', effect: { ...current, range: { start, end } }, lock: true },
                  '调整遮挡区间',
                );
              }}
            />
            <Slider
              label="结束"
              min={0}
              max={Math.max(1, ticksToSeconds(timelineDuration(project)))}
              step={0.1}
              value={ticksToSeconds(current.range.end)}
              format={(v) => `${v.toFixed(1)} 秒`}
              onCommit={(next) => {
                const end = secondsToTicks(next);
                const start = Math.min(current.range.start, Math.max(0, end - secondsToTicks(0.2)));
                execute<SetEffectCommand>(
                  { kind: 'SetEffect', effect: { ...current, range: { start, end } }, lock: true },
                  '调整遮挡区间',
                );
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="clock"
              block
              onClick={() =>
                execute<SetEffectCommand>(
                  {
                    kind: 'SetEffect',
                    effect: { ...current, range: { start: current.range.start, end: Math.min(timelineDuration(project), tick) } },
                    lock: true,
                  },
                  '结束时间设为播放头',
                )
              }
            >
              结束时间设为播放头
            </Button>
          </div>

          <div className="inspector-section">
            <div className="inspector-section-head">
              <h3>确认状态</h3>
            </div>
            {(current.parameters as PrivacyParameters).confirmed ? (
              <>
                <InlineNote tone="ok">
                  该区域已确认遮挡，导出时会按「{styleLabel((current.parameters as PrivacyParameters).style)}」处理。
                </InlineNote>
                <Button
                  size="sm"
                  variant="ghost"
                  block
                  style={{ marginTop: 8 }}
                  onClick={() => update({ confirmed: false })}
                >
                  取消确认（标记为未遮挡）
                </Button>
              </>
            ) : (
              <>
                <InlineNote tone="warn">
                  该区域<strong>未确认</strong>，当前<strong>不会被遮挡</strong>。确认前请在预览中核对范围。
                </InlineNote>
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  block
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    update({ confirmed: true });
                    pushToast({ tone: 'ok', title: '遮挡已确认', message: '导出与教程截图都会应用该遮挡。' });
                  }}
                >
                  确认此处已遮挡
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <InlineNote tone="info">在时间线上选择一段遮挡，或在预览上拖拽框选新建。</InlineNote>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 光标（R06：光标事件与点击效果，不出现双光标）
// ---------------------------------------------------------------------------

function CursorTab({
  project,
  selectedEffectId,
  onSelectEffect,
  execute,
}: {
  project: Project;
  selectedEffectId: string | null;
  onSelectEffect: (id: string | null) => void;
  execute: ReturnType<typeof useApp>['execute'];
}) {
  const cursors = useMemo(() => project.effects.filter((e) => e.kind === 'cursor'), [project.effects]);
  const current = cursors.find((e) => e.id === selectedEffectId) ?? cursors[0] ?? null;
  const params = current ? (current.parameters as CursorParameters) : null;

  const update = (patch: Partial<CursorParameters>, label: string) => {
    if (!current) return;
    const next: Effect = {
      ...current,
      parameters: { ...(current.parameters as CursorParameters), ...patch },
      origin: 'manual',
    };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect: next, lock: current.locked }, label);
  };

  const enableCursor = () => {
    const id = `cursor-${Date.now().toString(36)}`;
    const effect: Effect = {
      id,
      kind: 'cursor',
      // 覆盖整条主轨时长，光标效果贯穿整个工程
      range: { start: 0, end: Math.max(1, timelineDuration(project)) },
      parameters: {
        size: 26,
        clickRipple: 1,
        visible: true,
        burnedIn: false,
      },
      origin: 'manual',
      locked: false,
    };
    execute<SetEffectCommand>({ kind: 'SetEffect', effect, lock: false }, '启用光标效果');
    onSelectEffect(id);
  };

  if (!current || !params) {
    return (
      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="cursor" size={12} />
            光标效果
          </h3>
        </div>
        <div className="wcs-empty" style={{ padding: '14px 8px' }}>
          <p>还没有光标效果。启用后可调整光标大小与点击反馈。</p>
          <Button size="sm" icon="cursor" onClick={enableCursor}>
            启用光标效果
          </Button>
        </div>
        <p className="wcs-field-hint" style={{ marginTop: 8 }}>
          光标由事件轨在成片上叠加绘制。如果录制时源画面已经烧录了系统光标，请打开「烧录光标」，避免出现双光标。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="cursor" size={12} />
            光标效果
          </h3>
          <Badge tone="accent">{formatDuration(current.range.start)} → {formatDuration(current.range.end)}</Badge>
        </div>

        <Toggle
          checked={params.visible}
          onChange={(next) => update({ visible: next }, next ? '显示光标' : '隐藏光标')}
          label="显示光标"
          description="关闭后成片不绘制叠加光标；若源画面本身没有光标，观看者将看不到指针。"
        />
        <Toggle
          checked={params.burnedIn}
          onChange={(next) => update({ burnedIn: next }, next ? '启用烧录光标' : '关闭烧录光标')}
          label="烧录光标"
          description="源画面已含系统光标时打开此项：直接使用源画面自带的光标，后期不再叠加绘制，避免出现双光标。"
        />

        {params.burnedIn ? (
          <InlineNote tone="warn">
            烧录模式已开启：源画面中已经带有光标，大小与点击反馈由系统决定，因此下方滑杆不可用，后期不再叠加光标，避免出现双光标。
          </InlineNote>
        ) : null}

        <Slider
          label="光标大小"
          min={12}
          max={96}
          step={1}
          value={params.size}
          disabled={params.burnedIn}
          format={(v) => `${v} px`}
          onCommit={(next) => update({ size: next }, '调整光标大小')}
          hint={
            params.burnedIn
              ? '烧录模式下光标由源画面提供，此滑杆已禁用。'
              : '输出画面上的光标尺寸；录制教程建议 24–40 px，过大容易遮挡内容。'
          }
        />
        <Slider
          label="点击反馈强度"
          min={0}
          max={3}
          step={0.1}
          value={params.clickRipple}
          disabled={params.burnedIn}
          format={(v) => (v === 0 ? '无反馈' : `${v.toFixed(1)}×`)}
          onCommit={(next) => update({ clickRipple: next }, '调整点击反馈强度')}
          hint={
            params.burnedIn
              ? '烧录模式下点击反馈由源画面提供，此滑杆已禁用。'
              : '点击时波纹的强度倍数；0 表示点击不产生波纹。'
          }
        />
      </div>

      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>双光标检查</h3>
        </div>
        {params.burnedIn ? (
          <InlineNote tone="ok">
            当前为烧录模式：只用源画面自带的光标，成片不会叠加第二个光标。
          </InlineNote>
        ) : (
          <InlineNote tone="info">
            当前为叠加模式：光标由事件轨绘制。若录制时未关闭系统光标（源画面已烧录光标），请打开「烧录光标」，否则成片会出现双光标。
          </InlineNote>
        )}
        <div style={{ marginTop: 10 }}>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            block
            onClick={() => {
              execute({ kind: 'DeleteEffect', effectId: current.id }, '删除光标效果');
              onSelectEffect(null);
            }}
          >
            删除光标效果
          </Button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

function CanvasTab({
  project,
  selectedEffect,
  execute,
}: {
  project: Project;
  selectedEffect: Effect | null;
  execute: ReturnType<typeof useApp>['execute'];
}) {
  const canvas = project.settings.canvas;
  const variant = project.variants.find((v) => v.id === project.settings.activeVariantId) ?? project.variants[0];

  const setCanvas = (patch: Partial<CanvasStyle>) => {
    execute<SetCanvasStyleCommand>({ kind: 'SetCanvasStyle', canvas: patch }, '调整画布样式');
  };

  const setVariant = (variantId: string) => {
    execute({ kind: 'SetActiveVariant', variantId }, '切换画幅');
  };

  return (
    <>
      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>
            <Icon name="image" size={12} />
            画幅
          </h3>
          <Badge tone="accent">{`${variant.aspect[0]}:${variant.aspect[1]}`}</Badge>
        </div>
        <div className="variant-row">
          {[
            { id: 'landscape', label: '16:9', w: 34, h: 19 },
            { id: 'square', label: '1:1', w: 24, h: 24 },
            { id: 'portrait', label: '9:16', w: 17, h: 30 },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn('variant-card', project.settings.activeVariantId === item.id && 'is-selected')}
              aria-pressed={project.settings.activeVariantId === item.id}
              onClick={() => setVariant(item.id)}
            >
              <span className="variant-shape" style={{ width: item.w, height: item.h }} />
              <span className="variant-label">{item.label}</span>
            </button>
          ))}
        </div>
        <p className="wcs-field-hint" style={{ marginTop: 6 }}>
          画幅切换只改变输出构图与布局，不重新渲染素材，可随时来回切换。
        </p>
      </div>

      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>背景</h3>
        </div>
        <div className="swatch-row">
          {BACKGROUND_SWATCHES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={cn('swatch', canvas.background === item.value && 'is-active')}
              style={{ background: item.value }}
              aria-label={`背景 ${item.label}`}
              title={item.label}
              onClick={() => setCanvas({ background: item.value })}
            />
          ))}
          <TextInput
            aria-label="自定义背景色"
            value={canvas.background.startsWith('#') ? canvas.background : ''}
            placeholder="#101418"
            style={{ width: 92, height: 24, fontSize: 'var(--fs-aux)' }}
            onChange={(event) => {
              const value = event.target.value.trim();
              if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) setCanvas({ background: value });
            }}
          />
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>画面装饰</h3>
        </div>
        <Slider
          label="圆角"
          min={0}
          max={48}
          step={1}
          value={canvas.cornerRadius}
          format={(v) => `${v} px`}
          onCommit={(next) => setCanvas({ cornerRadius: next })}
        />
        <Slider
          label="阴影模糊"
          min={0}
          max={80}
          step={1}
          value={canvas.shadowBlur}
          format={(v) => (v === 0 ? '无阴影' : `${v} px`)}
          onCommit={(next) => setCanvas({ shadowBlur: next })}
        />
        <Slider
          label="阴影不透明度"
          min={0}
          max={1}
          step={0.01}
          value={canvas.shadowOpacity}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onCommit={(next) => setCanvas({ shadowOpacity: next })}
        />
        <Slider
          label="内边距"
          min={0}
          max={0.3}
          step={0.005}
          value={canvas.padding}
          format={(v) => `${(v * 100).toFixed(1)}%`}
          onCommit={(next) => setCanvas({ padding: next })}
        />
      </div>

      <div className="inspector-section">
        <div className="inspector-section-head">
          <h3>摄像头布局</h3>
          <button
            type="button"
            className={cn('wcs-btn is-sm is-ghost', !canvas.camera.visible && 'is-danger')}
            onClick={() => setCanvas({ camera: { ...canvas.camera, visible: !canvas.camera.visible } })}
          >
            <Icon name={canvas.camera.visible ? 'eye' : 'eyeOff'} size={11} />
            {canvas.camera.visible ? '显示' : '隐藏'}
          </button>
        </div>
        <Slider
          label="X"
          min={0}
          max={1}
          step={0.005}
          value={canvas.camera.x}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onCommit={(next) => setCanvas({ camera: { ...canvas.camera, x: next } })}
        />
        <Slider
          label="Y"
          min={0}
          max={1}
          step={0.005}
          value={canvas.camera.y}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onCommit={(next) => setCanvas({ camera: { ...canvas.camera, y: next } })}
        />
        <Slider
          label="大小"
          min={0.08}
          max={0.6}
          step={0.005}
          value={canvas.camera.width}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onCommit={(next) => setCanvas({ camera: { ...canvas.camera, width: next, height: next } })}
        />
        <Slider
          label="圆角"
          min={0}
          max={48}
          step={1}
          value={canvas.camera.cornerRadius}
          format={(v) => `${v} px`}
          onCommit={(next) => setCanvas({ camera: { ...canvas.camera, cornerRadius: next } })}
        />
      </div>

      {selectedEffect && selectedEffect.kind === 'privacy' && (
        <InlineNote tone="info">
          遮挡矩形按「源画面坐标」记录，换画幅后仍会跟随内容位置，不需要重新框选。
        </InlineNote>
      )}
    </>
  );
}
