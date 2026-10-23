import type { Project } from './project';
import { clipTimelineDuration } from './project';

export function timelineSnapTargets(project: Project, clipId: string, playhead: number): number[] {
  const clips = project.tracks.flatMap(t => t.clips), moving = clips.find(c => c.id === clipId);
  return [...new Set([0, playhead, ...clips.filter(c => c.id !== clipId && (!moving?.linkGroupId || c.linkGroupId !== moving.linkGroupId))
    .flatMap(c => [c.timelineInTicks, c.timelineInTicks + clipTimelineDuration(c)])])].sort((a, b) => a - b);
}
export function snapPosition(value: number, targets: readonly number[], threshold: number, offsets: readonly number[] = [0]): { value: number; guide: number | null } {
  let result = value, distance = Math.max(0, threshold), guide: number | null = null;
  for (const target of targets) for (const offset of offsets) {
    const candidate = target - offset, diff = Math.abs(candidate - value);
    if (candidate >= 0 && diff <= distance && (guide === null || diff < distance)) { result = candidate; distance = diff; guide = target; }
  }
  return { value: result, guide };
}
