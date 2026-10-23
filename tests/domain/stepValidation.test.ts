import { it, expect } from 'vitest';
import { validateProject } from '../../src/domain/validate';
import { createEmptyProject } from '../../src/domain/project';

it('steps are validated against retained source time after trimming and retiming', () => {
  const S = 10_000_000;
  const p = createEmptyProject('p', 'trimmed');
  p.assets.push({ id: 'a', kind: 'screen', path: 'media/a.mp4', durationTicks: 10 * S,
    hash: '', width: 1920, height: 1080, sampleRate: 0, channels: 0, createdAt: 0 });
  p.tracks[0].clips.push({ id: 'c', assetId: 'a', sourceInTicks: 6 * S, sourceDurationTicks: 4 * S,
    timelineInTicks: 0, rate: { num: 2, den: 1 }, linkGroupId: '' });
  p.steps.push({ id: 's', sourceRange: { start: 7 * S, end: 9 * S }, imageTick: 8 * S,
    title: 'retained', description: '', actionRect: null, source: 'manual', privacyVersion: 0 });
  expect(validateProject(p).warnings.filter((w) => w.entity === 'step')).toEqual([]);
  p.steps[0].imageTick = 3 * S;
  expect(validateProject(p).warnings.some((w) => w.code === 'step-image-out-of-range')).toBe(true);
});
