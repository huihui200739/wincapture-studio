export interface CameraMediaClock { state: 'recording' | 'paused' | 'stopped'; mediaTick: number; wallTimeMs: number }
/** Bounded ownership of live camera frames; a committed range is detached before encoding. */
export class CameraFrameBuffer<T extends { close(): void }> {
  private entries: { tick: number; frame: T }[] = [];
  constructor(private readonly capacity = 120, private readonly cloneFrame?: (frame: T) => T) {}
  push(tick: number, frame: T): void {
    if (!Number.isFinite(tick) || tick < 0) { frame.close(); return; }
    this.entries.push({ tick, frame });
    while (this.entries.length > this.capacity) this.entries.shift()!.frame.close();
  }
  trimFrom(tick: number): void {
    this.entries = this.entries.filter(item => { if (item.tick < tick) return true; item.frame.close(); return false; });
  }
  take(start: number, end: number): { tick: number; frame: T }[] {
    const taken = this.entries.filter(item => item.tick < end);
    this.entries = this.entries.filter(item => item.tick >= end);
    // Adjacent screen/camera boundaries need not coincide. Retain an owned copy
    // of the final preceding sample so encoding cannot remove the next range's
    // boundary frame. The detached originals still belong to the encoder.
    const boundary = taken.at(-1);
    if (boundary && this.cloneFrame) this.entries.unshift({ tick: boundary.tick, frame: this.cloneFrame(boundary.frame) });
    // Keep one preceding frame when the camera and screen frame boundaries differ.
    const first = taken.findIndex(item => item.tick >= start);
    const keepFrom = Math.max(0, first < 0 ? taken.length - 1 : first - 1);
    for (const item of taken.slice(0, keepFrom)) item.frame.close();
    return taken.slice(keepFrom);
  }
  clear(): void { for (const item of this.entries) item.frame.close(); this.entries = []; }
  get size(): number { return this.entries.length; }
}
