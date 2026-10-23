/**
 * 内置示例工程（mock 模式）
 *
 * wp-a-capture 的 window.wcs 尚未就绪时，界面用这份示例工程独立跑起来。
 * 数据结构严格遵循 src/domain/project.ts，可直接被 evaluateScene / drawScene 消费，
 * 因此预览、时间线、属性面板走的都是真实代码路径。
 */

import type {
  AudioDeviceInfo,
  CaptureSourceInfo,
  DisplayInfo,
  QualityProfile,
  RecentProject,
  RecoverableSession,
  SystemInfo,
  VideoDeviceInfo,
} from '@shared/ipc';
import { QUALITY_PROFILES } from '@shared/ipc';
import type { Project } from '@domain/project';
import { createEmptyProject, DEFAULT_VARIANTS, PROJECT_SCHEMA_VERSION } from '@domain/project';
import { makeFrameRate, secondsToTicks, TICKS_PER_SECOND } from '@domain/timebase';
import type { Effect } from '@domain/project';
import { syntheticThumbnail } from './syntheticMedia';

const S = TICKS_PER_SECOND;

export const MOCK_PROJECT_PATH = 'C:\\Users\\huihui\\Documents\\WinCapture\\演示工程.wcaproj';

/** 构造示例工程：30 秒屏幕 + 摄像头 + 双音轨，带运镜、遮挡与教程步骤。 */
export function createMockProject(now = Date.now()): Project {
  const project = createEmptyProject('demo-project-0001', '演示工程 · 新建客户流程', now);
  project.schemaVersion = PROJECT_SCHEMA_VERSION;
  project.revision = 12;
  project.updatedAt = now;
  project.settings.fps = makeFrameRate(30, 1);
  project.settings.activeVariantId = 'landscape';

  const screenDuration = 30 * S;

  project.assets = [
    {
      id: 'asset-screen-1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'a3f19c2b7d4e5061',
      durationTicks: screenDuration,
      width: 1600,
      height: 900,
      sampleRate: 0,
      channels: 0,
      createdAt: now,
    },
    {
      id: 'asset-camera-1',
      kind: 'camera',
      path: 'media/camera/seg-000001.mp4',
      hash: 'b71e44a90c3d2f18',
      durationTicks: screenDuration,
      width: 640,
      height: 480,
      sampleRate: 0,
      channels: 0,
      createdAt: now,
    },
    {
      id: 'asset-mic-1',
      kind: 'mic',
      path: 'media/mic/seg-000001.wav',
      hash: 'c2d8f0a15b6e7349',
      durationTicks: screenDuration,
      width: 0,
      height: 0,
      sampleRate: 48000,
      channels: 2,
      createdAt: now,
    },
    {
      id: 'asset-system-1',
      kind: 'system',
      path: 'media/system/seg-000001.wav',
      hash: 'd9e0b1c47a2f8856',
      durationTicks: screenDuration,
      width: 0,
      height: 0,
      sampleRate: 48000,
      channels: 2,
      createdAt: now,
    },
  ];

  // 主轨：前 12 秒 + 后 18 秒（中间有一次分割，体现时间线上有多个片段）
  const main = project.tracks.find((t) => t.kind === 'primaryVideo')!;
  main.clips = [
    {
      id: 'clip-main-1',
      assetId: 'asset-screen-1',
      sourceInTicks: 0,
      sourceDurationTicks: 12 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'group-a',
    },
    {
      id: 'clip-main-2',
      assetId: 'asset-screen-1',
      sourceInTicks: 12 * S,
      sourceDurationTicks: 18 * S,
      timelineInTicks: 12 * S,
      rate: { num: 1, den: 1 },
      linkGroupId: 'group-b',
    },
  ];

  const camera = project.tracks.find((t) => t.kind === 'camera')!;
  camera.clips = [
    {
      id: 'clip-cam-1',
      assetId: 'asset-camera-1',
      sourceInTicks: 0,
      sourceDurationTicks: 12 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'group-a',
    },
    {
      id: 'clip-cam-2',
      assetId: 'asset-camera-1',
      sourceInTicks: 12 * S,
      sourceDurationTicks: 18 * S,
      timelineInTicks: 12 * S,
      rate: { num: 1, den: 1 },
      linkGroupId: 'group-b',
    },
  ];

  const mic = project.tracks.find((t) => t.kind === 'mic')!;
  mic.clips = [
    {
      id: 'clip-mic-1',
      assetId: 'asset-mic-1',
      sourceInTicks: 0,
      sourceDurationTicks: 30 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'group-audio',
    },
  ];
  mic.gain = 0.86;

  const system = project.tracks.find((t) => t.kind === 'system')!;
  system.clips = [
    {
      id: 'clip-sys-1',
      assetId: 'asset-system-1',
      sourceInTicks: 0,
      sourceDurationTicks: 30 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'group-audio',
    },
  ];
  system.gain = 0.42;
  system.muted = false;

  const zoomEffects: Effect[] = [
    {
      id: 'zoom-auto-1',
      kind: 'zoom',
      range: { start: secondsToTicks(2.4), end: secondsToTicks(7.2) },
      parameters: {
        scale: 1.7,
        focusX: 0.34,
        focusY: 0.42,
        easeInTicks: secondsToTicks(0.45),
        easeOutTicks: secondsToTicks(0.5),
        focusSource: 'control',
      },
      origin: 'automatic',
      locked: false,
    },
    {
      id: 'zoom-manual-1',
      kind: 'zoom',
      range: { start: secondsToTicks(14.5), end: secondsToTicks(21) },
      parameters: {
        scale: 2.1,
        focusX: 0.52,
        focusY: 0.46,
        easeInTicks: secondsToTicks(0.6),
        easeOutTicks: secondsToTicks(0.7),
        focusSource: 'manual',
      },
      origin: 'manual',
      locked: true,
    },
  ];

  const privacyEffects: Effect[] = [
    {
      id: 'privacy-1',
      kind: 'privacy',
      range: { start: secondsToTicks(6), end: secondsToTicks(16) },
      anchor: 'screen',
      parameters: {
        x: 0.262,
        y: 0.285,
        width: 0.2,
        height: 0.045,
        anchor: 'screen',
        style: 'solid',
        confirmed: true,
      },
      origin: 'manual',
      locked: true,
    },
    {
      id: 'privacy-2',
      kind: 'privacy',
      range: { start: secondsToTicks(6), end: secondsToTicks(16) },
      anchor: 'screen',
      parameters: {
        x: 0.262,
        y: 0.372,
        width: 0.185,
        height: 0.045,
        anchor: 'screen',
        style: 'blur',
        confirmed: false,
        candidateId: 'cand-02',
      },
      origin: 'manual',
      locked: false,
    },
  ];

  project.effects = [...zoomEffects, ...privacyEffects];
  project.privacyVersion = 3;

  project.markers = [
    { id: 'marker-1', mediaTick: secondsToTicks(2.6), note: '打开新建客户表单', createdAt: now - 600000 },
    { id: 'marker-2', mediaTick: secondsToTicks(9.4), note: '填写联系人信息', createdAt: now - 580000 },
    { id: 'marker-3', mediaTick: secondsToTicks(15.2), note: '选择客户等级', createdAt: now - 560000 },
    { id: 'marker-4', mediaTick: secondsToTicks(24.8), note: '保存并返回列表', createdAt: now - 540000 },
  ];

  project.steps = [
    {
      id: 'step-1',
      sourceRange: { start: secondsToTicks(2.6), end: secondsToTicks(8.2) },
      title: '打开新建客户表单',
      description: '在左侧导航选择「新建客户」，主区域会切换为空白客户档案表单。',
      imageTick: secondsToTicks(3.6),
      actionRect: { x: 0.02, y: 0.19, width: 0.12, height: 0.04 },
      source: 'marker',
      privacyVersion: 3,
    },
    {
      id: 'step-2',
      sourceRange: { start: secondsToTicks(9.4), end: secondsToTicks(15) },
      title: '填写联系人信息',
      description: '依次填写客户名称、联系人与联系方式；邮箱和手机号属于敏感信息，导出前请确认遮挡范围。',
      imageTick: secondsToTicks(10.6),
      actionRect: { x: 0.24, y: 0.28, width: 0.24, height: 0.05 },
      source: 'marker',
      privacyVersion: 3,
    },
    {
      id: 'step-3',
      sourceRange: { start: secondsToTicks(15.2), end: secondsToTicks(21) },
      title: '选择客户等级',
      description: '按业务重要度选择「普通 / 重要 / 战略」，示例中选择「重要」。',
      imageTick: secondsToTicks(16.4),
      actionRect: { x: 0.24, y: 0.47, width: 0.19, height: 0.05 },
      source: 'marker',
      privacyVersion: 3,
    },
    {
      id: 'step-4',
      sourceRange: { start: secondsToTicks(24.8), end: secondsToTicks(29.4) },
      title: '保存并返回列表',
      description: '点击「保存并关闭」，新客户会出现在列表首行。',
      imageTick: secondsToTicks(25.9),
      actionRect: { x: 0.72, y: 0.82, width: 0.08, height: 0.045 },
      source: 'marker',
      privacyVersion: 3,
    },
  ];

  project.variants = DEFAULT_VARIANTS.map((v) => ({ ...v, layoutOverrides: { ...v.layoutOverrides } }));
  return project;
}

export function mockRecentProjects(now = Date.now()): RecentProject[] {
  return [
    {
      id: 'demo-project-0001',
      name: '演示工程 · 新建客户流程',
      path: MOCK_PROJECT_PATH,
      updatedAt: now - 1000 * 60 * 26,
      durationTicks: 30 * S,
      thumbnail: syntheticThumbnail('screen'),
      missingMedia: false,
      recoverable: false,
    },
    {
      id: 'demo-project-0002',
      name: '季度报表讲解 · 16:9',
      path: 'C:\\Users\\huihui\\Documents\\WinCapture\\季度报表讲解.wcaproj',
      updatedAt: now - 1000 * 60 * 60 * 20,
      durationTicks: 4 * 60 * S + 12 * S,
      thumbnail: syntheticThumbnail('window', 1),
      missingMedia: false,
      recoverable: false,
    },
    {
      id: 'demo-project-0003',
      name: '竖屏短视频 · 三步上手',
      path: 'C:\\Users\\huihui\\Documents\\WinCapture\\竖屏短视频.wcaproj',
      updatedAt: now - 1000 * 60 * 60 * 24 * 3,
      durationTicks: 58 * S,
      thumbnail: syntheticThumbnail('window', 2),
      missingMedia: true,
      recoverable: false,
    },
  ];
}

export function mockRecoverable(now = Date.now()): RecoverableSession[] {
  return [
    {
      projectPath: 'C:\\Users\\huihui\\Documents\\WinCapture\\未完成录制-20261021.wcaproj',
      sessionId: 'session-8f3a2c',
      name: '未完成录制 · 2026-10-21 22:14',
      createdAt: now - 1000 * 60 * 60 * 3,
      committedSegments: 27,
      durationTicks: 54 * S,
      estimatedLossTicks: secondsToTicks(1.8),
    },
  ];
}

export function mockSystemInfo(): SystemInfo {
  return {
    platform: 'win32',
    arch: 'x64',
    osVersion: 'Windows 11 24H2 (26100.2314)',
    electronVersion: '45.0.0',
    chromeVersion: '138.0.7204.101',
    appVersion: '0.1.0',
    totalMemoryBytes: 32 * 1024 ** 3,
    freeMemoryBytes: 18.4 * 1024 ** 3,
    userDataPath: 'C:\\Users\\huihui\\AppData\\Roaming\\WinCapture Studio',
    videosPath: 'C:\\Users\\huihui\\Videos\\WinCapture Studio',
    hardwareEncoding: true,
    captureCapabilities: {
      screen: true,
      window: true,
      systemAudio: true,
      microphone: true,
      camera: true,
      applicationAudio: false,
    },
  };
}

export function mockQualityProfiles(): QualityProfile[] {
  return QUALITY_PROFILES.map((p) => ({ ...p }));
}

export function mockDisplays(): DisplayInfo[] {
  return [
    {
      id: 'display-1',
      label: '显示器 1 · 主显示器',
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.5,
      isPrimary: true,
      rotation: 0,
      refreshRate: 165,
    },
    {
      id: 'display-2',
      label: '显示器 2 · DELL U2720Q',
      bounds: { x: 2560, y: 0, width: 3840, height: 2160 },
      scaleFactor: 1,
      isPrimary: false,
      rotation: 0,
      refreshRate: 60,
    },
  ];
}

export function mockSources(): CaptureSourceInfo[] {
  return [
    {
      id: 'src-screen-1',
      kind: 'screen',
      name: '显示器 1 · 2560 × 1440',
      thumbnail: syntheticThumbnail('screen'),
      displayId: 'display-1',
      width: 2560,
      height: 1440,
      available: true,
    },
    {
      id: 'src-screen-2',
      kind: 'screen',
      name: '显示器 2 · 3840 × 2160',
      thumbnail: syntheticThumbnail('screen', 1),
      displayId: 'display-2',
      width: 3840,
      height: 2160,
      available: true,
    },
    {
      id: 'src-window-1',
      kind: 'window',
      name: 'Contoso 客户管理 — 新建客户',
      thumbnail: syntheticThumbnail('window', 1),
      width: 1600,
      height: 900,
      available: true,
    },
    {
      id: 'src-window-2',
      kind: 'window',
      name: 'Visual Studio Code — wincapture-studio',
      thumbnail: syntheticThumbnail('window', 2),
      width: 1920,
      height: 1040,
      available: true,
    },
    {
      id: 'src-window-3',
      kind: 'window',
      name: 'Windows 设置（受保护内容）',
      width: 1280,
      height: 800,
      available: false,
    },
  ];
}

export function mockDevices(): { audio: AudioDeviceInfo[]; video: VideoDeviceInfo[] } {
  return {
    audio: [
      { deviceId: 'mic-default', label: '麦克风阵列（Realtek(R) Audio）', kind: 'audioinput', isDefault: true },
      { deviceId: 'mic-usb', label: 'USB 麦克风 · Blue Yeti', kind: 'audioinput', isDefault: false },
      { deviceId: 'spk-default', label: '扬声器（Realtek(R) Audio）', kind: 'audiooutput', isDefault: true },
      { deviceId: 'spk-hdmi', label: 'DELL U2720Q（HDMI）', kind: 'audiooutput', isDefault: false },
    ],
    video: [
      { deviceId: 'cam-default', label: 'HD 摄像头（内置）' },
      { deviceId: 'cam-usb', label: 'Logitech StreamCam' },
    ],
  };
}
