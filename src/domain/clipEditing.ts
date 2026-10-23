import type { Clip, Project } from './project';

export const clipEnd = (clip: Clip): number => clip.timelineInTicks +
  Math.round(clip.sourceDurationTicks * clip.rate.den / clip.rate.num);

export function linkedClips(project: Project, target: Clip): Clip[] {
  if (!target.linkGroupId) return [target];
  const ownTrack = project.tracks.find((t) => t.clips.includes(target));
  return project.tracks.flatMap((t) => t.clips.filter((c) => c === target ||
    (t !== ownTrack && c.linkGroupId === target.linkGroupId && c.timelineInTicks < clipEnd(target) &&
      clipEnd(c) > target.timelineInTicks)));
}

export interface ClipMovePlan {
  clipId: string; originTick: number; desiredTick: number; tick: number; adjusted: boolean;
}

/** Every linked track constrains the same delta, so a free video slot cannot hide an audio collision. */
export function planGroupMove(project: Project, clipId: string, desiredTick: number): ClipMovePlan | null {
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!clip || !Number.isFinite(desiredTick)) return null;
  const group = new Set(linkedClips(project, clip));
  const minDelta = -Math.min(...[...group].map((c) => c.timelineInTicks));
  const desired = Math.max(0, Math.round(desiredTick));
  const delta = Math.max(minDelta, desired - clip.timelineInTicks);
  const forbidden: { start: number; end: number }[] = [];
  for (const track of project.tracks) {
    for (const moved of track.clips.filter((c) => group.has(c))) {
      if (clipEnd(moved) <= moved.timelineInTicks) continue;
      for (const other of track.clips.filter((c) => !group.has(c))) {
        if (clipEnd(other) <= other.timelineInTicks) continue;
        forbidden.push({ start: other.timelineInTicks - clipEnd(moved), end: clipEnd(other) - moved.timelineInTicks });
      }
    }
  }
  const valid = (d: number) => d >= minDelta && forbidden.every((f) => d <= f.start || d >= f.end);
  const candidates = [delta, 0, minDelta, ...forbidden.flatMap((f) => [f.start, f.end])].filter(valid);
  candidates.sort((a, b) => Math.abs(a - delta) - Math.abs(b - delta) || a - b);
  const applied = candidates[0] ?? Math.max(minDelta, ...forbidden.map((f) => f.end));
  const tick = clip.timelineInTicks + applied;
  return { clipId, originTick: clip.timelineInTicks, desiredTick: desired, tick, adjusted: tick !== desired };
}
