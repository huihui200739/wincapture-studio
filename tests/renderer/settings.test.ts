/**
 * 渲染层本地设置测试
 *
 * 覆盖：损坏/旧版设置的回退、画质档位与 fps 的派生一致性、持久化往返。
 * 对应缺陷：设置页只改 qualityId 不改 fps，导致「1080p60 档位 + 30fps」错配录制。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_DEFAULTS,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  captureConfigFromDefaults,
  loadSettings,
  mergeCaptureConfig,
  normalizeCaptureDefaults,
  saveSettings,
  type SettingsStorage,
} from '../../src/renderer/lib/settings';

function memoryStorage(seed?: Record<string, string>): SettingsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('normalizeCaptureDefaults', () => {
  it('persists capture backend and scaling without accepting invalid modes', () => {
    const storage = memoryStorage();
    const captureDefaults = { ...DEFAULT_CAPTURE_DEFAULTS, backend: 'compatibility' as const, scaling: 'performance' as const };
    saveSettings({ captureDefaults }, storage);
    const config = captureConfigFromDefaults(loadSettings(storage).captureDefaults);
    expect(config.backend).toBe('compatibility'); expect(config.scaling).toBe('performance');
    expect(normalizeCaptureDefaults({ backend: 'unsafe', scaling: 'unsafe' })).toMatchObject({ backend: 'auto', scaling: 'quality' });
  });
  it('非对象输入回退默认值', () => {
    expect(normalizeCaptureDefaults(undefined)).toEqual(DEFAULT_CAPTURE_DEFAULTS);
    expect(normalizeCaptureDefaults('oops')).toEqual(DEFAULT_CAPTURE_DEFAULTS);
  });

  it('未知画质档位回退到 1080p30，而不是留下非法 id', () => {
    const normalized = normalizeCaptureDefaults({ qualityId: '8K999' });
    expect(normalized.qualityId).toBe('1080p30');
  });

  it('倒计时夹到 0..10 的整数', () => {
    expect(normalizeCaptureDefaults({ countdownSeconds: -5 }).countdownSeconds).toBe(0);
    expect(normalizeCaptureDefaults({ countdownSeconds: 99 }).countdownSeconds).toBe(10);
    expect(normalizeCaptureDefaults({ countdownSeconds: 2.6 }).countdownSeconds).toBe(3);
    expect(normalizeCaptureDefaults({ countdownSeconds: 'abc' }).countdownSeconds).toBe(3);
  });

  it('布尔字段类型错误时回退默认值', () => {
    const normalized = normalizeCaptureDefaults({ systemAudioEnabled: 'yes', microphoneEnabled: 0 });
    expect(normalized.systemAudioEnabled).toBe(true);
    expect(normalized.microphoneEnabled).toBe(true);
  });
});

describe('loadSettings', () => {
  it('旧设置迁移后保留采集选项，并为外观和动效提供默认值', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ captureDefaults: { qualityId: '720p30' }, lastDirectory: 'D:\\Recordings' }) });
    expect(loadSettings(storage)).toMatchObject({ captureDefaults: { qualityId: '720p30' }, lastDirectory: 'D:\\Recordings', appearance: 'light', motion: 'system', exportSound: true });
  });
  it('修改外观不会覆盖用户的导出目录与录制默认值', () => {
    const storage = memoryStorage();
    saveSettings({ exportDirectory: 'D:\\Exports', captureDefaults: { ...DEFAULT_CAPTURE_DEFAULTS, qualityId: '1080p60' } }, storage);
    saveSettings({ appearance: 'dark', motion: 'reduced', exportSound: false }, storage);
    expect(loadSettings(storage)).toMatchObject({ exportDirectory: 'D:\\Exports', captureDefaults: { qualityId: '1080p60' }, appearance: 'dark', motion: 'reduced', exportSound: false });
  });
  it('没有存储时返回默认设置', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('损坏 JSON 不抛异常，回退默认设置', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: '{not-json' });
    expect(loadSettings(storage).captureDefaults).toEqual(DEFAULT_CAPTURE_DEFAULTS);
  });

  it('读取被人工改坏的字段时逐项回退', () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        captureDefaults: { qualityId: 'nope', countdownSeconds: 4, systemAudioEnabled: false },
        alwaysOnTop: 'yes',
        lastDirectory: 42,
      }),
    });
    const settings = loadSettings(storage);
    expect(settings.captureDefaults.qualityId).toBe('1080p30');
    expect(settings.captureDefaults.countdownSeconds).toBe(4);
    expect(settings.captureDefaults.systemAudioEnabled).toBe(false);
    expect(settings.alwaysOnTop).toBe(false);
    expect(settings.lastDirectory).toBeNull();
  });
});

describe('saveSettings', () => {
  it('往返持久化并保留未修改字段', () => {
    const storage = memoryStorage();
    saveSettings(
      {
        captureDefaults: {
          qualityId: '720p30',
          countdownSeconds: 5,
          systemAudioEnabled: true,
          microphoneEnabled: false,
          cameraEnabled: true,
        },
      },
      storage,
    );
    const loaded = loadSettings(storage);
    expect(loaded.captureDefaults.qualityId).toBe('720p30');
    expect(loaded.captureDefaults.countdownSeconds).toBe(5);
    expect(loaded.captureDefaults.microphoneEnabled).toBe(false);

    saveSettings({ alwaysOnTop: true }, storage);
    expect(loadSettings(storage).alwaysOnTop).toBe(true);
    expect(loadSettings(storage).captureDefaults.qualityId).toBe('720p30');
  });

  it('存储抛异常时降级为不持久化，不向上抛', () => {
    const broken: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveSettings({ alwaysOnTop: true }, broken)).not.toThrow();
  });
});

describe('mergeCaptureConfig', () => {
  const base = captureConfigFromDefaults(DEFAULT_CAPTURE_DEFAULTS);

  it('切换画质档位时同步 fps（避免档位与帧率错配）', () => {
    const next = mergeCaptureConfig(base, { qualityId: '1080p60' });
    expect(next.qualityId).toBe('1080p60');
    expect(next.fps).toEqual({ num: 60, den: 1 });
  });

  it('非法画质档位被忽略，保留原档位与 fps', () => {
    const next = mergeCaptureConfig(base, { qualityId: 'invalid' });
    expect(next.qualityId).toBe(base.qualityId);
    expect(next.fps).toEqual(base.fps);
  });

  it('单独更新 fps（不带 qualityId）时不被画质档位覆盖', () => {
    const next = mergeCaptureConfig(base, { fps: { num: 24, den: 1 } });
    expect(next.fps).toEqual({ num: 24, den: 1 });
    expect(next.qualityId).toBe(base.qualityId);
  });

  it('只切换来源时保留其它设置', () => {
    const next = mergeCaptureConfig(base, { sourceId: 'src-1', sourceKind: 'window' });
    expect(next.sourceId).toBe('src-1');
    expect(next.sourceKind).toBe('window');
    expect(next.qualityId).toBe(base.qualityId);
  });

  it('倒计时保持 0..10 合法', () => {
    expect(mergeCaptureConfig(base, { countdownSeconds: -3 }).countdownSeconds).toBe(0);
    expect(mergeCaptureConfig(base, { countdownSeconds: 30 }).countdownSeconds).toBe(10);
    expect(mergeCaptureConfig(base, { countdownSeconds: Number.NaN }).countdownSeconds).toBe(3);
  });
});
