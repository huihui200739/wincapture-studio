import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { contextMenuPosition } from '../lib/contextMenu';
import { normalizeShortcutEvent } from '../lib/hooks';
import { Icon, type IconName } from './ui';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  keys?: string[];
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onSelect: () => void;
}

export function ContextMenu({ anchor, label, items, hint, onClose, onSelect }: {
  anchor: { x: number; y: number };
  label: string;
  items: ContextMenuItem[];
  hint?: string;
  onClose: (restoreFocus: boolean) => void;
  onSelect: (item: ContextMenuItem) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setPosition(contextMenuPosition(anchor.x, anchor.y, box.width, box.height, window.innerWidth, window.innerHeight));
    (node.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? node).focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) closeRef.current(false);
    };
    const dismiss = () => closeRef.current(false);
    const onScroll = (event: Event) => {
      if (event.target !== document && !panel.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  const keys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end', 'escape', 'space', 'enter', ...items.flatMap(item => item.keys ?? [])];
  return createPortal(
    <div ref={panel} className="wcs-context-menu" role="menu" aria-label={label} tabIndex={-1}
      style={position} data-keys={keys.join(' ')}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); onClose(true); return;
        }
        if (event.key === 'Tab') { onClose(true); return; }
        const combo = normalizeShortcutEvent(event.nativeEvent);
        const command = items.find(item => item.keys?.includes(combo));
        if (command) {
          event.preventDefault(); event.stopPropagation();
          if (!command.disabled && !event.repeat) onSelect(command);
          return;
        }
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let next: number;
        if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
        else if (event.key === 'ArrowUp') next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
      }}>
      <div className="context-menu-heading">{label}</div>
      {items.map(item => <div key={item.id}>
        {item.separator && <div className="context-menu-divider" role="separator" />}
        <button type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
          className={item.danger ? 'is-danger' : undefined} aria-label={item.label}
          onClick={() => onSelect(item)}>
          <Icon name={item.icon} size={14} /><span>{item.label}</span>
          {item.shortcut && <kbd aria-hidden="true">{item.shortcut}</kbd>}
        </button>
      </div>)}
      {hint && <p className="context-menu-hint">{hint}</p>}
    </div>, document.body,
  );
}
