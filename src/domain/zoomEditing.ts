import type { Effect, Project, ZoomParameters } from './project';
import type { TickRange } from './timebase';

function sampleFocus(points: NonNullable<ZoomParameters['focusPath']>, tick: number) {
  let i = 0;
  while (i + 1 < points.length && points[i + 1].tick <= tick) i++;
  const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
  const k = b.tick > a.tick ? Math.max(0, Math.min(1, (tick - a.tick) / (b.tick - a.tick))) : 0;
  return { tick, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Crop with interpolated boundary samples, preserving the original focus path. */
function cropFocus(p: ZoomParameters, range: TickRange): ZoomParameters['focusPath'] {
  if (!p.focusPath?.length) return p.focusPath;
  return [sampleFocus(p.focusPath, range.start), ...p.focusPath.filter(point => point.tick > range.start && point.tick < range.end), sampleFocus(p.focusPath, range.end)];
}

/** Partition on main-video boundaries, without restarting the animation. */
export function splitZoomsAt(project: Project, boundaries: readonly number[]): string[] {
  const taken = new Set(project.effects.map(e => e.id));
  const changed: string[] = [];
  project.effects = project.effects.flatMap(effect => {
    if (effect.kind !== 'zoom') return [effect];
    const cuts = [...new Set(boundaries.filter(tick => tick > effect.range.start && tick < effect.range.end))].sort((a, b) => a - b);
    if (!cuts.length) return [effect];
    const p = effect.parameters as ZoomParameters;
    const edges = [effect.range.start, ...cuts, effect.range.end];
    return edges.slice(0, -1).map((start, index) => {
      const range = { start, end: edges[index + 1] };
      let id = effect.id;
      if (index > 0) {
        const base = `${effect.id}-split-${start}`;
        id = base;
        for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
        taken.add(id);
      }
      changed.push(id);
      return { ...effect, id, range, parameters: { ...p, focusPath: cropFocus(p, range),
        continuation: { id: p.continuation?.id ?? effect.id,
          offsetTicks: (p.continuation?.offsetTicks ?? 0) + start - effect.range.start,
          durationTicks: p.continuation?.durationTicks ?? effect.range.end - effect.range.start } } };
    });
  });
  return changed;
}

/** Infer ownership from pre-move video intervals, including legacy projects. */
export function moveClipZooms(project: Project, ranges: readonly TickRange[], delta: number): string[] {
  if (!ranges.length || delta === 0) return [];
  const changed = splitZoomsAt(project, ranges.flatMap(range => [range.start, range.end]));
  for (const effect of project.effects) {
    if (effect.kind !== 'zoom' || !ranges.some(range => effect.range.start >= range.start && effect.range.end <= range.end)) continue;
    const p = effect.parameters as ZoomParameters;
    effect.parameters = { ...p, focusPath: cropFocus(p, effect.range)?.map(point => ({ ...point, tick: point.tick + delta })) };
    effect.range = { start: effect.range.start + delta, end: effect.range.end + delta };
    changed.push(effect.id);
  }
  project.effects.sort((a, b) => a.range.start - b.range.start || a.id.localeCompare(b.id));
  return [...new Set(changed)];
}
