import type { Effect, PrivacyParameters, Project } from './project';
import { timelineDuration } from './project';

/** Produce a new independent payload; copied privacy must be checked against its new content. */
export function pasteEffect(source: Effect, project: Project, tick: number, id: string, target?: Effect): Effect {
  if (target && target.kind !== source.kind) throw new Error('只能向相同类型的效果粘贴属性');
  const duration = timelineDuration(project);
  if (duration <= 0) throw new Error('工程里没有可粘贴效果的视频片段');
  const start = Math.min(duration - 1, Math.max(0, Math.round(tick)));
  const result: Effect = target ? structuredClone(target) : {
    ...structuredClone(source), id, range: { start, end: Math.min(duration, start + Math.max(1, source.range.end - source.range.start)) },
  };
  result.parameters = structuredClone(source.parameters);
  if (result.kind === 'zoom') {
    const p = result.parameters as import('./project').ZoomParameters;
    p.focusPath = p.focusPath?.map(point => ({ ...point, tick: Math.max(0, point.tick + result.range.start - source.range.start) }));
  }
  if (result.kind === 'privacy') {
    result.parameters = { ...(result.parameters as PrivacyParameters), confirmed: false };
    result.anchor = (result.parameters as PrivacyParameters).anchor;
  }
  if (!target) delete result.stepId;
  result.origin = 'manual';
  result.locked = true;
  return result;
}
