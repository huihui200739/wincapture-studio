/**
 * 波形峰值缓存（§10.4）
 *
 * 文档要求：「波形采用分层峰值缓存，缩略图按可视时间区间惰性生成。
 * 缓存键包含素材哈希、解码版本、采样规则和遮挡版本。缓存失效时可重建，
 * 不视为工程损坏。」
 *
 * 实现要点：
 * - 分层：每层把上一层两两合并，L0 每桶 = samplesPerBucket 个采样。
 *   放大时用细层，缩小时用粗层，避免每次都扫全量采样。
 * - 惰性：只在轨道可见时才生成，且只算当前视口需要的区间。
 * - 缓存键：素材 id + 文件字节数 + 采样率 + 声道数（工程里 WAV 是不可变分段，
 *   字节数变化即代表换了文件；真正的哈希由主进程落盘时记录，这里用廉价指纹）。
 * - 失效重建：任何异常都退化成「无波形」，绝不让界面报错。
 */

/** 单声道峰值：min/max 用于画对称波形包络。 */
export interface PeakBucket {
  min: number;
  max: number;
}

/** 一层峰值数据。 */
export interface PeakLevel {
  /** 每桶覆盖的采样数（L0 最小） */
  samplesPerBucket: number;
  buckets: PeakBucket[];
}

export interface WaveformData {
  /** 采样率 */
  sampleRate: number;
  /** 声道数（已合并成单声道峰值） */
  channels: number;
  /** 总采样数（每声道） */
  totalSamples: number;
  /** 分层峰值，L0 最细 */
  levels: PeakLevel[];
}

const DEFAULT_BASE_BUCKET = 256;
const MAX_LEVELS = 8;
/** 缓存上限，防止长时间编辑把内存吃满。 */
const MAX_CACHE_ENTRIES = 64;

const cache = new Map<string, WaveformData>();

/** 生成缓存键（§10.4：素材 + 解码版本 + 采样规则）。 */
export function waveformCacheKey(input: {
  assetId: string;
  byteLength: number;
  sampleRate: number;
  channels: number;
  /** 解码实现版本，改动解码逻辑时递增即可整体失效 */
  decoderVersion?: number;
}): string {
  const version = input.decoderVersion ?? 1;
  return `${input.assetId}|${input.byteLength}|${input.sampleRate}|${input.channels}|v${version}`;
}

/**
 * 解析 32-bit float WAV（录制端写入的格式：WAVE_FORMAT_IEEE_FLOAT，立体声）。
 * 也接受 16-bit PCM，便于以后导入外部音频。
 */
export function parseWav(buffer: ArrayBuffer): {
  sampleRate: number;
  channels: number;
  frames: number;
  /** 交错采样，已归一到 [-1,1] */
  samples: Float32Array;
} | null {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) return null;
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buffer.byteLength - body);
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || channels <= 0 || sampleRate <= 0) return null;

  const bytesPerSample = bitsPerSample / 8;
  if (bytesPerSample <= 0) return null;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frames * channels);

  for (let i = 0; i < frames * channels; i++) {
    const at = dataOffset + i * bytesPerSample;
    if (format === 3 && bitsPerSample === 32) {
      samples[i] = view.getFloat32(at, true);
    } else if (bitsPerSample === 16) {
      samples[i] = view.getInt16(at, true) / 32768;
    } else if (bitsPerSample === 32) {
      samples[i] = view.getInt32(at, true) / 2147483648;
    } else if (bitsPerSample === 8) {
      samples[i] = (view.getUint8(at) - 128) / 128;
    }
  }
  return { sampleRate, channels, frames, samples };
}

/** 从交错采样构建分层峰值。 */
export function buildWaveform(
  samples: Float32Array,
  channels: number,
  sampleRate: number,
  baseBucket = DEFAULT_BASE_BUCKET,
): WaveformData {
  const frames = channels > 0 ? Math.floor(samples.length / channels) : 0;

  // L0：每 baseBucket 帧一个桶，取所有声道合并后的 min/max
  const l0: PeakBucket[] = [];
  for (let start = 0; start < frames; start += baseBucket) {
    const end = Math.min(start + baseBucket, frames);
    let min = 0;
    let max = 0;
    for (let f = start; f < end; f++) {
      // 多声道取平均，避免单声道偏小的声音被另一声道掩盖
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[f * channels + c];
      const v = sum / channels;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    l0.push({ min, max });
  }

  const levels: PeakLevel[] = [{ samplesPerBucket: baseBucket, buckets: l0 }];
  let prev = l0;
  let perBucket = baseBucket;
  for (let level = 1; level < MAX_LEVELS && prev.length > 1; level++) {
    const next: PeakBucket[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i];
      const b = prev[i + 1];
      next.push(
        b
          ? { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
          : { min: a.min, max: a.max },
      );
    }
    perBucket *= 2;
    levels.push({ samplesPerBucket: perBucket, buckets: next });
    prev = next;
  }

  return { sampleRate, channels, totalSamples: frames, levels };
}

/**
 * 取指定时间区间的峰值，自动选择合适层级。
 *
 * @param fromSeconds 区间起点（秒）
 * @param toSeconds   区间终点（秒）
 * @param targetBuckets 期望输出的桶数（一般等于像素宽度）
 */
export function slicePeaks(
  data: WaveformData,
  fromSeconds: number,
  toSeconds: number,
  targetBuckets: number,
): PeakBucket[] {
  const buckets = Math.max(1, Math.floor(targetBuckets));
  if (data.totalSamples <= 0 || data.levels.length === 0) return [];

  const fromSample = Math.max(0, Math.floor(fromSeconds * data.sampleRate));
  const toSample = Math.min(data.totalSamples, Math.ceil(toSeconds * data.sampleRate));
  const spanSamples = Math.max(1, toSample - fromSample);
  const samplesPerOutput = spanSamples / buckets;

  // 选「桶宽不超过输出桶宽」的最粗层，保证不丢细节也不做无谓计算
  let level = data.levels[0];
  for (const candidate of data.levels) {
    if (candidate.samplesPerBucket <= samplesPerOutput) level = candidate;
    else break;
  }

  const out: PeakBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    const startSample = fromSample + i * samplesPerOutput;
    const endSample = fromSample + (i + 1) * samplesPerOutput;
    const startBucket = Math.floor(startSample / level.samplesPerBucket);
    const endBucket = Math.max(startBucket + 1, Math.ceil(endSample / level.samplesPerBucket));
    let min = 0;
    let max = 0;
    let seen = false;
    for (let b = startBucket; b < endBucket && b < level.buckets.length; b++) {
      const bucket = level.buckets[b];
      if (!bucket) continue;
      if (!seen) {
        min = bucket.min;
        max = bucket.max;
        seen = true;
      } else {
        if (bucket.min < min) min = bucket.min;
        if (bucket.max > max) max = bucket.max;
      }
    }
    out.push(seen ? { min, max } : { min: 0, max: 0 });
  }
  return out;
}

/** 读取缓存。 */
export function getCachedWaveform(key: string): WaveformData | null {
  return cache.get(key) ?? null;
}

/** 写入缓存（超出上限时按插入顺序淘汰最旧的）。 */
export function putCachedWaveform(key: string, data: WaveformData): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, data);
}

/** 清空缓存（素材被移除或工程关闭时调用）。 */
export function clearWaveformCache(): void {
  cache.clear();
}

/**
 * 从 WAV 字节构建波形并写缓存。失败返回 null —— 波形是装饰性信息，
 * 生成失败不能影响编辑（§10.4「缓存失效时可重建，不视为工程损坏」）。
 */
export function buildWaveformFromWav(
  key: string,
  buffer: ArrayBuffer,
  baseBucket = DEFAULT_BASE_BUCKET,
): WaveformData | null {
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const parsed = parseWav(buffer);
    if (!parsed) return null;
    const data = buildWaveform(parsed.samples, parsed.channels, parsed.sampleRate, baseBucket);
    putCachedWaveform(key, data);
    return data;
  } catch {
    return null;
  }
}
