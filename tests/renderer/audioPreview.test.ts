import { describe, it, expect } from 'vitest';
import { AudioPreviewScheduler } from '../../src/renderer/lib/audioPreview';

function harness() {
  let tick = 0;
  const nodes: { stopped: boolean; disconnected: boolean; startAt: number; start(t: number): void; stop(): void; disconnect(): void; connect(): void }[] = [];
  const context = { currentTime: 1, state: 'running', destination: {}, createBufferSource() {
    const node = { stopped: false, disconnected: false, startAt: 0, connect() {}, disconnect() { this.disconnected = true; }, stop() { this.stopped = true; }, start(t: number) { this.startAt = t; } };
    nodes.push(node); return node;
  } };
  const starts: number[] = [];
  const mixer = { async renderChunk(start: number) { starts.push(start); return {} as AudioBuffer; } };
  const errors: unknown[] = [];
  const scheduler = new AudioPreviewScheduler(context as unknown as AudioContext, mixer, 480_000, () => tick, e => errors.push(e));
  return { context, nodes, mixer, scheduler, errors, starts, tick: (value: number) => { tick = value; } };
}
describe('real-time audio scheduling', () => {
  it('schedules ahead on the context clock and cancels every node on pause', async () => {
    const h = harness(); await h.scheduler.pump();
    expect(h.nodes.length).toBe(3); expect(h.nodes[0].startAt).toBeCloseTo(1.04);
    h.scheduler.stop(); expect(h.nodes.every(n => n.stopped && n.disconnected)).toBe(true);
  });
  it('seek stops queued audio and starts at the new source sample', async () => {
    const h = harness(); await h.scheduler.pump(); const oldNodes = h.nodes.slice();
    h.tick(50_000_000); h.context.currentTime += 0.04; await h.scheduler.pump();
    expect(oldNodes.every(n => n.stopped)).toBe(true);
    expect(h.starts[3]).toBe(241_920);
  });
  it('does not revive pending audio after stop or overlap decoder calls', async () => {
    const h = harness(); let finish!: (value: AudioBuffer) => void;
    h.mixer.renderChunk = () => new Promise(resolve => { finish = resolve; });
    const pending = h.scheduler.pump(); await h.scheduler.pump(); h.scheduler.stop(); finish({} as AudioBuffer);
    await pending; expect(h.nodes).toHaveLength(0);
  });
  it('reports decoding failure and disconnects prior audio', async () => {
    const h = harness(); await h.scheduler.pump();
    h.tick(4_000_000); h.context.currentTime += 0.4;
    h.mixer.renderChunk = async () => { throw new Error('decode failed'); };
    await h.scheduler.pump(); expect(h.errors).toHaveLength(1); expect(h.nodes.every(n => n.stopped)).toBe(true);
  });
});
