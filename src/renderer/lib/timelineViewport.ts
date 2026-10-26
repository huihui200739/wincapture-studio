export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 5;

export function clampTimelineZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_TIMELINE_ZOOM;
  return Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, Math.round(value * 10) / 10));
}

export interface TimelineZoomAnchor {
  tick: number;
  viewportX: number;
}

/** Keep the visible playhead in place; otherwise preserve the viewport's centre. */
export function timelineZoomAnchor(scrollLeft: number, viewportWidth: number, pixelsPerTick: number, playhead: number): TimelineZoomAnchor {
  const playheadX = playhead * pixelsPerTick - scrollLeft;
  const viewportX = playheadX >= 0 && playheadX <= viewportWidth ? playheadX : viewportWidth / 2;
  return { tick: (scrollLeft + viewportX) / pixelsPerTick, viewportX };
}

export function anchoredTimelineScroll(anchor: TimelineZoomAnchor, pixelsPerTick: number, contentWidth: number, viewportWidth: number): number {
  return Math.max(0, Math.min(Math.max(0, contentWidth - viewportWidth), anchor.tick * pixelsPerTick - anchor.viewportX));
}
