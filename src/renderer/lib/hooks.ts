/**
 * 渲染层通用 hooks
 *
 * 关键约定（§6.3）：输入框获得焦点时，剪辑快捷键不能抢走文字输入。
 * 所有全局快捷键都必须先经过 isTextEntryTarget() 判断。
 */

import { useEffect, useRef, useState } from 'react';

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute('role');
  if (role === 'textbox' || role === 'combobox' || role === 'spinbutton') return true;
  return false;
}

/** 当前焦点是否在可输入控件内（也可用于判断是否展示「输入中」提示）。 */
export function hasTextFocus(): boolean {
  if (typeof document === 'undefined') return false;
  return isTextEntryTarget(document.activeElement);
}

export interface ShortcutHandler {
  /** 例如 "ctrl+z"、"ctrl+shift+z"、"space"、"delete"、"ctrl+b"、"arrowleft" */
  combo: string;
  handler: (event: KeyboardEvent) => void;
  /** 允许在输入框内触发（例如 Escape），默认 false */
  allowInInput?: boolean;
  /** 允许在弹窗打开时触发，默认 true */
  allowInModal?: boolean;
}

function normalizeEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

/** 注册一组快捷键；返回注销函数。 */
export function useShortcuts(handlers: ShortcutHandler[], enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = normalizeEvent(event);
      const inInput = isTextEntryTarget(event.target);
      const modalOpen = typeof document !== 'undefined' && !!document.querySelector('.wcs-modal-backdrop');
      for (const item of ref.current) {
        if (item.combo !== combo) continue;
        if (inInput && !item.allowInInput) continue;
        if (modalOpen && item.allowInModal === false) continue;
        event.preventDefault();
        event.stopPropagation();
        item.handler(event);
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}

/** 元素尺寸（用于 canvas 等比适配）。 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/** 简单节流（录制状态高频推送时避免界面抖动）。 */
export function useRafValue<T>(value: T, enabled = true): T {
  const [shown, setShown] = useState(value);
  const pending = useRef(value);
  const frame = useRef<number | null>(null);
  pending.current = value;

  useEffect(() => {
    if (!enabled) {
      setShown(value);
      return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setShown(pending.current);
    });
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [value, enabled]);

  return enabled ? shown : value;
}

/** 复制文本到剪贴板（失败不抛异常）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
