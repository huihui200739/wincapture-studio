/**
 * 原生采集子进程的 stdout 二进制协议解码（纯函数，无副作用，便于单测）。
 *
 * grabber.exe 帧协议：[uint32 小端长度][int64 小端 QPC][JPEG 字节]
 * audio.exe 包协议：  [uint32 长度][uint32 streamId][int32 startFrame][float32 rms][int64 qpc][L…][R…]
 *                     错误包：    [uint32 长度][0xFFFFFFFF][uint32 流][uint32 codeLen][uint32 msgLen][code][msg]
 *
 * 设计要点：
 *  - 流式解码：一次 push 可以只有半个包头、也可以包含多个完整包（粘包）；
 *    未消费的尾部会拷贝成独立小 Buffer，避免 subarray 视图长期引用大块内存（V8 无法回收）。
 *  - 非法长度/失步立即返回 error 而不是静默重置：长度前缀协议没有同步标记，
 *    一旦长度字段被读错，后续所有包都会错位；继续跑只会写入错帧。调用方应杀死子进程并报告源故障。
 *  - JPEG 用 SOI 标记（FF D8）做帧级校验：这是低成本、高命中率的失步检测。
 */

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
  /**
   * 编码/落盘时该块首采样在「所属分段」内的 48 kHz 帧序号。
   * 原生进程输出的是该流自身的累计帧号；主进程在切段时会按 QPC 重新计算为
   * 段内偏移（见 audioAlign.ts），因此录制渲染窗口拿到的始终是段内对齐时间。
   */
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

export const VIDEO_HEADER_BYTES = 12;
export const AUDIO_HEADER_BYTES = 24;
export const AUDIO_ERROR_HEADER_BYTES = 20;

/**
 * 单帧上限。1080p q=88 的 JPEG 约 100~400KB；即使 8K 屏幕也不该超过 16MB。
 * 上限的作用是「读到损坏的长度字段时不要按 60MB 去攒内存」。
 */
export const MAX_VIDEO_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * 单个音频包上限。20ms/48kHz/立体声 float 是 7.5KB；8MB 足够容错且能识别损坏长度。
 */
export const MAX_AUDIO_PACKET_BYTES = 8 * 1024 * 1024;

export interface VideoDecodeResult {
  frames: VideoFramePacket[];
  /** 协议失步/长度非法；非 null 表示后续数据不可信，调用方应终止子进程 */
  error: string | null;
}

export interface AudioDecodeResult {
  packets: AudioPacket[];
  errors: AudioErrorPacket[];
  error: string | null;
}

/** 逐块解码 grabber.exe 的帧流。 */
export class FrameStreamDecoder {
  private pending: Buffer = Buffer.alloc(0);

  get pendingBytes(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }

  push(chunk: Buffer): VideoDecodeResult {
    // 只有在有半包时才拼接；半包通常 < 一帧，因此每个 chunk 至多一次 memcpy。
    let buf = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const frames: VideoFramePacket[] = [];

    while (buf.length >= VIDEO_HEADER_BYTES) {
      const length = buf.readUInt32LE(0);
      if (length < 2 || length > MAX_VIDEO_FRAME_BYTES) {
        return { frames, error: `视频帧长度非法：${length}（上限 ${MAX_VIDEO_FRAME_BYTES}）` };
      }
      const total = VIDEO_HEADER_BYTES + length;
      if (buf.length < total) break;

      const jpeg = buf.subarray(VIDEO_HEADER_BYTES, total);
      // JPEG 一定以 SOI（FF D8）开头。不是的话说明长度字段已错位，
      // 若继续按此长度切，后面每一帧都会是垃圾 —— 必须报告失步。
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        return { frames, error: `视频帧 JPEG 标记非法（0x${jpeg[0].toString(16)}${jpeg[1].toString(16)}），协议失步` };
      }
      frames.push({
        qpc: buf.readBigInt64LE(4),
        // 拷贝成独立 Buffer：不能持有 chunk 视图，否则整块管道缓冲都无法回收。
        jpeg: Buffer.from(jpeg),
        receivedAt: Date.now(),
      });
      buf = buf.subarray(total);
    }

    if (buf.length > 0) {
      // 断开与原 chunk 的引用关系，避免长期滞留大 Buffer。
      this.pending = Buffer.from(buf);
    }
    return { frames, error: null };
  }
}

/** 逐块解码 audio.exe 的音频包流。 */
export class AudioStreamDecoder {
  private pending: Buffer = Buffer.alloc(0);

  get pendingBytes(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }

  push(chunk: Buffer): AudioDecodeResult {
    let buf = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const packets: AudioPacket[] = [];
    const errors: AudioErrorPacket[] = [];

    while (buf.length >= 4) {
      const total = buf.readUInt32LE(0);
      // 最小合法包是错误包头 20 字节；正常音频包 24+8。
      // 注意不能统一用 24 做下限：错误包在 code/message 都很短时可能只有 20~23 字节，
      // 旧实现会把它们当非法长度整块丢弃 —— 设备错误就此消失。
      if (total < AUDIO_ERROR_HEADER_BYTES || total > MAX_AUDIO_PACKET_BYTES) {
        return { packets, errors, error: `音频包长度非法：${total}（上限 ${MAX_AUDIO_PACKET_BYTES}）` };
      }
      if (buf.length < total) break;

      const packet = buf.subarray(0, total);
      const streamId = packet.readUInt32LE(4);

      if (streamId === 0xffffffff) {
        const codeLen = packet.readUInt32LE(12);
        const msgLen = packet.readUInt32LE(16);
        if (AUDIO_ERROR_HEADER_BYTES + codeLen + msgLen > total) {
          return { packets, errors, error: `音频错误包长度字段越界：${codeLen}/${msgLen}/${total}` };
        }
        errors.push({
          streamId: packet.readUInt32LE(8),
          code: packet.subarray(AUDIO_ERROR_HEADER_BYTES, AUDIO_ERROR_HEADER_BYTES + codeLen).toString('utf8'),
          message: packet
            .subarray(AUDIO_ERROR_HEADER_BYTES + codeLen, AUDIO_ERROR_HEADER_BYTES + codeLen + msgLen)
            .toString('utf8'),
        });
      } else if (streamId === 0 || streamId === 1) {
        if (total < AUDIO_HEADER_BYTES) {
          return { packets, errors, error: `音频包过短：${total}（至少 ${AUDIO_HEADER_BYTES}）` };
        }
        const frames = (total - AUDIO_HEADER_BYTES) / 8;
        if (!Number.isInteger(frames) || frames <= 0) {
          return { packets, errors, error: `音频包采样数非法：${frames}（包长 ${total}）` };
        }
        const startFrame = packet.readInt32LE(8);
        const rms = packet.readFloatLE(12);
        const qpc = packet.readBigInt64LE(16);
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        for (let i = 0; i < frames; i++) left[i] = packet.readFloatLE(AUDIO_HEADER_BYTES + i * 4);
        const rightStart = AUDIO_HEADER_BYTES + frames * 4;
        for (let i = 0; i < frames; i++) right[i] = packet.readFloatLE(rightStart + i * 4);
        packets.push({
          streamId: streamId as 0 | 1,
          startFrame,
          rms,
          qpc,
          left,
          right,
          receivedAt: Date.now(),
        });
      }
      // 其它 streamId：协议允许将来扩展，跳过整包即可（长度已验证，不会失步）。

      buf = buf.subarray(total);
    }

    if (buf.length > 0) this.pending = Buffer.from(buf);
    return { packets, errors, error: null };
  }
}
