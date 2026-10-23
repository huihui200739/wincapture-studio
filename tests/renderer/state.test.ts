/**
 * 纯状态推导测试
 *
 * 对应缺陷：
 * - RecoverableFailure 被当成「正在录制」，顶栏显示不存在的录制计时；
 * - 删除片段后播放头停在工程时长之外；
 * - 自动保存失败后每 2 秒重试并弹一次错误（提示风暴）。
 */

import { describe, expect, it } from 'vitest';
import { normalizeShortcutEvent } from '../../src/renderer/lib/hooks';
import {
  AUTO_SAVE_IDLE_MS,
  AUTO_SAVE_MAX_MS,
  INACTIVE_CAPTURE_STATES,
  autoSaveDeadline,
  clampTickToDuration,
  isCaptureActive,
  nextAutoSaveDelay,
} from '../../src/renderer/lib/state';

describe('isCaptureActive', () => {
  it.each(INACTIVE_CAPTURE_STATES)('结束态 %s 不显示为录制中', (state) => {
    expect(isCaptureActive(state)).toBe(false);
  });

  it.each(['Preparing', 'Countdown', 'Recording', 'Pausing', 'Paused', 'Resuming', 'Stopping', 'Finalizing'] as const)(
    '过渡态 %s 视为录制中',
    (state) => {
      expect(isCaptureActive(state)).toBe(true);
    },
  );

  it('没有状态时返回 false', () => {
    expect(isCaptureActive(null)).toBe(false);
    expect(isCaptureActive(undefined)).toBe(false);
  });
});

describe('clampTickToDuration', () => {
  it('负数与 NaN 归零', () => {
    expect(clampTickToDuration(-5, 100)).toBe(0);
    expect(clampTickToDuration(Number.NaN, 100)).toBe(0);
  });

  it('超过时长时夹到结尾', () => {
    expect(clampTickToDuration(120, 100)).toBe(100);
    expect(clampTickToDuration(42.4, 100)).toBe(42);
  });

  it('时长为 0（未打开工程）时只保证非负', () => {
    expect(clampTickToDuration(30, 0)).toBe(30);
  });
});

describe('nextAutoSaveDelay', () => {
  it('普通情况取空闲去抖 2 秒', () => {
    const now = 1_000_000;
    const deadline = autoSaveDeadline(now);
    expect(nextAutoSaveDelay({ now, deadline })).toBe(AUTO_SAVE_IDLE_MS);
  });

  it('接近最长间隔时提前保存（不超过 10 秒）', () => {
    const now = 1_000_000;
    expect(nextAutoSaveDelay({ now, deadline: now + 500 })).toBe(500);
    expect(AUTO_SAVE_MAX_MS).toBe(10_000);
  });

  it('最长间隔已过期时立即保存', () => {
    const now = 1_000_000;
    expect(nextAutoSaveDelay({ now, deadline: now - 1 })).toBe(0);
  });

  it('失败退避窗口内延后到退避结束（即使超过最长间隔）', () => {
    const now = 1_000_000;
    expect(nextAutoSaveDelay({ now, deadline: now + 10_000, retryAt: now + 15_000 })).toBe(15_000);
    expect(nextAutoSaveDelay({ now, deadline: now + 10_000, retryAt: now - 5 })).toBe(AUTO_SAVE_IDLE_MS);
  });

  it('deadline 缺省时按最长间隔计算', () => {
    const now = 500;
    expect(nextAutoSaveDelay({ now, deadline: null })).toBe(AUTO_SAVE_IDLE_MS);
  });
});

describe('normalizeShortcutEvent', () => {
  const event = (key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ key, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent;

  it('空格映射成 space（回归：旧实现产生 " "，EditorView 的 combo: "space" 永远不触发）', () => {
    expect(normalizeShortcutEvent(event(' '))).toBe('space');
    expect(normalizeShortcutEvent(event('Spacebar'))).toBe('space');
  });

  it('方向键与组合键统一小写', () => {
    expect(normalizeShortcutEvent(event('ArrowLeft'))).toBe('arrowleft');
    expect(normalizeShortcutEvent(event('Z', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+z');
    expect(normalizeShortcutEvent(event('s', { ctrlKey: true }))).toBe('ctrl+s');
  });

  it('Escape 兼容 esc 写法', () => {
    expect(normalizeShortcutEvent(event('Escape'))).toBe('escape');
    expect(normalizeShortcutEvent(event('Esc'))).toBe('escape');
  });
});
