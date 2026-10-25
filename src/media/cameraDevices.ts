export interface CameraChoice { deviceId: string; label: string }

/** 自动模式优先内置/物理设备；明确选择的设备仍保持用户选择。 */
export function cameraCandidates(devices: readonly CameraChoice[], requested?: string): (string | undefined)[] {
  if (requested && devices.some(device => device.deviceId === requested)) return [requested];
  const priority = (label: string) => /integrated|built[ .-]?in|内置/i.test(label) ? 0
    : /virtual|smart connect|obs|phone|droid|虚拟/i.test(label) ? 2 : 1;
  const ordered = [...devices].filter(device => device.deviceId).sort((a, b) => priority(a.label) - priority(b.label));
  return ordered.length ? ordered.map(device => device.deviceId) : [undefined];
}

/** 超时后迟到的流也必须释放，避免重试和退出后仍占用摄像头。 */
export async function cameraStreamWithTimeout(request: Promise<MediaStream>, timeoutMs = 6000): Promise<MediaStream> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  request.then(stream => { if (expired) stream.getTracks().forEach(track => track.stop()); }, () => {});
  try {
    return await Promise.race([request, new Promise<MediaStream>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('摄像头响应超时')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
