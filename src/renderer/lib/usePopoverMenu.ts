import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from 'react';

/** 弹层和触发按钮声明本地按键，避免播放器先截走方向键、空格和 Escape。 */
export const POPOVER_MENU_KEYS = 'arrowleft arrowright arrowup arrowdown home end escape space enter';
const POPOVER_TRIGGER_KEYS = 'arrowup arrowdown space enter';

export function usePopoverMenu({ open, onOpen, onClose }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onOpen, onClose });
  callbacks.current = { onOpen, onClose };
  const entry = useRef<'selected' | 'last'>('selected');

  const close = useCallback((restoreFocus = true) => {
    callbacks.current.onClose();
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = menuRef.current;
    if (!panel) return;
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const selected = buttons.find(button => button.getAttribute('aria-checked') === 'true');
    const initial = entry.current === 'last' ? buttons.at(-1) : selected ?? buttons[0];
    entry.current = 'selected';
    (initial ?? panel).focus();

    const onOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const onWindowBlur = () => close(false);
    document.addEventListener('pointerdown', onOutsidePointer, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open, close]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    entry.current = event.key === 'ArrowUp' ? 'last' : 'selected';
    callbacks.current.onOpen();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // 先将焦点还给触发按钮，再让浏览器执行正常的 Tab/Shift+Tab 导航。
      close();
      return;
    }
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!buttons.length) return;
    const index = buttons.findIndex(button => button === document.activeElement);
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': next = (index + 1) % buttons.length; break;
      case 'ArrowLeft':
      case 'ArrowUp': next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length; break;
      case 'Home': next = 0; break;
      case 'End': next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  // Once closed, Escape belongs to the editor again (for example, exit focus view).
  const triggerKeys = open ? POPOVER_MENU_KEYS : POPOVER_TRIGGER_KEYS;
  return { id, triggerRef, menuRef, triggerKeys, close, onTriggerKeyDown, onMenuKeyDown };
}
