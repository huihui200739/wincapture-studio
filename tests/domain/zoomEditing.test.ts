import { describe, expect, it } from 'vitest';
import { applyCommand, CommandHistory, makeCommand } from '../../src/domain/commands';
import { createEmptyProject, type Effect, type Project, type ZoomParameters } from '../../src/domain/project';
import { evaluateZoom } from '../../src/domain/zoom';
import { evaluateMotion } from '../../src/domain/projection';
import { validateProject } from '../../src/domain/validate';

const S = 10_000_000;
function fixture(): Project {
  const project = createEmptyProject('zoom-editing', 'Zoom editing');
  for (const track of project.tracks) {
    const id = `asset-${track.kind}`;
    project.assets.push({ id, kind: track.kind === 'primaryVideo' ? 'screen' : track.kind,
      path: `media/${id}.mp4`, hash: id, durationTicks: 20 * S, width: 1920, height: 1080,
      sampleRate: 48000, channels: 2, createdAt: 0 });
    track.clips = [{ id: `clip-${track.kind}`, assetId: id, sourceInTicks: 0, sourceDurationTicks: 10 * S,
      timelineInTicks: 0, linkGroupId: 'recording', rate: { num: 1, den: 1 } }];
  }
  project.effects = [shot('zoom', 2, 8)];
  return project;
}
function shot(id: string, start: number, end: number): Effect {
  return { id, kind: 'zoom', range: { start: start * S, end: end * S }, origin: 'automatic', locked: false,
    parameters: { scale: 2, focusX: 0.3, focusY: 0.4, easeInTicks: S, easeOutTicks: S, rotateX: 20,
      focusPath: [{ tick: start * S, x: 0.3, y: 0.4 }, { tick: end * S, x: 0.7, y: 0.6 }] } };
}
const edit = (project: Project, spec: Parameters<typeof makeCommand>[1]) => applyCommand(project, makeCommand(project, spec)).project;
const split = (project: Project, time = 4) => edit(project, { kind: 'SplitClip', timelineTick: time * S });
const moveRight = (project: Project, time = 11.44) => edit(project, { kind: 'MoveClip', clipId: 'clip-primaryVideo-b', timelineInTicks: time * S });
function sameCurve(a: Project, b: Project) {
  for (let tick = 0; tick < 10 * S; tick += 791_903) {
    const before = evaluateZoom(a.effects, tick), after = evaluateZoom(b.effects, tick);
    expect(after.scale).toBeCloseTo(before.scale, 9);
    expect(after.focusX).toBeCloseTo(before.focusX, 9);
    expect(after.focusY).toBeCloseTo(before.focusY, 9);
    expect(evaluateMotion(b.effects, tick)).toEqual(evaluateMotion(a.effects, tick));
  }
}

describe('zoom follows split video', () => {
  it.each([2.2, 4, 7.8])('splitting at %ss preserves zoom, focus and 3D curves before moving', time => {
    const original = fixture();
    const divided = split(original, time);
    expect(divided.effects).toHaveLength(2);
    sameCurve(original, divided);
    expect(evaluateZoom(divided.effects, time * S - 1).scale).toBeCloseTo(evaluateZoom(divided.effects, time * S).scale, 5);
  });

  it('moves only the right video zoom, together with linked audio and camera', () => {
    const original = fixture(); original.effects = [shot('left', 0.5, 3), shot('right', 5, 8)];
    const moved = moveRight(split(original));
    expect(moved.effects.find(e => e.id === 'left')?.range).toEqual({ start: 0.5 * S, end: 3 * S });
    expect(moved.effects.find(e => e.id === 'right')?.range).toEqual({ start: 12.44 * S, end: 15.44 * S });
    for (const track of moved.tracks) expect(track.clips[1].timelineInTicks).toBe(11.44 * S);
    const p = moved.effects.find(e => e.id === 'right')!.parameters as ZoomParameters;
    expect(p.focusPath?.[0].tick).toBe(12.44 * S);
    expect(p.focusPath?.at(-1)?.tick).toBe(15.44 * S);
    expect(original.effects[1].range.start).toBe(5 * S);
  });

  it('splits a straddling shot and fades its newly exposed edges without zoom in the gap', () => {
    const moved = moveRight(split(fixture()));
    expect(moved.effects.map(e => e.range)).toEqual([{ start: 2 * S, end: 4 * S }, { start: 11.44 * S, end: 15.44 * S }]);
    for (const tick of [4.1, 5, 7, 9, 11.43]) expect(evaluateZoom(moved.effects, tick * S).scale).toBe(1);
    expect(evaluateZoom(moved.effects, 4 * S - 1).scale).toBeCloseTo(1, 9);
    expect(evaluateZoom(moved.effects, 11.44 * S).scale).toBe(1);
    expect(evaluateZoom(moved.effects, 11.7 * S).scale).toBeGreaterThan(1);
    expect(evaluateZoom(moved.effects, 12.5 * S).scale).toBe(2);
    expect(evaluateZoom(moved.effects, 15.44 * S - 1).scale).toBeCloseTo(1, 9);
    // A 30fps scrub must not jump to a different focus or angle at the cut.
    for (const boundary of [4, 11.44, 15.44]) {
      const a = evaluateZoom(moved.effects, Math.round((boundary - 1 / 30) * S));
      const b = evaluateZoom(moved.effects, Math.round(boundary * S));
      expect(Math.abs(a.scale - b.scale)).toBeLessThan(0.01);
      expect(Math.abs(a.focusX - b.focusX)).toBeLessThan(0.01);
    }
  });

  it('rejoining halves restores the original continuous animation without a zoom-out pulse', () => {
    const original = fixture();
    const rejoined = moveRight(moveRight(split(original)), 4);
    sameCurve(original, rejoined);
    expect(evaluateZoom(rejoined.effects, 4 * S).scale).toBe(2);
  });

  it('handles old already-split projects that still contain unsplit zoom effects', () => {
    const legacy = split(fixture()); legacy.effects = fixture().effects;
    const moved = moveRight(legacy);
    expect(moved.effects.map(e => e.range)).toEqual([{ start: 2 * S, end: 4 * S }, { start: 11.44 * S, end: 15.44 * S }]);
    expect(new Set(moved.effects.map(e => e.id)).size).toBe(2);
  });

  it('moves a shot back to timeline zero without negative focus samples', () => {
    const shifted = edit(fixture(), { kind: 'MoveClip', clipId: 'clip-primaryVideo', timelineInTicks: 10 * S });
    const divided = edit(shifted, { kind: 'SplitClip', timelineTick: 14 * S });
    const moved = moveRight(divided, 0);
    const rightShot = moved.effects.find(e => e.range.start === 0)!;
    expect((rightShot.parameters as ZoomParameters).focusPath?.every(p => p.tick >= 0)).toBe(true);
    expect(evaluateZoom(moved.effects, 0).scale).toBe(1);
    expect(validateProject(moved).issues.filter(issue => issue.entity === 'effect' && issue.severity === 'error')).toEqual([]);
  });

  it('keeps manual locked shots attached and leaves unrelated camera moves alone', () => {
    const original = fixture(); original.effects[0].origin = 'manual'; original.effects[0].locked = true;
    const moved = moveRight(split(original));
    expect(moved.effects.every(effect => effect.locked && effect.origin === 'manual')).toBe(true);
    const camera = original.tracks.find(t => t.kind === 'camera')!.clips[0]; camera.linkGroupId = '';
    const cameraMoved = edit(original, { kind: 'MoveClip', clipId: camera.id, timelineInTicks: 12 * S });
    expect(cameraMoved.effects).toEqual(original.effects);
  });

  it('undo/redo and save/reopen preserve the whole edit and animation phase', () => {
    const original = split(fixture());
    const history = new CommandHistory();
    const moved = history.execute(original, makeCommand(original, { kind: 'MoveClip', clipId: 'clip-primaryVideo-b', timelineInTicks: 11.44 * S })).project;
    const undone = history.undo(moved)!;
    expect(undone.effects).toEqual(original.effects);
    const redone = history.redo(undone)!;
    expect(redone.effects).toEqual(moved.effects);
    const reopened = JSON.parse(JSON.stringify(redone)) as Project;
    expect(evaluateZoom(reopened.effects, 12.8 * S)).toEqual(evaluateZoom(moved.effects, 12.8 * S));
    expect(evaluateMotion(reopened.effects, 11.7 * S)).toEqual(evaluateMotion(moved.effects, 11.7 * S));
  });

  it('repeated splits/moves keep deterministic unique shot IDs and avoid duplicate shifts', () => {
    const original = fixture();
    const run = () => {
      let p = moveRight(split(original));
      p = edit(p, { kind: 'SplitClip', timelineTick: 13 * S });
      p = edit(p, { kind: 'MoveClip', clipId: 'clip-primaryVideo-b-b', timelineInTicks: 20 * S });
      return edit(p, { kind: 'MoveClip', clipId: 'clip-primaryVideo-b-b', timelineInTicks: 22 * S });
    };
    const a = run(), b = run();
    expect(a.effects).toEqual(b.effects);
    expect(a.effects).toHaveLength(3);
    expect(a.effects.at(-1)!.range).toEqual({ start: 22 * S, end: 24.44 * S });
  });
});
