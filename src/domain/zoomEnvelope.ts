import type { Effect, ZoomParameters } from './project';

const smooth = (value: number): number => {
  const k = Math.max(0, Math.min(1, value));
  return k * k * (3 - 2 * k);
};

/** Shared by zoom and 3D projection, so the two never disagree at an edit. */
export function zoomEnvelopeWeight(effect: Effect, effects: readonly Effect[], tick: number): number {
  const p = effect.parameters as ZoomParameters;
  const span = effect.range.end - effect.range.start;
  const offset = p.continuation?.offsetTicks ?? 0;
  const duration = p.continuation?.durationTicks ?? span;
  const phase = offset + tick - effect.range.start;
  let weight = Math.min(smooth(p.easeInTicks > 0 ? phase / p.easeInTicks : 1),
    smooth(p.easeOutTicks > 0 ? (duration - phase) / p.easeOutTicks : 1));
  if (!p.continuation) return weight;
  const connected = (before: boolean) => effects.some(other => {
    if (other === effect || other.kind !== 'zoom') return false;
    const q = (other.parameters as ZoomParameters).continuation;
    if (!q || q.id !== p.continuation!.id) return false;
    return before
      ? other.range.end === effect.range.start && Math.abs(q.offsetTicks + other.range.end - other.range.start - offset) <= 1
      : other.range.start === effect.range.end && Math.abs(offset + span - q.offsetTicks) <= 1;
  });
  // Contiguous halves keep their original phase. Separating them reveals an
  // edit boundary: ease to/from the neutral view instead of snapping there.
  if (offset > 0 && !connected(true) && p.easeInTicks > 0) {
    weight = Math.min(weight, smooth((tick - effect.range.start) / Math.min(p.easeInTicks, span / 2)));
  }
  if (offset + span < duration && !connected(false) && p.easeOutTicks > 0) {
    weight = Math.min(weight, smooth((effect.range.end - tick) / Math.min(p.easeOutTicks, span / 2)));
  }
  return weight;
}
