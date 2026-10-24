/**
 * tests/media 共用测试替身。
 *
 * src/media 依赖浏览器 API（OffscreenCanvas / WebCodecs / mediabunny），
 * vitest 运行在 node 环境。这里提供最小可观测的假实现：
 *  - FakeOffscreenCanvas / Fake2DContext：记录 2D 调用序列，供合成器断言；
 *  - fake mediabunny：提供 Input / VideoSampleSink / AudioBufferSink 的可编排行为；
 *  - fake 文件 IO：用于导出器的失败路径（磁盘满 / 改名失败 / 清理残留）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

export interface CanvasOp {
  op: string;
  args: any[];
}

export class FakeGradient {
  stops: { offset: number; color: string }[] = [];
  constructor(
    readonly x0: number,
    readonly y0: number,
    readonly x1: number,
    readonly y1: number,
  ) {}
  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
  }
}

export class Fake2DContext {
  readonly ops: CanvasOp[] = [];
  readonly canvas: { width: number; height: number; getContext?: any };
  fillStyle: any = '#000';
  strokeStyle: any = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  private _filter = 'none';
  /** filter 赋值会被记录，便于断言「真正的模糊」确实应用了高斯滤镜 */
  get filter(): string {
    return this._filter;
  }
  set filter(value: string) {
    this._filter = value;
    this.push('filter', value);
  }
  font = '10px sans-serif';
  textBaseline = 'alphabetic';
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  shadowColor = 'transparent';
  shadowBlur = 0;
  shadowOffsetY = 0;

  constructor(canvas: { width: number; height: number; getContext?: any }) {
    this.canvas = canvas;
  }

  private push(op: string, ...args: any[]): void {
    this.ops.push({ op, args });
  }

  save(): void {
    this.push('save');
  }
  restore(): void {
    this.push('restore');
  }
  setTransform(...args: any[]): void {
    this.push('setTransform', ...args);
  }
  beginPath(): void {
    this.push('beginPath');
  }
  closePath(): void {
    this.push('closePath');
  }
  moveTo(...args: any[]): void {
    this.push('moveTo', ...args);
  }
  lineTo(...args: any[]): void {
    this.push('lineTo', ...args);
  }
  arc(...args: any[]): void {
    this.push('arc', ...args);
  }
  arcTo(...args: any[]): void {
    this.push('arcTo', ...args);
  }
  rect(...args: any[]): void {
    this.push('rect', ...args);
  }
  clip(): void {
    this.push('clip');
  }
  fill(): void {
    this.push('fill');
  }
  stroke(): void {
    this.push('stroke');
  }
  fillRect(...args: any[]): void {
    this.push('fillRect', ...args, this.fillStyle);
  }
  clearRect(...args: any[]): void {
    this.push('clearRect', ...args);
  }
  strokeRect(...args: any[]): void {
    this.push('strokeRect', ...args);
  }
  drawImage(...args: any[]): void {
    this.push('drawImage', ...args);
  }
  fillText(...args: any[]): void {
    this.push('fillText', ...args);
  }
  setLineDash(...args: any[]): void {
    this.push('setLineDash', ...args);
  }
  translate(...args: any[]): void {
    this.push('translate', ...args);
  }
  scale(...args: any[]): void {
    this.push('scale', ...args);
  }
  measureText(text: string): { width: number } {
    const size = Number.parseFloat(this.font) || 10;
    return { width: text.length * size * 0.55 };
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): FakeGradient {
    const gradient = new FakeGradient(x0, y0, x1, y1);
    this.push('createLinearGradient', gradient);
    return gradient;
  }

  opsOf(op: string): CanvasOp[] {
    return this.ops.filter((item) => item.op === op);
  }
}

export class FakeOffscreenCanvas {
  width: number;
  height: number;
  private ctx: Fake2DContext | null = null;

  constructor(width = 300, height = 150) {
    this.width = width;
    this.height = height;
  }

  getContext(): Fake2DContext {
    if (!this.ctx) this.ctx = new Fake2DContext(this);
    return this.ctx;
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob([new Uint8Array(0)], { type: 'image/png' });
  }
}

export function installFakeCanvas(): () => void {
  const g = globalThis as any;
  const previous = g.OffscreenCanvas;
  g.OffscreenCanvas = FakeOffscreenCanvas;
  return () => {
    g.OffscreenCanvas = previous;
  };
}

// ---------------------------------------------------------------------------
// fake mediabunny（解码器用）
// ---------------------------------------------------------------------------

export interface FakeFrameSpec {
  timestamp: number;
  duration: number;
  width?: number;
  height?: number;
}

export interface FakeAudioBufferSpec {
  timestamp: number;
  /** 每声道采样；缺省按 duration * sampleRate 生成静音 */
  duration?: number;
  channels?: Float32Array[];
  sampleRate?: number;
}

export interface FakeSegmentSpec {
  videoFrames?: FakeFrameSpec[];
  audioBuffers?: FakeAudioBufferSpec[];
  durationSeconds?: number;
  /** 构造 Input 时抛错（模拟文件损坏/缺失） */
  failInput?: boolean;
  /** 取视频帧时抛错（模拟解码器失败） */
  failVideoSamples?: boolean;
  /** 取音频块时抛错 */
  failAudioBuffers?: boolean;
  /** Input 构造的异步延迟（毫秒），用于并发单飞测试 */
  openDelayMs?: number;
}

export interface FakeMediabunnyStats {
  inputsCreated: number;
  inputsDisposed: number;
  samplesClosed: number;
  audioIteratorsReturned: number;
  inputsCreatedByKey: Record<string, number>;
  lastDrawnTimestamp: number | null;
}

function makeFakeAudioBuffer(spec: FakeAudioBufferSpec, sampleRate: number): any {
  const channels = spec.channels ?? [new Float32Array(0)];
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData: (ch: number) => channels[Math.min(ch, channels.length - 1)],
  };
}

/**
 * 构造一个行为可编排的 mediabunny 模块替身。
 *
 * 段身份通过 `segment.data = new Blob([...], { type: key })` 传入（decoder 会原样使用 Blob）。
 */
export function createFakeMediabunny(
  specs: Record<string, FakeSegmentSpec>,
  options: { sampleRate?: number } = {},
): { lib: any; stats: FakeMediabunnyStats } {
  const sampleRate = options.sampleRate ?? 48_000;
  const stats: FakeMediabunnyStats = {
    inputsCreated: 0,
    inputsDisposed: 0,
    samplesClosed: 0,
    audioIteratorsReturned: 0,
    inputsCreatedByKey: {},
    lastDrawnTimestamp: null,
  };

  class FakeBlobSource {
    readonly key: string;
    constructor(blob: Blob) {
      this.key = blob?.type || 'default';
    }
  }

  class FakeVideoSample {
    private closed = false;
    constructor(private readonly spec: FakeFrameSpec) {}
    get timestamp(): number {
      return this.spec.timestamp;
    }
    get duration(): number {
      return this.spec.duration;
    }
    get displayWidth(): number {
      return this.spec.width ?? 1920;
    }
    get displayHeight(): number {
      return this.spec.height ?? 1080;
    }
    draw(): void {
      stats.lastDrawnTimestamp = this.spec.timestamp;
    }
    toCanvasImageSource(): any {
      return new FakeOffscreenCanvas(16, 16);
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      stats.samplesClosed += 1;
    }
  }

  class FakeVideoSink {
    private readonly spec: FakeSegmentSpec;
    private readonly key: string;
    constructor(track: FakeTrack) {
      this.spec = track.spec;
      this.key = track.key;
    }
    private frames(): FakeFrameSpec[] {
      return (this.spec.videoFrames ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
    }
    /** mediabunny 语义：取 <= timestamp 的最近一帧；越界取最后一帧。 */
    async getSample(t: number): Promise<FakeVideoSample | null> {
      if (this.spec.failVideoSamples) throw new Error(`decode-failed:${this.key}`);
      const frames = this.frames();
      if (frames.length === 0) return null;
      let found: FakeFrameSpec | null = null;
      for (const frame of frames) {
        if (frame.timestamp <= t + 1e-6) found = frame;
        else break;
      }
      return new FakeVideoSample(found ?? frames[0]);
    }
    async *samples(startTimestamp = 0): AsyncGenerator<FakeVideoSample, void, unknown> {
      if (this.spec.failVideoSamples) throw new Error(`decode-failed:${this.key}`);
      try {
        for (const frame of this.frames()) {
          if (frame.timestamp >= startTimestamp - 1e-6) yield new FakeVideoSample(frame);
        }
      } finally {
        // 消费方提前 return 时也走这里
        stats.audioIteratorsReturned += 1;
      }
    }
  }

  class FakeAudioSink {
    private readonly spec: FakeSegmentSpec;
    private readonly key: string;
    constructor(track: FakeTrack) {
      this.spec = track.spec;
      this.key = track.key;
    }
    async *buffers(startTimestamp = 0): AsyncGenerator<any, void, unknown> {
      if (this.spec.failAudioBuffers) throw new Error(`audio-failed:${this.key}`);
      try {
        const sorted = (this.spec.audioBuffers ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
        for (const bufferSpec of sorted) {
          if (bufferSpec.timestamp < startTimestamp - 1e-6) continue;
          yield {
            buffer: makeFakeAudioBuffer(bufferSpec, bufferSpec.sampleRate ?? sampleRate),
            timestamp: bufferSpec.timestamp,
            duration: bufferSpec.duration ?? 1,
          };
        }
      } finally {
        stats.audioIteratorsReturned += 1;
      }
    }
  }

  class FakeTrack {
    constructor(
      readonly spec: FakeSegmentSpec,
      readonly key: string,
      private readonly kind: 'video' | 'audio',
    ) {}
    async getCodedWidth(): Promise<number> {
      return this.spec.videoFrames?.[0]?.width ?? 1920;
    }
    async getCodedHeight(): Promise<number> {
      return this.spec.videoFrames?.[0]?.height ?? 1080;
    }
    async getRotation(): Promise<number> {
      return 0;
    }
    async getCodec(): Promise<string | null> {
      return this.kind === 'video' ? 'avc' : 'pcm-f32';
    }
    async getNumberOfChannels(): Promise<number> {
      return this.spec.audioBuffers?.[0]?.channels?.length ?? 2;
    }
    async getSampleRate(): Promise<number> {
      return this.spec.audioBuffers?.[0]?.sampleRate ?? sampleRate;
    }
  }

  class FakeInput {
    private readonly spec: FakeSegmentSpec;
    private readonly key: string;
    disposed = false;
    constructor(args: { source: FakeBlobSource }) {
      this.key = args.source.key;
      this.spec = specs[this.key] ?? { failInput: true };
      stats.inputsCreated += 1;
      stats.inputsCreatedByKey[this.key] = (stats.inputsCreatedByKey[this.key] ?? 0) + 1;
    }
    private async ready(): Promise<void> {
      if (this.spec.openDelayMs) await new Promise((resolve) => setTimeout(resolve, this.spec.openDelayMs));
      if (this.spec.failInput) throw new Error(`open-failed:${this.key}`);
    }
    async getPrimaryVideoTrack(): Promise<FakeTrack | null> {
      await this.ready();
      return this.spec.videoFrames ? new FakeTrack(this.spec, this.key, 'video') : null;
    }
    async getPrimaryAudioTrack(): Promise<FakeTrack | null> {
      await this.ready();
      return this.spec.audioBuffers ? new FakeTrack(this.spec, this.key, 'audio') : null;
    }
    async computeDuration(): Promise<number> {
      if (this.spec.durationSeconds !== undefined) return this.spec.durationSeconds;
      const videoEnd = Math.max(0, ...(this.spec.videoFrames ?? []).map((f) => f.timestamp + f.duration));
      const audioEnd = Math.max(0, ...(this.spec.audioBuffers ?? []).map((b) => b.timestamp + (b.duration ?? 1)));
      return Math.max(videoEnd, audioEnd);
    }
    async getFirstTimestamp(): Promise<number> {
      return 0;
    }
    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      stats.inputsDisposed += 1;
    }
  }

  const lib = {
    Input: FakeInput,
    ALL_FORMATS: [],
    BlobSource: FakeBlobSource,
    VideoSampleSink: FakeVideoSink,
    AudioBufferSink: FakeAudioSink,
  };
  return { lib, stats };
}

/** 造一个「以 type 作为段键」的 Blob，供 createFakeMediabunny 识别段身份。 */
export function segmentBlob(key: string): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: key });
}

// ---------------------------------------------------------------------------
// fake 文件 IO（导出器用）
// ---------------------------------------------------------------------------

export interface FakeFileIOState {
  files: Map<string, Uint8Array>;
  calls: {
    write: string[];
    rename: { from: string; to: string }[];
    remove: string[];
    read: string[];
  };
  /** 写文件时抛出的错误（先写入部分字节，模拟磁盘写满到一半） */
  failWrite: ((path: string, files: Map<string, Uint8Array>) => Error | null) | null;
  failRename: Error | null;
  failRead: Error | null;
  freeBytes: number;
}

export function makeFakeFileIO(): { io: any; state: FakeFileIOState } {
  const state: FakeFileIOState = {
    files: new Map(),
    calls: { write: [], rename: [], remove: [], read: [] },
    failWrite: null,
    failRename: null,
    failRead: null,
    freeBytes: 10 * 1024 ** 3,
  };
  const io = {
    writeFile: async (path: string, data: Uint8Array): Promise<void> => {
      state.calls.write.push(path);
      // 先落盘再决定是否抛错：真实 fsp.writeFile 在 ENOSPC 时就是留下部分字节
      const error = state.failWrite ? state.failWrite(path, state.files) : null;
      state.files.set(path, data);
      if (error) throw error;
    },
    rename: async (from: string, to: string): Promise<void> => {
      state.calls.rename.push({ from, to });
      if (state.failRename) throw state.failRename;
      const bytes = state.files.get(from);
      if (!bytes) throw Object.assign(new Error('ENOENT: rename source missing'), { code: 'ENOENT' });
      state.files.delete(from);
      state.files.set(to, bytes);
    },
    removeFile: async (path: string): Promise<void> => {
      state.calls.remove.push(path);
      state.files.delete(path);
    },
    freeBytes: async (): Promise<number> => state.freeBytes,
    readFile: async (path: string): Promise<Uint8Array> => {
      state.calls.read.push(path);
      if (state.failRead) throw state.failRead;
      const bytes = state.files.get(path);
      if (!bytes) throw Object.assign(new Error('ENOENT: read missing'), { code: 'ENOENT' });
      return bytes;
    },
  };
  return { io, state };
}

// ---------------------------------------------------------------------------
// fake 校验器（导出器 verifyMp4 用）
// ---------------------------------------------------------------------------

export interface FakeVerifierOptions {
  width?: number;
  height?: number;
  durationSeconds?: number;
  packetCount?: number;
  frameRate?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  audioChannels?: number;
  audioSampleRate?: number;
  throwOnOpen?: boolean;
}

export function createFakeVerifier(options: FakeVerifierOptions = {}): { lib: any; disposed: { count: number } } {
  const disposed = { count: 0 };
  class FakeVerifierInput {
    async getPrimaryVideoTrack(): Promise<any> {
      if (options.throwOnOpen) throw new Error('open-failed');
      if (options.hasVideo === false) return null;
      return {
        getCodedWidth: async () => options.width ?? 1920,
        getCodedHeight: async () => options.height ?? 1080,
        getCodec: async () => 'avc',
        computePacketStats: async () => ({
          packetCount: options.packetCount ?? 30,
          averagePacketRate: options.frameRate ?? 30,
        }),
      };
    }
    async getPrimaryAudioTrack(): Promise<any> {
      if (options.hasAudio === false) return null;
      return {
        getNumberOfChannels: async () => options.audioChannels ?? 2,
        getSampleRate: async () => options.audioSampleRate ?? 48_000,
        getCodec: async () => 'aac',
      };
    }
    async computeDuration(): Promise<number> {
      return options.durationSeconds ?? 1;
    }
    dispose(): void {
      disposed.count += 1;
    }
  }
  return {
    lib: {
      Input: FakeVerifierInput,
      ALL_FORMATS: [],
      BlobSource: class {
        constructor(readonly blob: Blob) {}
      },
    },
    disposed,
  };
}
