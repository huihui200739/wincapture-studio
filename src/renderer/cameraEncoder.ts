import { SegmentEncoder } from '../media/encode';
import type { CameraSegmentRequest, CameraSegmentResult } from './cameraRuntime';

export async function encodeCameraFrames(request: CameraSegmentRequest, captured: { tick: number; frame: VideoFrame }[]): Promise<CameraSegmentResult> {
  const encodeStarted = performance.now();
  const fps = request.fps > 0 ? request.fps : 30;
  const width = request.width > 0 ? request.width : 1280;
  const height = request.height > 0 ? request.height : 720;
  const start = request.startTick ?? 0;
  let encoder: SegmentEncoder | null = null;
  try {
    encoder = new SegmentEncoder({
      width,
      height,
      fps,
      // 摄像头画面细节比屏幕少，码率给低一些，避免文件无谓变大
      videoBitrate: Math.round(width * height * fps * 0.06),
      audioBitrate: 128_000,
      // Screen capture already uses the GPU encoder. Keep the small camera
      // track on this worker's software encoder to avoid periodic GPU contention.
      hardwarePreferred: false,
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
    let cursor = 0;
    const usedFrames = new Set<number>();
    let lastCursor = -1, repeated = 0, longestHold = 0;
    for (let i = 0; i < targetFrames; i++) {
      const tick = start + Math.round(i * 10_000_000 / fps);
      while (cursor + 1 < captured.length && captured[cursor + 1].tick <= tick) cursor++;
      const frame = captured[cursor].frame;
      usedFrames.add(cursor);
      repeated = lastCursor === cursor ? repeated + 1 : 1;
      lastCursor = cursor;
      longestHold = Math.max(longestHold, repeated);
      const scale = Math.max(width / frame.displayWidth, height / frame.displayHeight);
      const w = frame.displayWidth * scale, h = frame.displayHeight * scale;
      drawContext.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
      await encoder.commitVideoFrame(i * frameStepUs);
      written++;
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
      diagnostics: { sampledFrames: captured.length, uniqueFrames: usedFrames.size,
        longestHoldMs: Math.round(longestHold * 1000 / fps), encodeMs: Math.round(performance.now() - encodeStarted), samplingMode: 'worker' },
    };
  } catch (error) { return { ok: false, error: String(error instanceof Error ? error.stack : error) }; }
  finally {
    for (const item of captured) item.frame.close();
    try { encoder?.dispose(); } catch { /* Preserve the encoding result on cleanup failure. */ }
  }
}
