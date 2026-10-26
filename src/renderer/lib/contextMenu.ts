/** Place a floating menu inside the window, including bottom/right edge clicks. */
export function contextMenuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}
