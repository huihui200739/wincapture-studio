/**
 * 保持音调的变速（WSOLA 时间拉伸）
 *
 * 背景：`TimelineAudioMixer` 原来用 `resampleAudioChannels()` 做变速——那是线性插值的
 * 重采样，等价于「改变播放采样率」：2× 播放时音高升一个八度（花栗鼠），0.5× 时降一个八度。
 * 用户要的变速是「时长变了、音调不变」，必须做时间拉伸（time-scale modification）。
 *
 * 实现的是 WSOLA（Waveform Similarity Overlap-Add）：
 *   1. 把源信号按「分析帧」frameSize 切窗，相邻两帧在输出端重叠 overlap 个采样；
 *   2. 每帧向前推进 analysisHop = hop × rate 个**源**采样，但输出只推进
 *      hop = frameSize − overlap 个采样，于是输出时长 = 源时长 / rate；
 *      帧内波形本身没有被压缩或拉伸，所以基频（音高）不变；
 *   3. 直接叠加会在重叠区产生相位抵消（听起来是金属味的梳状滤波），
 *      因此在 ±search 范围内搜索一个偏移，让新帧的前 overlap 个采样与
 *      已输出的尾部波形最相似（归一化互相关最大），再做交叉淡化叠加。
 *
 * 几个必须注意的点：
 * - **前瞻量**：放慢（rate<1）时 analysisHop 小于 frameSize，产出 hop 个输出需要
 *   额外 frameSize − analysisHop 个源采样才能凑齐一个完整帧。这是 OLA 的固有代价，
 *   由 `primerSamples` 暴露给调用方，首次取源时多取这一段即可，之后稳态严格 1:rate。
 * - **保留尾部**：最后 overlap 个已合成采样还要参与下一次交叉淡化，未 `markEnd()`
 *   之前不能交给消费方，否则重叠区被提前固化成错误的波形。
 * - 相似性比较只看第 0 声道：多声道素材的声道间高度相关，用单声道求偏移既能省掉
 *   N 倍算力，又能保证所有声道用**同一个**偏移，不会把立体声像拉散。
 */

/** 分析帧时长（秒）。约 40ms，兼顾低频周期完整性与时间分辨率。 */
const FRAME_SECONDS = 0.04;
/** 交叉淡化重叠时长（秒）。约 12ms，短到不会有明显的重复感，长到足以平滑。 */
const OVERLAP_SECONDS = 0.012;
/** 相似性搜索窗口 = hop × 该比例，并夹到 [8, 512] 个采样。 */
const SEARCH_RATIO = 0.25;
const SEARCH_MIN = 8;
const SEARCH_MAX = 512;

export interface TimeStretchLayout {
  /** 分析帧长度（源采样） */
  frameSize: number;
  /** 交叉淡化重叠长度（输出采样） */
  overlap: number;
  /** 每帧推进的输出采样数 = frameSize − overlap */
  hop: number;
  /** 每帧推进的源采样数 = round(hop × rate) */
  analysisHop: number;
  /** 相似性搜索半径（源采样） */
  search: number;
  /**
   * 启动前瞻：首次取源时，除「本段输出对应的源长度」外还需要的额外源采样数。
   * 放慢时为正（必须多取），加速时为 0（帧在源上不再重叠）。
   */
  primerSamples: number;
}

function clampInt(value: number, min: number, max: number): number {
  const v = Math.round(Number.isFinite(value) ? value : min);
  return v < min ? min : v > max ? max : v;
}

/**
 * 由采样率与播放速度推导 WSOLA 的窗口参数。
 *
 * rate 非法（≤0 / NaN）时按 1 处理：宁可原速播放，也不要除零或产出静音。
 */
export function timeStretchLayout(sampleRate: number, rate: number): TimeStretchLayout {
  const sr = clampInt(sampleRate, 8000, 192_000);
  const value = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const frameSize = clampInt(sr * FRAME_SECONDS, 128, 8192);
  const overlap = clampInt(sr * OVERLAP_SECONDS, 32, Math.max(32, Math.floor(frameSize / 2)));
  const hop = Math.max(1, frameSize - overlap);
  const analysisHop = Math.max(1, Math.round(hop * value));
  const search = clampInt(hop * SEARCH_RATIO, SEARCH_MIN, SEARCH_MAX);
  return {
    frameSize,
    overlap,
    hop,
    analysisHop,
    search,
    primerSamples: Math.max(0, frameSize - analysisHop),
  };
}

/**
 * 流式 WSOLA 时间拉伸器。
 *
 * 用法：
 *   const s = new PitchPreservingStretcher(48000, 2, 2); // 2 倍速、保持音调
 *   s.push(pcm, frameCount);        // 源端连续追加
 *   const out = s.produce(4096);    // 取 4096 个输出采样（不足处补 0）
 *   s.markEnd();                    // 源已取完，释放尾部
 *
 * `rate = 1` 时不要使用本类：输出会恒定滞后 overlap 个采样（尾部保留），
 * 而且恒等映射不需要任何处理。调用方按 |rate−1| 判断即可。
 */
export class PitchPreservingStretcher {
  readonly rate: number;
  readonly sampleRate: number;
  readonly layout: TimeStretchLayout;
  private readonly channels: number;

  /** 源 FIFO，有效区间 [0, inputLength) */
  private input: Float32Array[] = [];
  private inputLength = 0;
  /** 下一帧的标称起点（源 FIFO 内的索引） */
  private nextBase = 0;
  /** 实际起点相对名义起点的累计漂移，被 pump() 钳制在 ±search 内 */
  private drift = 0;
  private primed = false;
  private ended = false;

  /** 输出累积区，有效区间 [0, outputLength)，已取走 [0, outputTaken) */
  private output: Float32Array[] = [];
  private outputLength = 0;
  private outputTaken = 0;

  constructor(sampleRate: number, channels: number, rate: number) {
    this.sampleRate = Math.max(1, Math.round(sampleRate) || 48_000);
    this.channels = Math.max(1, Math.round(channels) || 1);
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.layout = timeStretchLayout(this.sampleRate, this.rate);
    for (let ch = 0; ch < this.channels; ch++) {
      this.input.push(new Float32Array(this.layout.frameSize * 4));
      this.output.push(new Float32Array(this.layout.frameSize * 4));
    }
  }

  /** 启动前瞻（源采样），调用方首次取源时应在需求之外多取这一段。 */
  get primerSamples(): number {
    return this.layout.primerSamples;
  }

  /** 当前可取走的输出采样数（不含还要参与交叉淡化的尾部）。 */
  get available(): number {
    this.pump();
    const committed = this.ended ? this.outputLength : Math.max(0, this.outputLength - this.layout.overlap);
    return Math.max(0, committed - this.outputTaken);
  }

  /** 源 FIFO 中尚未消费的采样数（诊断用）。 */
  get pendingInputSamples(): number {
    return this.inputLength;
  }

  /**
   * 追加源 PCM（平面 Float32）。
   *
   * 声道数少于构造值时按最后一个声道复制，保持与混音器「单声道素材铺满全部声道」
   * 的既有行为一致；多于构造值的部分忽略（混音器只按输出声道数混合）。
   */
  push(frames: readonly Float32Array[], frameCount = frames[0]?.length ?? 0): void {
    const count = Math.min(frameCount, ...frames.map((f) => f.length));
    if (!frames.length || !Number.isFinite(count) || count <= 0) return;
    this.ensureInput(this.inputLength + count);
    for (let ch = 0; ch < this.channels; ch++) {
      const src = frames[Math.min(ch, frames.length - 1)];
      this.input[ch].set(src.subarray(0, count), this.inputLength);
    }
    this.inputLength += count;
  }

  /**
   * 取 count 个输出采样。不足处补 0（与旧的重采样实现一致：宁可极短静音也不越界读）。
   * 返回的数组长度恒为 count，方便调用方按固定网格写入。
   */
  produce(count: number): Float32Array[] {
    const n = Math.max(0, Math.floor(count));
    this.pump();
    const committed = this.ended ? this.outputLength : Math.max(0, this.outputLength - this.layout.overlap);
    const take = Math.max(0, Math.min(n, committed - this.outputTaken));
    const out: Float32Array[] = [];
    for (let ch = 0; ch < this.channels; ch++) {
      const dst = new Float32Array(n);
      if (take > 0) dst.set(this.output[ch].subarray(this.outputTaken, this.outputTaken + take), 0);
      out.push(dst);
    }
    this.outputTaken += take;
    this.compactOutput();
    return out;
  }

  /**
   * 标记源已取完：释放保留的尾部，并用补零凑齐最后一个分析帧，
   * 否则结尾会缺 frameSize − analysisHop 对应的输出（放慢时可达上百毫秒）。
   */
  markEnd(): void {
    if (this.ended) return;
    this.pump();
    this.ended = true;
    if (!this.primed) return;
    // 补零凑齐最后的分析帧。补 frameSize + analysisHop 而不是只补 frameSize：
    // 输出是以 hop 为量子产生的，量化截断最多会再吃掉一个 hop，
    // 只补一帧时结尾仍可能缺几十毫秒（放慢时更明显）。
    const pad = this.layout.frameSize + this.layout.analysisHop;
    const zeros = new Float32Array(pad);
    this.push([zeros], pad);
    this.pump();
  }

  /** 丢弃全部状态（速率改变或区间重新开始时用）。 */
  reset(): void {
    this.inputLength = 0;
    this.nextBase = 0;
    this.drift = 0;
    this.primed = false;
    this.ended = false;
    this.outputLength = 0;
    this.outputTaken = 0;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 尽可能多地合成整帧，直到源不足以再放一帧。
   *
   * 关键约束：**平均变速比必须等于 rate**。相似性搜索每帧都会挑一个偏移，
   * 对周期信号这些偏移往往同号（例如纯音的所有可选偏移都相差整数个周期），
   * 自由累积下来实际倍速会明显偏离设定值（实测 0.5× 会跑成约 0.35×，
   * 结尾提前几十毫秒就没声了）。因此把「实际起点 − 名义起点」的累计漂移
   * 钳制在 ±search 之内：搜索范围按名义位置而非上一帧的实际位置划定。
   * 漂移有界 → 每帧的平均源推进量收敛到 analysisHop → 时长严格等于 源/rate。
   */
  private pump(): void {
    const { frameSize, analysisHop, search } = this.layout;
    let guard = 0;
    while (guard++ < 4096) {
      let start = -1;
      // 名义起点：不考虑搜索偏移时本帧应落的源位置（首帧为 0）
      const nominal = this.primed ? this.nextBase - this.drift : 0;
      if (!this.primed) {
        // 首帧没有可对齐的尾部，直接落在源 0 处（也是输出的 0 号采样，保证零延迟）。
        if (this.inputLength < frameSize) return;
        start = 0;
      } else {
        const lo = Math.max(0, nominal - search);
        const hi = Math.min(this.inputLength - frameSize, nominal + search);
        let bestScore = -Infinity;
        for (let s = lo; s <= hi; s++) {
          const score = this.similarity(s);
          if (score > bestScore) {
            bestScore = score;
            start = s;
          }
        }
      }
      if (start < 0) return;
      this.drift = start - nominal;
      this.placeFrame(start);
      // 下一帧的候选区间是 [nominalNext − search, nominalNext + search]，
      // 只保留这一段，源 FIFO 才不会随导出时长线性增长。
      const nominalNext = nominal + analysisHop;
      const keepFrom = Math.max(0, Math.min(this.inputLength, nominalNext - search));
      this.discardInput(keepFrom);
      this.nextBase = start + analysisHop - keepFrom;
    }
  }

  /**
   * 把源 [start, start+frameSize) 叠加到输出尾部。
   *
   * 第一帧直接落盘（无重叠可淡化）；之后先对 overlap 区做线性交叉淡化，
   * 再把新区间整段拷入。写入位置恒为「上一帧之后的 commit 点」，
   * 因此输出长度每帧只增加 hop = frameSize − overlap 个采样。
   */
  private placeFrame(start: number): void {
    const { frameSize, overlap } = this.layout;
    if (start < 0 || start + frameSize > this.inputLength) return;
    const writeAt = this.primed ? this.outputLength - overlap : 0;
    this.ensureOutput(writeAt + frameSize);
    for (let ch = 0; ch < this.channels; ch++) {
      const dst = this.output[ch];
      const src = this.input[ch];
      if (!this.primed) {
        for (let i = 0; i < frameSize; i++) dst[i] = src[start + i];
        continue;
      }
      for (let i = 0; i < overlap; i++) {
        const t = (i + 1) / (overlap + 1);
        dst[writeAt + i] = dst[writeAt + i] * (1 - t) + src[start + i] * t;
      }
      for (let i = overlap; i < frameSize; i++) dst[writeAt + i] = src[start + i];
    }
    this.outputLength = writeAt + frameSize;
    this.primed = true;
  }

  /**
   * 归一化互相关：候选帧的前 overlap 个采样 vs 已输出的尾部。
   * 取最大值对应的偏移，能把叠加处的波形不连续降到最低。
   */
  private similarity(start: number): number {
    const { overlap } = this.layout;
    const w = this.outputLength - overlap;
    if (w < 0) return 0;
    const x = this.input[0];
    const y = this.output[0];
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < overlap; i++) {
      const a = x[start + i];
      const b = y[w + i];
      sxy += a * b;
      sxx += a * a;
      syy += b * b;
    }
    const denom = Math.sqrt(sxx * syy);
    if (denom < 1e-12) return 0;
    return sxy / denom;
  }

  private ensureInput(needed: number): void {
    if (needed <= this.input[0].length) return;
    let cap = this.input[0].length;
    while (cap < needed) cap *= 2;
    for (let ch = 0; ch < this.channels; ch++) {
      const next = new Float32Array(cap);
      next.set(this.input[ch].subarray(0, this.inputLength), 0);
      this.input[ch] = next;
    }
  }

  private ensureOutput(needed: number): void {
    if (needed <= this.output[0].length) return;
    let cap = this.output[0].length;
    while (cap < needed) cap *= 2;
    for (let ch = 0; ch < this.channels; ch++) {
      const next = new Float32Array(cap);
      next.set(this.output[ch].subarray(0, this.outputLength), 0);
      this.output[ch] = next;
    }
  }

  private discardInput(count: number): void {
    if (count <= 0) return;
    if (count >= this.inputLength) {
      this.inputLength = 0;
      return;
    }
    for (let ch = 0; ch < this.channels; ch++) {
      this.input[ch].copyWithin(0, count, this.inputLength);
    }
    this.inputLength -= count;
  }

  /** 已取走的采样不会再用，定期前移避免输出缓冲随导出时长线性增长。 */
  private compactOutput(): void {
    if (this.outputTaken < 8192) return;
    for (let ch = 0; ch < this.channels; ch++) {
      this.output[ch].copyWithin(0, this.outputTaken, this.outputLength);
    }
    this.outputLength -= this.outputTaken;
    this.outputTaken = 0;
  }
}

/**
 * 便捷函数：一次性把一段 PCM 按 rate 时间拉伸（保持音调）。
 *
 * 用于测试与离线小段处理；流式场景请用 `PitchPreservingStretcher`。
 * 注意结尾会缺至多 primerSamples/rate 个输出采样（OLA 的固有前瞻），
 * 长链路应优先用流式接口并在末尾调用 markEnd()。
 */
export function timeStretchChannels(
  channels: readonly Float32Array[],
  rate: number,
  sampleRate = 48_000,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const stretch = new PitchPreservingStretcher(sampleRate, Math.max(1, channels.length), rate);
  stretch.push(channels, frames);
  stretch.markEnd();
  const total = Math.max(0, Math.round(frames / (Number.isFinite(rate) && rate > 0 ? rate : 1)));
  return stretch.produce(total);
}
