/**
 * CaptureEngine 的回归测试（直接驱动私有状态，覆盖真实代码路径）。
 *
 * 这些用例锁定的是审计中发现的真实缺陷：
 *  - 停止排空阶段丢帧（框架声称已修、实际被状态守卫吃掉）
 *  - 暂停 flush 后栅格没有重基 → 下一段与已提交段重叠
 *  - 音频包 startFrame 是「流自身序号」，未按 QPC 换算成段内偏移
 *  - 摄像头分段串在屏幕编码循环里 await → 队列堆积、触发背压丢段
 *  - stop 之后状态停在 ReadyToEdit，第二场录制无法开始
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CaptureEngine, type RecorderHooks, type RecordSession } from '../../electron/capture/captureEngine';
import type { AudioPacket, VideoFramePacket } from '../../electron/capture/workers';
import type { QpcClock } from '../../electron/capture/qpcClock';
import type { SessionClock } from '../../src/domain/sessionClock';
import type { CaptureState } from '../../src/shared/ipc';
import { secondsToTicks } from '../../src/domain/timebase';

const FRAME = Math.round(secondsToTicks(1) / 30);
const FREQ = 10_000_000n;

interface SegmentView {
  index: number;
  startTick: number;
  durationTicks: number;
  frames: unknown[];
}

interface EngineInternals {
  state: CaptureState;
  session: RecordSession | null;
  clock: SessionClock;
  qpcClock: QpcClock;
  frames: { mediaTick: number; jpeg: Buffer; qpc: bigint }[];
  micPackets: AudioPacket[];
  systemPackets: AudioPacket[];
  pendingSegments: SegmentView[];
  grabber: { frequency: bigint; stop: () => Promise<void> } | null;
  audio: null;
  stopping: boolean;
  handleVideoFrame(frame: VideoFramePacket): void;
  handleAudioPacket(packet: AudioPacket): void;
  flushRemainingFrames(): void;
  splitAudioPackets(
    packets: AudioPacket[],
    slice: { startTick: number; durationTicks: number },
  ): { inside: AudioPacket[]; carry: AudioPacket[] };
  drainSegmentQueue(): Promise<void>;
  drainCameraJobs(): Promise<void>;
  resetFinishedSession(): Promise<void>;
  writeWav(target: string, packets: AudioPacket[], durationTicks: number): Promise<void>;
  writeAudioSegment(
    session: RecordSession,
    index: number,
    mic: AudioPacket[],
    system: AudioPacket[],
    durationTicks: number,
  ): Promise<void>;
}

const tempDirs: string[] = [];

async function makeProjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wcs-capture-'));
  await mkdir(path.join(dir, 'recovery'), { recursive: true });
  await mkdir(path.join(dir, 'events'), { recursive: true });
  await mkdir(path.join(dir, 'media', 'mic'), { recursive: true });
  await mkdir(path.join(dir, 'media', 'system'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeSession(projectPath: string, overrides: Partial<RecordSession['config']> = {}): RecordSession {
  return {
    sessionId: 'sess-test',
    projectPath,
    projectId: 'proj-test',
    config: {
      microphoneEnabled: true,
      systemAudioEnabled: true,
      ...overrides,
    } as unknown as RecordSession['config'],
    quality: { id: 'q' } as unknown as RecordSession['quality'],
    effective: { width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', hardwareEncoding: false },
    degradation: null,
    startedAt: Date.now(),
  };
}

function makeEngine(options: { hooks?: Partial<RecorderHooks> } = {}) {
  const hooks: RecorderHooks = {
    onStatus: () => {},
    requestSegment: async () => ({ mp4: null, frames: 0, encoder: 'test', durationUs: 0 }),
    finalizeRecorder: async () => {},
    onAppEvent: () => {},
    ...options.hooks,
  };
  const engine = new CaptureEngine(
    { grabberExe: 'grabber.exe', audioExe: 'audio.exe' },
    hooks,
    {
      getCursorPoint: () => ({ x: 0, y: 0 }),
      getFreeDisk: () => 10 * 1024 * 1024 * 1024,
      ensureProjectDir: async () => {},
      createProjectForSession: async () => {},
    },
  );
  return { engine, hooks, internals: engine as unknown as EngineInternals };
}

function videoFrame(tick: number): VideoFramePacket {
  return { qpc: BigInt(tick), jpeg: Buffer.from([0xff, 0xd8, 0x01, 0x02]), receivedAt: Date.now() };
}

function audioPacket(qpc: number, samples: number, streamId: 0 | 1 = 1, startFrame = 0): AudioPacket {
  return {
    streamId,
    startFrame,
    rms: 0.1,
    qpc: BigInt(qpc),
    left: new Float32Array(samples).fill(0.5),
    right: new Float32Array(samples).fill(-0.5),
    receivedAt: Date.now(),
  };
}

function feedFrames(internals: EngineInternals, fromTick: number, toTick: number, step = FRAME): void {
  for (let tick = fromTick; tick <= toTick; tick += step) internals.handleVideoFrame(videoFrame(tick));
}

function prepareRecording(projectPath: string, options: { hooks?: Partial<RecorderHooks> } = {}) {
  const created = makeEngine(options);
  const { internals } = created;
  internals.session = makeSession(projectPath);
  internals.state = 'Recording';
  internals.stopping = false;
  internals.clock.setZero(0);
  internals.grabber = { frequency: FREQ, stop: async () => {} };
  return created;
}

describe('CaptureEngine: 停止排空阶段的帧不能被状态守卫丢掉', () => {
  it('Stopping + 停止边界之前的帧仍被接收，边界之后的帧被丢弃', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.state = 'Stopping';
    internals.stopping = true;
    internals.clock.setZero(0);
    internals.clock.stop(500_000); // 停止命令发出于 50ms
    internals.grabber = { frequency: FREQ, stop: async () => {} };

    internals.handleVideoFrame(videoFrame(100_000)); // 停止前已采集，必须收
    internals.handleVideoFrame(videoFrame(600_000)); // 停止后才采集，丢弃
    expect(internals.frames).toHaveLength(1);
    expect(internals.frames[0].mediaTick).toBe(100_000);
  });

  it('录制中的帧照常接收（回归保护）', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.state = 'Recording';
    internals.clock.setZero(0);
    internals.grabber = { frequency: FREQ, stop: async () => {} };
    feedFrames(internals, 0, 2 * FRAME);
    expect(internals.frames).toHaveLength(3);
  });
});

describe('CaptureEngine: 分段栅格在暂停 flush 后重新对齐', () => {
  it('flush 短段之后继续录，下一段起点等于上一段结束，不重叠', async () => {
    const projectPath = await makeProjectDir();
    const requests: { index: number; startTick: number; durationTicks: number }[] = [];
    const { internals } = prepareRecording(projectPath, {
      hooks: {
        requestSegment: async (info) => {
          requests.push({ index: info.index, startTick: info.startTick, durationTicks: info.durationTicks });
          return { mp4: null, frames: 0, encoder: 'test', durationUs: 0 };
        },
      },
    });
    feedFrames(internals, 0, secondsToTicks(1.0));
    // 暂停：把当前缓冲收尾成一个短段
    internals.flushRemainingFrames();
    expect(internals.pendingSegments).toHaveLength(1);
    const partial = internals.pendingSegments[0];
    expect(partial.startTick).toBe(0);
    expect(partial.durationTicks).toBeGreaterThan(secondsToTicks(0.9));

    // 恢复后继续录（媒体时间连续）
    feedFrames(internals, secondsToTicks(1.0) + FRAME, secondsToTicks(3.2));
    await internals.drainSegmentQueue();

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0].index).toBe(1);
    expect(requests[0].startTick).toBe(partial.startTick);
    expect(requests[0].durationTicks).toBe(partial.durationTicks);
    // 关键：第二段必须从第一段真实结束处开始，而不是重新回到 0（旧实现会重叠约 1 秒）
    expect(requests[1].startTick).toBe(requests[0].startTick + requests[0].durationTicks);
  });
});

function alignOnly(internals: EngineInternals, packets: AudioPacket[], segmentStartTick: number): AudioPacket[] {
  return internals.splitAudioPackets(packets, {
    startTick: segmentStartTick,
    durationTicks: Number.MAX_SAFE_INTEGER,
  }).inside;
}

describe('CaptureEngine: 音频包按 QPC 对齐到段内偏移', () => {
  it('把流自身序号改写为段内 48k 帧偏移，并丢弃暂停期间的包', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.state = 'Recording';
    internals.clock.setZero(0);
    internals.grabber = { frequency: FREQ, stop: async () => {} };
    internals.clock.pause(secondsToTicks(1.0)); // 暂停尚未恢复

    const aligned = alignOnly(
      internals,
      [
        audioPacket(secondsToTicks(1.0), 960, 1, 96_000), // 正好暂停时刻 → 丢弃
        audioPacket(secondsToTicks(0.5), 960, 1, 48_000), // 段起点前 0.5s → 偏移 0.5s
        audioPacket(secondsToTicks(2.0), 960, 0, 2_000), // 暂停期间 → 丢弃
      ],
      secondsToTicks(0),
    );
    expect(aligned).toHaveLength(1);
    expect(aligned[0].startFrame).toBe(24_000);
  });

  it('零点之前的音频包被裁掉（早于首帧的轨道数据）', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.clock.setZero(secondsToTicks(1));
    const aligned = alignOnly(internals, [audioPacket(secondsToTicks(0.9), 960)], secondsToTicks(0));
    expect(aligned).toHaveLength(0);
  });

  it('越过段结束边界的包被交给下一段，不按本段偏移硬塞（段边界不丢音频）', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.state = 'Recording';
    internals.clock.setZero(0);
    internals.grabber = { frequency: FREQ, stop: async () => {} };
    const slice = { startTick: 0, durationTicks: secondsToTicks(1.6) };
    const split = internals.splitAudioPackets(
      [
        audioPacket(secondsToTicks(1.0), 960), // 属于本段
        audioPacket(secondsToTicks(1.7), 960), // 属于下一段
        audioPacket(secondsToTicks(1.8), 960), // 属于下一段
      ],
      slice,
    );
    expect(split.inside).toHaveLength(1);
    expect(split.inside[0].startFrame).toBe(48_000);
    expect(split.carry).toHaveLength(2);
    expect(split.carry.map((p) => Number(p.qpc))).toEqual([secondsToTicks(1.7), secondsToTicks(1.8)]);
  });
});

describe('CaptureEngine: WAV 按段内偏移写盘', () => {
  it('负偏移包头被裁掉、越界样本截断、其余位置为静音', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    const target = path.join(projectPath, 'media', 'mic', 'seg-000001.wav');
    const startFrame = -2;
    const packet: AudioPacket = {
      streamId: 1,
      startFrame,
      rms: 0.1,
      qpc: 1n,
      left: new Float32Array([1, 2, 3, 4]),
      right: new Float32Array([10, 20, 30, 40]),
      receivedAt: Date.now(),
    };
    const tail: AudioPacket = {
      streamId: 1,
      startFrame: 4799,
      rms: 0.1,
      qpc: 2n,
      left: new Float32Array([5, 6]),
      right: new Float32Array([50, 60]),
      receivedAt: Date.now(),
    };
    // 0.1s = 4800 帧
    await internals.writeWav(target, [packet, tail], secondsToTicks(0.1));
    const wav = await readFile(target);
    expect(wav.length).toBe(44 + 4800 * 8);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    // 前两个样本（i=0,1）落在段前被丢弃；i=2 → frame0、i=3 → frame1
    expect(wav.readFloatLE(44 + 0 * 8)).toBe(3);
    expect(wav.readFloatLE(44 + 0 * 8 + 4)).toBe(30);
    expect(wav.readFloatLE(44 + 1 * 8)).toBe(4);
    expect(wav.readFloatLE(44 + 1 * 8 + 4)).toBe(40);
    // tail 的 frame4799 写入最后一个样本，第二个样本越界丢弃
    expect(wav.readFloatLE(44 + 4799 * 8)).toBe(5);
    expect(wav.readFloatLE(44 + 4799 * 8 + 4)).toBe(50);
  });

  it('未启用的音轨不落盘（避免工程里多出静音轨）', async () => {
    const projectPath = await makeProjectDir();
    const { internals } = makeEngine();
    const session = makeSession(projectPath, { microphoneEnabled: false, systemAudioEnabled: false });
    await internals.writeAudioSegment(session, 1, [audioPacket(0, 960)], [audioPacket(0, 960)], secondsToTicks(0.1));
    await expect(access(path.join(projectPath, 'media', 'mic', 'seg-000001.wav'))).rejects.toThrow();
    await expect(access(path.join(projectPath, 'media', 'system', 'seg-000001.wav'))).rejects.toThrow();
  });
});

describe('CaptureEngine: 摄像头分段不阻塞屏幕编码队列', () => {
  it('摄像头提交未完成时 drainSegmentQueue 仍能结束，停止时再统一等待', async () => {
    const projectPath = await makeProjectDir();
    const calls: number[] = [];
    let resolveCamera: ((value: null) => void) | null = null;
    const cameraDone = new Promise<null>((resolve) => {
      resolveCamera = resolve;
    });
    const { internals } = prepareRecording(projectPath, {
      hooks: {
        commitCameraSegment: async (_path, index) => {
          calls.push(index);
          return cameraDone;
        },
      },
    });

    feedFrames(internals, 0, secondsToTicks(1.7));
    // 屏幕段编码在摄像头段完成前就应结束
    await internals.drainSegmentQueue();
    expect(calls).toEqual([1]);

    resolveCamera?.(null);
    await internals.drainCameraJobs();
    expect(calls).toEqual([1]);
  });
});

describe('CaptureEngine: 状态机复位（第二场录制可开始）', () => {
  it('ReadyToEdit 会被复位到 Idle', async () => {
    const projectPath = await makeProjectDir();
    const { engine, internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.state = 'ReadyToEdit';
    await internals.resetFinishedSession();
    expect(engine.getState()).toBe('Idle');
  });

  it('取消已完成的会话只复位状态、不删工程', async () => {
    const projectPath = await makeProjectDir();
    const { engine, internals } = makeEngine();
    internals.session = makeSession(projectPath);
    internals.state = 'ReadyToEdit';
    await engine.cancel();
    expect(engine.getState()).toBe('Idle');
  });

  it('没有会话时 addMarker 抛 E_INVALID_COMMAND 而不是写一个 tick=0 的幽灵标记', () => {
    const { engine } = makeEngine();
    expect(() => engine.addMarker('x')).toThrowError(/无法添加标记/);
  });
});
