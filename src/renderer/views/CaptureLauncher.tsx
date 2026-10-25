import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSourceInfo, DisplayInfo, AudioDeviceInfo, VideoDeviceInfo } from '@shared/ipc';
import { QUALITY_PROFILES } from '@shared/ipc';
import { useApp } from '../lib/store';
import { wcs } from '../lib/wcs';
import { unwrap, cn } from '../lib/format';
import { Icon } from '../components/ui';

type Mode = 'screen' | 'window' | 'region' | 'device';
type Rect = { x: number; y: number; width: number; height: number };
const MODES: { id: Mode; label: string; icon: string; hint: string }[] = [
  { id: 'window', label: '窗口', icon: 'window', hint: '只录一个应用' },
  { id: 'region', label: '区域', icon: 'crop', hint: '在桌面拖拽选取' },
  { id: 'device', label: '设备', icon: 'camera', hint: '摄像头 / 采集卡' },
  { id: 'screen', label: '显示器', icon: 'screen', hint: '录制整个屏幕' },
];

export function CaptureLauncher() {
  const { config, updateConfig, startRecording, busy, openProject, recents, setView, capture } = useApp();
  const [mode, setMode] = useState<Mode>(config.sourceKind === 'device' ? 'device' : config.sourceKind === 'window' ? 'window' : 'screen');
  const [panel, setPanel] = useState<'sources' | 'more' | null>(null);
  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [audio, setAudio] = useState<AudioDeviceInfo[]>([]);
  const [devices, setDevices] = useState<VideoDeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [directory, setDirectory] = useState(config.outputDirectory ?? '');
  const [name, setName] = useState('');
  const drag = useRef<{ x: number; y: number; move?: Rect } | null>(null);
  const configRef = useRef(config); configRef.current = config;
  const displayRequest = useRef<Promise<DisplayInfo[]> | null>(null);
  const deviceRequest = useRef<Promise<void> | null>(null);
  const sourceGeneration = useRef(0);
  const selected = sources.find(s => s.id === config.sourceId);
  const display = displays[Number(config.sourceId.split(':')[1])] ?? displays[0];
  const deviceName = devices.find(d => `device:${d.deviceId}` === config.sourceId)?.label ?? '视频设备';
  const sourceName = mode === 'device' ? deviceName : selected?.name ?? '选择录制来源';
  const profile = QUALITY_PROFILES.find(p => p.id === config.qualityId) ?? QUALITY_PROFILES[1];
  const modeInfo = MODES.find(m => m.id === mode)!;

  // 启动只读显示器元数据；窗口缩略图和设备枚举留到用户打开面板时执行。
  useEffect(() => {
    let active = true;
    displayRequest.current ??= wcs().listDisplays().then(unwrap);
    void displayRequest.current.then(monitors => {
      if (!active) return;
      setDisplays(monitors);
      const screens: CaptureSourceInfo[] = monitors.map((d, i) => ({ id: `display:${i}`, kind: 'screen', name: d.label,
        displayId: d.id, width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor), available: true }));
      setSources(previous => [...screens, ...previous.filter(s => s.kind === 'window')]);
      if (!configRef.current.sourceId && screens[0]) updateConfig({ sourceId: screens[0].id, sourceKind: 'screen' });
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [updateConfig]);

  const refreshDevices = useCallback(() => {
    if (deviceRequest.current) return deviceRequest.current;
    const task = Promise.all([
      wcs().listDevices().then(result => setAudio(unwrap(result).audio)),
      (navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([])).then(video => {
        const list = video.filter(d => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `视频设备 ${i + 1}` }));
        setDevices(list);
        const current = configRef.current;
        const preferred = list.find(d => /integrated|built[ .-]?in|内置/i.test(d.label)) ?? list[0];
        if (preferred && !list.some(d => d.deviceId === current.cameraDeviceId)) updateConfig({ cameraDeviceId: preferred.deviceId });
        if (preferred && current.sourceKind === 'device' && !list.some(d => `device:${d.deviceId}` === current.sourceId)) updateConfig({ sourceId: `device:${preferred.deviceId}` });
      }),
    ]).then(() => {}).finally(() => { deviceRequest.current = null; });
    deviceRequest.current = task; return task;
  }, [updateConfig]);
  const refresh = useCallback(async () => {
    const generation = ++sourceGeneration.current;
    setLoading(true);
    try {
      if (mode === 'device') await refreshDevices();
      else {
        const available = unwrap(await wcs().listSources({ kind: mode === 'window' ? 'window' : 'screen' }));
        if (generation === sourceGeneration.current) setSources(previous => [...previous.filter(s => s.kind !== (mode === 'window' ? 'window' : 'screen')), ...available]);
      }
    } catch (e) { if (generation === sourceGeneration.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation === sourceGeneration.current) setLoading(false); }
  }, [mode, refreshDevices]);
  useEffect(() => {
    if (panel === 'sources') void refresh();
    else if (panel === 'more') void refreshDevices().catch(e => setError(String(e)));
    return () => { sourceGeneration.current++; };
  }, [panel, refresh, refreshDevices]);

  useEffect(() => {
    if (confirming) return;
    void wcs().windowLayout({ mode: 'launcher', height: panel === 'sources' ? 610 : panel === 'more' ? 740 : error ? 170 : 96 });
  }, [panel, confirming, error]);
  const cancel = useCallback(() => {
    setConfirming(false); setPreparing(false); setRect(null); drag.current = null;
    void wcs().windowLayout({ mode: 'launcher', height: panel ? 610 : 96 });
  }, [panel]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (confirming) cancel(); else setPanel(null); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [confirming, cancel]);

  const changeMode = (next: Mode) => {
    setMode(next); setError('');
    if (next === 'device') {
      const device = devices.find(d => /Integrated|内置/i.test(d.label)) ?? devices[0];
      updateConfig({ sourceKind: 'device', sourceId: device ? `device:${device.deviceId}` : '', region: undefined });
    } else {
      const kind = next === 'window' ? 'window' : 'screen';
      const source = sources.find(s => s.kind === kind && s.available);
      updateConfig({ sourceKind: kind, sourceId: source?.id ?? '', region: undefined });
    }
  };
  const prepare = async () => {
    setError('');
    if (!config.sourceId || (mode !== 'device' && !selected?.available)) { setPanel('sources'); setError('先选择一个可用的录制来源'); return; }
    try {
      const result = unwrap(await wcs().windowLayout({ mode: mode === 'device' ? 'launcher' : 'selection', sourceId: config.sourceId, height: 186 }));
      setPanel(null); setConfirming(true);
      setRect(mode === 'region' ? { x: result.width * .15, y: result.height * .15, width: result.width * .7, height: result.height * .62 }
        : result.target ?? { x: 4, y: 4, width: result.width - 8, height: result.height - 8 });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const record = async () => {
    if (preparing || busy.capture) return;
    setPreparing(true);
    const scale = display?.scaleFactor ?? window.devicePixelRatio ?? 1;
    const region = mode === 'region' && rect ? {
      x: Math.max(0, Math.round(rect.x * scale)), y: Math.max(0, Math.round(rect.y * scale)),
      width: Math.max(2, Math.floor(rect.width * scale / 2) * 2), height: Math.max(2, Math.floor(rect.height * scale / 2) * 2),
    } : undefined;
    await startRecording({ region, outputDirectory: directory || undefined, projectName: name.trim() || undefined,
      cameraEnabled: mode === 'device' ? false : config.cameraEnabled });
    const status = await wcs().captureStatus();
    if (!status.ok || !status.data || ['Idle', 'RecoverableFailure', 'Cancelled'].includes(status.data.state)) {
      cancel(); setError(status.data?.error?.message ?? '未能开始录制，请检查来源和设备后重试');
    }
  };
  const chooseDirectory = async () => { const path = unwrap(await wcs().pickDirectory()); if (path) { setDirectory(path); updateConfig({ outputDirectory: path }); } };
  const open = async (path?: string) => { if (await openProject(path)) setView('editor'); };

  if (confirming) return <div className={cn('capture-selection', mode === 'region' && 'is-region', mode === 'device' && 'is-device')}
    onPointerDown={e => {
      if (mode !== 'region' || (e.target as HTMLElement).closest('button, .selection-actions')) return;
      const corner = (e.target as HTMLElement).closest('.corner');
      if (rect && corner) drag.current = {
        x: corner.classList.contains('tl') || corner.classList.contains('bl') ? rect.x + rect.width : rect.x,
        y: corner.classList.contains('tl') || corner.classList.contains('tr') ? rect.y + rect.height : rect.y,
      };
      else drag.current = { x: e.clientX, y: e.clientY, move: rect && e.clientX > rect.x && e.clientX < rect.x + rect.width && e.clientY > rect.y && e.clientY < rect.y + rect.height ? { ...rect } : undefined };
      e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={e => {
      if (!drag.current) return;
      const x = Math.max(0, Math.min(window.innerWidth, e.clientX)), y = Math.max(0, Math.min(window.innerHeight, e.clientY));
      if (drag.current.move) {
        const old = drag.current.move;
        setRect({ ...old, x: Math.max(0, Math.min(window.innerWidth - old.width, old.x + x - drag.current.x)),
          y: Math.max(0, Math.min(window.innerHeight - old.height, old.y + y - drag.current.y)) }); return;
      }
      setRect({ x: Math.min(drag.current.x, x), y: Math.min(drag.current.y, y), width: Math.max(2, Math.abs(x - drag.current.x)), height: Math.max(2, Math.abs(y - drag.current.y)) });
    }} onPointerUp={() => { drag.current = null; }}>
    {mode !== 'device' && rect && <div className="source-outline" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <span>{mode === 'region' ? '拖拽调整录制区域' : `即将录制 · ${sourceName}`}</span>
      <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
    </div>}
    <div className="selection-actions">
      <div className="selection-source"><strong>{mode === 'region' ? '自定义区域' : sourceName}</strong>
        <small>{mode === 'region' && rect ? `${Math.round(rect.width * (display?.scaleFactor ?? 1))} × ${Math.round(rect.height * (display?.scaleFactor ?? 1))}`
          : mode === 'device' ? '摄像头 / USB 采集卡' : `${selected?.width ?? 0} × ${selected?.height ?? 0}`} · {profile.fps} fps</small></div>
      <button onClick={cancel} disabled={preparing}>取消 <kbd>Esc</kbd></button>
      <button className="selection-start" disabled={preparing || (mode === 'region' && !!rect && (rect.width < 32 || rect.height < 32))} onClick={() => void record()}>
        <span />{preparing ? '正在准备…' : '开始录制'}</button>
    </div>
  </div>;

  return <div className="launcher-root">
    <div className="capture-capsule" role="toolbar" aria-label="录制胶囊">
      <button className={cn('capture-source-trigger', panel === 'sources' && 'active')} onClick={() => setPanel(panel === 'sources' ? null : 'sources')} title={sourceName}>
        <Icon name={modeInfo.icon} size={20} /><span>{modeInfo.label}</span><Icon name="chevronDown" size={13} />
      </button><span className="capsule-separator" />
      {([
        ['microphoneEnabled', 'mic', '麦克风'], ['cameraEnabled', 'camera', '摄像头'], ['systemAudioEnabled', 'volume', '系统声音'],
      ] as const).map(([key, icon, label]) => <button key={key} aria-label={`${label}${config[key] ? '开启' : '关闭'}`} aria-pressed={config[key]}
        className={cn('capsule-toggle', !config[key] && 'is-off')} title={`${label} · 点击开关，更多设置中选择设备`}
        onClick={() => updateConfig({ [key]: !config[key] })}><Icon name={icon} size={22} />{!config[key] && <i />}</button>)}
      <button className={cn('capsule-more', panel === 'more' && 'active')} aria-label="更多录前设置" aria-expanded={panel === 'more'} onClick={() => setPanel(panel === 'more' ? null : 'more')}>•••</button>
      <button className="capsule-record" aria-label="选择范围并准备录制" title="选择范围并准备录制" onClick={() => void prepare()} disabled={busy.capture || loading}><span /></button>
      <span className="capsule-drag" title="拖动录制胶囊">⠿</span>
    </div>
    {error && <div className="launcher-error" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError('')}>×</button></div>}
    {panel === 'sources' && <section className="launcher-popover source-popover" aria-label="录制来源选择">
      <div className="source-modes">{MODES.map(m => <button key={m.id} className={cn(mode === m.id && 'active')} onClick={() => changeMode(m.id)}>
        <Icon name={m.icon} size={20} /><strong>{m.label}</strong><small>{m.hint}</small></button>)}</div>
      <div className="popover-heading"><strong>{mode === 'device' ? '已连接的视频设备' : mode === 'region' ? '选择区域所在的显示器' : `选择${modeInfo.label}`}</strong>
        <button onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={14} />{loading ? '读取中' : '刷新'}</button></div>
      <div className="source-picker-grid">{mode === 'device' ? devices.map(d => <button key={d.deviceId} className={cn('source-choice', config.sourceId === `device:${d.deviceId}` && 'selected')}
        onClick={() => updateConfig({ sourceId: `device:${d.deviceId}`, sourceKind: 'device' })}><div className="source-camera-placeholder"><Icon name="camera" size={34} /></div><strong>{d.label}</strong><small>摄像头 / 采集设备</small></button>)
        : sources.filter(s => s.kind === (mode === 'window' ? 'window' : 'screen')).map(s => <button key={s.id} disabled={!s.available}
          className={cn('source-choice', s.id === config.sourceId && 'selected')} onClick={() => updateConfig({ sourceId: s.id, sourceKind: s.kind, region: undefined })}>
          {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div className="source-camera-placeholder"><Icon name={modeInfo.icon} size={30} /></div>}
          <strong>{s.name}</strong><small>{s.width} × {s.height}{!s.available ? ' · 不可用' : ''}</small></button>)}</div>
      {mode === 'device' && <p className="launcher-hint">支持 Windows 识别的摄像头与 USB 采集卡。手机需先通过系统可识别的视频采集设备连接。</p>}
      {!loading && (mode === 'device' ? !devices.length : !sources.some(s => s.kind === (mode === 'window' ? 'window' : 'screen'))) && <p className="launcher-hint">没有找到可用来源，连接设备或打开目标窗口后刷新。</p>}
      <button className="launcher-next" onClick={() => void prepare()}>下一步 · 确认录制范围 <Icon name="chevronRight" size={14} /></button>
    </section>}
    {panel === 'more' && <section className="launcher-popover preparation-popover" aria-label="录屏前准备">
      <button className="preparation-directory" onClick={() => void chooseDirectory()} title={directory || '默认保存在系统视频目录'}><Icon name="folder" size={19} /><span>{directory ? directory.split(/[\\/]/).filter(Boolean).at(-1) : '录屏'}<small>{directory || '系统视频目录'}</small></span><Icon name="chevronRight" size={15} /></button>
      <input className="preparation-name" placeholder="自动命名" aria-label="录制名称" value={name} onChange={e => setName(e.target.value)} />
      <div className="codec-choice" aria-label="录制编码"><span>H.264</span><small>MP4 · AAC</small></div>
      <label className="preparation-row"><Icon name="screen" size={18} /><span>分辨率与帧率</span><select aria-label="分辨率与帧率" value={config.qualityId} onChange={e => {
        const p = QUALITY_PROFILES.find(q => q.id === e.target.value)!; updateConfig({ qualityId: p.id, fps: { num: p.fps, den: 1 } });
      }}>{QUALITY_PROFILES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="preparation-row"><Icon name="clock" size={18} /><span>开始倒计时</span><select aria-label="开始倒计时" value={config.countdownSeconds} onChange={e => updateConfig({ countdownSeconds: Number(e.target.value) })}><option value={0}>立即</option><option value={3}>3 秒</option><option value={5}>5 秒</option></select></label>
      <label className="preparation-row"><Icon name="mic" size={18} /><span>麦克风设备</span><select aria-label="麦克风设备" value={config.microphoneDeviceId ?? ''} onChange={e => updateConfig({ microphoneDeviceId: e.target.value || undefined })}><option value="">系统默认</option>{audio.filter(d => d.kind === 'audioinput').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></label>
      <label className="preparation-row"><Icon name="camera" size={18} /><span>摄像头设备</span><select aria-label="摄像头设备" value={config.cameraDeviceId ?? ''} onChange={e => updateConfig({ cameraDeviceId: e.target.value || undefined })}><option value="">系统默认</option>{devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></label>
      <div className="preparation-links"><button onClick={() => void open()}><Icon name="folder" size={18} />打开项目…</button>
        <button disabled={!recents.length} onClick={() => void open(recents[0]?.path)}><Icon name="clock" size={18} />继续上次项目</button>
        <button onClick={() => setView('settings')}><Icon name="settings" size={18} />设置与设备诊断</button>
        <button onClick={() => setView('home')}><Icon name="layers" size={18} />全部项目</button></div>
      <button className="launcher-exit" onClick={() => void wcs().close()}>退出 WinCapture Studio</button>
    </section>}
    {capture?.error && !error && <div className="launcher-error">{capture.error.message}</div>}
  </div>;
}
