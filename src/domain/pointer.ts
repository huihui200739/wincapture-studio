import type { CursorParameters, Project } from './project';
import type { SceneOptions } from './scene';
import type { PointerEventLike } from './types';
import { TimeMap } from './timeMap';
import { TICKS_PER_SECOND } from './timebase';

export type PointerLookup = (sourceTick: number) => SceneOptions['pointer'];

/** Indexed once per log; seeks and high-frequency input never truncate click history. */
export function createPointerLookup(input: readonly PointerEventLike[]): PointerLookup {
  const events = input.filter((e) => e && Number.isFinite(e.tick) && e.tick >= 0 &&
    Number.isFinite(e.x) && Number.isFinite(e.y)).slice().sort((a, b) => a.tick - b.tick);
  const lastClick: number[] = [];
  const lastActivity: number[] = [];
  let click = -1;
  let activity = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === 'down') click = i;
    if (i === 0 || events[i].x !== events[i - 1].x || events[i].y !== events[i - 1].y ||
      events[i].kind === 'down' || events[i].kind === 'up') activity = i;
    lastClick.push(click);
    lastActivity.push(activity);
  }
  const rippleTicks = Math.round(0.45 * TICKS_PER_SECOND);
  return (tick) => {
    if (!Number.isFinite(tick)) return null;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    const index = lo - 1;
    if (index < 0) return null;
    const event = events[index];
    const down = events[lastClick[index]];
    const age = down ? tick - down.tick : Infinity;
    return {
      x: event.x, y: event.y,
      visible: event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1,
      idleTicks: Math.max(0, tick - events[lastActivity[index]].tick),
      clickProgress: age >= 0 && age < rippleTicks ? age / rippleTicks : 0,
      clickX: down?.x, clickY: down?.y,
    };
  };
}

/** Shared by preview, tutorial and export: edits map timeline back to source time. */
export function pointerForScene(
  project: Project, timelineTick: number, lookup: PointerLookup, map = new TimeMap(project),
): SceneOptions['pointer'] {
  const hit = map.toSource('primaryVideo', timelineTick);
  if (!hit) return null;
  const effect = project.effects.find((e) => e.kind === 'cursor' &&
    timelineTick >= e.range.start && timelineTick < e.range.end);
  const offset = (effect?.parameters as CursorParameters | undefined)?.timeOffsetTicks ?? 0;
  return lookup(Math.max(0, hit.sourceTick + (Number.isFinite(offset) ? offset : 0)));
}
