/**
 * 界面层格式化与错误呈现工具。
 *
 * 错误一律通过 ERROR_PRESENTATION 的稳定中文标题呈现，
 * 不把 HRESULT / 堆栈直接甩给用户（§4.1 R17 / §6.4）。
 */

import { AppError, ERROR_PRESENTATION, isAppErrorShape, type ErrorCode } from '@shared/errors';
import type { IpcResponse } from '@shared/ipc';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** 字节 → 人类可读（1 KB = 1024 B，但显示用 GB 等常见单位）。 */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = unit === 0 ? String(Math.round(value)) : value.toFixed(digits);
  return `${fixed} ${units[unit]}`;
}

/** 比特率 → Mbps / kbps 文本。 */
export function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/** 秒 → “约 2 小时 15 分钟”。 */
export function formatDurationLong(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '不足 1 分钟';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `约 ${Math.max(1, minutes)} 分钟`;
  if (minutes === 0) return `约 ${hours} 小时`;
  return `约 ${hours} 小时 ${minutes} 分钟`;
}

/** 预计可录时长：可用字节 / 每秒写入字节。 */
export function recordableSeconds(freeBytes: number, bytesPerSecond: number): number {
  if (bytesPerSecond <= 0) return 0;
  return Math.max(0, freeBytes / bytesPerSecond);
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 具体日期。 */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(timestamp);
}

export interface PresentedError {
  code: ErrorCode;
  title: string;
  message: string;
  retryable: boolean;
  preservedData: boolean;
  detail?: string;
}

/** 把任意错误（AppError / IPC 错误形状 / 普通异常）转成可展示的中文信息。 */
export function describeError(input: unknown): PresentedError {
  if (isAppErrorShape(input)) {
    const presentation = ERROR_PRESENTATION[input.code] ?? ERROR_PRESENTATION.E_UNKNOWN;
    return {
      code: input.code,
      title: presentation.title,
      message: input.message?.trim() || presentation.title,
      retryable: input.retryable ?? presentation.retryable,
      preservedData: input.preservedData ?? presentation.preservedData,
      detail: (input as { detail?: string }).detail,
    };
  }
  if (input instanceof AppError) {
    const presentation = ERROR_PRESENTATION[input.code] ?? ERROR_PRESENTATION.E_UNKNOWN;
    return {
      code: input.code,
      title: presentation.title,
      message: input.message || presentation.title,
      retryable: input.retryable,
      preservedData: input.preservedData,
      detail: input.detail,
    };
  }
  const message = input instanceof Error ? input.message : typeof input === 'string' ? input : '';
  return {
    code: 'E_UNKNOWN',
    title: ERROR_PRESENTATION.E_UNKNOWN.title,
    message: '操作没有完成，请重试。若反复失败，可在设置页导出诊断日志。',
    retryable: true,
    preservedData: true,
    detail: message,
  };
}

/** 从 IPC 响应取值；失败时抛出带中文信息的 AppError。 */
export function unwrap<T>(response: IpcResponse<T> | undefined | null): T {
  if (!response) {
    throw new AppError({
      code: 'E_UNKNOWN',
      message: '主进程没有返回结果，请重试。',
      retryable: true,
      preservedData: true,
    });
  }
  if (response.ok) {
    if (response.data === undefined) {
      throw new AppError({
        code: 'E_UNKNOWN',
        message: '主进程返回了空结果，请重试。',
        retryable: true,
        preservedData: true,
      });
    }
    return response.data;
  }
  const shape = response.error;
  if (shape && isAppErrorShape(shape)) {
    throw new AppError({
      code: shape.code,
      message: shape.message,
      retryable: shape.retryable,
      preservedData: shape.preservedData,
      detail: (shape as { detail?: string }).detail,
    });
  }
  throw new AppError({
    code: 'E_UNKNOWN',
    message: shape?.message?.trim() || '操作没有完成，请重试。',
    retryable: shape?.retryable ?? true,
    preservedData: shape?.preservedData ?? true,
  });
}

/** 每秒写入字节（视频 + 音频）。 */
export function bytesPerSecond(videoBitrate: number, audioBitrate: number): number {
  return (videoBitrate + audioBitrate) / 8;
}

/** 时间码格式化：优先使用 domain 的 formatDuration。 */
export { formatDuration, formatClock, TICKS_PER_SECOND } from '@domain/timebase';

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * 10_000_000);
}

export function ticksToSeconds(ticks: number): number {
  return ticks / 10_000_000;
}
