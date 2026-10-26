import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../lib/store';
import { wcs } from '../lib/wcs';
import { saveSettings } from '../lib/settings';
import { LineIcon } from './LineIcon';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';
import { useShortcuts } from '../lib/hooks';

export function StudioHeader() {
  const { project, view, setView, dirty, saving, undo, redo, canUndo, canRedo, openProject, recents, apiMode, setPlaying } = useApp();
  const [menu, setMenu] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const menuId = useId();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuItems = useRef<HTMLDivElement>(null);
  const menuEntry = useRef<'first' | 'last'>('first');
  const openShortcuts = () => {
    if (shortcutsOpen || document.querySelector('.wcs-modal-backdrop')) return;
    if (menu) menuTrigger.current?.focus();
    setMenu(false);
    setPlaying(false);
    setShortcutsOpen(true);
  };
  useShortcuts([{ combo: 'f1', handler: openShortcuts, allowInInput: true, allowInModal: true, allowRepeat: true }], !!project && view === 'editor');

  // 设置、系统偏好和其他窗口都能切换外观，按钮跟随实际显示的主题。
  useEffect(() => {
    const syncTheme = () => setIsDark(document.documentElement.dataset.theme === 'dark');
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    syncTheme();
    return () => observer.disconnect();
  }, []);

  useEffect(() => setMenu(false), [view]);

  useEffect(() => {
    if (!menu) return;
    const buttons = menuItems.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    const first = menuEntry.current === 'last' ? buttons?.[buttons.length - 1] : buttons?.[0];
    first?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenu(false);
    };
    const closeOnBlur = () => setMenu(false);
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('blur', closeOnBlur);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('blur', closeOnBlur);
    };
  }, [menu]);

  const closeMenu = (restoreFocus = false) => {
    setMenu(false);
    if (restoreFocus) menuTrigger.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        menuEntry.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setMenu(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      // 回到触发按钮后交给原生 Tab 顺序，焦点不会落到已移除的菜单项上。
      closeMenu(true);
      return;
    }
    const buttons = Array.from(menuItems.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = buttons.findIndex(button => button === document.activeElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % buttons.length; break;
      case 'ArrowUp': next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length; break;
      case 'Home': next = 0; break;
      case 'End': next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  const open = async (path?: string) => { closeMenu(); if (await openProject(path)) setView('editor'); };
  const toggleAppearance = () => {
    closeMenu();
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    saveSettings({ appearance: next });
    document.documentElement.dataset.theme = next;
  };
  return <><header className="studio-header">
    <div className="studio-project-menu" ref={menuRoot} data-keys={menu ? 'arrowdown arrowup home end escape space enter' : 'arrowdown arrowup space enter'} onKeyDown={onMenuKeyDown}>
      <button type="button" ref={menuTrigger} className="studio-menu-trigger" aria-label="项目菜单" aria-haspopup="menu" aria-controls={menu ? menuId : undefined} aria-expanded={menu} onClick={() => { menuEntry.current = 'first'; setMenu(!menu); }}><LineIcon kind="folder" size={15} /><LineIcon kind="chevronDown" size={9} /></button>
      {menu && <><button type="button" tabIndex={-1} className="studio-menu-scrim" aria-label="收起项目菜单" onClick={() => closeMenu(true)} /><div id={menuId} ref={menuItems} className="studio-dropdown" role="menu" aria-label="项目">
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setView('record'); setMenu(false); }}><LineIcon kind="record" size={15} />新建录制</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => void open()}><LineIcon kind="folder" size={15} />打开项目…</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setView('home'); setMenu(false); }}><LineIcon kind="layers" size={15} />全部项目</button>
        {project && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setView('tutorial'); setMenu(false); }}><LineIcon kind="book" size={15} />图文教程</button>}
        {recents.slice(0, 4).map(p => <button type="button" role="menuitem" tabIndex={-1} key={p.path} onClick={() => void open(p.path)} title={p.name}><LineIcon kind="clock" size={14} /><span>{p.name}</span></button>)}
      </div></>}
    </div>
    <div className="studio-document-name"><strong>{project?.name ?? 'WinCapture Studio'}</strong><span className={`document-save-state${saving ? ' is-saving' : ''}`}>{saving ? <span className="save-dot" /> : <LineIcon kind={dirty ? 'clock' : 'check'} size={12} />}{saving ? '保存中…' : dirty ? '未保存' : project ? '已保存' : '准备就绪'}</span></div>
    {project && <div className="studio-history"><button className="wcs-iconbtn" aria-label="撤销（Ctrl+Z）" title="撤销（Ctrl+Z）" onClick={undo} disabled={!canUndo}><LineIcon kind="undo" size={16} /></button><button className="wcs-iconbtn" aria-label="重做（Ctrl+Y）" title="重做（Ctrl+Y）" onClick={redo} disabled={!canRedo}><LineIcon kind="redo" size={16} /></button></div>}
    <div className="studio-header-spacer" />
    {apiMode === 'mock' && <span className="studio-preview-mode" title="使用示例工程预览界面，不进行真实录制或导出">界面预览</span>}
    {project && view === 'editor' && <button type="button" className="studio-text-action" aria-label="快捷键速查（F1）" title="Windows 快捷键速查（F1）" aria-haspopup="dialog" onClick={openShortcuts}><LineIcon kind="keyboard" size={16} /></button>}
    <button className="studio-text-action" aria-label={isDark ? '切换到浅色外观' : '切换到深色外观'} title={isDark ? '切换到浅色外观' : '切换到深色外观'} onClick={toggleAppearance}><LineIcon kind={isDark ? 'sun' : 'moon'} size={16} /></button>
    <button className="studio-text-action" aria-label="打开设置" title="设置" onClick={() => setView('settings')}><LineIcon kind="settings" size={16} /></button>
    {project && <><span className="studio-toolbar-divider" /><button className="studio-export" onClick={() => setView('export')}><LineIcon kind="share" size={14} />导出</button></>}
    {apiMode === 'native' && wcs().role === 'main' && <div className="studio-window-controls"><button aria-label="最小化" onClick={() => void wcs().minimize()}><LineIcon kind="minus" size={14} /></button><button aria-label="最大化或还原" onClick={() => void wcs().windowLayout({ mode: 'maximize' })}><LineIcon kind="stop" size={12} /></button><button aria-label="关闭应用" onClick={() => void wcs().close()}><LineIcon kind="close" size={13} /></button></div>}
  </header>{shortcutsOpen && <ShortcutCheatsheet onClose={() => setShortcutsOpen(false)} />}</>;
}
