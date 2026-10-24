/**
 * src/media/exporter.ts 审计回归测试。
 *
 * encode / compositor 是浏览器 API 依赖层，这里用 vi.mock 替换成可观测替身，
 * 专注验证导出编排本身：失败清理、取消语义、进度统计、音频降级告警、资源释放。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createEmptyProject } from '../../src/domain/project';
import type { Project } from '../../src/domain/project';
import { buildExportPlan } from '../../src/domain/exportPlan';
import { TICKS_PER_SECOND } from '../../src/domain/timebase';
import type { ExportProfile } from '../../src/shared/ipc';
import {
  installFakeCanvas,
  makeFakeFileIO,
  createFakeVerifier,
} from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mocks = vi.hoisted(() => ({
  muxers: [] as any[],
  drawSceneCalls: 0,
}));

vi.mock('../../src/media/encode', () => {
  class FakeContinuousMuxer {
    options: any;
    frames = 0;
    addedAudio: any[] = [];
    finalized = false;
    canceled = false;
    disposed = false;
    readonly audioFactory = {
      createBuffer: (channels: number, length: number, sampleRate: number) => {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          copyToChannel: (source: Float32Array, ch: number) => data[ch].set(source.subarray(0, length)),
          getChannelData: (ch: number) => data[ch],
        };
      },
    };
    constructor(options: any) {
      this.options = options;
      mocks.muxers.push(this);
    }
    async init(): Promise<string> {
      return 'fake-avc (prefer-hardware)';
    }
    get drawContext(): any {
      return { fake: true };
    }
    async addFrame(): Promise<void> {
      this.frames += 1;
    }
    async addAudio(buffer: any): Promise<void> {
      this.addedAudio.push(buffer);
    }
    get audioBufferFactory(): any {
      return this.audioFactory;
    }
    async finalize(): Promise<{ data: Uint8Array; frames: number; encoder: string }> {
      this.finalized = true;
      return { data: new Uint8Array(16), frames: this.frames, encoder: 'fake-avc (prefer-hardware)' };
    }
    async cancel(): Promise<void> {
      this.canceled = true;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return {
    ContinuousMuxer: FakeContinuousMuxer,
    SegmentEncoder: class {},
    probeEncodeCapabilities: vi.fn(),
  };
});

vi.mock('../../src/media/compositor', () => ({
  drawScene: () => {
    mocks.drawSceneCalls += 1;
  },
}));

// 注意：必须在 vi.mock 之后导入被测模块
const { exportProject, estimateOutputBytes, sha256Hex, snapshotProject, resampleAudioChannels, TimelineAudioMixer } =
  await import('../../src/media/exporter');

const S = TICKS_PER_SECOND;

const PROFILE: ExportProfile = {
  variantId: 'landscape',
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  videoBitrate: 4_000_000,
  audioBitrate: 128_000,
  audioOnly: false,
  includeTutorial: false,
};

let restoreCanvas: () => void = () => {};
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
});
afterAll(() => restoreCanvas());

function baseProject(): Project {
  const project = createEmptyProject('proj-export', 'export');
  project.assets.push(
    {
      id: 'screen-1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'h1',
      durationTicks: S,
      width: 1920,
      height: 1080,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    },
    {
      id: 'mic-1',
      kind: 'mic',
      path: 'media/mic/seg-000001.wav',
      hash: 'h2',
      durationTicks: S,
      width: 0,
      height: 0,
      sampleRate: 48_000,
      channels: 2,
      createdAt: 0,
    },
  );
  project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
    {
      id: 'clip-screen',
      assetId: 'screen-1',
      sourceInTicks: 0,
      sourceDurationTicks: S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'link-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'mic')!.clips = [
    {
      id: 'clip-mic',
      assetId: 'mic-1',
      sourceInTicks: 0,
      sourceDurationTicks: S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'link-1',
    },
  ];
  return project;
}

interface MediaHarness {
  media: any;
  screenProvider: any;
  audioProvider: any;
  errors: string[];
}

function makeMedia(options: { failAudio?: boolean; missingAudio?: boolean } = {}): MediaHarness {
  const errors: string[] = [];
  const screenCanvas = { width: 1920, height: 1080 } as unknown as CanvasImageSource;
  const decoded = (range: { start: number; end: number }, channels: number) => {
    const sr = 48_000;
    const startSample = Math.max(0, Math.round((range.start * sr) / S));
    const endSample = Math.max(startSample, Math.round((range.end * sr) / S));
    const count = endSample - startSample;
    const list: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) list.push(new Float32Array(count).fill(ch === 0 ? 0.1 : -0.1));
    return {
      channels: list,
      sampleRate: sr,
      startTick: Math.round((startSample * S) / sr),
      frameCount: count,
      hasData: count > 0,
    };
  };

  const screenProvider = {
    getFrameAt: async () => screenCanvas,
    getAudioAt: async (range: any, opts: any = {}) => {
      if (options.failAudio) throw new Error('audio decoder lost');
      if (options.missingAudio) return null;
      return decoded(range, opts.channels ?? 2);
    },
    close: vi.fn(),
  };
  const audioProvider = {
    getFrameAt: async () => null,
    getAudioAt: async (range: any, opts: any = {}) => {
      if (options.failAudio) throw new Error('audio decoder lost');
      return decoded(range, opts.channels ?? 2);
    },
    close: vi.fn(),
  };

  const media = {
    segmentsFor: async () => [],
    providerFor: async (assetId: string) => {
      if (assetId === 'screen-1') return screenProvider;
      if (assetId === 'mic-1') return options.missingAudio ? null : audioProvider;
      return null;
    },
  };
  return { media, screenProvider, audioProvider, errors };
}

function collector() {
  const events: any[] = [];
  return { events, onProgress: (event: any) => events.push(event) };
}

function optionsFor(project: Project, io: any, media: any, verifier: any, extra: any = {}) {
  return {
    jobId: 'job-1',
    project,
    profile: PROFILE,
    outputPath: 'C:\\out\\video.mp4',
    io,
    media,
    mediabunny: verifier.lib,
    ...extra,
  };
}

const PARTIAL = 'C:\\out\\video.mp4.partial';
const OUTPUT = 'C:\\out\\video.mp4';

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('resampleAudioChannels: 变速音频重采样', () => {
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i / n);

  it('rate=1 时逐个采样保持不变', () => {
    const src = ramp(8);
    const [out] = resampleAudioChannels([src], 8, 1);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it('rate=2（2 倍速）把源压缩为一半长度，取值按 2 倍步长', () => {
    const src = ramp(16);
    const [out] = resampleAudioChannels([src], 8, 2);
    expect(out).toHaveLength(8);
    expect(out[0]).toBeCloseTo(src[0], 6);
    expect(out[1]).toBeCloseTo(src[2], 6);
    expect(out[7]).toBeCloseTo(src[14], 6);
  });

  it('rate=0.5（慢放）在源不足处留 0，不读越界', () => {
    const src = ramp(8);
    const [out] = resampleAudioChannels([src], 16, 0.5);
    expect(out).toHaveLength(16);
    // 越界处保持最后一个采样（而不是读越界内存）
    expect(out[15]).toBeCloseTo(src[7], 6);
    expect(out[14]).toBeCloseTo(src[7], 6);
  });

  it('双声道逐声道独立重采样，非法 rate 退化为 1', () => {
    const left = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const right = Float32Array.from([-0.1, -0.2, -0.3, -0.4]);
    const [l, r] = resampleAudioChannels([left, right], 2, Number.NaN);
    expect(Array.from(l)).toEqual([left[0], left[1]]);
    expect(Array.from(r)).toEqual([right[0], right[1]]);
  });
});

describe('导出辅助函数', () => {
  it('estimateOutputBytes 使用调用方码率而不是固定 12Mbps', () => {
    const plan = buildExportPlan(baseProject(), PROFILE);
    const estimate = estimateOutputBytes(plan, { videoBitrate: 4_000_000, audioBitrate: 128_000 });
    const baseline = estimateOutputBytes(plan);
    expect(estimate).toBeLessThan(baseline);
    // 1s 内容：(4M+128k)/8*1.15 + 8MB ≈ 8.59MB
    expect(estimate).toBeGreaterThan(8 * 1024 * 1024);
    expect(estimate).toBeLessThan(baseline);
  });

  it('sha256Hex 与标准向量一致', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('snapshotProject 是深拷贝，导出期间修改工程不影响快照', () => {
    const project = baseProject();
    const snapshot = snapshotProject(project);
    snapshot.tracks[0].clips = [];
    snapshot.settings.canvas.background = '#fff';
    expect(project.tracks[0].clips).toHaveLength(1);
    expect(project.settings.canvas.background).not.toBe('#fff');
  });
});

// ---------------------------------------------------------------------------
// 导出主流程
// ---------------------------------------------------------------------------

describe('exportProject 成功路径', () => {
  it('写 .partial → 校验 → 原子改名，并释放封装器与素材解码器', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    const { media, screenProvider, audioProvider } = makeMedia();
    const verifier = createFakeVerifier();
    const progress = collector();
    mocks.muxers.length = 0;

    const result = await exportProject(
      optionsFor(project, io, media, verifier, { onProgress: progress.onProgress }) as any,
    );

    expect(result.ok).toBe(true);
    expect(result.outputPath).toBe(OUTPUT);
    expect(result.partialPath).toBeNull();
    expect(result.bytes).toBe(16);
    expect(result.frames).toBe(30);
    expect(result.verified).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.snapshotHash).toHaveLength(64);
    expect(state.files.has(OUTPUT)).toBe(true);
    expect(state.files.has(PARTIAL)).toBe(false);
    expect(state.calls.remove).toEqual([]);
    expect(screenProvider.close).toHaveBeenCalledTimes(1);
    expect(audioProvider.close).toHaveBeenCalledTimes(1);
    expect(mocks.muxers).toHaveLength(1);
    expect(mocks.muxers[0].disposed).toBe(true);

    const last = progress.events[progress.events.length - 1];
    expect(last.phase).toBe('done');
    expect(last.percent).toBe(100);
    expect(last.framesDone).toBe(30);
    expect(verifier.disposed.count).toBe(1); // 校验用的 Input 已释放
  });
});

describe('exportProject 失败清理', () => {
  it('写 .partial 遇到磁盘满：清理已写出的残片，而不是留下几 GB 临时文件', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    // 真实行为：文件已部分落盘后才返回 ENOSPC
    state.failWrite = () =>
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const { media } = makeMedia();
    const verifier = createFakeVerifier();
    const progress = collector();
    mocks.muxers.length = 0;

    await expect(
      exportProject(optionsFor(project, io, media, verifier, { onProgress: progress.onProgress }) as any),
    ).rejects.toMatchObject({ code: 'E_DISK_FULL' });

    expect(state.calls.remove).toContain(PARTIAL);
    expect(state.files.has(PARTIAL)).toBe(false);
    expect(state.calls.rename).toEqual([]);
    expect(mocks.muxers[0].disposed).toBe(true);
    const last = progress.events[progress.events.length - 1];
    expect(last.phase).toBe('failed');
    expect(last.framesDone).toBe(30); // 已渲染帧数必须如实上报，不能归零
  });

  it('写文件失败（非磁盘满）同样清理残片', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    state.failWrite = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const { media } = makeMedia();
    const verifier = createFakeVerifier();
    mocks.muxers.length = 0;

    await expect(exportProject(optionsFor(project, io, media, verifier) as any)).rejects.toMatchObject({
      code: 'E_EXPORT_FAILED',
    });
    expect(state.calls.remove).toContain(PARTIAL);
    expect(state.files.has(PARTIAL)).toBe(false);
  });

  it('磁盘空间预检不足时在渲染前中止，不产生任何文件', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    state.freeBytes = 1024;
    const { media } = makeMedia();
    const verifier = createFakeVerifier();
    mocks.muxers.length = 0;

    await expect(exportProject(optionsFor(project, io, media, verifier) as any)).rejects.toMatchObject({
      code: 'E_DISK_FULL',
    });
    expect(state.calls.write).toEqual([]);
    expect(state.calls.rename).toEqual([]);
    expect(mocks.muxers).toHaveLength(0);
  });

  it('原子改名失败：清理 .partial，不留下半完成输出', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    state.failRename = Object.assign(new Error('EPERM: target locked'), { code: 'EPERM' });
    const { media } = makeMedia();
    const verifier = createFakeVerifier();
    mocks.muxers.length = 0;

    await expect(exportProject(optionsFor(project, io, media, verifier) as any)).rejects.toMatchObject({
      code: 'E_EXPORT_FAILED',
    });
    expect(state.calls.remove).toContain(PARTIAL);
    expect(state.files.has(PARTIAL)).toBe(false);
    expect(state.files.has(OUTPUT)).toBe(false);
  });

  it('输出校验不通过时丢弃临时文件且不提交', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    const { media } = makeMedia();
    const verifier = createFakeVerifier({ width: 1280 });
    mocks.muxers.length = 0;

    await expect(exportProject(optionsFor(project, io, media, verifier) as any)).rejects.toMatchObject({
      code: 'E_EXPORT_FAILED',
    });
    expect(state.calls.remove).toContain(PARTIAL);
    expect(state.calls.rename).toEqual([]);
    expect(state.files.has(OUTPUT)).toBe(false);
  });

  it('取消：抛 E_EXPORT_CANCELLED，取消封装器、清理临时文件，进度带真实渲染帧数', async () => {
    const project = baseProject();
    const { io, state } = makeFakeFileIO();
    const { media, screenProvider } = makeMedia();
    const verifier = createFakeVerifier();
    const controller = new AbortController();
    const progress = collector();
    mocks.muxers.length = 0;

    const options = optionsFor(project, io, media, verifier, {
      signal: controller.signal,
      onProgress: progress.onProgress,
      // 渲染到第 2 帧时取消
      pointerAt: (tick: number) => {
        if (tick >= 1 * 333_333) controller.abort();
        return null;
      },
    });

    await expect(exportProject(options as any)).rejects.toMatchObject({ code: 'E_EXPORT_CANCELLED' });
    expect(mocks.muxers[0].canceled).toBe(true);
    expect(state.calls.write).toEqual([]);
    expect(state.files.has(PARTIAL)).toBe(false);
    expect(screenProvider.close).toHaveBeenCalledTimes(1);
    const last = progress.events[progress.events.length - 1];
    expect(last.phase).toBe('cancelled');
    expect(last.framesDone).toBeGreaterThan(0);
    expect(last.framesDone).toBeLessThan(30);
  });
});

describe('exportProject 音频降级告警', () => {
  it('音频解码抛错时导出继续，但 warnings 明确报告静音降级', async () => {
    const project = baseProject();
    const { io } = makeFakeFileIO();
    const { media } = makeMedia({ failAudio: true });
    const verifier = createFakeVerifier();
    mocks.muxers.length = 0;

    const result = await exportProject(optionsFor(project, io, media, verifier) as any);
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/音频片段 clip-mic 解码失败/);
    // 静音占位仍保证音轨连续（时间不被丢弃）
    expect(mocks.muxers[0].addedAudio.length).toBeGreaterThan(0);
  });

  it('音频素材缺失时报告缺失告警而不是静默成功', async () => {
    const project = baseProject();
    const { io } = makeFakeFileIO();
    const { media } = makeMedia({ missingAudio: true });
    const verifier = createFakeVerifier();
    mocks.muxers.length = 0;

    const result = await exportProject(optionsFor(project, io, media, verifier) as any);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join('\n')).toMatch(/mic-1/);
  });
});

// ---------------------------------------------------------------------------
// 变速：保持音调的时间拉伸（WSOLA）接入混音器
// ---------------------------------------------------------------------------

/** 440Hz 正弦素材，长度 2 秒，用于检查变速后的音高与时长。 */
function sineMediaHarness(changing = false): { media: any; sine: Float32Array } {
  const sr = 48_000;
  const sine = new Float32Array(2 * sr);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * (changing && i >= sr ? 880 : 440) * i) / sr) * 0.5;
  const provider = {
    getFrameAt: async () => ({ width: 1920, height: 1080 }) as unknown as CanvasImageSource,
    getAudioAt: async (range: { start: number; end: number }, opts: any = {}) => {
      const startSample = Math.max(0, Math.round((range.start * sr) / S));
      const endSample = Math.min(sine.length, Math.max(startSample, Math.round((range.end * sr) / S)));
      const count = endSample - startSample;
      if (count <= 0) return null;
      const channels = Math.max(1, opts.channels ?? 2);
      const list: Float32Array[] = [];
      for (let ch = 0; ch < channels; ch++) list.push(sine.subarray(startSample, endSample));
      return {
        channels: list,
        sampleRate: sr,
        startTick: Math.round((startSample * S) / sr),
        frameCount: count,
        hasData: true,
      };
    },
    close: () => {},
  };
  return { sine, media: { segmentsFor: async () => [], providerFor: async () => provider } };
}

/** 统计相邻同向过零点间隔的中位数，估算基频。 */
function pitchOf(data: Float32Array, sr = 48_000): number {
  const rising: number[] = [];
  for (let i = 1; i < data.length; i++) if (data[i - 1] < 0 && data[i] >= 0) rising.push(i);
  if (rising.length < 4) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < rising.length; i++) gaps.push(rising[i] - rising[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 0 ? sr / median : 0;
}

function retimedProject(rate: { num: number; den: number }): Project {
  const project = baseProject();
  // 全部片段源时长统一为 2s，时间线时长 = 2s / rate
  project.assets = project.assets.map((a) => ({ ...a, durationTicks: 2 * S }));
  for (const track of project.tracks) {
    track.clips = track.clips.map((clip) => ({ ...clip, sourceDurationTicks: 2 * S, rate }));
  }
  return project;
}

function verifierFor(durationSeconds: number) {
  return createFakeVerifier({
    durationSeconds,
    packetCount: Math.round(durationSeconds * 30),
  });
}

describe('变速导出走保持音调的时间拉伸', () => {
  it('试听跳转与回退从对应源时间开始，重新定位拉伸器', async () => {
    const project = retimedProject({ num: 2, den: 1 }), {media} = sineMediaHarness(true);
    const provider = await media.providerFor();
    const sources = new Map(project.assets.map(asset => [asset.id, provider]));
    const factory = {createBuffer: (channels: number, length: number, sampleRate: number) => {
      const data = Array.from({length: channels}, () => new Float32Array(length));
      return {sampleRate, length, numberOfChannels: channels, getChannelData: (channel: number) => data[channel], copyToChannel: (source: Float32Array, channel: number) => data[channel].set(source)};
    }};
    const mixer = new TimelineAudioMixer(buildExportPlan(project, {audioOnly: true}), sources, {audioBufferFactory: factory as any, addAudio: async () => {}}, () => {});
    const first = await mixer.renderChunk(0, 4800), forward = await mixer.renderChunk(33600, 4800), backward = await mixer.renderChunk(4800, 4800);
    expect(pitchOf(first!.getChannelData(0))).toBeLessThan(470);
    expect(pitchOf(forward!.getChannelData(0))).toBeGreaterThan(840);
    expect(pitchOf(backward!.getChannelData(0))).toBeGreaterThan(420);
    expect(pitchOf(backward!.getChannelData(0))).toBeLessThan(470);
  });
  it('跨块推进到后半段不同音调，不重复读取源片段开头', async () => {
    const { media } = sineMediaHarness(true);
    const project = retimedProject({ num: 2, den: 1 });
    const { io } = makeFakeFileIO(); mocks.muxers.length = 0;
    await exportProject(optionsFor(project, io, media, verifierFor(1)) as any);
    const buffers = mocks.muxers[0].addedAudio;
    const flat = new Float32Array(buffers.reduce((sum: number, b: any) => sum + b.length, 0));
    let at = 0; for (const b of buffers) { flat.set(b.getChannelData(0), at); at += b.length; }
    expect(pitchOf(flat.subarray(4800, 19200))).toBeGreaterThan(420);
    expect(pitchOf(flat.subarray(4800, 19200))).toBeLessThan(465);
    expect(pitchOf(flat.subarray(33600, 43200))).toBeGreaterThan(840);
    expect(pitchOf(flat.subarray(33600, 43200))).toBeLessThan(930);
    for (let block = 2; block < buffers.length - 2; block++) {
      const data = buffers[block].getChannelData(0);
      const rms = Math.sqrt(data.reduce((s: number, x: number) => s + x * x, 0) / data.length);
      expect(rms).toBeGreaterThan(0.15);
    }
  });
  it('2× 片段：输出时长按时间线缩短，但音高不翻倍', async () => {
    const { media } = sineMediaHarness();
    const project = retimedProject({ num: 2, den: 1 });
    const { io } = makeFakeFileIO();
    const verifier = verifierFor(1);
    mocks.muxers.length = 0;

    const result = await exportProject(optionsFor(project, io, media, verifier) as any);
    expect(result.ok).toBe(true);

    const buffers = mocks.muxers[0].addedAudio as { length: number; getChannelData(ch: number): Float32Array }[];
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    // 时间线时长 = 2s / 2 = 1s → 48000 采样（不是 2s 也不是被截断）
    expect(total).toBeGreaterThan(47_000);
    expect(total).toBeLessThanOrEqual(48_000 + 4096);

    const flat = new Float32Array(total);
    let at = 0;
    for (const b of buffers) {
      flat.set(b.getChannelData(0).subarray(0, b.length), at);
      at += b.length;
    }
    // 只看中段：开头一帧与结尾补零是 OLA 的固有边界
    const mid = flat.subarray(Math.floor(total * 0.1), Math.floor(total * 0.9));
    const pitch = pitchOf(mid);
    expect(pitch).toBeGreaterThan(400);
    expect(pitch).toBeLessThan(485);
  });

  it('0.5× 片段：输出时长加倍，音高不减半，且中段不是静音', async () => {
    const { media } = sineMediaHarness();
    const project = retimedProject({ num: 1, den: 2 });
    const { io } = makeFakeFileIO();
    const verifier = verifierFor(4);
    mocks.muxers.length = 0;

    const result = await exportProject(optionsFor(project, io, media, verifier) as any);
    expect(result.ok).toBe(true);

    const buffers = mocks.muxers[0].addedAudio as { length: number; getChannelData(ch: number): Float32Array }[];
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    // 时间线时长 = 2s / 0.5 = 4s → 192000 采样
    expect(total).toBeGreaterThan(190_000);

    const flat = new Float32Array(total);
    let at = 0;
    for (const b of buffers) {
      flat.set(b.getChannelData(0).subarray(0, b.length), at);
      at += b.length;
    }
    const mid = flat.subarray(Math.floor(total * 0.1), Math.floor(total * 0.85));
    const pitch = pitchOf(mid);
    expect(pitch).toBeGreaterThan(400);
    expect(pitch).toBeLessThan(485);
    let energy = 0;
    for (let i = 0; i < mid.length; i += 37) energy += Math.abs(mid[i]);
    expect(energy / Math.ceil(mid.length / 37)).toBeGreaterThan(0.05);
  });

  it('恒速片段不进入拉伸路径（输出与原素材逐样本一致）', async () => {
    const { media, sine } = sineMediaHarness();
    const project = retimedProject({ num: 1, den: 1 });
    const { io } = makeFakeFileIO();
    const verifier = verifierFor(2);
    mocks.muxers.length = 0;

    await exportProject(optionsFor(project, io, media, verifier) as any);
    const buffers = mocks.muxers[0].addedAudio as { length: number; getChannelData(ch: number): Float32Array }[];
    let at = 0;
    let matches = 0;
    for (const b of buffers) {
      const data = b.getChannelData(0);
      for (let i = 0; i < b.length; i++) {
        if (at + i < sine.length && Math.abs(data[i] - sine[at + i]) < 1e-6) matches++;
      }
      at += b.length;
    }
    expect(matches).toBeGreaterThan(at * 0.9);
  });
});
