import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../../src/domain/project';
import { createExportProfile, type ExportResolution } from '../../src/renderer/lib/exportSettings';
const project = () => createEmptyProject('p', 'export');
describe('export settings', () => {
  it.each([['720', 1280, 720], ['1080', 1920, 1080], ['1440', 2560, 1440], ['2160', 3840, 2160]] as const)(
    '%sp produces the advertised landscape dimensions', (resolution, width, height) => {
      const p = createExportProfile(project(), { variantId: 'landscape', resolution, fps: '30', quality: 'balanced', includeTutorial: false });
      expect([p.width, p.height]).toEqual([width, height]);
    });
  it('supports portrait and square 4K, fps independent of project, and adaptive bitrate', () => {
    const base = { resolution: '2160' as ExportResolution, fps: '60' as const, quality: 'high' as const, includeTutorial: true };
    const portrait = createExportProfile(project(), { ...base, variantId: 'portrait' });
    expect([portrait.width, portrait.height, portrait.fps.num]).toEqual([2160, 3840, 60]);
    const square = createExportProfile(project(), { ...base, variantId: 'square' });
    expect([square.width, square.height]).toEqual([3840, 3840]);
    expect(square.videoBitrate).toBeGreaterThanOrEqual(portrait.videoBitrate);
    expect(square.videoBitrate).toBeLessThanOrEqual(120_000_000);
  });
  it('source size uses referenced screen assets and keeps fractional project fps', () => {
    const p = project();
    p.settings.fps = { num: 30000, den: 1001 };
    p.assets.push({ id: 'a', kind: 'screen', width: 1600, height: 900, path: 'media/a.mp4', durationTicks: 100,
      hash: '', createdAt: 0, channels: 0, sampleRate: 0 });
    p.tracks[0].clips.push({ id: 'c', assetId: 'a', sourceInTicks: 0, sourceDurationTicks: 100, timelineInTicks: 0,
      rate: { num: 1, den: 1 }, linkGroupId: '' });
    const profile = createExportProfile(p, { variantId: 'missing', resolution: 'source', fps: 'project', quality: 'compact', includeTutorial: false });
    expect([profile.width, profile.height]).toEqual([1600, 900]);
    expect(profile.fps).toEqual(p.settings.fps);
    expect(p.settings.fps.num).toBe(30000);
  });
});
