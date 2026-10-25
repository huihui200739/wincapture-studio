import { useState } from 'react';
import { useApp } from '../lib/store';
import { wcs } from '../lib/wcs';
import { Icon, IconButton } from './ui';

export function StudioHeader() {
  const { project, view, setView, dirty, saving, save, undo, redo, canUndo, canRedo, openProject, recents } = useApp();
  const [menu, setMenu] = useState(false);
  const open = async (path?: string) => { if (await openProject(path)) setView('editor'); setMenu(false); };
  return <header className="studio-header">
    <div className="studio-project-menu">
      <button className="studio-menu-trigger" aria-label="项目菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="folder" size={18} /><Icon name="chevronDown" size={11} /></button>
      {menu && <><button className="studio-menu-scrim" aria-label="收起项目菜单" onClick={() => setMenu(false)} /><div className="studio-dropdown">
        <button onClick={() => { setView('record'); setMenu(false); }}><Icon name="record" size={16} />新建录制</button>
        <button onClick={() => void open()}><Icon name="folder" size={16} />打开项目…</button>
        <button onClick={() => { setView('home'); setMenu(false); }}><Icon name="layers" size={16} />全部项目</button>
        {recents.slice(0, 4).map(p => <button key={p.path} onClick={() => void open(p.path)} title={p.name}><Icon name="clock" size={15} /><span>{p.name}</span></button>)}
      </div></>}
    </div>
    <div className="studio-document-name"><strong>{project?.name ?? (view === 'settings' ? '设置' : 'WinCapture Studio')}</strong><span>{saving ? '保存中…' : dirty ? '未保存' : project ? '✓ 已保存' : '录制与教程制作'}</span></div>
    {project && <div className="studio-history"><IconButton icon="undo" label="撤销（Ctrl+Z）" onClick={undo} disabled={!canUndo} /><IconButton icon="redo" label="重做（Ctrl+Y）" onClick={redo} disabled={!canRedo} />
      {dirty && <button className="studio-save" onClick={() => void save()}>保存</button>}</div>}
    <div className="studio-header-spacer" />
    <button className="studio-text-action" onClick={() => setView('record')}><Icon name="record" size={15} />新录制</button>
    <button className="studio-text-action" aria-label="打开设置" onClick={() => setView('settings')}><Icon name="settings" size={17} /></button>
    {project && <button className="studio-export" onClick={() => setView('export')}><Icon name="export" size={15} />导出</button>}
    {wcs().role === 'main' && <div className="studio-window-controls"><button aria-label="最小化" onClick={() => void wcs().minimize()}>−</button><button aria-label="最大化或还原" onClick={() => void wcs().windowLayout({ mode: 'maximize' })}>□</button><button aria-label="关闭应用" onClick={() => void wcs().close()}>×</button></div>}
  </header>;
}
