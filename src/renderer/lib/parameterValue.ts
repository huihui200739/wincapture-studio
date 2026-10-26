export interface ParameterBounds {
  min: number;
  max: number;
  step: number;
}

/** Only completed, finite values may enter a project command. */
export function normalizeParameterValue(value: number, { min, max, step }: ParameterBounds): number | null {
  if (!Number.isFinite(value)) return null;
  const bounded = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((bounded - min) / step) * step;
  // Remove floating point noise from decimal steps before storing/displaying.
  return Math.min(max, Math.max(min, Number(snapped.toFixed(10))));
}

export function parseParameterDraft(draft: string, bounds: ParameterBounds): number | null {
  if (draft.trim() === '') return null;
  return normalizeParameterValue(Number(draft), bounds);
}
