import { describe, it, expect } from 'vitest';
import { CameraFrameBuffer } from '../../src/media/cameraBuffer';
const frame = () => ({ closed: false, close() { this.closed = true; } });
describe('camera frame ownership and capture-time ranges', () => {
  it('bounds live frame memory and disposes evicted frames', () => {
    const buffer = new CameraFrameBuffer(2), a = frame(), b = frame(), c = frame();
    buffer.push(0, a); buffer.push(1, b); buffer.push(2, c);
    expect(a.closed).toBe(true); expect(buffer.size).toBe(2); buffer.clear(); expect(b.closed && c.closed).toBe(true);
  });
  it('detaches past frames without including future/pause frames', () => {
    const buffer = new CameraFrameBuffer(), frames = [frame(), frame(), frame(), frame()];
    frames.forEach((f, i) => buffer.push(i * 10, f));
    const taken = buffer.take(10, 20); expect(taken.map(f => f.tick)).toEqual([0, 10]);
    buffer.trimFrom(25); expect(frames[3].closed).toBe(true); expect(buffer.take(20, 30).map(f => f.tick)).toEqual([20]);
    expect(frames[1].closed).toBe(false);
  });
});
