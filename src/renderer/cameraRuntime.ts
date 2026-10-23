/**
 * 摄像头采集运行时（R04）
 *
 * 为什么放在渲染进程：摄像头只能通过 `navigator.mediaDevices.getUserMedia` 拿到，
 * 主进程没有等价 API；拿到 MediaStream 后用 WebCodecs + mediabunny 编成分段 MP4，
 * 和屏幕录制走完全相同的编码路径（src/media/encode.ts 的 SegmentEncoder）。
 *
 * 产物与屏幕段对齐：
 *   media/camera/seg-000001.mp4、seg-000002.mp4 ...
 * 每个段自包含（时间从 0 开始），与 screen 段一一对应，
 * 这样导出时 camera 轨和主视频轨用同一个时间映射，不需要额外对齐逻辑。
 *
 * 降级策略（§9.5 诚实降级）：
 * - 没有摄像头 / 权限被拒 / 设备被占用 → 返回明确的 reason，录制继续但无摄像头轨
 * - 绝不假装成功，也绝不因为摄像头失败而中断整场录制
 */

import { SegmentEncoder } from '../media/encode';

export interface CameraSegmentRequest {
  /** 段序号，与 screen 段一致 */
  index: number;
  /** 段时长（ticks） */
  durationTicks: number;
  /** 目标帧率 */
  fps: number;
  /** 输出尺寸（固定 1280×720，文档 R04 要求 720p30） */
  width: number;
  height: number;
  /** 该段内要采样的时刻（毫秒，相对段起点），由主进程按固定间隔给出 */
  sampleTimesMs: number[];
}

export interface CameraSegmentResult {
  ok: boolean;
  /** base64 MP4 字节 */
  mp4?: string;
  frames?: number;
  bytes?: number;
  encoder?: string;
  error?: string;
}

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let activeDeviceId: string | null = null;
/** 采集画布：摄像头原始帧先画到这里再编码，避免直接编码 VideoFrame 的尺寸差异 */
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function ensureElements(): { video: HTMLVideoElement; canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  if (!video) {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
  }
  if (!canvas || !ctx) {
    canvas = new OffscreenCanvas(1280, 720);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建摄像头采集画布');
    ctx = context;
  }
  return { video, canvas, ctx };
}

/** 枚举摄像头设备。 */
async function listDevices(): Promise<CameraDeviceInfo[]> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, index) => ({
        deviceId: d.deviceId,
        // 未授权时 label 是空串，给一个可读的兜底名
        label: d.label || `摄像头 ${index + 1}`,
      }));
  } catch {
    return [];
  }
}

/**
 * 等第一帧真正到达，否则第一段会编码出黑帧。
 * 超时/失败都要清掉事件处理器，避免下一次 open 时旧 handler 还在。
 */
async function waitForFirstFrame(videoEl: HTMLVideoElement, timeoutMs = 3000): Promise<void> {
  if (videoEl.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      videoEl.onloadeddata = null;
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    videoEl.onloadeddata = finish;
  });
}

/**
 * 打开摄像头。
 *
 * 优先用调用方指定的 deviceId；指定失败时退回默认设备（用户可能拔了设备）。
 * 失败一律返回 reason，不抛异常——调用方要能继续录制。
 *
 * 每个失败分支都必须先把已拿到的 MediaStream 停掉：
 * 旧实现里 getUserMedia 成功但 video.play() 失败时直接进入下一轮重试，
 * 上一个流既没 stop 也没断开，摄像头指示灯一直亮着、设备被永久占用。
 */
async function open(deviceId?: string): Promise<{ ok: boolean; deviceId?: string; label?: string; error?: string }> {
  await close();
  const { video: videoEl } = ensureElements();

  const attempts: (MediaStreamConstraints | null)[] = [];
  if (deviceId) {
    attempts.push({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  }
  attempts.push({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });

  let lastError = '';
  for (const constraints of attempts) {
    if (!constraints) continue;
    try {
      const media = await navigator.mediaDevices.getUserMedia(constraints);
      stream = media;
      videoEl.srcObject = media;
      await videoEl.play();
      await waitForFirstFrame(videoEl);
      const track = media.getVideoTracks()[0];
      activeDeviceId = track?.getSettings().deviceId ?? deviceId ?? null;
      const label = track?.label ?? '';
      return { ok: true, deviceId: activeDeviceId ?? undefined, label };
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error);
      // 释放本轮可能已经拿到的流（play() 失败时 getUserMedia 已成功）
      await close();
      // NotAllowedError 说明是权限问题，换约束重试也没用
      if (lastError.includes('NotAllowed') || lastError.includes('Permission')) break;
    }
  }

  const friendly = (() => {
    if (!lastError) return '没有可用的摄像头设备';
    if (lastError.includes('NotAllowed') || lastError.includes('Permission')) {
      return '摄像头权限被拒绝。请在系统设置里允许本应用使用摄像头，或关闭摄像头后重试。';
    }
    if (lastError.includes('NotFound') || lastError.includes('DevicesNotFound')) {
      return '没有检测到摄像头设备。插上摄像头后点「重新检测」。';
    }
    if (lastError.includes('NotReadable') || lastError.includes('TrackStart')) {
      return '摄像头被其他程序占用（如会议软件）。关掉占用它的程序后重试。';
    }
    return `摄像头打开失败：${lastError}`;
  })();
  return { ok: false, error: friendly };
}

/** 关闭摄像头，释放设备（否则录制结束后摄像头灯会一直亮）。 */
async function close(): Promise<void> {
  if (video) {
    try {
      video.pause();
      video.srcObject = null;
    } catch {
      // 忽略
    }
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // 忽略
      }
    }
    stream = null;
  }
  activeDeviceId = null;
}

/** 当前是否已打开摄像头且有可用帧。 */
function isReady(): boolean {
  return Boolean(stream && video && video.readyState >= 2 && video.videoWidth > 0);
}

/**
 * 把当前摄像头画面按目标尺寸居中裁切绘制到画布。
 *
 * 用 cover 裁切而不是拉伸：拉伸会让脸变形，而摄像头画中画里的脸变形非常明显。
 */
function drawFrame(width: number, height: number): boolean {
  const { video: videoEl, canvas: target, ctx: context } = ensureElements();
  if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return false;

  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const sourceW = videoEl.videoWidth;
  const sourceH = videoEl.videoHeight;
  const scale = Math.max(width / sourceW, height / sourceH);
  const drawW = sourceW * scale;
  const drawH = sourceH * scale;
  context.clearRect(0, 0, width, height);
  context.drawImage(videoEl, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
  return true;
}

/** 摄像头分段是否正在编码（协调器本来串行 await，这里再防一次重入）。 */
let encoding = false;

/**
 * 编码一个摄像头分段。
 *
 * 时间语义与 recorderRuntime 完全一致：第 i 帧的时间戳 = i × (1/fps)，
 * 段内从 0 开始，保证各段可独立解码、可顺序拼接。
 * 时间戳用整数微秒累加（不是每帧重算 i/fps 再取整），
 * 否则每段会多出约 5.3ms，30 段累计 160ms，超出「音画偏差 ≤80ms」。
 */
async function encodeSegment(request: CameraSegmentRequest): Promise<CameraSegmentResult> {
  if (encoding) {
    return { ok: false, error: '上一段摄像头编码尚未完成，跳过该段' };
  }
  encoding = true;
  let encoder: SegmentEncoder | null = null;
  try {
    if (!isReady()) {
      return { ok: false, error: '摄像头未就绪，跳过该段' };
    }
    const fps = request.fps > 0 ? request.fps : 30;
    const width = request.width > 0 ? request.width : 1280;
    const height = request.height > 0 ? request.height : 720;

    encoder = new SegmentEncoder({
      width,
      height,
      fps,
      // 摄像头画面细节比屏幕少，码率给低一些，避免文件无谓变大
      videoBitrate: Math.round(width * height * fps * 0.06),
      audioBitrate: 128_000,
      hardwarePreferred: true,
      // 摄像头不带音轨：麦克风由单独的 audio 工作进程采集，
      // 在摄像头轨再放一份会导致导出时声音翻倍
      includeAudio: false,
      audioSampleRate: 48_000,
      audioChannels: 2,
      startTimestampUs: 0,
    });
    await encoder.init();
    const drawContext = encoder.drawContext;

    const targetFrames = Math.max(1, Math.round((request.durationTicks / 10_000_000) * fps));
    const frameStepUs = Math.round(1_000_000 / fps);
    let written = 0;
    for (let i = 0; i < targetFrames; i++) {
      if (!drawFrame(width, height)) break;
      drawContext.drawImage(canvas as unknown as CanvasImageSource, 0, 0, width, height);
      await encoder.commitVideoFrame(i * frameStepUs);
      written++;
      // 摄像头是实时源，帧间留一点时间让 video 元素刷新到下一帧，
      // 否则一段里会编码出同一帧的多个副本（看起来像卡住）。
      // 注意：这使摄像头段的采集耗时≈段时长，必须由协调器与屏幕编码并行，
      // 不能串行 await（见 cameraCapture.ts / captureEngine.ts 的跨范围说明）。
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(1000 / fps) - 2)));
    }

    if (written === 0) {
      return { ok: false, error: '该段没有取到任何摄像头帧' };
    }

    const result = await encoder.finalize();
    const bytes = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))) as unknown as number[],
      );
    }
    return {
      ok: true,
      mp4: btoa(binary),
      frames: written,
      bytes: bytes.length,
      encoder: result.encoder,
    };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? (error.stack ?? error.message) : error) };
  } finally {
    encoding = false;
    // 每段都新建编码器（硬件 VideoEncoder + OffscreenCanvas 后备存储），
    // 成功与失败都必须释放；旧实现只在 finalize 成功后靠 GC，连续失败会线性涨内存。
    try {
      encoder?.dispose();
    } catch {
      // 忽略
    }
  }
}

/** 取一帧当前画面的 PNG（用于界面上的摄像头预览校验）。 */
async function snapshot(): Promise<{ ok: boolean; png?: string; error?: string }> {
  try {
    if (!isReady()) return { ok: false, error: '摄像头未就绪' };
    if (!drawFrame(1280, 720)) return { ok: false, error: '取帧失败' };
    const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(buffer.subarray(i, Math.min(i + 0x8000, buffer.length))) as unknown as number[],
      );
    }
    return { ok: true, png: btoa(binary) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

declare global {
  interface Window {
    __wcsCamera?: {
      listDevices: typeof listDevices;
      open: typeof open;
      close: typeof close;
      isReady: typeof isReady;
      encodeSegment: typeof encodeSegment;
      snapshot: typeof snapshot;
    };
  }
}

/**
 * 摄像头运行时只在自己所属的隐藏窗口里安装。
 *
 * 为什么必须判断角色：main.tsx 会静态 import 本模块（Vite 才能把它打进产物），
 * 而 recorder / exporter 窗口也执行同一份 bundle。
 * 如果无条件安装，recorder 窗口会同时持有摄像头运行时；
 * 实测 recorder 窗口在编码时反复崩溃（渲染进程 exitCode -1），
 * 因为它和 camera 窗口争用同一个 GPU/媒体上下文。
 * 用 location.hash 判定角色，非 camera 窗口直接跳过安装。
 */
function isCameraRole(): boolean {
  if (typeof window === 'undefined') return false;
  const declared = window.wcs?.role;
  if (declared) return declared === 'camera';
  return typeof location !== 'undefined' && /camera/.test(location.hash + location.search);
}

if (isCameraRole()) {
  window.__wcsCamera = { listDevices, open, close, isReady, encodeSegment, snapshot };
  console.log('[camera] 摄像头运行时就绪');
}
