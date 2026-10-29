/**
 * 波形峰值缓存测试（§10.4）
 *
 * 覆盖：WAV 解析（32-bit float / 16-bit PCM / 异常输入）、
 * 分层构建的桶数与单调性、按时间区间切片、缓存键与淘汰。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildWaveform,
  buildWaveformFromWav,
  clearWaveformCache,
  getCachedWaveform,
  parseWav,
  putCachedWaveform,
  slicePeaks,
  waveformCacheKey,
} from '../../src/renderer/lib/waveform';

/** 构造 32-bit float WAV 字节。samples 是交错数据。 */
function makeFloatWav(samples: number[], channels: number, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 4;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) view.setFloat32(44 + i * 4, samples[i], true);
  return buffer;
}

/** 构造 16-bit PCM WAV 字节。 */
function makePcm16Wav(samples: number[], channels: number, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
  }
  return buffer;
}

describe('parseWav', () => {
  it('解析 32-bit float 立体声', () => {
    const parsed = parseWav(makeFloatWav([0.5, -0.5, 0.25, -0.25], 2, 48000));
    expect(parsed).not.toBeNull();
    expect(parsed!.sampleRate).toBe(48000);
    expect(parsed!.channels).toBe(2);
    expect(parsed!.frames).toBe(2);
    expect(parsed!.samples.length).toBe(4);
    expect(parsed!.samples[0]).toBeCloseTo(0.5, 6);
    expect(parsed!.samples[1]).toBeCloseTo(-0.5, 6);
  });

  it('解析 16-bit PCM 并归一到 [-1,1]', () => {
    const parsed = parseWav(makePcm16Wav([0.5, -0.5], 1, 44100));
    expect(parsed).not.toBeNull();
    expect(parsed!.channels).toBe(1);
    expect(parsed!.sampleRate).toBe(44100);
    expect(parsed!.samples[0]).toBeCloseTo(0.5, 3);
    expect(parsed!.samples[1]).toBeCloseTo(-0.5, 3);
  });

  it('非 WAV 数据返回 null 而不是抛异常', () => {
    expect(parseWav(new ArrayBuffer(10))).toBeNull();
    const junk = new Uint8Array(100).fill(7).buffer;
    expect(parseWav(junk)).toBeNull();
  });

  it('RIFF 但非 WAVE 返回 null', () => {
    const buffer = new ArrayBuffer(64);
    const view = new DataView(buffer);
    view.setUint8(0, 'R'.charCodeAt(0));
    view.setUint8(1, 'I'.charCodeAt(0));
    view.setUint8(2, 'F'.charCodeAt(0));
    view.setUint8(3, 'F'.charCodeAt(0));
    view.setUint8(8, 'X'.charCodeAt(0));
    expect(parseWav(buffer)).toBeNull();
  });
});

describe('buildWaveform', () => {
  it('L0 桶数等于帧数除以桶宽（向上取整）', () => {
    const frames = 1000;
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = Math.sin(i / 20);
    const data = buildWaveform(samples, 1, 48000, 256);
    expect(data.totalSamples).toBe(1000);
    expect(data.levels[0].samplesPerBucket).toBe(256);
    expect(data.levels[0].buckets.length).toBe(Math.ceil(1000 / 256));
  });

  it('分层逐级减半，且桶宽逐级翻倍', () => {
    const samples = new Float32Array(4096);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 13);
    const data = buildWaveform(samples, 1, 48000, 128);
    expect(data.levels.length).toBeGreaterThan(1);
    for (let i = 1; i < data.levels.length; i++) {
      expect(data.levels[i].samplesPerBucket).toBe(data.levels[i - 1].samplesPerBucket * 2);
      expect(data.levels[i].buckets.length).toBe(Math.ceil(data.levels[i - 1].buckets.length / 2));
    }
  });

  it('上层峰值必须包住下层（合并只扩不缩）', () => {
    const samples = new Float32Array(2048);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 7) * 0.9;
    const data = buildWaveform(samples, 1, 48000, 64);
    for (let level = 1; level < data.levels.length; level++) {
      const lower = data.levels[level - 1].buckets;
      const upper = data.levels[level].buckets;
      for (let i = 0; i < upper.length; i++) {
        const a = lower[i * 2];
        const b = lower[i * 2 + 1];
        if (a) expect(upper[i].min).toBeLessThanOrEqual(a.min + 1e-9);
        if (a) expect(upper[i].max).toBeGreaterThanOrEqual(a.max - 1e-9);
        if (b) expect(upper[i].min).toBeLessThanOrEqual(b.min + 1e-9);
        if (b) expect(upper[i].max).toBeGreaterThanOrEqual(b.max - 1e-9);
      }
    }
  });

  it('反相立体声保留各声道峰值，不抵消为假静音', () => {
    const samples = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1]);
    const data = buildWaveform(samples, 2, 48000, 2);
    const bucket = data.levels[0].buckets[0];
    expect(bucket.min).toBe(-1);
    expect(bucket.max).toBe(1);
  });

  it('空输入不崩，返回空桶列表', () => {
    const data = buildWaveform(new Float32Array(0), 2, 48000);
    expect(data.totalSamples).toBe(0);
    expect(data.levels[0].buckets.length).toBe(0);
  });
});

describe('slicePeaks', () => {
  const sampleRate = 48000;
  // 前一半安静、后一半很响，便于验证区间切片
  const frames = sampleRate * 2;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = i < frames / 2 ? 0.01 : 0.9;
  }
  const data = buildWaveform(samples, 1, sampleRate, 256);

  it('输出桶数等于请求值', () => {
    expect(slicePeaks(data, 0, 2, 100).length).toBe(100);
    expect(slicePeaks(data, 0, 2, 37).length).toBe(37);
  });

  it('安静段与响段的峰值明显不同', () => {
    const quiet = slicePeaks(data, 0, 0.5, 20);
    const loud = slicePeaks(data, 1.5, 2, 20);
    const quietMax = Math.max(...quiet.map((b) => b.max));
    const loudMax = Math.max(...loud.map((b) => b.max));
    expect(quietMax).toBeLessThan(0.05);
    expect(loudMax).toBeGreaterThan(0.8);
  });

  it('超出素材范围时自动夹紧，不返回 NaN', () => {
    const peaks = slicePeaks(data, -10, 999, 16);
    expect(peaks.length).toBe(16);
    for (const p of peaks) {
      expect(Number.isFinite(p.min)).toBe(true);
      expect(Number.isFinite(p.max)).toBe(true);
    }
  });

  it('零时长区间不崩', () => {
    const peaks = slicePeaks(data, 1, 1, 8);
    expect(peaks.length).toBe(8);
    for (const p of peaks) expect(Number.isFinite(p.min) && Number.isFinite(p.max)).toBe(true);
  });

  it('空波形返回空数组', () => {
    const empty = buildWaveform(new Float32Array(0), 1, 48000);
    expect(slicePeaks(empty, 0, 1, 10)).toEqual([]);
  });
});

describe('缓存', () => {
  beforeEach(() => clearWaveformCache());

  it('缓存键包含素材、字节数、采样率、声道与版本', () => {
    const key = waveformCacheKey({
      assetId: 'a1',
      byteLength: 100,
      sampleRate: 48000,
      channels: 2,
    });
    expect(key).toBe('a1|100|48000|2|v1');
  });

  it('任一维度变化都产生不同的键', () => {
    const base = { assetId: 'a1', byteLength: 100, sampleRate: 48000, channels: 2 };
    const keys = new Set([
      waveformCacheKey(base),
      waveformCacheKey({ ...base, assetId: 'a2' }),
      waveformCacheKey({ ...base, byteLength: 101 }),
      waveformCacheKey({ ...base, sampleRate: 44100 }),
      waveformCacheKey({ ...base, channels: 1 }),
      waveformCacheKey({ ...base, decoderVersion: 2 }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('写入后能读回同一对象', () => {
    const data = buildWaveform(new Float32Array([0.1, 0.2]), 1, 48000);
    putCachedWaveform('k', data);
    expect(getCachedWaveform('k')).toBe(data);
  });

  it('未命中返回 null', () => {
    expect(getCachedWaveform('missing')).toBeNull();
  });

  it('超出上限时淘汰最旧条目', () => {
    const data = buildWaveform(new Float32Array([0.1]), 1, 48000);
    for (let i = 0; i < 70; i++) putCachedWaveform(`k${i}`, data);
    expect(getCachedWaveform('k0')).toBeNull();
    expect(getCachedWaveform('k69')).toBe(data);
  });

  it('clear 清空全部', () => {
    const data = buildWaveform(new Float32Array([0.1]), 1, 48000);
    putCachedWaveform('a', data);
    clearWaveformCache();
    expect(getCachedWaveform('a')).toBeNull();
  });

  it('buildWaveformFromWav 命中缓存时不重复解析', () => {
    const wav = makeFloatWav([0.3, -0.3, 0.6, -0.6], 2, 48000);
    const first = buildWaveformFromWav('wk', wav);
    expect(first).not.toBeNull();
    // 第二次传入垃圾数据，若仍返回同一对象就证明走了缓存
    const second = buildWaveformFromWav('wk', new ArrayBuffer(8));
    expect(second).toBe(first);
  });

  it('坏数据返回 null 而不抛异常', () => {
    expect(buildWaveformFromWav('bad', new ArrayBuffer(4))).toBeNull();
  });
});
