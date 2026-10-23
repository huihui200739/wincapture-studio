import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../../src/domain/project';
import { evaluateScene } from '../../src/domain/scene';
const mocks = vi.hoisted(() => ({ frame: vi.fn(), readLog: vi.fn() }));
vi.mock('../../src/renderer/lib/wcs', () => ({
  detectApiMode: () => 'native',
  wcs: () => ({ readPointerLog: mocks.readLog,
    listMediaSegments: async () => ({ ok: true, data: [{ path: 'media/seg.mp4', startTick: 0, durationTicks: 100 }] }) }),
}));
vi.mock('../../src/media/decoder', () => ({
  configureMediabunny: vi.fn(), loadMediabunny: () => ({}),
  VideoFrameSource: class { open = async () => {}; close = () => {}; getFrameAt = mocks.frame; },
}));
import { PreviewMediaCache } from '../../src/renderer/lib/previewSource';
const p = createEmptyProject('p', 'preview');
p.assets.push({ id: 'a', kind: 'screen', path: 'media/seg.mp4', durationTicks: 100,
  hash: '', width: 16, height: 9, channels: 0, sampleRate: 0, createdAt: 0 });
p.tracks[0].clips.push({ id: 'c', assetId: 'a', sourceInTicks: 0, sourceDurationTicks: 100,
  timelineInTicks: 0, rate: { num: 1, den: 1 }, linkGroupId: '' });
const scene = (tick: number) => evaluateScene(p, tick, { outputWidth: 16, outputHeight: 9 });
afterEach(() => vi.resetAllMocks());
function cache() {
  mocks.frame.mockImplementation(async () => ({ width: 16, height: 9 }));
  mocks.readLog.mockResolvedValue({ ok: true, data: { events: [{ tick: 0, x: 0.25, y: 0.5, kind: 'move' }] } });
  return new PreviewMediaCache('C:\\test.wcaproj');
}
describe('shared preview decoding', () => {
  it('does not cancel requests from other tutorial thumbnails', async () => {
    const media = cache();
    const results = await Promise.all([1, 2, 3].map((tick) => media.resolve(p, scene(tick), tick, {})));
    expect(results.every((r) => r?.status === 'ready' && r.screen !== null)).toBe(true);
    expect(results[0]?.pointer?.x).toBe(0.25);
    expect(mocks.readLog).toHaveBeenCalledTimes(1);
    media.dispose();
  });
  it('cancels stale requests belonging to the same consumer', async () => {
    const media = cache();
    const consumer = {};
    const a = media.resolve(p, scene(1), 1, consumer);
    const b = media.resolve(p, scene(2), 2, consumer);
    expect(await a).toBeNull();
    expect((await b)?.status).toBe('ready');
    media.dispose();
  });
  it('does not reuse an old source frame for a gap or a failed seek', async () => {
    const media = cache();
    expect((await media.resolve(p, scene(1), 1))?.screen).not.toBeNull();
    expect((await media.resolve(p, scene(101), 101))?.screen).toBeNull();
    mocks.frame.mockResolvedValue(null);
    expect((await media.resolve(p, scene(2), 2))?.screen).toBeNull();
    media.dispose();
  });
});
