/**
 * src/media/decoder.ts 审计回归测试。
 *
 * 重点覆盖：
 *  - SegmentSet 的段定位（纯逻辑）；
 *  - 损坏段解码失败时回溯到更早的段（而不是让整次导出失败）；
 *  - open() 预热真正暴露「素材完全打不开」；
 *  - 同一段的并发打开只创建一次 Input（不泄漏文件句柄/解码器）；
 *  - 视频帧 / 音频 PCM 的取样、跨段拼接、重采样与声道映射；
 *  - close / LRU 驱逐 / 打开中失败都释放 mediabunny 资源。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  SegmentSet,
  VideoFrameSource,
  openFrameSources,
  singleSegmentSet,
  type MediaSegment,
} from '../../src/media/decoder';
import { TICKS_PER_SECOND } from '../../src/domain/timebase';
import {
  createFakeMediabunny,
  installFakeCanvas,
  segmentBlob,
  type FakeSegmentSpec,
} from './helpers';

const S = TICKS_PER_SECOND;

let restoreCanvas: () => void = () => {};
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
});
afterAll(() => restoreCanvas());

function seg(path: string, key: string, startTick: number, durationTicks: number): MediaSegment {
  return { path, startTick, durationTicks, data: segmentBlob(key) };
}

function source(specs: Record<string, FakeSegmentSpec>, segments: MediaSegment[], options: Record<string, unknown> = {}) {
  const fake = createFakeMediabunny(specs);
  const src = new VideoFrameSource({ mediabunny: fake.lib, ...options }, segments);
  return { ...fake, src };
}

// ---------------------------------------------------------------------------
// SegmentSet
// ---------------------------------------------------------------------------

describe('SegmentSet 段定位', () => {
  it('按 startTick 排序、过滤非法项并定位段下标', () => {
    const set = new SegmentSet([
      { path: 'b', startTick: 2 * S, durationTicks: S },
      { path: 'a', startTick: 0, durationTicks: 2 * S },
      { path: 42 as unknown as string, startTick: 5 * S },
    ]);
    expect(set.length).toBe(2);
    expect(set.segments.map((s) => s.path)).toEqual(['a', 'b']);
    expect(set.startTick).toBe(0);
    expect(set.indexAt(-1)).toBe(-1);
    expect(set.indexAt(0)).toBe(0);
    expect(set.indexAt(2 * S)).toBe(1);
    expect(set.indexAt(99 * S)).toBe(1);
    expect(set.endTickOf(0)).toBe(2 * S);
    expect(set.endTickOf(1)).toBe(Number.POSITIVE_INFINITY);
    expect(set.endTickOf(-1)).toBe(0);
    expect(set.durationTicks).toBe(3 * S);
    expect(set.localSeconds(1, 2.5 * S)).toBeCloseTo(0.5, 6);
    expect(set.localSeconds(9, S)).toBe(0);
  });

  it('indicesIn 只返回与区间相交的段', () => {
    const set = new SegmentSet([
      { path: 'a', startTick: 0, durationTicks: S },
      { path: 'b', startTick: S, durationTicks: S },
      { path: 'c', startTick: 2 * S, durationTicks: S },
    ]);
    expect(set.indicesIn({ start: 0.5 * S, end: 1.5 * S })).toEqual([0, 1]);
    expect(set.indicesIn({ start: 1 * S, end: 2 * S })).toEqual([1]);
    expect(set.indicesIn({ start: 5 * S, end: 5 * S })).toEqual([]);
    expect(singleSegmentSet('x', S).durationTicks).toBe(S);
  });
});

// ---------------------------------------------------------------------------
// 取帧
// ---------------------------------------------------------------------------

describe('VideoFrameSource 取帧', () => {
  const frames = [
    { timestamp: 0, duration: 0.5 },
    { timestamp: 0.5, duration: 0.5 },
    { timestamp: 1.0, duration: 0.5 },
  ];

  it('取 tick 对应的最近前一帧，并在帧时长内复用缓存', async () => {
    const { src, stats } = source({ 'seg-a': { videoFrames: frames } }, [
      seg('a.mp4', 'seg-a', 0, 2 * S),
    ]);
    await src.open();
    await src.getFrameAt(0.2 * S);
    expect(stats.lastDrawnTimestamp).toBe(0);
    const second = await src.getFrameAt(0.7 * S);
    expect(stats.lastDrawnTimestamp).toBe(0.5);
    // 0.6s 仍在 0.5s 帧的时长内：走缓存，不再画
    const third = await src.getFrameAt(0.6 * S);
    expect(third).toBe(second);
    expect(stats.lastDrawnTimestamp).toBe(0.5);
    src.close();
    expect(stats.inputsDisposed).toBe(1);
  });

  it('跨段取帧使用后一段的文件内时间', async () => {
    const { src, stats } = source(
      {
        'seg-a': { videoFrames: frames, durationSeconds: 1.5 },
        'seg-b': { videoFrames: frames, durationSeconds: 1.5 },
      },
      [seg('a.mp4', 'seg-a', 0, 2 * S), seg('b.mp4', 'seg-b', 2 * S, 2 * S)],
    );
    await src.open();
    await src.getFrameAt(2.7 * S);
    // 段内 0.7s → 段 b 的 0.5s 帧
    expect(stats.lastDrawnTimestamp).toBe(0.5);
    src.close();
  });

  it('当前段解码异常时标记失败并回溯到更早的段，且不再重试坏段', async () => {
    const { src, stats } = source(
      {
        'seg-a': { videoFrames: frames, durationSeconds: 1.5 },
        'seg-b': { videoFrames: frames, failVideoSamples: true },
      },
      [seg('a.mp4', 'seg-a', 0, 2 * S), seg('b.mp4', 'seg-b', 2 * S, 2 * S)],
    );
    await src.open();
    const frame = await src.getFrameAt(2.1 * S);
    expect(frame).not.toBeNull();
    // 回溯到段 a 的最后一帧（时间戳 1.0）
    expect(stats.lastDrawnTimestamp).toBe(1.0);
    expect(stats.inputsDisposed).toBe(1); // 坏段 b 的资源已释放

    // 第二次请求仍落在段 b：直接跳过失败段，不再创建新的 Input
    const again = await src.getFrameAt(2.3 * S);
    expect(again).not.toBeNull();
    expect(stats.inputsCreatedByKey['seg-b']).toBe(1);
    expect(stats.lastDrawnTimestamp).toBe(1.0);
    src.close();
  });

  it('帧时间戳越界时保留最后一帧（不返回 null）', async () => {
    const { src, stats } = source({ 'seg-a': { videoFrames: frames, durationSeconds: 1.5 } }, [
      seg('a.mp4', 'seg-a', 0, 2 * S),
    ]);
    await src.open();
    expect(await src.getFrameAt(9 * S)).not.toBeNull();
    expect(stats.lastDrawnTimestamp).toBe(1.0);
    src.close();
  });

  it('getSizeAt 返回编码尺寸', async () => {
    const { src } = source(
      { 'seg-a': { videoFrames: [{ timestamp: 0, duration: 1, width: 2560, height: 1440 }] } },
      [seg('a.mp4', 'seg-a', 0, S)],
    );
    await src.open();
    expect(await src.getSizeAt(0)).toEqual({ width: 2560, height: 1440 });
    expect(await src.getSizeAt(-1)).toBeNull();
    src.close();
  });
});

// ---------------------------------------------------------------------------
// 打开语义与资源释放
// ---------------------------------------------------------------------------

describe('VideoFrameSource 打开与释放', () => {
  it('所有分段都打不开时 open() 抛 E_MEDIA_MISSING（不再静默导出黑屏）', async () => {
    const { src } = source(
      { 'seg-a': { failInput: true }, 'seg-b': { failInput: true } },
      [seg('a.mp4', 'seg-a', 0, S), seg('b.mp4', 'seg-b', S, S)],
    );
    await expect(src.open()).rejects.toMatchObject({ code: 'E_MEDIA_MISSING' });
  });

  it('首段损坏时继续探测后续段', async () => {
    const { src, stats } = source(
      {
        'seg-a': { failInput: true },
        'seg-b': { videoFrames: [{ timestamp: 0, duration: 1 }] },
      },
      [seg('a.mp4', 'seg-a', 0, S), seg('b.mp4', 'seg-b', S, S)],
    );
    await src.open();
    expect(await src.getSizeAt(1.2 * S)).toEqual({ width: 1920, height: 1080 });
    expect(stats.inputsCreatedByKey['seg-b']).toBe(1);
    src.close();
  });

  it('同一段的并发打开只创建一个 Input（避免覆盖泄漏）', async () => {
    const { src, stats } = source(
      {
        'seg-a': { videoFrames: [{ timestamp: 0, duration: 1 }] },
        'seg-b': { videoFrames: [{ timestamp: 0, duration: 1 }], openDelayMs: 20 },
      },
      [seg('a.mp4', 'seg-a', 0, S), seg('b.mp4', 'seg-b', S, S)],
      { maxOpenSegments: 4 },
    );
    await src.open();
    const [a, b] = await Promise.all([src.getSizeAt(1.2 * S), src.getSizeAt(1.3 * S)]);
    expect(a).toEqual({ width: 1920, height: 1080 });
    expect(b).toEqual({ width: 1920, height: 1080 });
    expect(stats.inputsCreatedByKey['seg-b']).toBe(1);
    src.close();
  });

  it('getFrameAt 前必须先 open()', async () => {
    const { src } = source({ 'seg-a': { videoFrames: [] } }, [seg('a.mp4', 'seg-a', 0, S)]);
    await expect(src.getFrameAt(0)).rejects.toMatchObject({ code: 'E_MEDIA_MISSING' });
  });

  it('openFrameSources 中途失败会关闭已打开的解码源', async () => {
    const { lib, stats } = createFakeMediabunny({
      'seg-a': { videoFrames: [{ timestamp: 0, duration: 1 }] },
      'seg-b': { failInput: true },
    });
    await expect(
      openFrameSources(
        {
          a: [seg('a.mp4', 'seg-a', 0, S)],
          b: [seg('b.mp4', 'seg-b', 0, S)],
        },
        { mediabunny: lib },
      ),
    ).rejects.toBeTruthy();
    // b 段打开失败时释放自己的 Input；a 段被 openFrameSources 兜底关闭
    expect(stats.inputsDisposed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 音频
// ---------------------------------------------------------------------------

describe('VideoFrameSource 音频', () => {
  const SR = 48_000;

  function constantAudio(value: number, sampleRate = SR, seconds = 1) {
    const length = Math.round(sampleRate * seconds);
    return { timestamp: 0, duration: seconds, sampleRate, channels: [new Float32Array(length).fill(value)] };
  }

  it('单声道素材映射到双声道输出', async () => {
    const { src } = source({ 'aud-a': { audioBuffers: [constantAudio(0.5)] } }, [
      seg('a.wav', 'aud-a', 0, S),
    ]);
    await src.open();
    const pcm = await src.getAudioAt({ start: 0, end: 0.5 * S }, { channels: 2 });
    expect(pcm).not.toBeNull();
    expect(pcm!.frameCount).toBe(24_000);
    expect(pcm!.channels.length).toBe(2);
    expect(pcm!.hasData).toBe(true);
    expect(pcm!.channels[0][0]).toBeCloseTo(0.5, 5);
    expect(pcm!.channels[1][0]).toBeCloseTo(0.5, 5);
    src.close();
  });

  it('立体声下混为单声道取均值', async () => {
    const channels = [new Float32Array(48_000).fill(0.2), new Float32Array(48_000).fill(0.8)];
    const { src } = source({ 'aud-a': { audioBuffers: [{ timestamp: 0, duration: 1, channels }] } }, [
      seg('a.wav', 'aud-a', 0, S),
    ]);
    await src.open();
    const pcm = await src.getAudioAt({ start: 0, end: 0.1 * S }, { channels: 1 });
    expect(pcm!.channels.length).toBe(1);
    expect(pcm!.channels[0][100]).toBeCloseTo(0.5, 5);
    src.close();
  });

  it('跨段音频按时间拼接', async () => {
    const { src } = source(
      {
        'aud-a': { audioBuffers: [constantAudio(0.25)] },
        'aud-b': { audioBuffers: [constantAudio(0.75)] },
      },
      [seg('a.wav', 'aud-a', 0, S), seg('b.wav', 'aud-b', S, S)],
    );
    await src.open();
    const pcm = await src.getAudioAt({ start: 0.5 * S, end: 1.5 * S }, { channels: 1 });
    expect(pcm!.frameCount).toBe(48_000);
    expect(pcm!.channels[0][0]).toBeCloseTo(0.25, 5);
    expect(pcm!.channels[0][24_000]).toBeCloseTo(0.75, 5);
    src.close();
  });

  it('源采样率不是 48k 时线性重采样', async () => {
    const { src } = source(
      { 'aud-a': { audioBuffers: [constantAudio(0.4, 24_000, 0.5)] } },
      [seg('a.wav', 'aud-a', 0, S)],
    );
    await src.open();
    const pcm = await src.getAudioAt({ start: 0, end: 0.2 * S }, { channels: 1 });
    expect(pcm!.sampleRate).toBe(48_000);
    expect(pcm!.frameCount).toBe(9_600);
    for (const index of [0, 1000, 9599]) {
      expect(pcm!.channels[0][index]).toBeCloseTo(0.4, 3);
    }
    src.close();
  });

  it('没有音轨的分段返回 null', async () => {
    const { src } = source({ 'seg-a': { videoFrames: [{ timestamp: 0, duration: 1 }] } }, [
      seg('a.mp4', 'seg-a', 0, S),
    ]);
    await src.open();
    expect(await src.getAudioAt({ start: 0, end: S })).toBeNull();
    src.close();
  });

  it('关闭时归还挂起的音频异步迭代器', async () => {
    const { src, stats } = source({ 'aud-a': { audioBuffers: [constantAudio(0.1, SR, 1)] } }, [
      seg('a.wav', 'aud-a', 0, S),
    ]);
    await src.open();
    await src.getAudioAt({ start: 0, end: 0.4 * S }, { channels: 1 });
    src.close();
    expect(stats.audioIteratorsReturned).toBeGreaterThanOrEqual(1);
  });

  it('LRU 驱逐时归还被驱逐段的音频迭代器', async () => {
    // a 段有两个缓冲块：只取第一块时迭代器停在第二块上（挂起），驱逐必须 return 它
    const a1 = new Float32Array(12_000).fill(0.1);
    const a2 = new Float32Array(12_000).fill(0.1);
    const audioA = [
      { timestamp: 0, duration: 0.25, channels: [a1] },
      { timestamp: 0.25, duration: 0.25, channels: [a2] },
    ];
    const audioB = [constantAudio(0.2)];
    const { src, stats } = source(
      {
        'aud-a': { audioBuffers: audioA },
        'aud-b': { audioBuffers: audioB },
      },
      [seg('a.wav', 'aud-a', 0, S), seg('b.wav', 'aud-b', S, S)],
      { maxOpenSegments: 1 },
    );
    await src.open();
    await src.getAudioAt({ start: 0, end: 0.1 * S }, { channels: 1 });
    await src.getAudioAt({ start: 1.0 * S, end: 1.1 * S }, { channels: 1 });
    expect(stats.audioIteratorsReturned).toBeGreaterThanOrEqual(1);
    expect(stats.inputsDisposed).toBeGreaterThanOrEqual(1);
    src.close();
  });
});
