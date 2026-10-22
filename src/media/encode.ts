/**
 * 媒体编码层（开发文档 §11.3 / §9.5）
 *
 * 职责：把「一帧画面 + 一段 PCM」编码成独立可解码的 MP4 分段。
 * - 视频：WebCodecs VideoEncoder（H.264 High Profile），优先硬件，失败降级软件
 * - 音频：WebCodecs AudioEncoder（AAC-LC 48kHz）
 * - 封装：mediabunny Mp4OutputFormat，每段自包含（moov 前置），可独立解码
 *
 * 分段的意义（§9.5）：录制中以约 2 秒提交独立可解码段，任一段损坏不影响其他段，
 * 崩溃恢复损失上限 4 秒。
 */

import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  canEncodeVideo,
  canEncodeAudio,
} from 'mediabunny';

export interface EncodeCapabilities {
  videoCodec: 'avc' | 'vp9' | null;
  audioCodec: 'aac' | 'opus' | null;
  hardwareVideo: boolean;
  detail: string;
}

/** 探测本机可用的编码能力，结果用于界面显示「实际生效档位」与降级原因（§9.5）。 */
export async function probeEncodeCapabilities(width: number, height: number): Promise<EncodeCapabilities> {
  const detail: string[] = [];
  let videoCodec: 'avc' | 'vp9' | null = null;
  let hardwareVideo = false;

  for (const codec of ['avc', 'vp9'] as const) {
    for (const hw of ['prefer-hardware', 'prefer-software', 'no-preference'] as const) {
      try {
        const ok = await canEncodeVideo(codec, {
          width,
          height,
          bitrate: 12_000_000,
          hardwareAcceleration: hw as HardwareAcceleration,
        });
        if (ok) {
          videoCodec = codec;
          hardwareVideo = hw === 'prefer-hardware';
          detail.push(`video=${codec} (${hw})`);
          break;
        }
        detail.push(`video=${codec} (${hw}) 不可用`);
      } catch (e) {
        detail.push(`video=${codec} (${hw}) 探测失败: ${String(e)}`);
      }
    }
    if (videoCodec) break;
  }

  let audioCodec: 'aac' | 'opus' | null = null;
  for (const codec of ['aac', 'opus'] as const) {
    try {
      const ok = await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192_000 });
      if (ok) {
        audioCodec = codec;
        detail.push(`audio=${codec}`);
        break;
      }
      detail.push(`audio=${codec} 不可用`);
    } catch (e) {
      detail.push(`audio=${codec} 探测失败: ${String(e)}`);
    }
  }

  return { videoCodec, audioCodec, hardwareVideo, detail: detail.join('; ') };
}

export interface SegmentEncodeOptions {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  /** 视频编码器优先策略 */
  hardwarePreferred: boolean;
  /** 是否包含音频轨 */
  includeAudio: boolean;
  audioSampleRate: number;
  audioChannels: number;
  /** 首帧时间戳（微秒），用于跨段连续时间轴 */
  startTimestampUs: number;
}

export interface SegmentResult {
  /** 完整的 MP4 字节 */
  data: Uint8Array;
  frames: number;
  /** 该段覆盖的时长（微秒） */
  durationUs: number;
  /** 实际使用的编码器描述，界面显示真实档位 */
  encoder: string;
}

/**
 * 分段编码器：收集帧与 PCM，finalize 时产出独立 MP4。
 *
 * 使用方式：
 *   const seg = new SegmentEncoder(opts);
 *   seg.addVideoFrame(canvas, timestampUs);
 *   seg.addAudioSamples(float32Planar, timestampUs);
 *   const result = await seg.finalize();
 */
export class SegmentEncoder {
  private output: Output | null = null;
  private videoSource: CanvasSource | null = null;
  private audioSource: AudioBufferSource | null = null;
  private started = false;
  private audioContext: OfflineAudioContext | null = null;
  private readonly pendingAudio: { data: Float32Array[]; timestampUs: number }[] = [];
  private framesWritten = 0;
  private firstTimestampUs: number | null = null;
  private lastTimestampUs = 0;
  private encoderLabel = 'unknown';
  private videoCodec: 'avc' | 'vp9' = 'avc';
  private failed: Error | null = null;

  constructor(private readonly options: SegmentEncodeOptions) {}

  async init(): Promise<void> {
    const { width, height, fps, videoBitrate, audioBitrate, hardwarePreferred, includeAudio, audioSampleRate, audioChannels } = this.options;

    // 视频编码器：优先硬件，失败降级软件（§11.3）
    const attempts: HardwareAcceleration[] = hardwarePreferred
      ? ['prefer-hardware', 'no-preference', 'prefer-software']
      : ['no-preference', 'prefer-software'];
    let chosen: { codec: 'avc' | 'vp9'; hw: HardwareAcceleration } | null = null;
    for (const codec of ['avc', 'vp9'] as const) {
      for (const hw of attempts) {
        try {
          const ok = await canEncodeVideo(codec, { width, height, bitrate: videoBitrate, hardwareAcceleration: hw });
          if (ok) {
            chosen = { codec, hw };
            break;
          }
        } catch {
          // 继续尝试下一个组合
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      throw new Error('本机没有可用的视频编码器（H.264/VP9 均不可用）');
    }
    this.videoCodec = chosen.codec;
    this.encoderLabel = `${chosen.codec} (${chosen.hw})`;

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!ctx) throw new Error('无法创建 2D 画布上下文');
    this.canvas = canvas;
    this.ctx = ctx;

    this.videoSource = new CanvasSource(canvas, {
      codec: this.videoCodec,
      bitrate: videoBitrate,
      hardwareAcceleration: chosen.hw,
    });
    output.addVideoTrack(this.videoSource, { frameRate: fps });

    if (includeAudio) {
      // mediabunny 的 AudioBufferSource 只接收 AudioBuffer，声道数/采样率由 buffer 本身决定，
      // 时间位置通过构造选项的 startTimestamp 设定（不是每次 add 传参）。
      this.audioSource = new AudioBufferSource({
        codec: 'aac',
        bitrate: audioBitrate,
      });
      output.addAudioTrack(this.audioSource);
      this.audioContext = new OfflineAudioContext(audioChannels, audioSampleRate, audioSampleRate);
      this.audioChannels = audioChannels;
      this.audioSampleRate = audioSampleRate;
    }

    this.output = output;
    await output.start();
    this.started = true;
  }

  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private audioChannels = 2;
  private audioSampleRate = 48_000;

  /** 当前段的绘制上下文；录制端把画面绘制到它上面再调用 commitVideoFrame。 */
  get drawContext(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) throw new Error('SegmentEncoder 尚未初始化');
    return this.ctx;
  }

  get canvasElement(): OffscreenCanvas {
    if (!this.canvas) throw new Error('SegmentEncoder 尚未初始化');
    return this.canvas;
  }

  /**
   * 提交当前画布内容为视频帧。
   *
   * @param timestampUs 该帧时间戳（相对段起点，微秒）
   * @param durationUs 该帧时长（微秒）；省略时按 1/fps。
   *   允许显式指定是为了消除累计取整误差：mediabunny 按 1/fps 写入每帧时长时，
   *   60 帧（2 秒 @30fps）会被量化成 2.005333 秒，多出 5.333ms。
   *   单段无感，但 30 段累计 160ms，会让「音画偏差 ≤80ms」超标。
   *   调用方在段末把差值补到最后一帧即可精确对齐。
   */
  async commitVideoFrame(timestampUs: number, durationUs?: number): Promise<void> {
    if (!this.started || !this.videoSource) throw new Error('SegmentEncoder 未启动');
    if (this.firstTimestampUs === null) this.firstTimestampUs = timestampUs;
    // mediabunny 的 CanvasSource.add(timestampSeconds, durationSeconds)
    const relSeconds = (timestampUs - this.options.startTimestampUs) / 1e6;
    const durSeconds = durationUs && durationUs > 0 ? durationUs / 1e6 : 1 / this.options.fps;
    await this.videoSource.add(Math.max(0, relSeconds), durSeconds);
    this.framesWritten += 1;
    this.lastTimestampUs = timestampUs;
  }

  /** 追加音频（Float32 平面数据），时间戳为该批首个样本的时间。 */
  async addAudio(data: Float32Array[], timestampUs: number, sampleRate: number): Promise<void> {
    if (!this.audioSource || !this.audioContext) return;
    const frames = data[0]?.length ?? 0;
    if (frames === 0) return;
    const buffer = this.audioContext.createBuffer(data.length, frames, sampleRate);
    for (let ch = 0; ch < data.length; ch++) {
      buffer.copyToChannel(data[ch] as Float32Array<ArrayBuffer>, ch);
    }
    // AudioBufferSource.add 只接收 AudioBuffer，位置由构造时的 startTimestamp 决定；
    // 分段编码时音频总是从段首开始，因此这里直接追加即可（顺序拼接）。
    void timestampUs;
    await this.audioSource.add(buffer);
    if (this.firstTimestampUs === null) this.firstTimestampUs = timestampUs;
  }

  /** 完成本段封装，返回可独立解码的 MP4 字节。 */
  async finalize(): Promise<SegmentResult> {
    if (!this.output || !this.started) throw new Error('SegmentEncoder 未启动');
    if (this.failed) throw this.failed;
    // 至少写一帧，避免空轨
    if (this.framesWritten === 0 && this.canvas) {
      await this.commitVideoFrame(this.options.startTimestampUs);
    }
    await this.output.finalize();
    const target = this.output.target as BufferTarget;
    const data = new Uint8Array(target.buffer as ArrayBuffer);
    const durationUs =
      this.firstTimestampUs !== null && this.lastTimestampUs > this.firstTimestampUs
        ? this.lastTimestampUs - this.firstTimestampUs + 1e6 / this.options.fps
        : (this.framesWritten * 1e6) / this.options.fps;
    return {
      data,
      frames: this.framesWritten,
      durationUs: Math.max(1, Math.round(durationUs)),
      encoder: this.encoderLabel,
    };
  }

  abort(): void {
    try {
      void this.output?.cancel();
    } catch {
      // 忽略取消异常
    }
  }

  /**
   * 释放本实例占用的原生资源。
   *
   * 每段都要新建编码器（复用会被 mediabunny 的连续时间戳假设破坏），
   * 而一个实例持有硬件 VideoEncoder（GPU 上下文）、AudioBufferSource
   * 和 Output 封装器。不显式释放的话这些资源只能等 GC，
   * 实测长时间录制时进程树内存随分段数线性增长
   * （40 秒涨到 3058MB，超出 §16.2 的 1.2GB）。
   *
   * canvas 由调用方持有（drawContext），这里只断开本实例的引用，
   * 调用方需自行把 canvas 尺寸置零以归还后备存储。
   */
  dispose(): void {
    // 取消未完成的输出（已 finalize 的会静默失败）
    try {
      void this.output?.cancel();
    } catch {
      // 忽略
    }
    this.output = null;
    this.videoSource = null;
    this.audioSource = null;
    // OfflineAudioContext 没有显式 close()，断开引用即可
    this.audioContext = null;
    this.pendingAudio.length = 0;
    this.started = false;
  }
}

// ---------------------------------------------------------------------------
// 输出容器（导出用）：一个连续 MP4，而不是分段
// ---------------------------------------------------------------------------

export interface MuxerOptions {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  audioSampleRate: number;
  audioChannels: number;
  includeAudio: boolean;
}

/**
 * 连续输出封装器：导出时把整段视频写成一个 MP4。
 * 使用 mediabunny 的 CanvasSource / AudioBufferSource。
 */
export class ContinuousMuxer {
  private output: Output | null = null;
  private videoSource: CanvasSource | null = null;
  private audioSource: AudioBufferSource | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private audioContext: OfflineAudioContext | null = null;
  private frames = 0;
  private encoderLabel = 'unknown';

  constructor(private readonly options: MuxerOptions) {}

  async init(hardwarePreferred = true): Promise<string> {
    const { width, height, fps, videoBitrate, audioBitrate, audioSampleRate, audioChannels, includeAudio } = this.options;
    const attempts: HardwareAcceleration[] = hardwarePreferred
      ? ['prefer-hardware', 'no-preference', 'prefer-software']
      : ['no-preference', 'prefer-software'];
    let chosen: { codec: 'avc' | 'vp9'; hw: HardwareAcceleration } | null = null;
    for (const codec of ['avc', 'vp9'] as const) {
      for (const hw of attempts) {
        try {
          if (await canEncodeVideo(codec, { width, height, bitrate: videoBitrate, hardwareAcceleration: hw })) {
            chosen = { codec, hw };
            break;
          }
        } catch {
          /* 继续 */
        }
      }
      if (chosen) break;
    }
    if (!chosen) throw new Error('本机没有可用的视频编码器');

    this.encoderLabel = `${chosen.codec} (${chosen.hw})`;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建画布');
    this.canvas = canvas;
    this.ctx = ctx;
    this.videoSource = new CanvasSource(canvas, { codec: chosen.codec, bitrate: videoBitrate, hardwareAcceleration: chosen.hw });
    output.addVideoTrack(this.videoSource, { frameRate: fps });

    if (includeAudio) {
      // AudioBufferSource 的采样率/声道由传入的 AudioBuffer 决定，位置按追加顺序排列。
      // 导出时音频必须连续追加（缺口需显式补静音 buffer），见 addSilence。
      this.audioSource = new AudioBufferSource({
        codec: 'aac',
        bitrate: audioBitrate,
      });
      output.addAudioTrack(this.audioSource);
      this.audioContext = new OfflineAudioContext(audioChannels, audioSampleRate, audioSampleRate);
      this.audioChannels = audioChannels;
      this.audioSampleRate = audioSampleRate;
    }
    this.output = output;
    await output.start();
    return this.encoderLabel;
  }

  private audioChannels = 2;
  private audioSampleRate = 48_000;

  get drawContext(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) throw new Error('未初始化');
    return this.ctx;
  }

  async addFrame(timestampSeconds: number): Promise<void> {
    if (!this.videoSource) throw new Error('未初始化');
    await this.videoSource.add(timestampSeconds, 1 / this.options.fps);
    this.frames += 1;
  }

  /**
   * 追加音频。注意：mediabunny 的 AudioBufferSource 按「顺序拼接」语义工作，
   * 不支持任意时间戳跳转，因此调用方必须按时间顺序、无空洞地追加；
   * 空洞用 addSilence 显式补齐，避免音画漂移。
   */
  async addAudio(buffer: AudioBuffer): Promise<void> {
    if (!this.audioSource) return;
    await this.audioSource.add(buffer);
  }

  /** 补一段静音，用于填充音频缺口（保持时间轴连续）。 */
  async addSilence(durationSeconds: number): Promise<void> {
    if (!this.audioSource || !this.audioContext) return;
    const frames = Math.max(1, Math.round(durationSeconds * this.audioSampleRate));
    const buffer = this.audioContext.createBuffer(this.audioChannels, frames, this.audioSampleRate);
    await this.audioSource.add(buffer);
  }

  get audioBufferFactory(): OfflineAudioContext | null {
    return this.audioContext;
  }

  async finalize(): Promise<{ data: Uint8Array; frames: number; encoder: string }> {
    if (!this.output) throw new Error('未初始化');
    await this.output.finalize();
    const target = this.output.target as BufferTarget;
    return { data: new Uint8Array(target.buffer as ArrayBuffer), frames: this.frames, encoder: this.encoderLabel };
  }

  async cancel(): Promise<void> {
    try {
      await this.output?.cancel();
    } catch {
      /* 忽略 */
    }
  }
}
