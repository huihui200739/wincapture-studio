/**
 * 原生采集工作进程的封装（主进程侧）
 *
 * 两个常驻子进程：
 *   grabber.exe —— GDI 屏幕采集，输出 JPEG 帧 + QPC 时间戳
 *   audio.exe   —— WASAPI 双路音频（系统回环 + 麦克风），输出 48kHz 立体声 Float32 块 + QPC
 *
 * 为什么用原生进程而不是 Chromium 的采集：
 *   本机 Windows.Graphics.Capture 被系统拒绝（E_ACCESSDENIED），getDisplayMedia 全部失败。
 *   详见 docs/technical-verification.md。
 *
 * 时间基准（文档 §9.2）：
 *   所有帧和音频块都携带 QPC 时间戳。会话开始时刻记为 sessionQpc0，
 *   媒体时间 = (qpc - sessionQpc0) / qpcFrequency − 累计暂停时长。
 *   这样两路音频启动不同步（实测相差约 0.9 秒）也能被正确对齐。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface VideoFramePacket {
  /** QPC 原始计数 */
  qpc: bigint;
  /** JPEG 字节 */
  jpeg: Buffer;
  /** 该帧到达的墙钟时刻（Date.now），仅用于诊断 */
  receivedAt: number;
}

export interface AudioPacket {
  /** 0 = 系统回环，1 = 麦克风 */
  streamId: 0 | 1;
  /** 48 kHz 时间轴上的帧序号（该流自身的序号，仅供调试） */
  startFrame: number;
  /** 均方根电平 0..1 */
  rms: number;
  /** 该块首采样的 QPC 原始计数 */
  qpc: bigint;
  /** 左声道 */
  left: Float32Array;
  /** 右声道 */
  right: Float32Array;
  receivedAt: number;
}

export interface AudioErrorPacket {
  streamId: number;
  code: string;
  message: string;
}

export interface GrabberOptions {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  quality: number;
  fps: number;
}

export interface AudioOptions {
  enableSystem: boolean;
  enableMic: boolean;
  micDeviceId?: string;
}

export interface WorkerPaths {
  grabberExe: string;
  audioExe: string;
}

type FrameListener = (frame: VideoFramePacket) => void;
type AudioListener = (packet: AudioPacket) => void;
type AudioErrorListener = (error: AudioErrorPacket) => void;
type ExitListener = (reason: { code: number | null; signal: string | null; stderr: string }) => void;

/** GDI 采集进程封装。 */
export class GrabberWorker {
  private child: ChildProcess | null = null;
  private acc = Buffer.alloc(0);
  private stderrText = '';
  private frameListeners = new Set<FrameListener>();
  private exitListeners = new Set<ExitListener>();
  private qpcFrequency = 10_000_000n;
  private stopping = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private framesEmitted = 0;

  constructor(
    private readonly exePath: string,
    private readonly options: GrabberOptions,
  ) {}

  get frequency(): bigint {
    return this.qpcFrequency;
  }

  get frameCount(): number {
    return this.framesEmitted;
  }

  get stderr(): string {
    return this.stderrText;
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const { width, height, offsetX, offsetY, quality, fps } = this.options;
    const child = spawn(
      this.exePath,
      [String(width), String(height), String(offsetX), String(offsetY), String(quality), String(fps)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrText += text;
      // 保留最后 8KB，避免长时录制无限增长
      if (this.stderrText.length > 8192) this.stderrText = this.stderrText.slice(-8192);
      const freqMatch = /QPCFREQ (\d+)/.exec(text);
      if (freqMatch) this.qpcFrequency = BigInt(freqMatch[1]);
      if (text.includes('READY')) this.resolveReady?.();
      if (text.includes('ARGS_ERROR') || text.includes('NO_JPEG_ENCODER') || text.includes('BITMAP_ERROR')) {
        this.rejectReady?.(new Error('采集进程启动失败：' + text.trim()));
      }
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      // 缓冲拼接：避免 Buffer.concat + subarray 造成的内存滞留。
      //
      // 旧实现有两个问题：
      //  1. 每个 chunk 都 Buffer.concat 重新分配整个累积缓冲，
      //     1080p 每帧约 200KB、30fps，一秒就是 6MB 的反复拷贝；
      //  2. 用 subarray 切走已消费部分后，剩余视图仍引用原来那个大 Buffer，
      //     V8 无法回收，录制越久滞留越多 ——
      //     实测主进程内存随录制时长线性增长（0s:426MB → 30s:1853MB）。
      //
      // 现在改为：一次只处理 chunk 内的完整帧，剩余不完整部分
      // 拷贝成新的小缓冲（不引用原 chunk），消费完即释放。
      let buf = this.acc.length === 0 ? chunk : Buffer.concat([this.acc, chunk]);

      while (buf.length >= 12) {
        const length = buf.readUInt32LE(0);
        if (length === 0 || length > 64 * 1024 * 1024) {
          // 长度异常：重置缓冲，避免死循环
          buf = Buffer.alloc(0);
          break;
        }
        if (buf.length < 12 + length) break;
        const qpc = buf.readBigInt64LE(4);
        const frame: VideoFramePacket = {
          qpc,
          // 必须拷贝一份独立的 Buffer，不能直接引用 buf 的视图
          jpeg: Buffer.from(buf.subarray(12, 12 + length)),
          receivedAt: Date.now(),
        };
        buf = buf.subarray(12 + length);
        this.framesEmitted += 1;
        for (const listener of this.frameListeners) {
          try {
            listener(frame);
          } catch {
            // 监听器异常不应中断采集
          }
        }
      }

      // 剩下的不完整数据拷贝出来，断开与原 chunk 的引用关系
      this.acc = buf.length > 0 ? Buffer.from(buf) : Buffer.alloc(0);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      const reason = { code, signal, stderr: this.stderrText };
      this.rejectReady?.(new Error(`采集进程退出（code=${code}）`));
      if (!this.stopping) {
        for (const listener of this.exitListeners) {
          try {
            listener(reason);
          } catch {
            // 忽略
          }
        }
      }
    });

    child.on('error', (error) => {
      this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
    });

    // 兜底：3 秒内没收到 READY 视为启动失败
    const timer = setTimeout(() => {
      this.rejectReady?.(new Error('采集进程启动超时（3 秒内未就绪）'));
    }, 3000);
    void this.readyPromise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );

    return this.readyPromise;
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** 优雅停止；超时后强杀。 */
  async stop(timeoutMs = 1500): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.write('q\n');
    } catch {
      // 管道可能已关闭
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }

    // 等 stdout 真正排空。
    //
    // 进程 exit 事件只代表采集端停止运行，此时管道里可能还有已写入、
    // 尚未被本进程读取的帧数据（管道缓冲通常能存 2~4 秒的量）。
    // 如果这时就开始切最后一段，这些帧会被整段丢掉 ——
    // 实测 20 秒录制只成片 18 秒，正好少一个分段窗口。
    //
    // 这里等 stdout 的 'end'/'close'（写端关闭且数据读完）或短暂超时，
    // 确保 this.frames 里是完整的全部帧。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 800);
      if (!child.stdout || child.stdout.readableEnded) {
        clearTimeout(timer);
        resolve();
        return;
      }
      child.stdout.once('end', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdout.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.child = null;
  }
}

/** WASAPI 双路音频采集进程封装。 */
export class AudioWorker {
  private child: ChildProcess | null = null;
  private acc = Buffer.alloc(0);
  private stderrText = '';
  private audioListeners = new Set<AudioListener>();
  private errorListeners = new Set<AudioErrorListener>();
  private exitListeners = new Set<ExitListener>();
  private qpcFrequency = 10_000_000n;
  private stopping = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(
    private readonly exePath: string,
    private readonly options: AudioOptions,
  ) {}

  get frequency(): bigint {
    return this.qpcFrequency;
  }

  get stderr(): string {
    return this.stderrText;
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const args: string[] = [];
    if (!this.options.enableSystem) args.push('--no-system');
    if (!this.options.enableMic) args.push('--no-mic');
    if (this.options.enableMic && this.options.micDeviceId) args.push('--mic', this.options.micDeviceId);

    const child = spawn(this.exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrText += text;
      if (this.stderrText.length > 8192) this.stderrText = this.stderrText.slice(-8192);
      const freqMatch = /QPCFREQ (\d+)/.exec(text);
      if (freqMatch) this.qpcFrequency = BigInt(freqMatch[1]);
      if (text.includes('READY')) this.resolveReady?.();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      this.acc = this.acc.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.acc, chunk]);
      while (this.acc.length >= 4) {
        const total = this.acc.readUInt32LE(0);
        if (total < 24 || total > 8 * 1024 * 1024) {
          this.acc = Buffer.alloc(0);
          break;
        }
        if (this.acc.length < total) break;
        const packet = this.acc.subarray(0, total);
        this.acc = this.acc.subarray(total);

        const streamId = packet.readUInt32LE(4);
        if (streamId === 0xffffffff) {
          const codeLen = packet.readUInt32LE(12);
          const msgLen = packet.readUInt32LE(16);
          const error: AudioErrorPacket = {
            streamId: packet.readUInt32LE(8),
            code: packet.subarray(20, 20 + codeLen).toString('utf8'),
            message: packet.subarray(20 + codeLen, 20 + codeLen + msgLen).toString('utf8'),
          };
          for (const listener of this.errorListeners) {
            try {
              listener(error);
            } catch {
              // 忽略
            }
          }
          continue;
        }

        if (streamId !== 0 && streamId !== 1) continue;
        const startFrame = packet.readInt32LE(8);
        const rms = packet.readFloatLE(12);
        const qpc = packet.readBigInt64LE(16);
        const frames = (total - 24) / 8;
        if (!Number.isInteger(frames) || frames <= 0) continue;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        const dataStart = 24;
        for (let i = 0; i < frames; i++) left[i] = packet.readFloatLE(dataStart + i * 4);
        const rightStart = dataStart + frames * 4;
        for (let i = 0; i < frames; i++) right[i] = packet.readFloatLE(rightStart + i * 4);

        const audio: AudioPacket = {
          streamId: streamId as 0 | 1,
          startFrame,
          rms,
          qpc,
          left,
          right,
          receivedAt: Date.now(),
        };
        for (const listener of this.audioListeners) {
          try {
            listener(audio);
          } catch {
            // 忽略
          }
        }
      }
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      const reason = { code, signal, stderr: this.stderrText };
      this.rejectReady?.(new Error(`音频进程退出（code=${code}）`));
      if (!this.stopping) {
        for (const listener of this.exitListeners) {
          try {
            listener(reason);
          } catch {
            // 忽略
          }
        }
      }
    });

    child.on('error', (error) => {
      this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
    });

    const timer = setTimeout(() => {
      this.rejectReady?.(new Error('音频进程启动超时（3 秒内未就绪）'));
    }, 3000);
    void this.readyPromise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );

    return this.readyPromise;
  }

  onAudio(listener: AudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onError(listener: AudioErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async stop(timeoutMs = 1500): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.write('q\n');
    } catch {
      // 管道可能已关闭
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }
    this.child = null;
  }
}

/** 解析音频设备清单（调用 audio.exe --list-devices）。 */
export function listAudioDevices(exePath: string): Promise<
  { deviceId: string; label: string; kind: 'audioinput' | 'audiooutput'; isDefault: boolean }[]
> {
  return new Promise((resolve) => {
    const child = spawn(exePath, ['--list-devices'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      resolve([]);
    }, 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      const text = out.trim();
      const start = text.indexOf('[');
      if (start < 0) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(text.slice(start));
        if (!Array.isArray(parsed)) {
          resolve([]);
          return;
        }
        resolve(
          parsed.map((item: Record<string, unknown>) => ({
            deviceId: String(item.deviceId ?? ''),
            label: String(item.label ?? ''),
            kind: item.kind === 'audioinput' ? 'audioinput' : 'audiooutput',
            isDefault: Boolean(item.isDefault),
          })),
        );
      } catch {
        resolve([]);
      }
      void err;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

/** 解析原生可执行文件路径（开发期在 dist/native，打包后在 resources/native）。 */
/**
 * 解析原生可执行文件路径。
 *
 * 开发期：app.getAppPath() 返回项目根目录，产物在 <root>/dist/native。
 * 打包后：<resources>/app.asar 之外，产物在 <resources>/native（由打包配置 extraResources 放置）。
 */
export function resolveWorkerPaths(appPath: string, isPackaged: boolean): WorkerPaths {
  const base = isPackaged ? path.join(path.dirname(appPath), 'native') : path.join(appPath, 'dist', 'native');
  return {
    grabberExe: path.join(base, 'grabber.exe'),
    audioExe: path.join(base, 'audio.exe'),
  };
}
