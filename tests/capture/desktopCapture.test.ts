import { it, expect } from 'vitest';
import { DesktopVideoSource } from '../../electron/capture/desktopCapture';
it('maps modern frame timestamps to native QPC and reports source loss once', () => {
  const source = new DesktopVideoSource({ createWindow: () => { throw Error('unused'); }, ready: async () => {}, clockExe: '' },
    { x: -1920, y: 0, width: 1920, height: 1080 }, { width: 1280, height: 720, fps: 30, sourceWidth: 1920, sourceHeight: 1080 });
  Object.assign(source, { qpc: 100_000_000, epochMs: 1000 });
  const frames: bigint[] = []; let exits = 0;
  source.onFrame(frame => frames.push(frame.qpc)); source.onExit(() => exits++);
  source.accept({ jpeg: new Uint8Array([255, 216, 255, 217]), wallTimeMs: 1033 });
  source.accept({ jpeg: new Uint8Array([255]), wallTimeMs: 1040 });
  source.accept({ ended: true }); source.accept({ error: 'closed' });
  expect(frames).toEqual([100_330_000n]); expect(exits).toBe(1);
});
