/**
 * src/media/encode.ts 审计回归测试。
 *
 * 用注入的假 Output / 假 AudioBufferSource / 假 OfflineAudioContext 覆盖：
 *  - finalize 成功/失败都释放编码资源（硬件编码器上下文不能留给 GC）；
 *  - abort() 真正释放而不是只 cancel；
 *  - addAudio 按 startTimestampUs / 时间戳补静音，避免音画错位；
 *  - ContinuousMuxer.dispose() 归还画布与编码器。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SegmentEncoder, ContinuousMuxer } from '../../src/media/encode';
import type { SegmentEncodeOptions, MuxerOptions } from '../../src/media/encode';
import { FakeOffscreenCanvas, installFakeCanvas } from './helpers';
import { canEncodeVideo } from 'mediabunny';
vi.mock('mediabunny', async (importOriginal) => ({
  ...await importOriginal<typeof import('mediabunny')>(),
  canEncodeVideo: vi.fn(async () => false),
}));

it('encoding probes include the actual fps for AVC profile/level selection', async () => {
  vi.mocked(canEncodeVideo).mockClear();
  const muxer = new ContinuousMuxer({ ...MUXER_OPTIONS, width: 3840, height: 2160, fps: 60 });
  await expect(muxer.init()).rejects.toThrow(/编码器/);
  expect(vi.mocked(canEncodeVideo).mock.calls.length).toBeGreaterThan(1);
  for (const call of vi.mocked(canEncodeVideo).mock.calls) expect(call[1]?.frameRate).toBe(60);
  vi.mocked(canEncodeVideo).mockClear();
  await expect(new SegmentEncoder({ ...SEGMENT_OPTIONS, fps: 60 }).init()).rejects.toThrow(/编码器/);
  for (const call of vi.mocked(canEncodeVideo).mock.calls) expect(call[1]?.frameRate).toBe(60);
});

/* eslint-disable @typescript-eslint/no-explicit-any */

const SEGMENT_OPTIONS: SegmentEncodeOptions = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitrate: 12_000_000,
  audioBitrate: 192_000,
  hardwarePreferred: true,
  includeAudio: true,
  audioSampleRate: 48_000,
  audioChannels: 2,
  startTimestampUs: 0,
};

const MUXER_OPTIONS: MuxerOptions = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitrate: 12_000_000,
  audioBitrate: 192_000,
  audioSampleRate: 48_000,
  audioChannels: 2,
  includeAudio: true,
};

let restoreCanvas: () => void = () => {};
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
});
afterAll(() => restoreCanvas());

interface FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  data: Float32Array[];
  getChannelData(ch: number): Float32Array;
  copyToChannel(source: Float32Array, ch: number): void;
}

function makeAudioContext(): { createBuffer: (channels: number, length: number, sampleRate: number) => FakeAudioBuffer; created: FakeAudioBuffer[] } {
  const created: FakeAudioBuffer[] = [];
  return {
    created,
    createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
      const data: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(length));
      const buffer: FakeAudioBuffer = {
        numberOfChannels: channels,
        length,
        sampleRate,
        data,
        getChannelData: (ch) => data[ch],
        copyToChannel: (source, ch) => {
          data[ch].set(source.subarray(0, length));
        },
      };
      created.push(buffer);
      return buffer;
    },
  };
}

function injectEncoder(encoder: SegmentEncoder, overrides: Record<string, any> = {}): void {
  const target = encoder as any;
  target.started = true;
  target.output = { cancel: vi.fn(), finalize: vi.fn(async () => undefined), target: { buffer: new ArrayBuffer(0) } };
  target.videoSource = { add: vi.fn(async () => undefined) };
  target.audioSource = { add: vi.fn(async () => undefined) };
  target.audioContext = makeAudioContext();
  target.canvas = new FakeOffscreenCanvas(16, 16);
  target.ctx = (target.canvas as FakeOffscreenCanvas).getContext();
  Object.assign(target, overrides);
}

function addedLengths(source: { add: ReturnType<typeof vi.fn> }): number[] {
  return source.add.mock.calls.map((call) => (call[0] as FakeAudioBuffer).length);
}

// ---------------------------------------------------------------------------
// SegmentEncoder：音频时间戳
// ---------------------------------------------------------------------------

describe('SegmentEncoder.addAudio 时间戳与补静音', () => {
  it('连续写入不补静音，间隔写入按时间戳补静音', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    const audioContext = makeAudioContext();
    injectEncoder(encoder, { audioContext });
    const audioSource = (encoder as any).audioSource;

    await encoder.addAudio([new Float32Array(480), new Float32Array(480)], 0, 48_000);
    // 0.1s 处：与上一批结束（0.01s）之间有 0.09s 空洞 → 4320 采样静音
    await encoder.addAudio([new Float32Array(480), new Float32Array(480)], 100_000, 48_000);
    // 紧接着上一批结束（0.1s + 480/48000 = 0.11s）→ 不补
    await encoder.addAudio([new Float32Array(480), new Float32Array(480)], 110_000, 48_000);

    expect(addedLengths(audioSource)).toEqual([480, 4_320, 480, 480]);
    expect(audioContext.created[1].numberOfChannels).toBe(2);
    expect(audioContext.created[1].sampleRate).toBe(48_000);
    expect((audioSource.add.mock.calls[1][0] as FakeAudioBuffer).data[0].every((v) => v === 0)).toBe(true);
  });

  it('按 startTimestampUs 归一化：第一批也可以从段内非 0 处开始', async () => {
    const encoder = new SegmentEncoder({ ...SEGMENT_OPTIONS, startTimestampUs: 1_000_000 });
    const audioContext = makeAudioContext();
    injectEncoder(encoder, { audioContext });
    const audioSource = (encoder as any).audioSource;

    await encoder.addAudio([new Float32Array(480)], 1_100_000, 48_000);
    expect(addedLengths(audioSource)).toEqual([4_800, 480]);
  });

  it('时间戳早于已写入位置时不补静音（顺序追加，不倒退）', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    const audioContext = makeAudioContext();
    injectEncoder(encoder, { audioContext });
    const audioSource = (encoder as any).audioSource;

    await encoder.addAudio([new Float32Array(1_000)], 100_000, 48_000);
    await encoder.addAudio([new Float32Array(1_000)], 50_000, 48_000);
    expect(addedLengths(audioSource)).toEqual([4_800, 1_000, 1_000]);
  });

  it('非法采样率直接报错而不是写出错误时间轴', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    injectEncoder(encoder);
    await expect(encoder.addAudio([new Float32Array(10)], 0, 0)).rejects.toThrow(/采样率/);
  });

  it('空批次直接忽略', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    injectEncoder(encoder);
    const audioSource = (encoder as any).audioSource;
    await encoder.addAudio([], 0, 48_000);
    await encoder.addAudio([new Float32Array(0)], 0, 48_000);
    expect(audioSource.add).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SegmentEncoder：finalize / abort / dispose 生命周期
// ---------------------------------------------------------------------------

describe('SegmentEncoder 编码器生命周期', () => {
  it('commitVideoFrame 在未初始化时抛错，负时间戳被夹到 0', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    await expect(encoder.commitVideoFrame(0)).rejects.toThrow(/未启动/);

    injectEncoder(encoder);
    const videoSource = (encoder as any).videoSource;
    await encoder.commitVideoFrame(-500);
    expect(videoSource.add).toHaveBeenCalledWith(0, 1 / 30);
  });

  it('finalize 失败时 cancel 输出并断开全部引用（失败段不占用硬件编码器）', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    injectEncoder(encoder);
    const output = {
      finalize: vi.fn(async () => {
        throw new Error('GPU device removed');
      }),
      cancel: vi.fn(),
      target: { buffer: new ArrayBuffer(0) },
    };
    (encoder as any).output = output;

    await expect(encoder.finalize()).rejects.toThrow('GPU device removed');
    expect(output.cancel).toHaveBeenCalledTimes(1);
    const target = encoder as any;
    expect(target.started).toBe(false);
    expect(target.output).toBeNull();
    expect(target.videoSource).toBeNull();
    expect(target.audioSource).toBeNull();
    expect(target.canvas).toBeNull();
    expect(target.ctx).toBeNull();
  });

  it('finalize 成功后同样释放，且不再对已结束的 Output 调 cancel', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    injectEncoder(encoder);
    const output = {
      finalize: vi.fn(async () => undefined),
      cancel: vi.fn(),
      target: { buffer: new ArrayBuffer(8) },
    };
    (encoder as any).output = output;

    const result = await encoder.finalize();
    expect(result.data.byteLength).toBe(8);
    expect(result.frames).toBe(1); // 无帧时兜底写一帧
    expect(output.cancel).not.toHaveBeenCalled();
    expect((encoder as any).started).toBe(false);
    expect((encoder as any).output).toBeNull();
  });

  it('abort() 等价于释放资源（可重复调用）', () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    injectEncoder(encoder);
    const output = (encoder as any).output;
    encoder.abort();
    encoder.abort();
    expect(output.cancel).toHaveBeenCalledTimes(1);
    expect((encoder as any).started).toBe(false);
    expect((encoder as any).canvas).toBeNull();
  });

  it('重复 init 直接报错，避免创建第二个 Output 泄漏', async () => {
    const encoder = new SegmentEncoder(SEGMENT_OPTIONS);
    injectEncoder(encoder);
    await expect(encoder.init()).rejects.toThrow(/已初始化/);
  });
});

// ---------------------------------------------------------------------------
// ContinuousMuxer
// ---------------------------------------------------------------------------

function injectMuxer(muxer: ContinuousMuxer, overrides: Record<string, any> = {}): void {
  const target = muxer as any;
  target.output = {
    finalize: vi.fn(async () => undefined),
    cancel: vi.fn(),
    target: { buffer: new ArrayBuffer(16) },
  };
  target.videoSource = {};
  target.audioSource = { add: vi.fn(async () => undefined) };
  target.audioContext = makeAudioContext();
  target.canvas = new FakeOffscreenCanvas(32, 32);
  target.ctx = (target.canvas as FakeOffscreenCanvas).getContext();
  target.settled = false;
  Object.assign(target, overrides);
}

describe('ContinuousMuxer 生命周期', () => {
  it('未初始化时 drawContext 抛错', () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    expect(() => muxer.drawContext).toThrow(/未初始化/);
  });

  it('finalize 成功后 dispose 归还画布，不再 cancel', async () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    injectMuxer(muxer);
    const output = (muxer as any).output;
    const canvas = (muxer as any).canvas as FakeOffscreenCanvas;

    const result = await muxer.finalize();
    expect(result.data.byteLength).toBe(16);
    muxer.dispose();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(output.cancel).not.toHaveBeenCalled();
    expect(() => muxer.drawContext).toThrow(/未初始化/);
  });

  it('未 finalize 就 dispose：取消输出并归还画布', () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    injectMuxer(muxer);
    const output = (muxer as any).output;
    const canvas = (muxer as any).canvas as FakeOffscreenCanvas;
    muxer.dispose();
    expect(output.cancel).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
  });

  it('cancel 之后再 dispose 不重复取消', async () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    injectMuxer(muxer);
    const output = (muxer as any).output;
    await muxer.cancel();
    muxer.dispose();
    expect(output.cancel).toHaveBeenCalledTimes(1);
  });

  it('finalize 抛错时 dispose 仍会取消输出', async () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    injectMuxer(muxer);
    const output = (muxer as any).output;
    output.finalize.mockImplementation(async () => {
      throw new Error('mux failed');
    });
    await expect(muxer.finalize()).rejects.toThrow('mux failed');
    muxer.dispose();
    expect(output.cancel).toHaveBeenCalledTimes(1);
  });

  it('addSilence 按目标采样率补齐长度', async () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    const audioContext = makeAudioContext();
    injectMuxer(muxer, { audioContext });
    await muxer.addSilence(0.25);
    const source = (muxer as any).audioSource;
    expect(source.add).toHaveBeenCalledTimes(1);
    expect((source.add.mock.calls[0][0] as FakeAudioBuffer).length).toBe(12_000);
  });

  it('重复 init 直接报错', async () => {
    const muxer = new ContinuousMuxer(MUXER_OPTIONS);
    injectMuxer(muxer);
    await expect(muxer.init()).rejects.toThrow(/已初始化/);
  });
});
