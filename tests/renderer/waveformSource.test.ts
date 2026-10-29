import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WaveformSource } from '../../src/renderer/lib/waveformSource';
import { clearWaveformCache } from '../../src/renderer/lib/waveform';

const S = 10_000_000;
function wav(amplitude: number): Uint8Array {
  const frames = 1000;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, frames, true);
  view.setUint32(28, frames * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) view.setFloat32(44 + i * 4, (i % 2 ? -1 : 1) * amplitude, true);
  return bytes;
}

function fixture(root = 'C:/test.wcaproj') {
  const files = [wav(0.1), wav(0.8), wav(0)];
  const api = {
    listMediaSegments: vi.fn(async () => ({ ok: true as const, data: files.map((file, i) => ({
      path: `media/mic/seg-${i}.wav`, startTick: i * S, durationTicks: S, bytes: file.byteLength,
    })) })),
    readExportFile: vi.fn(async (path: string) => ({ ok: true as const, data: files[Number(path.match(/seg-(\d)/)![1])] })),
  };
  return { source: new WaveformSource(root, api), api };
}

beforeEach(clearWaveformCache);
describe('recorded waveform segments', () => {
  it('keeps quiet, loud and silent segments at their real positions across the entire recording', async () => {
    const { source, api } = fixture();
    const peaks = await source.load('mic', 'media/mic/seg-0.wav', 0, 3, 6);
    expect(peaks.map(p => Number(p.max.toFixed(1)))).toEqual([0.1, 0.1, 0.8, 0.8, 0, 0]);
    expect(api.readExportFile).toHaveBeenCalledTimes(3);
  });

  it('reads the source in-point after trim/speed changes and merges peaks across segment boundaries', async () => {
    const { source } = fixture();
    const trim = await source.load('mic', 'media/mic/seg-0.wav', 1, 3, 2);
    expect(trim[0].max).toBeCloseTo(0.8);
    expect(trim[1].max).toBe(0);
    const boundary = await source.load('mic', 'media/mic/seg-0.wav', 0.75, 1.25, 1);
    expect(boundary[0].min).toBeCloseTo(-0.8);
    expect(boundary[0].max).toBeCloseTo(0.8);
  });

  it('reuses segment data when zooming and deduplicates concurrent requests', async () => {
    const { source, api } = fixture();
    await Promise.all([source.load('mic', 'media/mic/seg-0.wav', 0, 3, 6), source.load('mic', 'media/mic/seg-0.wav', 0, 3, 20)]);
    await source.load('mic', 'media/mic/seg-0.wav', 1, 2, 12);
    expect(api.listMediaSegments).toHaveBeenCalledTimes(1);
    expect(api.readExportFile).toHaveBeenCalledTimes(3);
  });

  it('does not reuse another project’s identical asset IDs', async () => {
    const first = fixture('C:/one.wcaproj');
    const second = fixture('C:/two.wcaproj');
    await first.source.load('mic', 'media/mic/seg-0.wav', 0, 1, 4);
    await second.source.load('mic', 'media/mic/seg-0.wav', 0, 1, 4);
    expect(second.api.readExportFile).toHaveBeenCalledTimes(1);
  });

  it('fails clearly on a missing segment and can retry after it is restored', async () => {
    const { source, api } = fixture();
    api.readExportFile.mockRejectedValueOnce(new Error('missing'));
    await expect(source.load('mic', 'media/mic/seg-0.wav', 0, 1, 4)).rejects.toThrow('missing');
    const peaks = await source.load('mic', 'media/mic/seg-0.wav', 0, 1, 4);
    expect(peaks[0].max).toBeCloseTo(0.1);
  });
});
