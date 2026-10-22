/**
 * 录制编码窗口的运行时（开发文档 §9.4 / §11.2）
 *
 * 这个窗口是隐藏的，职责单一：
 *   主进程采集到一批 JPEG 帧 + 一段 PCM 音频 → 这里用 WebCodecs 编成 MP4 段
 *   → 把字节回传给主进程落盘。
 *
 * 为什么放在渲染进程：WebCodecs（VideoEncoder / AudioEncoder）只在渲染进程可用，
 * 主进程拿不到编码器。分段编码还能把内存占用限制在 2 秒窗口内。
 *
 * 与主进程的接口（由 electron/main.ts 通过 executeJavaScript 调用）：
 *   window.__wcsRecorder.encodeSegment(payload) → { ok, mp4(base64), frames, encoder, durationUs }
 *   window.__wcsRecorder.dispose()
 */

import { SegmentEncoder } from '../media/encode';

interface IncomingFrame {
  mediaTick: number;
  /** base64 JPEG */
  jpeg: string;
}

interface IncomingAudioPacket {
  startFrame: number;
  rms: number;
  qpc: string;
  left: number[];
  right: number[];
}

interface SegmentPayload {
  index: number;
  startTick: number;
  durationTicks: number;
  width: number;
  height: number;
  fps: number;
  frames: IncomingFrame[];
  audio: { mic: IncomingAudioPacket[]; system: IncomingAudioPacket[] };
}

interface SegmentResponse {
  ok: boolean;
  mp4?: string;
  frames?: number;
  encoder?: string;
  durationUs?: number;
  error?: string;
}

/** 解码 base64 → ArrayBuffer（渲染进程没有 Buffer）。 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 字节 → base64，分块避免超长字符串参数溢出。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(binary);
}

/** 用 createImageBitmap 解码 JPEG。 */
async function decodeJpeg(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' });
  return createImageBitmap(blob);
}

/**
 * 把两路音频包（系统/麦克风）混成一段交错的 Float32 立体声。
 *
 * 时间对齐：每个包都带 qpc（WASAPI 位置），换算成相对会话起点的样本偏移。
 * 两路采样率都是 48 kHz（原生层已重采样），因此可以直接按样本索引相加。
 */
function mixAudio(
  mic: IncomingAudioPacket[],
  system: IncomingAudioPacket[],
  totalFrames: number,
): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  const apply = (packets: IncomingAudioPacket[], gain: number) => {
    for (const packet of packets) {
      const offset = packet.startFrame;
      const count = packet.left.length;
      for (let i = 0; i < count; i++) {
        const target = offset + i;
        if (target < 0 || target >= totalFrames) continue;
        left[target] += (packet.left[i] ?? 0) * gain;
        right[target] += (packet.right[i] ?? 0) * gain;
      }
    }
  };

  // 两路各按 0.7 增益叠加，避免同时有声音时削顶
  apply(system, 0.7);
  apply(mic, 0.7);

  // 软限幅：超过 ±1 才压缩，正常音量不受影响
  for (let i = 0; i < totalFrames; i++) {
    if (left[i] > 1) left[i] = 1;
    else if (left[i] < -1) left[i] = -1;
    if (right[i] > 1) right[i] = 1;
    else if (right[i] < -1) right[i] = -1;
  }
  return { left, right };
}

/** 当前段的编码器实例（跨段复用会被 mediabunny 的连续时间戳假设破坏，故每段新建）。 */
let activeEncoder: SegmentEncoder | null = null;

async function encodeSegment(payload: SegmentPayload): Promise<SegmentResponse> {
  const started = performance.now();
  try {
    if (payload.frames.length === 0) {
      return { ok: false, error: '该段没有采集到任何帧' };
    }

    const fps = payload.fps > 0 ? payload.fps : 30;
    const sampleRate = 48_000;
    const segmentSeconds = payload.durationTicks / 10_000_000;
    const totalAudioFrames = Math.max(0, Math.round(segmentSeconds * sampleRate));

    const encoder = new SegmentEncoder({
      width: payload.width,
      height: payload.height,
      fps,
      videoBitrate: Math.round(payload.width * payload.height * fps * 0.09),
      audioBitrate: 160_000,
      hardwarePreferred: true,
      includeAudio: totalAudioFrames > 0,
      audioSampleRate: sampleRate,
      audioChannels: 2,
      // 每段自包含，时间轴从 0 开始；段内时间由帧序决定
      startTimestampUs: 0,
    });
    activeEncoder = encoder;
    await encoder.init();

    const ctx = encoder.drawContext;

    // 逐帧绘制 JPEG 并编码。
    //
    // 关键：时间戳必须按「段时长」算出目标帧数，不能直接用采集帧数。
    // 采集进程按 QPC 节拍出帧，实际帧率可能略高于目标（实测 20 秒收到 656 帧而非 600 帧），
    // 如果仍按 i/fps 逐帧打时间戳，视频时间轴会被拉长到 656/30 = 21.87s，
    // 播放起来比真实时间慢 9%，且与音频（按真实时长生成）产生累计漂移。
    //
    // 正确做法：目标帧数 = 段时长 × fps；采集帧多于目标时按间隔抽样丢弃，
    // 少于目标时重复最后一帧补齐。这样段内时间轴严格等于段时长。
    // 采样点选择需要段时长，复用上面已经算好的 segmentSeconds，不再重复计算
    const targetFrames = Math.max(1, Math.round(segmentSeconds * fps));
    const sourceCount = payload.frames.length;
    const picks: number[] = [];
    if (sourceCount >= targetFrames) {
      // 均匀抽样：从 sourceCount 帧里挑 targetFrames 帧，间距最均匀
      for (let i = 0; i < targetFrames; i++) {
        picks.push(Math.min(sourceCount - 1, Math.floor((i * sourceCount) / targetFrames)));
      }
    } else {
      // 帧不够：能取多少取多少，剩余用最后一帧补齐（画面停住而不是时间轴变短）
      for (let i = 0; i < sourceCount; i++) picks.push(i);
      while (picks.length < targetFrames) picks.push(sourceCount - 1);
    }

    let written = 0;
    // 时间戳用「整数微秒」逐帧递增，而不是每帧重算 i/fps。
    //
    // 为什么：i/fps 会引入浮点误差，mediabunny 转回整数时间基准时向上取整，
    // 每段因此比目标时长多 5.333ms（实测 2.005333s 而非 2.000000s）。
    // 单段看不出来，但 30 段累计 160ms，正好让 §16.2「音画偏差 ≤80ms」超标。
    // 用整数累加（frameStepUs 固定）可保证段内总时长精确。
    const frameStepUs = Math.round(1_000_000 / fps);
    // 注意：不能在这里把用过的 payload.frames[i].jpeg 置空。
    // picks 会重复引用同一帧（帧数不足时用最后一帧补齐），
    // 提前置空会让后续 picks 解到空字符串，整段编码失败 ——
    // 实测表现为「录制覆盖率 8%、只出 1 段」。
    // 整段编码结束后 payload 会被整体丢弃，V8 随即回收，无需逐帧释放。
    for (let i = 0; i < picks.length; i++) {
      const bitmap = await decodeJpeg(base64ToBytes(payload.frames[picks[i]].jpeg));
      try {
        ctx.drawImage(bitmap, 0, 0, payload.width, payload.height);
      } finally {
        bitmap.close();
      }
      await encoder.commitVideoFrame(i * frameStepUs);
      written++;
    }

    // 音频：把整段 PCM 混好，一次追加（AudioBufferSource 顺序拼接语义）
    if (totalAudioFrames > 0) {
      const mixed = mixAudio(payload.audio.mic, payload.audio.system, totalAudioFrames);
      await encoder.addAudio([mixed.left, mixed.right], 0, sampleRate);
    }

    const result = await encoder.finalize();
    activeEncoder = null;

    // 主动释放本段的编码器资源与画布后备存储。
    //
    // 每段都新建 SegmentEncoder（持有硬件 VideoEncoder 上下文、AudioBufferSource、
    // Output 封装器）和一个 1920×1080 的 OffscreenCanvas（约 8MB 后备存储）。
    // 不显式释放时这些资源只能等 GC，实测进程树内存随分段数线性增长
    // （40 秒录制涨到 3058MB，超出 §16.2 的 1.2GB 上限）。
    encoder.dispose();
    try {
      // canvas 尺寸置零才会立即归还后备存储
      ctx.canvas.width = 0;
      ctx.canvas.height = 0;
    } catch {
      // 忽略
    }

    const elapsed = Math.round(performance.now() - started);
    console.log(
      `[recorder] 段 #${payload.index} 编码完成 ${written} 帧 / ${totalAudioFrames} 采样 / ${result.data.byteLength} 字节 / ${elapsed}ms / ${result.encoder}`,
    );

    return {
      ok: true,
      mp4: bytesToBase64(result.data),
      frames: result.frames,
      encoder: result.encoder,
      durationUs: result.durationUs,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.message}` : String(error);
    console.error(`[recorder] 段 #${payload.index} 编码失败：${message}`);
    try {
      activeEncoder?.abort();
    } catch {
      // 忽略
    }
    activeEncoder = null;
    return { ok: false, error: message };
  }
}

async function dispose(): Promise<void> {
  try {
    activeEncoder?.abort();
  } catch {
    // 忽略
  }
  activeEncoder = null;
}

declare global {
  interface Window {
    __wcsRecorder?: { encodeSegment: (payload: SegmentPayload) => Promise<SegmentResponse>; dispose: () => Promise<void> };
  }
}

window.__wcsRecorder = { encodeSegment, dispose };

console.log('[recorder] 录制编码窗口就绪');
