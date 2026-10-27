import { useState } from 'react';
import { useApp } from '../lib/store';
import { Badge, Button, Field, Icon, Kbd, Modal, Select, Toggle } from '../components/ui';
import { ChoiceButton } from '../components/ChoiceButton';
import { formatBytes, unwrap } from '../lib/format';
import { wcs, withTimeout, IPC_TIMEOUT } from '../lib/wcs';
import { loadSettings, saveSettings, type PersistedSettings } from '../lib/settings';
import type { DiagnosticsReport } from '@shared/api';

const PAGES = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'editor', label: '编辑器', icon: 'layers' },
  { id: 'recording', label: '录制', icon: 'record' },
  { id: 'permissions', label: '设备', icon: 'shield' },
  { id: 'about', label: '关于', icon: 'info' },
] as const;
const SHORTCUTS = [
  ['开始 / 停止录制', 'Ctrl + Alt + R'], ['暂停 / 继续录制', 'Ctrl + Alt + P'], ['添加标记', 'Ctrl + Alt + M'],
  ['播放 / 暂停', 'Space'], ['逐帧步进', '← / →'], ['逐秒步进', 'Shift + ← / →'], ['分割片段', 'Ctrl + B'],
  ['复制 / 粘贴效果', 'Ctrl + C / V'], ['只粘贴效果属性', 'Ctrl + Shift + V'], ['删除所选', 'Delete'],
  ['撤销 / 重做', 'Ctrl + Z / Y'], ['保存工程', 'Ctrl + S'], ['跳到开头 / 结尾', 'Home / End'], ['切换工作区', 'Ctrl + 1–6'],
];

export function SettingsView({ onClose }: { onClose?: () => void }) {
  const { systemInfo, refreshSystemInfo, config, updateConfig, pushError, pushToast, setView } = useApp();
  const [page, setPage] = useState<typeof PAGES[number]['id']>('general');
  const [preferences, setPreferences] = useState(loadSettings);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const close = onClose ?? (() => setView('editor'));
  const persist = (patch: Partial<PersistedSettings>) => setPreferences(saveSettings(patch));
  const chooseDirectory = async (kind: 'project' | 'export') => {
    try {
      const path = unwrap(await wcs().pickDirectory());
      if (!path) return;
      if (kind === 'project') { updateConfig({ outputDirectory: path }); persist({ lastDirectory: path }); }
      else persist({ exportDirectory: path });
    } catch (error) { pushError(error, '选择目录失败'); }
  };
  const diagnose = async () => {
    setDiagnosing(true);
    try {
      const result = unwrap(await withTimeout(wcs().writeDiagnostics(), IPC_TIMEOUT.diagnostics, '导出诊断日志'));
      setDiagnostics(result); pushToast({ tone: 'ok', title: '诊断日志已导出', message: formatBytes(result.bytes) });
    } catch (error) { pushError(error, '导出诊断日志失败'); }
    finally { setDiagnosing(false); }
  };
  const changeTopmost = async (next: boolean) => {
    try { unwrap(await wcs().setAlwaysOnTop(next)); persist({ alwaysOnTop: next }); }
    catch (error) { pushError(error, '置顶设置未生效'); }
  };
  const folders = [
    { kind: 'project' as const, label: '项目目录', path: config.outputDirectory || preferences.lastDirectory || systemInfo?.videosPath || '系统视频目录', icon: 'folder' },
    { kind: 'export' as const, label: '导出目录', path: preferences.exportDirectory || systemInfo?.videosPath || '系统视频目录', icon: 'export' },
  ];
  return <Modal title="设置" className="settings-dialog" width={560} onClose={close}>
    <nav className="island-navigation" role="tablist" aria-label="设置分类" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = PAGES.findIndex(item => item.id === page);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? PAGES.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + PAGES.length) % PAGES.length;
      setPage(PAGES[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
    }}>
      {PAGES.map(item => <ChoiceButton selected={page === item.id} key={item.id} role="tab" id={`settings-tab-${item.id}`} aria-controls="settings-page" aria-selected={page === item.id} aria-label={item.label} title={item.label} tabIndex={page === item.id ? 0 : -1} onClick={() => setPage(item.id)}>
        <Icon name={item.icon} size={18} /><span className="settings-tab-label">{item.label}</span>
      </ChoiceButton>)}
    </nav>
    <div className="settings-island" id="settings-page" role="tabpanel" aria-labelledby={`settings-tab-${page}`}>
      <div className="settings-page" key={page}>
        {page === 'general' && <>
          <h3 className="section-caption">存储位置</h3>
          <div className="settings-folder-grid">{folders.map(folder => <div className={`settings-tile folder-tile is-${folder.kind}`} key={folder.kind}>
            <div className="folder-tile-head"><span className="folder-symbol"><Icon name={folder.icon} size={24} /></span><Button size="sm" variant="ghost" onClick={() => void chooseDirectory(folder.kind)}>更改…</Button></div>
            <span>{folder.label}</span><strong title={folder.path}>{folder.path.split(/[\\/]/).filter(Boolean).at(-1)}</strong><small title={folder.path}>{folder.path}</small>
          </div>)}</div>
          <h3 className="section-caption">偏好</h3>
          <div className="settings-preference-grid">
            <div className="settings-tile preference-tile"><Icon name="sun" size={21} /><strong>界面外观</strong><Select ariaLabel="界面外观" value={preferences.appearance ?? 'light'} onChange={next => persist({ appearance: next as PersistedSettings['appearance'] })} options={[{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}]} /></div>
            <div className="settings-tile preference-tile"><Icon name="volume" size={21} /><strong>导出完成提示音</strong><Toggle checked={preferences.exportSound !== false} onChange={next => persist({ exportSound: next })} label="提示音" /></div>
            <div className="settings-tile preference-tile"><Icon name="play" size={21} /><strong>界面动效</strong><Select ariaLabel="界面动效" value={preferences.motion ?? 'system'} onChange={next => persist({ motion: next as PersistedSettings['motion'] })} options={[{value:'system',label:'跟随系统'},{value:'reduced',label:'减少动态效果'}]} /></div>
          </div>
          <div className="settings-tile settings-row"><Toggle checked={preferences.alwaysOnTop ?? false} onChange={next => void changeTopmost(next)} label="主窗口置顶" description="重启后保留，录制控制条始终置顶" /></div>
        </>}
        {page === 'editor' && <>
          <h3 className="section-caption">工作区</h3><div className="settings-tile settings-row"><Icon name="image" size={23} /><div><strong>清晰预览</strong><p>预览自动匹配屏幕像素密度，最高支持 4K。</p></div></div>
          <h3 className="section-caption">快捷键</h3><div className="settings-tile shortcut-tile">{SHORTCUTS.map(([label, keys]) => <div className="settings-shortcut" key={label}><span>{label}</span><Kbd>{keys}</Kbd></div>)}</div>
          <p className="settings-hint">在输入框中编辑文字时，剪辑快捷键会自动让位。</p>
        </>}
        {page === 'recording' && <>
          <h3 className="section-caption">录制默认值</h3><div className="settings-tile settings-form">
            <Field label="画质档位"><Select ariaLabel="默认质量档位" value={config.qualityId} onChange={next => updateConfig({qualityId:next})} options={[{value:'1080p60',label:'1080p · 60 帧'},{value:'1080p30',label:'1080p · 30 帧'},{value:'720p30',label:'720p · 30 帧'}]} /></Field>
            <Field label="开始倒计时"><Select ariaLabel="默认倒计时" value={String(config.countdownSeconds)} onChange={next => updateConfig({countdownSeconds:Number(next)})} options={[{value:'0',label:'立即开始'},{value:'3',label:'3 秒'},{value:'5',label:'5 秒'}]} /></Field>
            <Field label="采集方式"><Select ariaLabel="采集方式" value={config.backend ?? 'auto'} onChange={next => updateConfig({backend:next as typeof config.backend})} options={[{value:'auto',label:'自动选择'},{value:'wgc',label:'现代采集'},{value:'compatibility',label:'兼容采集'}]} /></Field>
          </div><div className="settings-tile settings-form">
            <Toggle checked={config.systemAudioEnabled} onChange={next => updateConfig({systemAudioEnabled:next})} label="录制系统声音" />
            <Toggle checked={config.microphoneEnabled} onChange={next => updateConfig({microphoneEnabled:next})} label="录制麦克风" />
            <Toggle checked={config.cameraEnabled} onChange={next => updateConfig({cameraEnabled:next})} label="录制摄像头" />
          </div>
        </>}
        {page === 'permissions' && <>
          <h3 className="section-caption">设备与采集能力</h3><div className="settings-tile settings-form">
            {Object.entries({ '屏幕采集':systemInfo?.captureCapabilities.screen, '窗口采集':systemInfo?.captureCapabilities.window, '系统声音':systemInfo?.captureCapabilities.systemAudio, '麦克风':systemInfo?.captureCapabilities.microphone, '摄像头':systemInfo?.captureCapabilities.camera, '硬件编码':systemInfo?.hardwareEncoding }).map(([label,available]) => <div className="settings-status-row" key={label}><span>{label}</span><Badge tone={available ? 'ok' : 'muted'} icon={available ? 'check' : 'info'}>{available ? '可用' : '不可用'}</Badge></div>)}
            <Button size="sm" icon="refresh" onClick={() => void refreshSystemInfo()}>重新检测</Button>
          </div><h3 className="section-caption">隐私与数据</h3><div className="settings-tile settings-form"><p>录制、工程与标记保存在本机。</p><p>控制条会从录制画面中排除。未确认的遮挡不会生效，可在编辑器中逐一核对。</p><Button size="sm" variant="ghost" onClick={() => setView('editor')}>检查画面遮挡</Button></div>
        </>}
        {page === 'about' && <>
          <div className="settings-about"><img src="./app-icon.png" alt="" /><h2>WinCapture Studio</h2><p>录得清楚，剪得轻松。</p><small>版本 {systemInfo?.appVersion ?? '0.1.0'}</small></div>
          <div className="settings-tile settings-form"><div className="settings-status-row"><span>系统</span><span>{systemInfo?.osVersion ?? '正在读取…'}</span></div><div className="settings-status-row"><span>内存</span><span>{formatBytes(systemInfo?.freeMemoryBytes ?? 0)} 可用</span></div><div className="settings-status-row"><span>运行环境</span><span>Electron {systemInfo?.electronVersion ?? '—'}</span></div></div>
          <h3 className="section-caption">诊断与数据</h3><div className="settings-tile settings-form"><p className="settings-hint">诊断包含系统信息和采集日志，不包含录制画面。</p><Button size="sm" icon="save" loading={diagnosing} onClick={() => void diagnose()}>导出诊断日志</Button>{diagnostics && <Button size="sm" variant="ghost" icon="folder" onClick={() => void wcs().showInFolder(diagnostics.path)}>打开所在文件夹</Button>}<Button size="sm" variant="ghost" icon="folder" disabled={!systemInfo?.userDataPath} onClick={() => systemInfo && void wcs().openPath(systemInfo.userDataPath)}>打开数据目录</Button></div>
        </>}
      </div>
    </div>
  </Modal>;
}
