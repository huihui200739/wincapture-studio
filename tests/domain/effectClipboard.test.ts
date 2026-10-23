import { describe, expect, it } from 'vitest';
import { pasteEffect } from '../../src/domain/effectClipboard';
import { createEmptyProject, type Effect, type PrivacyParameters } from '../../src/domain/project';
const p = createEmptyProject('p', 'clipboard');
p.tracks[0].clips.push({ id: 'c', assetId: 'a', sourceInTicks: 0, sourceDurationTicks: 100,
  timelineInTicks: 0, rate: { num: 1, den: 1 }, linkGroupId: '' });
const effect: Effect = { id: 'e', kind: 'privacy', range: { start: 10, end: 40 }, stepId: 's',
  parameters: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, anchor: 'screen', style: 'solid', confirmed: true }, origin: 'automatic', locked: false };
describe('effect clipboard', () => {
  it('clamps to the output end, deep copies and resets privacy confirmation', () => {
    const result = pasteEffect(effect, p, 90, 'new');
    expect(result.range).toEqual({ start: 90, end: 100 });
    expect(result.stepId).toBeUndefined();
    expect((result.parameters as PrivacyParameters).confirmed).toBe(false);
    expect((effect.parameters as PrivacyParameters).confirmed).toBe(true);
    expect(result.parameters).not.toBe(effect.parameters);
  });
  it('attribute paste retains target identity and timing', () => {
    const target = { ...effect, id: 'target', range: { start: 50, end: 80 } };
    const result = pasteEffect(effect, p, 0, 'unused', target);
    expect(result.id).toBe('target');
    expect(result.range).toEqual(target.range);
  });
  it('rejects wrong effect types and empty projects', () => {
    expect(() => pasteEffect(effect, p, 0, 'n', { ...effect, kind: 'zoom' })).toThrow(/相同类型/);
    expect(() => pasteEffect(effect, createEmptyProject('empty', 'empty'), 0, 'n')).toThrow();
  });
});
