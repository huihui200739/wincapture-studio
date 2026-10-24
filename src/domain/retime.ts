import type { Clip, Project } from './project';
import { linkedClips, clipEnd } from './clipEditing';
import { timelineDuration } from './project';

/** Mutates only the command's private snapshot. Source media and source-time steps remain untouched. */
export function retimeClip(project: Project, target: Clip, rate: Clip['rate']): string[] {
  const value = rate.num / rate.den;
  if (!Number.isInteger(rate.num) || !Number.isInteger(rate.den) || rate.num <= 0 || rate.den <= 0 || value < 0.25 || value > 4) {
    throw new Error('播放速度必须在 0.25× 到 4× 之间');
  }
  const group = new Set(linkedClips(project, target));
  const start = target.timelineInTicks;
  const end = clipEnd(target);
  const oldSpan = end - start;
  if (oldSpan <= 0) throw new Error('片段时长无效');
  for (const member of group) {
    if (member.timelineInTicks !== start || clipEnd(member) > end + 1) {
      throw new Error('关联组包含多个时间区间，请先在片段边界分割所有轨道，再调整速度');
    }
  }
  for (const track of project.tracks) {
    if (track.clips.some((c) => !group.has(c) && c.timelineInTicks < end && clipEnd(c) > start)) {
      throw new Error('其它轨道跨过了变速区间，请先在两端分割，使音画能够同步变速');
    }
  }
  const newSpan = Math.max(1, Math.round(target.sourceDurationTicks / value));
  const delta = newSpan - oldSpan;
  const multiplier = value / (target.rate.num / target.rate.den);
  const changed: string[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (group.has(clip)) {
        // Store integer rationals; preserve any existing relative speed between tracks.
        clip.rate = clip === target ? { ...rate } : { num: Math.round(clip.rate.num / clip.rate.den * multiplier * 1_000_000), den: 1_000_000 };
        changed.push(clip.id);
      } else if (clip.timelineInTicks >= end) {
        clip.timelineInTicks += delta;
        changed.push(clip.id);
      }
    }
    track.clips.sort((a, b) => a.timelineInTicks - b.timelineInTicks);
  }
  const map = (tick: number): number => tick <= start ? tick : tick >= end ? tick + delta
    : start + Math.round((tick - start) * newSpan / oldSpan);
  const duration = timelineDuration(project);
  for (const effect of project.effects) {
    const old = effect.range;
    const a = Math.max(0, Math.min(Math.max(0, duration - 1), map(old.start)));
    // Privacy coverage follows both media boundaries. Animation durations stay on the output clock.
    const b = effect.kind === 'privacy' ? map(old.end) : a + old.end - old.start;
    effect.range = { start: a, end: Math.min(duration, Math.max(a + 1, b)) };
    if (effect.kind === 'zoom') {
      const p = effect.parameters as import('./project').ZoomParameters;
      p.focusPath = p.focusPath?.map(point => ({ ...point, tick: map(point.tick) }));
    }
  }
  if (project.effects.some((e) => e.kind === 'privacy')) project.privacyVersion += 1;
  return changed;
}
