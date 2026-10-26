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
  /** 允许在弹窗打开时触发，默认 false，避免修改被遮住的工作区。 */
  allowInModal?: boolean;
  /**
   * 是否响应键盘长按产生的重复事件，默认 false（方向键例外，见 useShortcuts）。
   * 播放/分割/删除这类“开关/一次性动作”响应重复事件会瞬间执行几十次。
   */
  allowRepeat?: boolean;
}

/**
 * 把 KeyboardEvent 归一化成 "ctrl+shift+z" 这种组合串。
 *
 * 注意：空格键的 event.key 是 " "，必须显式映射为 "space"，
 * 否则注册 combo: 'space' 的播放快捷键永远匹配不上（曾导致空格无法播放/暂停）。
 */
export function normalizeShortcutEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.metaKey) parts.push('meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  const raw = event.key;
  let key = raw.toLowerCase();
  if (raw === ' ' || key === 'spacebar') key = 'space';
  // 兼容旧浏览器对 Escape 的两种写法
  else if (key === 'esc') key = 'escape';
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
      const combo = normalizeShortcutEvent(event);
      // 元素自己声明处理的组合键优先（data-keys="arrowleft arrowright"）。
      // 全局监听挂在 document 捕获阶段并 stopPropagation，会拦掉 React 的事件委托，
      // 让时间线片段上的方向键重排永远收不到事件（表现为「按左右键只移动播放头」）。
      const localOwner = (event.target as HTMLElement | null)?.closest?.('[data-keys]');
      if (localOwner) {
        const declared = (localOwner.getAttribute('data-keys') ?? '').split(/\s+/).filter(Boolean);
        if (declared.includes(combo)) return;
      }
      // 原生按钮、链接和 disclosure 用空格/回车操作自己，而不是播放背景视频。
      if ((combo === 'space' || combo === 'enter') &&
          (event.target as HTMLElement | null)?.closest?.('button, a[href], summary')) return;
      const inInput = isTextEntryTarget(event.target);
      const modalOpen = typeof document !== 'undefined' && !!document.querySelector('.wcs-modal-backdrop');
      for (const item of ref.current) {
        if (item.combo !== combo) continue;
        if (inInput && !item.allowInInput) continue;
        if (modalOpen && item.allowInModal !== true) continue;
        // 长按重复：方向键用于连续步进（保留），其余动作只执行一次
        const repeatAllowed = item.allowRepeat ?? item.combo.includes('arrow');
        if (event.repeat && !repeatAllowed) continue;
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

/**
 * 元素尺寸（用于 canvas 等比适配）。
 *
 * 注意：ref 目标常常是条件渲染/延迟挂载的（例如工程未加载时不渲染画布）。
 * 依赖数组为 [] 的旧实现会永远观察不到后来才出现的元素，这里改为每次渲染后
 * 检查节点身份，只在节点变化时重建 ResizeObserver。
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observed = useRef<T | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observed.current = null;
      return;
    }
    if (observed.current === node && observerRef.current) return;
    observerRef.current?.disconnect();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const next = { width: Math.round(width), height: Math.round(height) };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    });
    observer.observe(node);
    observed.current = node;
    observerRef.current = observer;
    // 立即量一次，避免首帧显示 0×0
    const rect = node.getBoundingClientRect();
    setSize((prev) => {
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      return prev.width === next.width && prev.height === next.height ? prev : next;
    });
  });

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observed.current = null;
    },
    [],
  );

  return { ref, size };
}

/** 简单节流（录制状态高频推送时避免界面抖动）。 */
export function useRafValue<T>(value: T, enabled = true): T {
  const [shown, setShown] = useState(value);
  const pending = useRef(value);
  const frame = useRef<number | null>(null);
  pending.current = value;

  useEffect(() => {
    const cancel = () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
    if (!enabled) {
      cancel();
      setShown(value);
      return;
    }
    cancel();
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setShown(pending.current);
    });
    return cancel;
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
