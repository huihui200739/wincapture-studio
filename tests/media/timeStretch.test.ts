import { describe, it, expect } from 'vitest';
import {
  PitchPreservingStretcher,
  timeStretchChannels,
  timeStretchLayout,
} from '../../src/media/timeStretch';

const SR = 48_000;

/** 正弦波：用于检查音高（周期）是否被时间拉伸改变。 */
function sine(freq: number, seconds: number, sampleRate = SR): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function ramp(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => i / n);
}

/** 过零率：粗略但稳定的音高代理指标。音调不变时它应保持不变。 */
function zeroCrossingRate(data: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  }
  return data.length > 1 ? crossings / (data.length - 1) : 0;
}

/** 估算基频：统计相邻同向过零点的间隔。 */
function estimatePitch(data: Float32Array, sampleRate = SR): number {
  const rising: number[] = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] < 0 && data[i] >= 0) rising.push(i);
  }
  if (rising.length < 3) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < rising.length; i++) gaps.push(rising[i] - rising[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 0 ? sampleRate / median : 0;
}

describe('timeStretchLayout: 窗口参数', () => {
  it('hop = frameSize - overlap，analysisHop = hop × rate', () => {
    const l = timeStretchLayout(SR, 1.5);
    expect(l.hop).toBe(l.frameSize - l.overlap);
    expect(l.analysisHop).toBe(Math.round(l.hop * 1.5));
    expect(l.overlap).toBeGreaterThan(0);
    expect(l.overlap).toBeLessThan(l.frameSize);
  });

  it('放慢时存在正的前瞻，加速时为 0', () => {
    expect(timeStretchLayout(SR, 0.5).primerSamples).toBeGreaterThan(0);
    expect(timeStretchLayout(SR, 4).primerSamples).toBe(0);
  });

  it('非法 rate 退化为 1，不产生 NaN/除零', () => {
    for (const rate of [Number.NaN, 0, -2]) {
      const l = timeStretchLayout(SR, rate);
      expect(Number.isFinite(l.analysisHop)).toBe(true);
      expect(l.analysisHop).toBeGreaterThan(0);
      expect(l.frameSize).toBeGreaterThan(l.overlap);
    }
  });
});

describe('PitchPreservingStretcher: 时长与音调', () => {
  it('2 倍速输出长度约为源的一半', () => {
    const src = sine(220, 1);
    const [out] = timeStretchChannels([src], 2, SR);
    expect(out.length).toBeCloseTo(src.length / 2, -2);
    expect(out.length).toBeGreaterThan(src.length * 0.45);
    expect(out.length).toBeLessThan(src.length * 0.55);
  });

  it('0.5 倍速输出长度约为源的两倍', () => {
    const src = sine(220, 1);
    const [out] = timeStretchChannels([src], 0.5, SR);
    expect(out.length).toBeGreaterThan(src.length * 1.9);
    expect(out.length).toBeLessThan(src.length * 2.1);
  });

  it('2 倍速后基频不变（对比重采样会翻倍）', () => {
    const src = sine(220, 1);
    const [out] = timeStretchChannels([src], 2, SR);
    const pitch = estimatePitch(out.subarray(SR * 0.05, SR * 0.45));
    expect(pitch).toBeGreaterThan(200);
    expect(pitch).toBeLessThan(242);
  });

  it('0.5 倍速后基频不变', () => {
    const src = sine(220, 1);
    const [out] = timeStretchChannels([src], 0.5, SR);
    const pitch = estimatePitch(out.subarray(SR * 0.3, SR * 1.5));
    expect(pitch).toBeGreaterThan(200);
    expect(pitch).toBeLessThan(242);
  });

  it('变速后过零率保持不变，说明不是重采样', () => {
    const src = sine(330, 1);
    const before = zeroCrossingRate(src);
    for (const rate of [0.25, 0.5, 2, 4]) {
      const [out] = timeStretchChannels([src], rate, SR);
      // 只看中间 90%：开头一帧与结尾补零是 OLA 的固有边界，不代表稳态音高
      const from = Math.floor(out.length * 0.05);
      const to = Math.floor(out.length * 0.95);
      const after = zeroCrossingRate(out.subarray(from, to));
      // 时间拉伸只改变时长，不改变波形重复速率；重采样会让这个值按 rate 成倍变化
      expect(Math.abs(after - before) / before).toBeLessThan(0.02);
    }
  });

  it('变速后信号仍是非静音的（能量没有塌掉）', () => {
    const src = sine(440, 0.5);
    for (const rate of [0.5, 2]) {
      const [out] = timeStretchChannels([src], rate, SR);
      let energy = 0;
      for (let i = Math.floor(out.length * 0.2); i < out.length * 0.8; i++) energy += out[i] * out[i];
      expect(Math.sqrt(energy / (out.length * 0.6))).toBeGreaterThan(0.3);
    }
  });
});

describe('PitchPreservingStretcher: 流式接口', () => {
  it('分块流式取用与一次性取用产出同样的总时长（跨块不产生空洞）', () => {
    const src = sine(300, 1);
    const want = Math.round(src.length * 2); // 0.5× 拉长一倍

    const once = new PitchPreservingStretcher(SR, 1, 0.5);
    once.push([src], src.length);
    once.markEnd();
    const [oneShot] = once.produce(want);
    expect(oneShot.length).toBe(want);

    const streamed = new PitchPreservingStretcher(SR, 1, 0.5);
    let cursor = 0;
    let total = 0;
    let guard = 0;
    while (total < want && guard++ < 200) {
      if (cursor < src.length) {
        const chunk = Math.min(4096, src.length - cursor);
        streamed.push([src.subarray(cursor, cursor + chunk)], chunk);
        cursor += chunk;
        if (cursor >= src.length) streamed.markEnd();
      }
      const [piece] = streamed.produce(Math.min(4096, want - total));
      total += piece.length;
    }
    expect(total).toBe(want);
  });

  it('分块流式输出与一次性输出逐样本一致（状态跨块连续）', () => {
    const src = sine(300, 1);
    const want = Math.round(src.length * 2);
    const once = new PitchPreservingStretcher(SR, 1, 0.5);
    once.push([src], src.length);
    once.markEnd();
    const [oneShot] = once.produce(want);

    const streamed = new PitchPreservingStretcher(SR, 1, 0.5);
    streamed.push([src], src.length);
    streamed.markEnd();
    const pieces: number[] = [];
    for (let taken = 0; taken < want; ) {
      const n = Math.min(4096, want - taken);
      const [piece] = streamed.produce(n);
      for (const v of piece) pieces.push(v);
      taken += n;
    }
    expect(pieces.length).toBe(want);
    let maxDiff = 0;
    for (let i = 0; i < want; i++) maxDiff = Math.max(maxDiff, Math.abs(pieces[i] - oneShot[i]));
    expect(maxDiff).toBe(0);
  });

  it('放慢时分块取源也能凑满输出（前瞻按需续取，不在块尾留静音）', () => {
    const src = sine(300, 2);
    const s = new PitchPreservingStretcher(SR, 1, 0.25);
    const primer = s.primerSamples;
    expect(primer).toBeGreaterThan(0);
    // 模拟导出器：每次只取「本块输出 × rate + 前瞻」的源
    const chunkOut = 4096;
    let cursor = 0;
    for (let block = 0; block < 8; block++) {
      const wantEnd = Math.min(src.length, cursor + Math.round(chunkOut * 0.25) + primer);
      if (wantEnd <= cursor) break;
      const take = wantEnd - cursor;
      s.push([src.subarray(cursor, wantEnd)], take);
      cursor = wantEnd;
      if (cursor >= src.length) s.markEnd();
      const [out] = s.produce(chunkOut);
      // 除了最后一两块，每块都应拿满；块中间不允许出现静音空洞
      if (block >= 3 && cursor < src.length) {
        let silent = 0;
        for (let i = 0; i < out.length; i += 64) if (Math.abs(out[i]) < 1e-6) silent++;
        expect(silent).toBeLessThan(out.length / 64 / 2);
      }
    }
  });

  it('produce 不足时补 0 且长度恒等于请求值', () => {
    const s = new PitchPreservingStretcher(SR, 2, 2);
    const [l, r] = s.produce(1000);
    expect(l.length).toBe(1000);
    expect(r.length).toBe(1000);
    expect(l.every((v) => v === 0)).toBe(true);
  });

  it('声道数少于构造值时按最后一声道复制，不静音右声道', () => {
    const s = new PitchPreservingStretcher(SR, 2, 2);
    const mono = sine(400, 0.5);
    s.push([mono], mono.length);
    s.markEnd();
    const [l, r] = s.produce(Math.round(mono.length / 2));
    let rl = 0;
    let rr = 0;
    for (let i = 0; i < l.length; i++) {
      rl += Math.abs(l[i]);
      rr += Math.abs(r[i]);
    }
    expect(rr).toBeGreaterThan(0);
    expect(Math.abs(rl - rr)).toBeLessThan(1e-3);
  });

  it('markEnd 后释放保留的尾部，多产出 overlap 个采样', () => {
    const src = sine(200, 1);
    const s = new PitchPreservingStretcher(SR, 1, 1);
    s.push([src], src.length);
    const before = s.available;
    s.markEnd();
    expect(s.available).toBeGreaterThan(before);
  });

  it('reset 后回到初始状态', () => {
    const s = new PitchPreservingStretcher(SR, 1, 2);
    s.push([sine(200, 1)], SR);
    s.markEnd();
    s.produce(4096);
    s.reset();
    expect(s.available).toBe(0);
    expect(s.pendingInputSamples).toBe(0);
  });

  it('长链路不会让源缓冲无限增长', () => {
    const s = new PitchPreservingStretcher(SR, 1, 0.5);
    let cursor = 0;
    let maxPending = 0;
    for (let i = 0; i < 40; i++) {
      const chunk = new Float32Array(2048);
      for (let k = 0; k < chunk.length; k++) chunk[k] = Math.sin((2 * Math.PI * 300 * (cursor + k)) / SR);
      s.push([chunk], chunk.length);
      cursor += chunk.length;
      s.produce(2048);
      maxPending = Math.max(maxPending, s.pendingInputSamples);
    }
    // 稳态下源缓冲只保留「前瞻 + 一帧」的量，不应随块数线性增长
    expect(maxPending).toBeLessThan(20000);
  });
});
