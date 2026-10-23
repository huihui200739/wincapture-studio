/**
 * 子进程封装的生命周期/协议回归测试。
 *
 * 用假的 ChildProcess（PassThrough 管道）注入，覆盖真实 spawn 难以稳定复现的路径：
 *  - stderr 中的 READY/QPCFREQ 被管道分块截断时仍能识别（旧实现按单 chunk 匹配，偶发启动超时）
 *  - 启动超时 / spawn error 必须 kill 子进程，不能留孤儿
 *  - 协议失步必须终止子进程并把原因带进 exit 通知
 *  - 子进程已退出但 stdout 还有未读数据时，stop 要等排空（否则丢掉最后一段帧）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { AudioWorker, GrabberWorker, type SpawnFn } from '../../electron/capture/workers';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function frameBytes(jpeg: Buffer, qpc: bigint): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(jpeg.length, 0);
  buf.writeBigInt64LE(qpc, 4);
  return Buffer.concat([buf, jpeg]);
}

function audioBytes(streamId: number, startFrame: number, rms: number, qpc: bigint, l: number[], r: number[]): Buffer {
  const frames = l.length;
  const total = 24 + frames * 8;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(total, 0);
  buf.writeUInt32LE(streamId >>> 0, 4);
  buf.writeInt32LE(startFrame, 8);
  buf.writeFloatLE(rms, 12);
  buf.writeBigInt64LE(qpc, 16);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(l[i], 24 + i * 4);
    buf.writeFloatLE(r[i], 24 + frames * 4 + i * 4);
  }
  return buf;
}

function shortErrorBytes(streamId: number, code: string, message: string): Buffer {
  const codeBytes = Buffer.from(code);
  const msgBytes = Buffer.from(message);
  const total = 20 + codeBytes.length + msgBytes.length;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(total, 0);
  buf.writeUInt32LE(0xffffffff, 4);
  buf.writeUInt32LE(streamId >>> 0, 8);
  buf.writeUInt32LE(codeBytes.length, 12);
  buf.writeUInt32LE(msgBytes.length, 16);
  codeBytes.copy(buf, 20);
  msgBytes.copy(buf, 20 + codeBytes.length);
  return buf;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 4321;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killCount = 0;

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  kill(): boolean {
    this.killCount += 1;
    this.finish(1);
    return true;
  }

  finish(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

function fakeSpawn(child: FakeChild): SpawnFn {
  return (() => child.asChildProcess()) as unknown as SpawnFn;
}

const pending: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of pending.splice(0)) cleanup();
  vi.useRealTimers();
});

function remember(child: FakeChild): void {
  pending.push(() => {
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    }
  });
}

const grabberOptions = { width: 1920, height: 1080, offsetX: 0, offsetY: 0, quality: 88, fps: 30 };

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('GrabberWorker: 启动握手', () => {
  it('window capture passes HWND and tracks physical bounds across split stderr chunks', async () => {
    const child = new FakeChild(); remember(child);
    const spawn = vi.fn(() => child.asChildProcess());
    const worker = new GrabberWorker('grabber.exe', { ...grabberOptions, windowHandle: '12345' }, spawn as unknown as SpawnFn);
    const ready = worker.start(); child.stderr.write('READY\nWINDOW_BOUNDS -100 40 800');
    child.stderr.write(' 600\n'); await ready;
    expect(spawn.mock.calls[0][1]).toContain('--window=12345');
    expect(worker.captureBounds).toEqual({ x: -100, y: 40, width: 800, height: 600 });
    child.stderr.write('WINDOW_BOUNDS 200 -50 400 300\n');
    expect(worker.captureBounds).toEqual({ x: 200, y: -50, width: 400, height: 300 });
  });
  it('stderr 被拆成多个 chunk 时仍能识别 QPCFREQ 与 READY', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const ready = worker.start();

    child.stderr.write('QPCFR');
    child.stderr.write('EQ 1234567\nREA');
    child.stderr.write('DY 1920x1080 fps=30\n');
    await ready;
    expect(worker.frequency).toBe(1_234_567n);

    child.stdout.write(frameBytes(JPEG, 42n));
    await nextTick();
    expect(worker.frameCount).toBe(1);
  });

  it('启动超时会 kill 子进程（不留孤儿）', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const assertion = expect(worker.start()).rejects.toThrow(/启动超时/);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(child.killCount).toBe(1);
  });

  it('spawn 失败会 reject 并回收子进程', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const assertion = expect(worker.start()).rejects.toThrow(/spawn ENOENT/);
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await assertion;
    expect(child.killCount).toBe(1);
  });

  it('stderr 出现 ARGS_ERROR 时立即失败，不再等到 3 秒超时', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const assertion = expect(worker.start()).rejects.toThrow(/启动失败/);
    child.stderr.write('ARGS_ERROR 尺寸必须为正\n');
    await assertion;
    expect(child.killCount).toBe(1);
  });
});

describe('GrabberWorker: 协议失步与停止排空', () => {
  it('非法帧长度会终止子进程，并把 PROTOCOL_ERROR 带进 exit 通知', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const exits: { code: number | null; stderr: string }[] = [];
    worker.onExit((reason) => exits.push(reason));
    const ready = worker.start();
    child.stderr.write('READY 1920x1080\n');
    await ready;

    const bad = Buffer.alloc(12);
    bad.writeUInt32LE(0, 0);
    child.stdout.write(bad);
    await nextTick();

    expect(child.killCount).toBe(1);
    expect(exits).toHaveLength(1);
    expect(exits[0].stderr).toMatch(/PROTOCOL_ERROR/);
    expect(exits[0].stderr).toMatch(/长度非法/);
  });

  it('子进程已退出但 stdout 还有数据时，stop 会等排空并把帧交给监听器', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const frames: bigint[] = [];
    worker.onFrame((frame) => frames.push(frame.qpc));
    const ready = worker.start();
    child.stderr.write('READY 1920x1080\n');
    await ready;

    // 模拟：进程已退出（引擎还没调 stop），管道里仍压着一帧
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.stdout.write(frameBytes(JPEG, 777n));

    const stopPromise = worker.stop();
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });
    await nextTick();
    // 关键：stdout 还没 end，stop 不能提前返回
    expect(settled).toBe(false);
    child.stdout.end();
    await stopPromise;
    expect(frames).toEqual([777n]);
  });

  it('优雅停止：写 q、等 exit、不强杀', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new GrabberWorker('grabber.exe', grabberOptions, fakeSpawn(child));
    const ready = worker.start();
    child.stderr.write('READY 1920x1080\n');
    await ready;

    let written = '';
    child.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const stopPromise = worker.stop();
    await nextTick();
    child.finish(0);
    await stopPromise;
    expect(written).toContain('q');
    expect(child.killCount).toBe(0);
  });
});

describe('AudioWorker: 包解析与生命周期', () => {
  it('正常包 + 短错误包 + 半包拼接都能正确分发', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new AudioWorker('audio.exe', { enableSystem: true, enableMic: true }, fakeSpawn(child));
    const received: number[] = [];
    const errors: string[] = [];
    worker.onAudio((packet) => received.push(packet.startFrame));
    worker.onError((error) => errors.push(error.code));

    const ready = worker.start();
    child.stderr.write('QPCFREQ 10000000\nREADY streams=2\n');
    await ready;

    const normal = audioBytes(1, 960, 0.4, 5n, [0.1, 0.2], [-0.1, -0.2]);
    const full = Buffer.concat([normal, shortErrorBytes(0, 'E', '')]);
    child.stdout.write(full.subarray(0, normal.length - 3));
    child.stdout.write(full.subarray(normal.length - 3));
    await nextTick();

    expect(received).toEqual([960]);
    expect(errors).toEqual(['E']);
    expect(worker.frequency).toBe(10_000_000n);
  });

  it('音频协议失步会终止子进程', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new AudioWorker('audio.exe', { enableSystem: true, enableMic: false }, fakeSpawn(child));
    const ready = worker.start();
    child.stderr.write('READY streams=1\n');
    await ready;

    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(19, 0);
    child.stdout.write(bad);
    await nextTick();
    expect(child.killCount).toBe(1);
  });

  it('启动超时会 kill 子进程', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    remember(child);
    const worker = new AudioWorker('audio.exe', { enableSystem: true, enableMic: true }, fakeSpawn(child));
    const assertion = expect(worker.start()).rejects.toThrow(/启动超时/);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(child.killCount).toBe(1);
  });

  it('优雅停止会向 stdin 写 q 并等待退出', async () => {
    const child = new FakeChild();
    remember(child);
    const worker = new AudioWorker('audio.exe', { enableSystem: true, enableMic: true }, fakeSpawn(child));
    const ready = worker.start();
    child.stderr.write('READY streams=2\n');
    await ready;

    let written = '';
    child.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const stopPromise = worker.stop();
    await nextTick();
    child.finish(0);
    await stopPromise;
    expect(written).toContain('q');
    expect(child.killCount).toBe(0);
  });
});
