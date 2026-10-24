/**
 * 原生采集工作进程的封装（主进程侧）
 *
 * 两个常驻子进程：
 *   grabber.exe —— GDI 屏幕采集，输出 JPEG 帧 + QPC 时间戳
 *   audio.exe   —— WASAPI 双路音频（系统回环 + 麦克风），输出 48kHz 立体声 Float32 块 + QPC
 *
 * 为什么用原生进程而不是 Chromium 的采集：
 *   本机 Windows.Graphics.Capture 被系统拒绝（E_ACCESSDENIED），getDisplayMedia 全部失败。
 *   详见 docs/testing.md。
 *
 * 时间基准（文档 §9.2）：
 *   所有帧和音频块都携带 QPC 时间戳。会话开始时刻记为 sessionQpc0，
 *   媒体时间 = (qpc - sessionQpc0) / qpcFrequency − 累计暂停时长。
 *   这样两路音频启动不同步（实测相差约 0.9 秒）也能被正确对齐。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import {
  AudioStreamDecoder,
  FrameStreamDecoder,
  type AudioErrorPacket,
  type AudioPacket,
  type VideoFramePacket,
} from './wireProtocol';

export type { AudioErrorPacket, AudioPacket, VideoFramePacket } from './wireProtocol';
export { MAX_AUDIO_PACKET_BYTES, MAX_VIDEO_FRAME_BYTES } from './wireProtocol';

export interface GrabberOptions {
  scaling?: 'quality' | 'performance';
  outputWidth?: number;
  outputHeight?: number;
  windowHandle?: string;
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

/** 便于单测注入假的 ChildProcess（生产代码直接用 node:child_process 的 spawn）。 */
export type SpawnFn = typeof spawn;

type FrameListener = (frame: VideoFramePacket) => void;
type AudioListener = (packet: AudioPacket) => void;
type AudioErrorListener = (error: AudioErrorPacket) => void;
type ExitListener = (reason: { code: number | null; signal: string | null; stderr: string }) => void;

/**
 * 给子进程的三条管道挂上空 error 监听。
 *
 * 为什么必须挂：父进程写 stdin 时如果子进程已经退出，管道会异步发 'error'（EPIPE）；
 * Node 对没有 error 监听的流会直接抛未捕获异常 —— 整个主进程崩溃。
 * 这在实际场景里很常见：grabber 启动失败/被杀死后引擎仍会尝试发退出命令。
 */
function guardStreamErrors(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {
      // 管道另一端已消失，由 exit/close 路径负责收尾
    });
  }
}

/** 把 stderr 文本解析成启动状态。必须基于「累计文本」，否则一行被管道分块截断时永远匹配不到。 */
class StderrParser {
  private text = '';
  private ready = false;
  private frequencySeen = false;
  private fatalSeen = false;
  private frequency: bigint | null = null;

  constructor(
    private readonly onReady: () => void,
    private readonly onFatal: (reason: string) => void,
    private readonly fatalPattern: RegExp = /ARGS_ERROR|NO_JPEG_ENCODER|BITMAP_ERROR/,
  ) {}

  push(chunk: Buffer): void {
    this.text += chunk.toString('utf8');
    // 保留最后 8KB，避免长时录制无限增长
    if (this.text.length > 8192) this.text = this.text.slice(-8192);

    if (!this.frequencySeen) {
      const match = /QPCFREQ (\d+)/.exec(this.text);
      if (match) {
        this.frequency = BigInt(match[1]);
        this.frequencySeen = true;
      }
    }
    if (!this.ready && /(?:^|[\r\n])READY(?:\s|$)/.test(this.text)) {
      this.ready = true;
      this.onReady();
    }
    if (!this.fatalSeen && this.fatalPattern.test(this.text)) {
      this.fatalSeen = true;
      this.onFatal(this.text.trim());
    }
  }

  get sawReady(): boolean {
    return this.ready;
  }

  get qpcFrequency(): bigint | null {
    return this.frequency;
  }

  get raw(): string {
    return this.text;
  }

  /** 追加内部诊断错误（协议失步等），并计入 stderrText 供失败原因展示。 */
  appendError(message: string): void {
    this.text = `${this.text}\n${message}`.slice(-8192);
  }
}

/** GDI 采集进程封装。 */
export class GrabberWorker {
  get pid(): number | null { return this.child?.exitCode === null ? this.child.pid ?? null : null; }
  private child: ChildProcess | null = null;
  private decoder = new FrameStreamDecoder();
  private parser: StderrParser;
  private frameListeners = new Set<FrameListener>();
  private exitListeners = new Set<ExitListener>();
  private qpcFrequency = 10_000_000n;
  private stopping = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readySettled = false;
  private framesEmitted = 0;
  private stdoutEnded: Promise<void> | null = null;

  constructor(
    private readonly exePath: string,
    private readonly options: GrabberOptions,
    private readonly spawnImpl: SpawnFn = spawn,
  ) {
    this.parser = new StderrParser(
      () => this.markReady(),
      (reason) => this.failStart(new Error(`采集进程启动失败：${reason}`)),
    );
  }

  get frequency(): bigint {
    return this.qpcFrequency;
  }

  get frameCount(): number {
    return this.framesEmitted;
  }

  get captureBounds(): { x: number; y: number; width: number; height: number } {
    const matches = [...this.parser.raw.matchAll(/WINDOW_BOUNDS (-?\d+) (-?\d+) (\d+) (\d+)/g)];
    const last = matches.at(-1);
    return last ? { x: Number(last[1]), y: Number(last[2]), width: Number(last[3]), height: Number(last[4]) }
      : { x: this.options.offsetX, y: this.options.offsetY, width: this.options.width, height: this.options.height };
  }

  get stderr(): string {
    return this.parser.raw;
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const { width, height, offsetX, offsetY, quality, fps } = this.options;
    const child = this.spawnImpl(
      this.exePath,
      [String(width), String(height), String(offsetX), String(offsetY), String(quality), String(fps),
        ...(this.options.windowHandle ? [`--window=${this.options.windowHandle}`] : []),
        ...(this.options.scaling === 'performance' ? ['--fast-scale'] : []),
        ...(this.options.outputWidth && this.options.outputHeight ? [`--output=${this.options.outputWidth}x${this.options.outputHeight}`] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;
    guardStreamErrors(child);

    // stdout 排空信号必须在创建时就挂好：进程可能在 stop() 之前就退出，
    // 若等到 stop() 才去听 'end'，已结束的流不会再触发，尾部帧就丢了。
    this.stdoutEnded = new Promise<void>((resolve) => {
      const out = child.stdout;
      if (!out || out.readableEnded) {
        resolve();
        return;
      }
      out.once('end', resolve);
      out.once('close', resolve);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.parser.push(chunk);
      this.qpcFrequency = this.parser.qpcFrequency ?? this.qpcFrequency;
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const { frames, error } = this.decoder.push(chunk);
      for (const frame of frames) {
        this.framesEmitted += 1;
        for (const listener of this.frameListeners) {
          try {
            listener(frame);
          } catch {
            // 监听器异常不应中断采集
          }
        }
      }
      if (error) {
        // 协议失步：长度前缀没有同步标记，继续读只会产出错位帧。
        // 标记原因并杀掉子进程，由 exit 事件把「源故障」上报给引擎（状态迁移到 RecoverableFailure）。
        this.parser.appendError(`PROTOCOL_ERROR ${error}`);
        this.killChild();
      }
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.failStart(new Error(`采集进程退出（code=${code}）`));
      if (!this.stopping) {
        const reason = { code, signal, stderr: this.parser.raw };
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
      this.failStart(error instanceof Error ? error : new Error(String(error)));
    });

    // 兜底：3 秒内没收到 READY 视为启动失败（并杀掉可能已经半启动的进程，
    // 否则它会一直抓屏/占用 GDI 资源，成为孤儿进程）
    const timer = setTimeout(() => {
      this.failStart(new Error('采集进程启动超时（3 秒内未就绪）'));
    }, 3000);
    void this.readyPromise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );

    return this.readyPromise;
  }

  private markReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady?.();
  }

  private failStart(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady?.(error);
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    try {
      if (child.exitCode === null) child.kill();
    } catch {
      // 忽略
    }
  }

  /** 等 stdout 真正排空（写端关闭且数据读完），或短暂超时。 */
  private async waitStdoutDrained(timeoutMs: number): Promise<void> {
    if (!this.stdoutEnded) return;
    await Promise.race([this.stdoutEnded, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** 优雅停止；超时后强杀。返回时 stdout 已排空（剩余帧已回调）。 */
  async stop(timeoutMs = 1500): Promise<void> {
    if (this.stopping) {
      // 重复 stop：等同一个排空信号即可
      await this.waitStdoutDrained(800);
      return;
    }
    this.stopping = true;
    const child = this.child;
    if (child) {
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
        if (child.exitCode !== null) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      if (!exited) this.killChild();
    }

    // 进程 exit 事件只代表采集端停止运行，此时管道里可能还有已写入、
    // 尚未被本进程读取的帧数据（管道缓冲通常能存 2~4 秒的量）。
    // 这里等 stdout 的 'end'/'close'（写端关闭且数据读完）或短暂超时，
    // 确保引擎 this.frames 里是完整的全部帧。
    await this.waitStdoutDrained(800);
    this.child = null;
    this.decoder.reset();
  }
}

/** WASAPI 双路音频采集进程封装。 */
export class AudioWorker {
  get pid(): number | null { return this.child?.exitCode === null ? this.child.pid ?? null : null; }
  private child: ChildProcess | null = null;
  private decoder = new AudioStreamDecoder();
  private parser: StderrParser;
  private audioListeners = new Set<AudioListener>();
  private errorListeners = new Set<AudioErrorListener>();
  private exitListeners = new Set<ExitListener>();
  private qpcFrequency = 10_000_000n;
  private stopping = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readySettled = false;
  /** stdout 排空信号：与 GrabberWorker 同理，尾部音频包必须读完再收尾。 */
  private stdoutEnded: Promise<void> | null = null;

  constructor(
    private readonly exePath: string,
    private readonly options: AudioOptions,
    private readonly spawnImpl: SpawnFn = spawn,
  ) {
    // 音频进程的设备错误以数据包形式上报，stderr 只用来等 READY。
    // 这里仍复用同一个解析器（fatalPattern 换成永不匹配，避免把日志里的设备名误判为启动失败）。
    this.parser = new StderrParser(
      () => this.markReady(),
      () => {},
      /$^/,
    );
  }

  get frequency(): bigint {
    return this.qpcFrequency;
  }

  get stderr(): string {
    return this.parser.raw;
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

    const child = this.spawnImpl(this.exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    guardStreamErrors(child);

    // 必须现在挂好排空信号：进程可能在 stop() 之前退出，
    // 那时再去听 'end' 不会触发，尾部音频包就永远读不到了。
    this.stdoutEnded = new Promise<void>((resolve) => {
      const out = child.stdout;
      if (!out || out.readableEnded) {
        resolve();
        return;
      }
      out.once('end', resolve);
      out.once('close', resolve);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.parser.push(chunk);
      this.qpcFrequency = this.parser.qpcFrequency ?? this.qpcFrequency;
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const { packets, errors, error } = this.decoder.push(chunk);
      for (const packet of packets) {
        for (const listener of this.audioListeners) {
          try {
            listener(packet);
          } catch {
            // 忽略
          }
        }
      }
      for (const packet of errors) {
        for (const listener of this.errorListeners) {
          try {
            listener(packet);
          } catch {
            // 忽略
          }
        }
      }
      if (error) {
        this.parser.appendError(`PROTOCOL_ERROR ${error}`);
        this.killChild();
      }
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.failStart(new Error(`音频进程退出（code=${code}）`));
      if (!this.stopping) {
        const reason = { code, signal, stderr: this.parser.raw };
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
      this.failStart(error instanceof Error ? error : new Error(String(error)));
    });

    const timer = setTimeout(() => {
      this.failStart(new Error('音频进程启动超时（3 秒内未就绪）'));
    }, 3000);
    void this.readyPromise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );

    return this.readyPromise;
  }

  private markReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady?.();
  }

  private failStart(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady?.(error);
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    try {
      if (child.exitCode === null) child.kill();
    } catch {
      // 忽略
    }
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

  /** 等 stdout 真正排空（写端关闭且数据读完），或短暂超时。 */
  private async waitStdoutDrained(timeoutMs: number): Promise<void> {
    if (!this.stdoutEnded) return;
    await Promise.race([this.stdoutEnded, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  async stop(timeoutMs = 1500): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.decoder.reset();
      return;
    }
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
      if (child.exitCode !== null) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    if (!exited) this.killChild();
    // 与 GrabberWorker 一致：exit 只代表进程停止运行，管道里可能还有已写入
    // 未读走的音频包。不等排空就 reset 解码器，最后一段音频会被丢弃，
    // writeWav 只能按声明时长补 0，成片尾部出现「掉音」。
    await this.waitStdoutDrained(800);
    this.child = null;
    this.decoder.reset();
  }
}

/** 解析音频设备清单（调用 audio.exe --list-devices）。 */
export function listAudioDevices(exePath: string): Promise<
  { deviceId: string; label: string; kind: 'audioinput' | 'audiooutput'; isDefault: boolean }[]
> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(exePath, ['--list-devices'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve([]);
      return;
    }
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
