import { encodeCameraFrames } from './cameraEncoder';
import type { CameraSegmentRequest } from './cameraRuntime';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; request: CameraSegmentRequest; frames: { tick: number; frame: VideoFrame }[] }>) => void) | null;
  postMessage: (data: unknown) => void;
};
scope.onmessage = async event => {
  const { id, request, frames } = event.data;
  const result = await encodeCameraFrames(request, frames);
  scope.postMessage({ id, result });
};
