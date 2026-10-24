export {};
let desktopStream: MediaStream | null = null;
let stopped = true;
let callbackId = 0;
const video = typeof document !== 'undefined' ? document.createElement('video') : null;
async function stop(): Promise<void> {
  stopped = true;
  if (video && callbackId) video.cancelVideoFrameCallback(callbackId);
  desktopStream?.getTracks().forEach(track => track.stop()); desktopStream = null;
  if (video) video.srcObject = null;
}
async function start(options: { width: number; height: number; fps: number; region?: { x: number; y: number; width: number; height: number }; sourceWidth: number; sourceHeight: number }): Promise<void> {
  await stop();
  if (!video) throw new Error('视频元素不可用');
  desktopStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: options.fps, max: options.fps } }, audio: false });
  const track = desktopStream.getVideoTracks()[0];
  // Chromium 的部分后端会把系统光标烧入视频。尽力关闭，并报告实际结果以防双光标。
  try { await track.applyConstraints({ cursor: 'never' } as MediaTrackConstraints); } catch { /* 使用实际设置降级。 */ }
  const cursorEmbedded = (track.getSettings() as MediaTrackSettings & { cursor?: string }).cursor !== 'never';
  video.srcObject = desktopStream; video.muted = true; await video.play(); stopped = false;
  const canvas = new OffscreenCanvas(options.width, options.height), context = canvas.getContext('2d')!;
  let busy = false, last = -Infinity;
  desktopStream.getVideoTracks()[0].onended = () => window.wcs.desktop?.frame({ ended: true });
  const sample = async (now: number) => {
    if (stopped || !video) return;
    callbackId = video.requestVideoFrameCallback(sample);
    if (busy || now - last < 950 / options.fps) return;
    busy = true; last = now;
    const wallTimeMs = performance.timeOrigin + now;
    try {
      const r = options.region;
      context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
      if (r) {
        context.drawImage(video, r.x / options.sourceWidth * video.videoWidth, r.y / options.sourceHeight * video.videoHeight,
          r.width / options.sourceWidth * video.videoWidth, r.height / options.sourceHeight * video.videoHeight, 0, 0, canvas.width, canvas.height);
      } else {
        const fit = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const w = video.videoWidth * fit, h = video.videoHeight * fit;
        context.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
      if (!stopped) window.wcs.desktop?.frame({ jpeg: new Uint8Array(await blob.arrayBuffer()), wallTimeMs, cursorEmbedded });
    } catch (error) { window.wcs.desktop?.frame({ error: String(error) }); }
    finally { busy = false; }
  };
  callbackId = video.requestVideoFrameCallback(sample);
}
declare global { interface Window { __wcsDesktop?: { start: typeof start; stop: typeof stop } } }
if (typeof location !== 'undefined' && location.hash.includes('camera-desktop')) window.__wcsDesktop = { start, stop };
