import { useState } from 'react';
import { useApp } from '../lib/store';
import { wcs } from '../lib/wcs';
import { loadSettings, saveSettings } from '../lib/settings';
import { LineIcon } from './LineIcon';

export function StudioHeader() {
  const { project, view, setView, dirty, saving, undo, redo, canUndo, canRedo, openProject, recents } = useApp();
  const [menu, setMenu] = useState(false);
  const isDark = document.documentElement.dataset.theme === 'dark';
  const open = async (path?: string) => { if (await openProject(path)) setView('editor'); setMenu(false); };
  const toggleAppearance = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    saveSettings({ appearance: next });
    document.documentElement.dataset.theme = next;
  };
  return <header className="studio-header">
    <div className="studio-project-menu">
      <button className="studio-menu-trigger" aria-label="项目菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}><LineIcon kind="folder" size={15} /><LineIcon kind="chevronDown" size={9} /></button>
      {menu && <><button className="studio-menu-scrim" aria-label="收起项目菜单" onClick={() => setMenu(false)} /><div className="studio-dropdown">
        <button onClick={() => { setView('record'); setMenu(false); }}><LineIcon kind="record" size={15} />新建录制</button>
        <button onClick={() => void open()}><LineIcon kind="folder" size={15} />打开项目…</button>
        <button onClick={() => { setView('home'); setMenu(false); }}><LineIcon kind="layers" size={15} />全部项目</button>
        {project && <button onClick={() => { setView('tutorial'); setMenu(false); }}><LineIcon kind="book" size={15} />图文教程</button>}
        {recents.slice(0, 4).map(p => <button key={p.path} onClick={() => void open(p.path)} title={p.name}><LineIcon kind="clock" size={14} /><span>{p.name}</span></button>)}
      </div></>}
    </div>
    <div className="studio-document-name"><strong>{project?.name ?? 'WinCapture Studio'}</strong><span className={`document-save-state${saving ? ' is-saving' : ''}`}>{saving ? <span className="save-dot" /> : <LineIcon kind={dirty ? 'clock' : 'check'} size={12} />}{saving ? '保存中…' : dirty ? '未保存' : project ? '已保存' : '准备就绪'}</span></div>
    {project && <div className="studio-history"><button className="wcs-iconbtn" aria-label="撤销（Ctrl+Z）" title="撤销（Ctrl+Z）" onClick={undo} disabled={!canUndo}><LineIcon kind="undo" size={16} /></button><button className="wcs-iconbtn" aria-label="重做（Ctrl+Y）" title="重做（Ctrl+Y）" onClick={redo} disabled={!canRedo}><LineIcon kind="redo" size={16} /></button></div>}
    <div className="studio-header-spacer" />
    <button className="studio-text-action" aria-label={isDark ? '切换到浅色外观' : '切换到深色外观'} title={isDark ? '切换到浅色外观' : '切换到深色外观'} onClick={toggleAppearance}><LineIcon kind={isDark ? 'sun' : 'moon'} size={16} /></button>
    <button className="studio-text-action" aria-label="打开设置" title="设置" onClick={() => setView('settings')}><LineIcon kind="settings" size={16} /></button>
    {project && <><span className="studio-toolbar-divider" /><button className="studio-export" onClick={() => setView('export')}><LineIcon kind="share" size={14} />导出</button></>}
    {wcs().role === 'main' && <div className="studio-window-controls"><button aria-label="最小化" onClick={() => void wcs().minimize()}><LineIcon kind="minus" size={14} /></button><button aria-label="最大化或还原" onClick={() => void wcs().windowLayout({ mode: 'maximize' })}><LineIcon kind="stop" size={12} /></button><button aria-label="关闭应用" onClick={() => void wcs().close()}><LineIcon kind="close" size={13} /></button></div>}
  </header>;
}
