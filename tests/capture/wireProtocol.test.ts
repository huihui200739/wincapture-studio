import { describe, it, expect } from 'vitest';
import {
  AudioStreamDecoder,
  FrameStreamDecoder,
  MAX_AUDIO_PACKET_BYTES,
  MAX_VIDEO_FRAME_BYTES,
  VIDEO_HEADER_BYTES,
} from '../../electron/capture/wireProtocol';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02, 0xfe, 0xff, 0xd9]);

function frameBytes(jpeg: Buffer, qpc: bigint, lengthOverride?: number): Buffer {
  const header = Buffer.alloc(VIDEO_HEADER_BYTES);
  header.writeUInt32LE(lengthOverride ?? jpeg.length, 0);
  header.writeBigInt64LE(qpc, 4);
  return Buffer.concat([header, jpeg]);
}

function audioPacketBytes(
  streamId: number,
  startFrame: number,
  rms: number,
  qpc: bigint,
  left: number[],
  right: number[],
): Buffer {
  const frames = left.length;
  const total = 24 + frames * 8;
  const data = Buffer.alloc(total);
  data.writeUInt32LE(total, 0);
  data.writeUInt32LE(streamId >>> 0, 4);
  data.writeInt32LE(startFrame, 8);
  data.writeFloatLE(rms, 12);
  data.writeBigInt64LE(qpc, 16);
  for (let i = 0; i < frames; i++) {
    data.writeFloatLE(left[i], 24 + i * 4);
    data.writeFloatLE(right[i], 24 + frames * 4 + i * 4);
  }
  return data;
}

function audioErrorBytes(streamId: number, code: string, message: string): Buffer {
  const codeBytes = Buffer.from(code, 'utf8');
  const msgBytes = Buffer.from(message, 'utf8');
  const total = 20 + codeBytes.length + msgBytes.length;
  const data = Buffer.alloc(total);
  data.writeUInt32LE(total, 0);
  data.writeUInt32LE(0xffffffff, 4);
  data.writeUInt32LE(streamId >>> 0, 8);
  data.writeUInt32LE(codeBytes.length, 12);
  data.writeUInt32LE(msgBytes.length, 16);
  codeBytes.copy(data, 20);
  msgBytes.copy(data, 20 + codeBytes.length);
  return data;
}

describe('FrameStreamDecoder: 帧流协议', () => {
  it('一个 chunk 里多个完整帧（粘包）只解码一次且顺序正确', () => {
    const decoder = new FrameStreamDecoder();
    const a = frameBytes(JPEG, 111n);
    const b = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
    const result = decoder.push(Buffer.concat([a, frameBytes(b, 222n)]));
    expect(result.error).toBeNull();
    expect(result.frames.map((f) => f.qpc)).toEqual([111n, 222n]);
    expect(result.frames[0].jpeg.equals(JPEG)).toBe(true);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('半个包头 / 半个 JPEG 也能在后续 chunk 补齐（半包）', () => {
    const bytes = frameBytes(JPEG, 987654321n);
    for (let cut = 1; cut < bytes.length; cut++) {
      const decoder = new FrameStreamDecoder();
      const first = decoder.push(bytes.subarray(0, cut));
      expect(first.error).toBeNull();
      const second = decoder.push(bytes.subarray(cut));
      expect(second.error).toBeNull();
      expect(second.frames).toHaveLength(1);
      expect(second.frames[0].qpc).toBe(987654321n);
      expect(second.frames[0].jpeg.equals(JPEG)).toBe(true);
    }
  });

  it('逐字节喂入也不丢帧', () => {
    const decoder = new FrameStreamDecoder();
    const payload = Buffer.concat([frameBytes(JPEG, 1n), frameBytes(JPEG, 2n), frameBytes(JPEG, 3n)]);
    const frames = [] as unknown[];
    for (const byte of payload) {
      const result = decoder.push(Buffer.from([byte]));
      expect(result.error).toBeNull();
      frames.push(...result.frames);
    }
    expect(frames).toHaveLength(3);
  });

  it('长度为 0 / 超过上限 / 0xFFFFFFFF 时报错（不再静默重置继续读）', () => {
    const decoder = new FrameStreamDecoder();
    expect(decoder.push(frameBytes(JPEG, 1n, 0)).error).toMatch(/长度非法/);
    expect(new FrameStreamDecoder().push(frameBytes(JPEG, 1n, MAX_VIDEO_FRAME_BYTES + 1)).error).toMatch(/长度非法/);
    expect(new FrameStreamDecoder().push(frameBytes(JPEG, 1n, 0xffffffff)).error).toMatch(/长度非法/);
  });

  it('JPEG 不是以 SOI 开头时判定协议失步', () => {
    const decoder = new FrameStreamDecoder();
    const broken = Buffer.from([0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4]);
    const result = decoder.push(frameBytes(broken, 1n));
    expect(result.error).toMatch(/JPEG 标记非法/);
  });

  it('错误之后已解出的帧仍会返回（调用方可先落盘再终止进程）', () => {
    const decoder = new FrameStreamDecoder();
    const good = frameBytes(JPEG, 7n);
    const bad = Buffer.concat([Buffer.alloc(12), Buffer.from([0, 0])]);
    bad.writeUInt32LE(2, 0);
    const result = decoder.push(Buffer.concat([good, bad]));
    expect(result.frames).toHaveLength(1);
    expect(result.error).toMatch(/JPEG 标记非法/);
  });

  it('尾部半包会拷贝成独立缓冲，pendingBytes 反映剩余长度', () => {
    const decoder = new FrameStreamDecoder();
    const full = frameBytes(JPEG, 5n);
    decoder.push(full.subarray(0, full.length - 3));
    expect(decoder.pendingBytes).toBe(full.length - 3);
    decoder.reset();
    expect(decoder.pendingBytes).toBe(0);
  });
});

describe('AudioStreamDecoder: 音频流协议', () => {
  it('解析正常音频包的元数据与左右声道', () => {
    const decoder = new AudioStreamDecoder();
    const bytes = audioPacketBytes(1, 960, 0.5, 123456789n, [0.1, 0.2], [-0.1, -0.2]);
    const result = decoder.push(bytes);
    expect(result.error).toBeNull();
    expect(result.packets).toHaveLength(1);
    const packet = result.packets[0];
    expect(packet.streamId).toBe(1);
    expect(packet.startFrame).toBe(960);
    expect(packet.rms).toBeCloseTo(0.5);
    expect(packet.qpc).toBe(123456789n);
    expect(Array.from(packet.left)).toEqual([expect.closeTo(0.1), expect.closeTo(0.2)]);
    expect(Array.from(packet.right)).toEqual([expect.closeTo(-0.1), expect.closeTo(-0.2)]);
  });

  it('两个包粘在一起、且第二个包被拆成两段也能正确解析', () => {
    const decoder = new AudioStreamDecoder();
    const a = audioPacketBytes(0, 0, 0.1, 10n, [1, 2, 3], [4, 5, 6]);
    const b = audioPacketBytes(1, 960, 0.2, 20n, [7], [8]);
    const all = Buffer.concat([a, b]);
    const first = decoder.push(all.subarray(0, a.length + 5));
    expect(first.packets).toHaveLength(1);
    const second = decoder.push(all.subarray(a.length + 5));
    expect(second.packets).toHaveLength(1);
    expect(second.packets[0].qpc).toBe(20n);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('短错误包（总长 20~23 字节）不会被当成非法长度丢弃', () => {
    // 旧实现用 total < 24 判非法，会把 code 很短的真实设备错误包整块丢掉。
    const decoder = new AudioStreamDecoder();
    const short = audioErrorBytes(1, 'E', '');
    expect(short.length).toBeLessThan(24);
    const result = decoder.push(short);
    expect(result.error).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ streamId: 1, code: 'E', message: '' });
  });

  it('错误包后紧跟正常包仍能继续解析', () => {
    const decoder = new AudioStreamDecoder();
    const result = decoder.push(
      Buffer.concat([audioErrorBytes(0, 'E_AUDIO_DEVICE_LOST', '设备已断开'), audioPacketBytes(0, 0, 0.3, 99n, [0.5], [0.5])]),
    );
    expect(result.error).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.packets).toHaveLength(1);
  });

  it('错误包长度字段越界时报错', () => {
    const decoder = new AudioStreamDecoder();
    const bytes = audioErrorBytes(0, 'E', 'broken');
    bytes.writeUInt32LE(1000, 12);
    expect(decoder.push(bytes).error).toMatch(/越界/);
  });

  it('长度非法（过小/过大）与非法采样数都会报错', () => {
    expect(new AudioStreamDecoder().push(Buffer.from([19, 0, 0, 0])).error).toMatch(/长度非法/);
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(MAX_AUDIO_PACKET_BYTES + 1, 0);
    expect(new AudioStreamDecoder().push(huge).error).toMatch(/长度非法/);

    const bad = Buffer.alloc(24 + 3); // (total-24) 不是 8 的倍数
    bad.writeUInt32LE(24 + 3, 0);
    bad.writeUInt32LE(0, 4);
    expect(new AudioStreamDecoder().push(bad).error).toMatch(/采样数非法/);
  });

  it('未知 streamId 的包被跳过但不会失步', () => {
    const decoder = new AudioStreamDecoder();
    const future = audioPacketBytes(9, 0, 0, 1n, [1], [1]);
    const result = decoder.push(Buffer.concat([future, audioPacketBytes(0, 0, 0.1, 2n, [0.1], [0.1])]));
    expect(result.error).toBeNull();
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0].streamId).toBe(0);
  });
});
