/**
 * 渲染层本地设置（采集默认值、窗口置顶、上次选择的目录）
 *
 * 边界：这里只保存**与工程内容无关的界面偏好**。工程数据（Project）一律
 * 通过工程文件与主进程持久化，绝不允许写进 localStorage —— 否则会出现
 * 「示例数据/本地缓存被当成真实工程」的泄漏路径。
 *
 * 本模块刻意不依赖 DOM/React，便于在 node 环境下用假 storage 直接单测。
 */

import type { CaptureConfig } from '@shared/ipc';
import { QUALITY_PROFILES } from '@shared/ipc';

/** 设置页可调的采集默认值（工程无关）。 */
export interface CaptureDefaults {
  backend?: CaptureConfig['backend'];
  scaling?: CaptureConfig['scaling'];
  qualityId: string;
  countdownSeconds: number;
  systemAudioEnabled: boolean;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
}

export interface PersistedSettings {
  version: 1;
  captureDefaults: CaptureDefaults;
  /** 主窗口置顶（重启后恢复） */
  alwaysOnTop: boolean;
  /** 用户选择的录制存储目录；由采集流程在其下创建独立工程。 */
  lastDirectory: string | null;
  exportDirectory?: string | null;
  appearance?: 'light' | 'dark' | 'system';
  motion?: 'system' | 'reduced';
  exportSound?: boolean;
}

export const SETTINGS_STORAGE_KEY = 'wcs.renderer.settings.v1';

const QUALITY_IDS = new Set(QUALITY_PROFILES.map((profile) => profile.id));

export const DEFAULT_CAPTURE_DEFAULTS: CaptureDefaults = {
  backend: 'auto',
  scaling: 'quality',
  qualityId: '1080p30',
  countdownSeconds: 3,
  systemAudioEnabled: true,
  microphoneEnabled: true,
  cameraEnabled: true,
};

export const DEFAULT_SETTINGS: PersistedSettings = {
  version: 1,
  captureDefaults: DEFAULT_CAPTURE_DEFAULTS,
  alwaysOnTop: false,
  lastDirectory: null,
  exportDirectory: null,
  appearance: 'light',
  motion: 'system',
  exportSound: true,
};

/** 只依赖 getItem/setItem 的最小存储面，便于测试注入。 */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SettingsStorage | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    // 某些环境下访问 localStorage 会抛 SecurityError（禁用存储），退化为不持久化
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 把任意持久化输入规整成合法默认值。
 * 旧版本/被人工改坏的设置不能导致应用启动失败或使用非法画质档位。
 */
export function normalizeCaptureDefaults(raw: unknown): CaptureDefaults {
  const source = asRecord(raw);
  const qualityId =
    typeof source.qualityId === 'string' && QUALITY_IDS.has(source.qualityId)
      ? source.qualityId
      : DEFAULT_CAPTURE_DEFAULTS.qualityId;
  const countdownRaw = Number(source.countdownSeconds);
  const countdownSeconds = Number.isFinite(countdownRaw)
    ? Math.min(10, Math.max(0, Math.round(countdownRaw)))
    : DEFAULT_CAPTURE_DEFAULTS.countdownSeconds;
  return {
    qualityId,
    backend: source.backend === 'wgc' || source.backend === 'compatibility' ? source.backend : 'auto',
    scaling: source.scaling === 'performance' ? 'performance' : 'quality',
    countdownSeconds,
    systemAudioEnabled: boolOr(source.systemAudioEnabled, DEFAULT_CAPTURE_DEFAULTS.systemAudioEnabled),
    microphoneEnabled: boolOr(source.microphoneEnabled, DEFAULT_CAPTURE_DEFAULTS.microphoneEnabled),
    cameraEnabled: boolOr(source.cameraEnabled, DEFAULT_CAPTURE_DEFAULTS.cameraEnabled),
  };
}

export function normalizeSettings(raw: unknown): PersistedSettings {
  const source = asRecord(raw);
  const lastDirectory = typeof source.lastDirectory === 'string' && source.lastDirectory.trim() ? source.lastDirectory : null;
  return {
    version: 1,
    captureDefaults: normalizeCaptureDefaults(source.captureDefaults),
    alwaysOnTop: boolOr(source.alwaysOnTop, false),
    lastDirectory,
    exportDirectory: typeof source.exportDirectory === 'string' ? source.exportDirectory : null,
    appearance: source.appearance === 'dark' || source.appearance === 'system' ? source.appearance : 'light',
    motion: source.motion === 'reduced' ? 'reduced' : 'system',
    exportSound: boolOr(source.exportSound, true),
  };
}

/** 读取本地设置；没有/损坏/不可用时返回默认值（不抛异常）。 */
export function loadSettings(storage: SettingsStorage | null = defaultStorage()): PersistedSettings {
  if (!storage) return { ...DEFAULT_SETTINGS, captureDefaults: { ...DEFAULT_CAPTURE_DEFAULTS } };
  try {
    const text = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!text) return { ...DEFAULT_SETTINGS, captureDefaults: { ...DEFAULT_CAPTURE_DEFAULTS } };
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS, captureDefaults: { ...DEFAULT_CAPTURE_DEFAULTS } };
  }
}

/** 合并写入本地设置；失败只降级为「本次不持久化」，不影响界面。 */
export function saveSettings(
  patch: Partial<Omit<PersistedSettings, 'version'>>,
  storage: SettingsStorage | null = defaultStorage(),
): PersistedSettings {
  const current = loadSettings(storage);
  const next: PersistedSettings = {
    version: 1,
    captureDefaults: normalizeCaptureDefaults({ ...current.captureDefaults, ...(patch.captureDefaults ?? {}) }),
    alwaysOnTop: patch.alwaysOnTop ?? current.alwaysOnTop,
    lastDirectory: patch.lastDirectory === undefined ? current.lastDirectory : patch.lastDirectory,
    exportDirectory: patch.exportDirectory === undefined ? current.exportDirectory : patch.exportDirectory,
    appearance: patch.appearance ?? current.appearance,
    motion: patch.motion ?? current.motion,
    exportSound: patch.exportSound ?? current.exportSound,
  };
  if (storage) {
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('wcs-settings-change'));
    } catch {
      // 存储配额/权限问题不阻塞使用
    }
  }
  return next;
}

/** 由默认值构造完整采集配置（sourceId 属于会话临时状态，不持久化）。 */
export function captureConfigFromDefaults(defaults: CaptureDefaults): CaptureConfig {
  const profile = QUALITY_PROFILES.find((item) => item.id === defaults.qualityId) ?? QUALITY_PROFILES[1];
  return {
    sourceId: '',
    sourceKind: 'screen',
    backend: defaults.backend ?? 'auto',
    scaling: defaults.scaling ?? 'quality',
    qualityId: profile.id,
    fps: { num: profile.fps, den: 1 },
    systemAudioEnabled: defaults.systemAudioEnabled,
    microphoneEnabled: defaults.microphoneEnabled,
    cameraEnabled: defaults.cameraEnabled,
    countdownSeconds: defaults.countdownSeconds,
  };
}

export function captureDefaultsOf(config: CaptureConfig): CaptureDefaults {
  return {
    backend: config.backend ?? 'auto',
    scaling: config.scaling ?? 'quality',
    qualityId: config.qualityId,
    countdownSeconds: config.countdownSeconds,
    systemAudioEnabled: config.systemAudioEnabled,
    microphoneEnabled: config.microphoneEnabled,
    cameraEnabled: config.cameraEnabled,
  };
}

/**
 * 合并一次配置补丁，并保证派生字段一致：
 * - 选画质档位时，fps 必须跟着档位走（否则会出现「1080p60 档位 + 30fps」的错配录制）；
 * - 倒计时夹到 0..10 秒，避免 0/负数或 NaN 造成录制流程异常。
 */
export function mergeCaptureConfig(previous: CaptureConfig, patch: Partial<CaptureConfig>): CaptureConfig {
  const next: CaptureConfig = { ...previous, ...patch };
  // 只有显式切换画质档位时才派生 fps；单独改 fps（若有调用方）应被尊重。
  if (patch.qualityId !== undefined) {
    const profile = QUALITY_PROFILES.find((item) => item.id === patch.qualityId);
    if (profile) {
      next.qualityId = profile.id;
      next.fps = patch.fps ?? { num: profile.fps, den: 1 };
    } else {
      next.qualityId = previous.qualityId;
      next.fps = patch.fps ?? previous.fps;
    }
  }
  const countdown = Number(next.countdownSeconds);
  next.countdownSeconds = Number.isFinite(countdown) ? Math.min(10, Math.max(0, Math.round(countdown))) : 3;
  return next;
}
