/**
 * 纯状态推导函数（不依赖 React/DOM，便于直接单测）
 *
 * 这些判断原先散落在 store.tsx / 视图里，一旦写错就会出现
 * 「录制失败仍显示正在录制」「播放头超出时长」「自动保存风暴」等界面级缺陷。
 */

import type { CaptureState } from '@shared/ipc';

/** 这些状态代表会话已结束或失败，界面不应再显示「正在录制」。 */
export const INACTIVE_CAPTURE_STATES: readonly CaptureState[] = [
  'Idle',
  'ReadyToEdit',
  'Cancelled',
  'RecoveryReady',
  'RecoverableFailure',
];

/** 是否处于「录制中」（含倒计时/暂停/收尾等过渡态）。 */
export function isCaptureActive(state: CaptureState | null | undefined): boolean {
  if (!state) return false;
  return !INACTIVE_CAPTURE_STATES.includes(state);
}

/** 播放头合法化：不得为负、不得越过工程时长（duration<=0 时只保证非负）。 */
export function clampTickToDuration(tick: number, duration: number): number {
  if (!Number.isFinite(tick)) return 0;
  const rounded = Math.max(0, Math.round(tick));
  if (Number.isFinite(duration) && duration > 0) return Math.min(rounded, Math.round(duration));
  return rounded;
}

export interface AutoSavePlanInput {
  /** 当前时间（Date.now()） */
  now: number;
  /** 「持续编辑时最晚必须保存」的绝对时刻；null 表示还没有变脏 */
  deadline: number | null;
  /** 上一次自动保存失败后的退避截止时刻；null 表示没有失败 */
  retryAt?: number | null;
  /** 停止编辑多久后保存 */
  idleMs?: number;
  /** 持续编辑时的最长间隔 */
  maxMs?: number;
}

export const AUTO_SAVE_IDLE_MS = 2000;
export const AUTO_SAVE_MAX_MS = 10_000;
/** 自动保存失败后的退避时间：避免失去焦点/磁盘满时每 2 秒弹一次错误。 */
export const AUTO_SAVE_RETRY_MS = 15_000;

/**
 * 计算下一次自动保存的延迟（毫秒，>=0）。
 *
 * 规则：取「空闲去抖」与「最长间隔」的较小值；若刚失败过且仍在退避窗口内，
 * 则延后到退避结束（此时可以超过最长间隔 —— 失败重试必须让位给稳定性）。
 */
export function nextAutoSaveDelay(input: AutoSavePlanInput): number {
  const idleMs = input.idleMs ?? AUTO_SAVE_IDLE_MS;
  const maxMs = input.maxMs ?? AUTO_SAVE_MAX_MS;
  const deadline = input.deadline ?? input.now + maxMs;
  const idleDelay = Math.max(0, Math.min(idleMs, deadline - input.now));
  const retryDelay = input.retryAt != null ? Math.max(0, input.retryAt - input.now) : 0;
  return Math.max(idleDelay, retryDelay);
}

/** 第一次变脏时确定「最晚保存时刻」。 */
export function autoSaveDeadline(now: number, maxMs: number = AUTO_SAVE_MAX_MS): number {
  return now + Math.max(0, maxMs);
}
