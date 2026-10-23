/**
 * 稳定错误码（开发文档 §14.3）
 *
 * 对外只暴露稳定代码与用户可理解的信息，不把 HRESULT 直接甩给用户。
 * 每个错误都带：是否可重试、是否保留已完成数据。
 */

export const ERROR_CODES = [
  'E_SOURCE_CLOSED',
  'E_CAPTURE_UNSUPPORTED',
  'E_PERMISSION_DENIED',
  'E_AUDIO_DEVICE_LOST',
  'E_ENCODER_UNAVAILABLE',
  'E_GPU_DEVICE_REMOVED',
  'E_DISK_FULL',
  'E_SCHEMA_FUTURE',
  'E_MEDIA_MISSING',
  // 以下为工程/协议层的补充代码，与文档同一命名风格
  'E_PROJECT_NOT_FOUND',
  'E_PROJECT_CORRUPT',
  'E_REVISION_CONFLICT',
  'E_INVALID_COMMAND',
  'E_EXPORT_FAILED',
  'E_EXPORT_CANCELLED',
  'E_UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorShape {
  code: ErrorCode;
  /** 面向用户的简体中文说明 */
  message: string;
  /** 是否值得让用户重试同一操作 */
  retryable: boolean;
  /** 失败后已完成的素材/工程是否仍然保留 */
  preservedData: boolean;
  /** 可选的技术细节，仅写入诊断日志，不直接展示为主文案 */
  detail?: string;
}

export class AppError extends Error implements AppErrorShape {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly preservedData: boolean;
  readonly detail?: string;

  constructor(shape: AppErrorShape) {
    super(shape.message);
    this.name = 'AppError';
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.preservedData = shape.preservedData;
    this.detail = shape.detail;
  }

  toShape(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      preservedData: this.preservedData,
      detail: this.detail,
    };
  }

  static from(unknown: unknown, fallback: ErrorCode = 'E_UNKNOWN'): AppError {
    if (unknown instanceof AppError) return unknown;
    const message = unknown instanceof Error ? unknown.message : String(unknown);
    return new AppError({
      code: fallback,
      message: '操作失败，请重试或查看诊断日志。',
      retryable: true,
      preservedData: true,
      detail: message,
    });
  }
}

export function isAppErrorShape(value: unknown): value is AppErrorShape {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(v.code) &&
    typeof v.message === 'string' &&
    // 这两个布尔标志决定界面如何提示（能否重试、数据是否保留），必须一起校验，
    // 否则一个不完整的外部形状也能被当成 AppErrorShape 透传到界面。
    typeof v.retryable === 'boolean' &&
    typeof v.preservedData === 'boolean'
  );
}

/** 每个错误码的默认呈现策略，界面层可直接复用。 */
export const ERROR_PRESENTATION: Record<ErrorCode, { title: string; retryable: boolean; preservedData: boolean }> = {
  E_SOURCE_CLOSED: { title: '录制来源已关闭', retryable: true, preservedData: true },
  E_CAPTURE_UNSUPPORTED: { title: '当前设备不支持该采集方式', retryable: false, preservedData: true },
  E_PERMISSION_DENIED: { title: '系统拒绝了权限请求', retryable: true, preservedData: true },
  E_AUDIO_DEVICE_LOST: { title: '音频设备已断开', retryable: true, preservedData: true },
  E_ENCODER_UNAVAILABLE: { title: '没有可用的编码器', retryable: true, preservedData: true },
  E_GPU_DEVICE_REMOVED: { title: '显卡设备已重置', retryable: true, preservedData: true },
  E_DISK_FULL: { title: '磁盘空间不足', retryable: true, preservedData: true },
  E_SCHEMA_FUTURE: { title: '工程由更高版本创建', retryable: false, preservedData: true },
  E_MEDIA_MISSING: { title: '素材文件缺失', retryable: true, preservedData: true },
  E_PROJECT_NOT_FOUND: { title: '找不到工程目录', retryable: true, preservedData: false },
  E_PROJECT_CORRUPT: { title: '工程文件损坏', retryable: false, preservedData: true },
  E_REVISION_CONFLICT: { title: '工程已被其他操作修改', retryable: true, preservedData: true },
  E_INVALID_COMMAND: { title: '编辑命令无效', retryable: false, preservedData: true },
  E_EXPORT_FAILED: { title: '导出失败', retryable: true, preservedData: true },
  E_EXPORT_CANCELLED: { title: '导出已取消', retryable: true, preservedData: true },
  E_UNKNOWN: { title: '发生未知错误', retryable: true, preservedData: true },
};
