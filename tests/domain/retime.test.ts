import { describe, expect, it } from 'vitest';
import { applyCommand, CommandHistory, makeCommand } from '../../src/domain/commands';
import { createEmptyProject, timelineDuration, type Clip } from '../../src/domain/project';
import { TimeMap } from '../../src/domain/timeMap';
const S = 10_000_000;
function project() {
  const p = createEmptyProject('p', 'retime');
  const clip = (id: string, time: number, group: string): Clip => ({ id, assetId: id, sourceInTicks: time,
    sourceDurationTicks: 5 * S, timelineInTicks: time, rate: { num: 1, den: 1 }, linkGroupId: group });
  for (const t of p.tracks) t.clips = [clip(t.id + '-a', 0, 'a'), clip(t.id + '-b', 5 * S, 'b')];
  p.effects = [{ id: 'privacy', kind: 'privacy', range: { start: 2 * S, end: 8 * S }, locked: true, origin: 'manual',
    parameters: { x: 0, y: 0, width: 1, height: 1, anchor: 'screen', confirmed: true, style: 'solid' } }];
  return p;
}
describe('linked clip playback rate', () => {
  it('retimes all linked tracks and ripples later clips, preserving source media', () => {
    const p = project();
    const result = applyCommand(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'main-a', rate: { num: 2, den: 1 } })).project;
    expect(timelineDuration(result)).toBe(7.5 * S);
    for (const t of result.tracks) {
      expect(t.clips[0].rate.num / t.clips[0].rate.den).toBe(2);
      expect(t.clips[1].timelineInTicks).toBe(2.5 * S);
      expect(t.clips[0].sourceDurationTicks).toBe(5 * S);
    }
    expect(new TimeMap(result).toSource('mic', S)?.sourceTick).toBe(2 * S);
    expect(result.effects[0].range).toEqual({ start: S, end: 5.5 * S });
    expect(result.privacyVersion).toBe(1);
    expect(p.tracks[0].clips[0].rate.num).toBe(1);
  });
  it('undo and redo preserve the entire transaction', () => {
    const p = project();
    const h = new CommandHistory();
    const changed = h.execute(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'main-a', rate: { num: 1, den: 2 } })).project;
    expect(timelineDuration(changed)).toBe(15 * S);
    const undone = h.undo(changed)!;
    expect(timelineDuration(undone)).toBe(10 * S);
    expect(timelineDuration(h.redo(undone)!)).toBe(15 * S);
  });
  it('repeated changes keep rational denominators bounded and all tracks synchronized', () => {
    let p = project();
    for (let i = 0; i < 12; i++) {
      const num = i % 2 ? 1 : 2;
      p = applyCommand(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'main-a', rate: { num, den: 1 } })).project;
    }
    for (const t of p.tracks) {
      expect(t.clips[0].rate.den).toBeLessThanOrEqual(1_000_000);
      expect(t.clips[0].rate.num / t.clips[0].rate.den).toBe(1);
    }
  });
  it('rejects invalid speeds and unrelated clips that cross the edit region', () => {
    const p = project();
    expect(() => applyCommand(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'main-a', rate: { num: 0, den: 1 } }))).toThrow();
    p.tracks[1].clips = [{ ...p.tracks[1].clips[0], linkGroupId: 'unrelated' }];
    expect(() => applyCommand(p, makeCommand(p, { kind: 'SetClipRate', clipId: 'main-a', rate: { num: 2, den: 1 } }))).toThrow(/分割/);
  });
});
