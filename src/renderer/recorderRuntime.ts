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
 *
 * 协议约束：encodeSegment **永远 resolve**，失败用 { ok:false, error } 表达。
 * 主进程拿到后会抛 E_ENCODER_UNAVAILABLE 并由采集引擎记录段失败，
 * 因此这里既不能让异常逃逸（会变成 executeJavaScript 的 reject），
 * 也不能留下未释放的编码器/画布（隐藏窗口会连续编码几十段）。
 */

import { SegmentEncoder } from '../media/encode';
import { planFrameSlots } from './uiSync';
import { TICKS_PER_SECOND } from '@domain/timebase';

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
  /**
   * 音频包（主进程仍会随载荷发来）。
   *
   * 为什么这里不再使用它：`startFrame` 是**音频工作进程启动以来的全局采样序号**
   * （见 electron/native/audio.cs 的 _frameCursor），而本窗口拿到的是 2 秒的段载荷，
   * 没有「会话零点 → 音频采样零点」的映射。旧实现直接拿 startFrame 当段内偏移：
   *  - 第 1 段会把**倒计时期间的麦克风声音**混进 MP4（偏移 < 段长），
   *  - 后续段的偏移全部 ≥ 段长，于是被整段丢弃，MP4 里是无声音轨。
   * 屏幕段的音频真正来源是主进程按段写出的 media/mic|system/*.wav，
   * 导出时由时间映射混音；段 MP4 内嵌音轨既没有消费方，又会重复编码/放大体积，
   * 因此这里显式不内嵌音频（includeAudio:false），等主进程给出段内相对偏移后再启用。
   */
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
 * 本段选帧方案：按每帧真实时间戳落到「严格段长 × fps」的目标槽位。
 *
 * 纯逻辑在 ./uiSync.ts（planFrameSlots / planFramePicks，有单测）；这里只负责调用。
 * mediaTick 不可用时自动退回均匀抽样。
 */
/** 当前段的编码器实例（跨段复用会被 mediabunny 的连续时间戳假设破坏，故每段新建）。 */
let activeEncoder: SegmentEncoder | null = null;
/** 与 activeEncoder 同生命周期：dispose() 时要把画布后备存储置零归还内存。 */
let activeCtx: OffscreenCanvasRenderingContext2D | null = null;

/** 释放当前编码器与画布后备存储（成功、失败、窗口销毁三条路径共用）。 */
function releaseActiveEncoder(): void {
  const encoder = activeEncoder;
  const ctx = activeCtx;
  activeEncoder = null;
  activeCtx = null;
  try {
    encoder?.dispose();
  } catch {
    // 忽略
  }
  try {
    // canvas 尺寸置零才会立即归还后备存储
    if (ctx) {
      ctx.canvas.width = 0;
      ctx.canvas.height = 0;
    } else {
      // init() 在创建画布之后、返回 drawContext 之前抛错时，本地 ctx 还没拿到，
      // 但编码器内部画布已经分配了 8MB 后备存储，这里通过 canvasElement 补一次归还。
      const canvas = encoder?.canvasElement;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } catch {
    // 忽略
  }
}

async function encodeSegment(payload: SegmentPayload): Promise<SegmentResponse> {
  const started = performance.now();
  let encoder: SegmentEncoder | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let decodeFailures = 0;
  // 只有本调用真正创建了编码器才在 finally 里释放；
  // 否则「防重入提前返回」会把另一个正在跑的那段编码器拆掉。
  let ownsEncoder = false;

  try {
    // 主进程是串行 await 本方法的；这里再挡一次防重入：两个编码器同时跑会争用
    // GPU 上下文（旧实现用模块级 activeEncoder，第二个会覆盖第一个的引用，
    // 前一个就再也不会被 abort/dispose）。
    if (activeEncoder) {
      return { ok: false, error: '上一段仍在编码中，已跳过该段' };
    }
    if (!payload || !Array.isArray(payload.frames) || payload.frames.length === 0) {
      return { ok: false, error: '该段没有采集到任何帧' };
    }

    const fps = payload.fps > 0 ? payload.fps : 30;
    const segmentSeconds = payload.durationTicks / 10_000_000;

    encoder = new SegmentEncoder({
      width: payload.width,
      height: payload.height,
      fps,
      videoBitrate: Math.round(payload.width * payload.height * fps * 0.09),
      audioBitrate: 160_000,
      hardwarePreferred: true,
      // 音频不内嵌到段 MP4：原因见 SegmentPayload.audio 注释。
      // 音频由主进程按段写 WAV，导出时混音，重复编码只会放大文件、拖慢编码。
      includeAudio: false,
      audioSampleRate: 48_000,
      audioChannels: 2,
      // 每段自包含，时间轴从 0 开始；段内时间由帧序决定
      startTimestampUs: 0,
    });
    activeEncoder = encoder;
    activeCtx = null;
    ownsEncoder = true;
    await encoder.init();

    ctx = encoder.drawContext;
    activeCtx = ctx;

    // 逐帧绘制 JPEG 并编码。
    //
    // 关键：时间戳必须按「段时长」算出目标帧数，不能直接用采集帧数。
    // 采集进程按 QPC 节拍出帧，实际帧率可能略高于目标（实测 20 秒收到 656 帧而非 600 帧），
    // 如果仍按 i/fps 逐帧打时间戳，视频时间轴会被拉长到 656/30 = 21.87s，
    // 播放起来比真实时间慢 9%，且与音频（按真实时长生成）产生累计漂移。
    //
    // 正确做法：目标帧数 = 段时长 × fps，再按每帧的 mediaTick 落到最近槽位。
    // 掉帧只让对应时刻画面静止，不会把整段压快（旧实现均匀抽样会压缩时间轴，
    // 导致段内画面与按真实时长生成的音频错位，最多差一个段长）。
    const targetFrames = Math.max(1, Math.round(segmentSeconds * fps));
    const picks = planFrameSlots(
      payload.frames,
      payload.startTick,
      targetFrames,
      TICKS_PER_SECOND / fps,
    );

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
      const sourceFrame = payload.frames[picks[i]];
      try {
        const bitmap = await decodeJpeg(base64ToBytes(sourceFrame.jpeg));
        try {
          ctx.drawImage(bitmap, 0, 0, payload.width, payload.height);
        } finally {
          bitmap.close();
        }
      } catch (error) {
        // 单帧 JPEG 损坏（grabber 截断/内存压力）不应该让整段 2 秒画面全部丢掉：
        // 跳过这一帧，画布保留上一帧内容，时间轴照常推进。
        decodeFailures += 1;
        if (decodeFailures <= 3) {
          console.warn(`[recorder] 段 #${payload.index} 第 ${picks[i]} 帧解码失败，沿用上一帧：${String(error)}`);
        }
      }
      await encoder.commitVideoFrame(i * frameStepUs);
      written++;
    }

    const result = await encoder.finalize();

    const elapsed = Math.round(performance.now() - started);
    console.log(
      `[recorder] 段 #${payload.index} 编码完成 ${written} 帧 / ${result.data.byteLength} 字节 / ${elapsed}ms / ${result.encoder}` +
        (decodeFailures > 0 ? ` / 跳过错帧 ${decodeFailures}` : ''),
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
    console.error(`[recorder] 段 #${payload?.index ?? '?'} 编码失败：${message}`);
    return { ok: false, error: message };
  } finally {
    // 成功与失败都必须释放：每段新建 SegmentEncoder 会持有硬件 VideoEncoder（GPU 上下文）
    // 与 AudioBufferSource，另有 1920×1080 的 OffscreenCanvas（约 8MB 后备存储）。
    // 旧实现只在成功路径 dispose，失败段的资源只能等 GC；连续失败时内存线性增长。
    if (ownsEncoder) releaseActiveEncoder();
  }
}

async function dispose(): Promise<void> {
  releaseActiveEncoder();
}

declare global {
  interface Window {
    __wcsRecorder?: { encodeSegment: (payload: SegmentPayload) => Promise<SegmentResponse>; dispose: () => Promise<void> };
  }
}

/**
 * 只在 recorder 角色窗口安装运行时。
 *
 * main.tsx 会把本模块静态打进每一个窗口（Vite 要求静态 import），
 * 但只有隐藏的 recorder 窗口会被主进程用 executeJavaScript 调用。
 * 旧实现无条件写 window.__wcsRecorder，导致主窗口/悬浮窗/导出窗也挂着一个
 * 永不使用的编码入口；一旦这些窗口被误调 executeJavaScript，就会在用户窗口里
 * 抢占 GPU 编码上下文。与 cameraRuntime 的角色判断保持一致。
 */
function isRecorderRole(): boolean {
  if (typeof window === 'undefined') return false;
  const declared = window.wcs?.role;
  if (declared) return declared === 'recorder';
  return typeof location !== 'undefined' && /recorder/.test(location.hash + location.search);
}

if (isRecorderRole()) {
  window.__wcsRecorder = { encodeSegment, dispose };
  console.log('[recorder] 录制编码窗口就绪');
}
