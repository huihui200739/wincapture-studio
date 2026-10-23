import { describe, it, expect } from 'vitest';
import { snapPosition, timelineSnapTargets } from '../../src/domain/snapping';
import { createEmptyProject } from '../../src/domain/project';
describe('magnetic timeline boundaries', () => {
  it('snaps either moving edge within a pixel-derived threshold', () => {
    expect(snapPosition(198, [100, 300], 5, [0, 100])).toEqual({ value: 200, guide: 300 });
    expect(snapPosition(106, [100], 5)).toEqual({ value: 106, guide: null });
    expect(snapPosition(102, [100], 5)).toEqual({ value: 100, guide: 100 });
  });
  it('never attracts a linked group to its own edges', () => {
    const p = createEmptyProject('p', 'snap');
    const clip = { id: 'a', assetId: 'asset', timelineInTicks: 50, sourceInTicks: 0, sourceDurationTicks: 100, rate: { num: 1, den: 1 }, linkGroupId: 'g' };
    p.tracks[0].clips.push(clip, { ...clip, id: 'b', timelineInTicks: 500, linkGroupId: 'other' });
    p.tracks[1].clips.push({ ...clip, id: 'cam' });
    expect(timelineSnapTargets(p, 'a', 200)).toEqual([0, 200, 500, 600]);
  });
});
