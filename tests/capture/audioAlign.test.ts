import { describe, it, expect } from 'vitest';
import {
  AUDIO_SAMPLE_RATE,
  audioBufferFrames,
  audioFrameCount,
  audioOffsetFrames,
  writePcmInto,
  type PlacedPcmPacket,
} from '../../electron/capture/audioAlign';
import { secondsToTicks, msToTicks } from '../../src/domain/timebase';

describe('audioOffsetFrames: 媒体时间 → 段内采样偏移', () => {
  it('整秒/毫秒换算到 48kHz', () => {
    expect(audioOffsetFrames(0, 0)).toBe(0);
    expect(audioOffsetFrames(secondsToTicks(1), 0)).toBe(AUDIO_SAMPLE_RATE);
    expect(audioOffsetFrames(secondsToTicks(1) + msToTicks(20), 0)).toBe(AUDIO_SAMPLE_RATE + 960);
  });

  it('段起点不为 0 时返回相对偏移', () => {
    expect(audioOffsetFrames(secondsToTicks(3), secondsToTicks(1.6))).toBe(Math.round((3 - 1.6) * AUDIO_SAMPLE_RATE));
  });

  it('允许负偏移（包从上一段跨过来，后半个包仍属于本段）', () => {
    expect(audioOffsetFrames(secondsToTicks(1) - msToTicks(10), secondsToTicks(1))).toBe(-480);
  });

  it('非法输入返回 0 而不是 NaN', () => {
    expect(audioOffsetFrames(Number.NaN, 0)).toBe(0);
    expect(audioOffsetFrames(0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('audioFrameCount / audioBufferFrames', () => {
  it('段时长换算成采样帧数', () => {
    expect(audioFrameCount(secondsToTicks(1.6))).toBe(76_800);
    expect(audioFrameCount(0)).toBe(0);
    expect(audioFrameCount(-5)).toBe(0);
  });

  it('声明时长为 0 时退化为包覆盖范围', () => {
    const packets: PlacedPcmPacket[] = [
      { startFrame: 100, left: new Float32Array(10), right: new Float32Array(10) },
      { startFrame: 50, left: new Float32Array(20), right: new Float32Array(20) },
    ];
    expect(audioBufferFrames(packets, 0)).toBe(110);
  });

  it('有声明时长时以声明时长为准（超出部分截断）', () => {
    const packets: PlacedPcmPacket[] = [
      { startFrame: 0, left: new Float32Array(500), right: new Float32Array(500) },
    ];
    expect(audioBufferFrames(packets, secondsToTicks(0.001))).toBe(48);
  });
});

describe('writePcmInto: 按偏移落盘', () => {
  const frameCount = 5;
  const makeBuffer = () => Buffer.alloc(frameCount * 8);

  it('负偏移的包头被裁掉，块内后续样本仍写到正确位置', () => {
    const data = makeBuffer();
    writePcmInto(
      data,
      [{ startFrame: -2, left: new Float32Array([1, 2, 3, 4]), right: new Float32Array([10, 20, 30, 40]) }],
      frameCount,
    );
    // i=0,1 落在段前被丢弃；i=2 → frame0，i=3 → frame1
    expect(data.readFloatLE(0)).toBe(3);
    expect(data.readFloatLE(4)).toBe(30);
    expect(data.readFloatLE(8)).toBe(4);
    expect(data.readFloatLE(12)).toBe(40);
  });

  it('超出段尾的样本被截断，未写入的位置保持静音 0', () => {
    const data = makeBuffer();
    writePcmInto(
      data,
      [{ startFrame: 4, left: new Float32Array([9, 8]), right: new Float32Array([7, 6]) }],
      frameCount,
    );
    expect(data.readFloatLE(4 * 8)).toBe(9);
    expect(data.readFloatLE(4 * 8 + 4)).toBe(7);
    // frame1~3 未被写入
    for (const frame of [1, 2, 3]) {
      expect(data.readFloatLE(frame * 8)).toBe(0);
      expect(data.readFloatLE(frame * 8 + 4)).toBe(0);
    }
  });

  it('多块按各自偏移写入，不互相覆盖', () => {
    const data = makeBuffer();
    writePcmInto(
      data,
      [
        { startFrame: 0, left: new Float32Array([1, 2]), right: new Float32Array([11, 12]) },
        { startFrame: 3, left: new Float32Array([4, 5]), right: new Float32Array([14, 15]) },
      ],
      frameCount,
    );
    expect(Array.from({ length: 5 }, (_, i) => data.readFloatLE(i * 8))).toEqual([1, 2, 0, 4, 5]);
    expect(Array.from({ length: 5 }, (_, i) => data.readFloatLE(i * 8 + 4))).toEqual([11, 12, 0, 14, 15]);
  });

  it('返回实际写入的样本帧数', () => {
    const data = makeBuffer();
    const written = writePcmInto(
      data,
      [
        { startFrame: -1, left: new Float32Array(3), right: new Float32Array(3) },
        { startFrame: 3, left: new Float32Array(3), right: new Float32Array(3) },
      ],
      frameCount,
    );
    expect(written).toBe(4); // -1 偏移 3 个样本只写入 2 个；3 偏移写入 2 个
  });

  it('左右声道长度不一致时按较短者写入，不越界', () => {
    const data = makeBuffer();
    writePcmInto(
      data,
      [{ startFrame: 0, left: new Float32Array([1, 2, 3]), right: new Float32Array([9]) }],
      frameCount,
    );
    expect(data.readFloatLE(0)).toBe(1);
    expect(data.readFloatLE(4)).toBe(9);
    expect(data.readFloatLE(8)).toBe(0); // 右声道缺失 → 不写
  });
});
