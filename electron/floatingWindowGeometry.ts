import type { BrowserWindow, Rectangle } from 'electron';

// Keep the requested DIP size, never feed getBounds()'s rounded size back into
// Windows SetWindowPos. At 150% DPI, setPosition on a visible transparent window
// can add one DIP on every move (including resizable:false windows).
const sizes = new WeakMap<BrowserWindow, { width: number; height: number }>();

export function rememberFloatingSize(win: BrowserWindow, width: number, height: number): void {
  sizes.set(win, { width, height });
}

export function setFloatingBounds(win: BrowserWindow, bounds: Rectangle): void {
  rememberFloatingSize(win, bounds.width, bounds.height);
  win.setBounds(bounds);
}

export function moveFloatingWindow(win: BrowserWindow, dx: number, dy: number): void {
  const bounds = win.getBounds();
  const size = sizes.get(win);
  if (!size) return;
  win.setBounds({ x: bounds.x + Math.round(dx), y: bounds.y + Math.round(dy), ...size });
}

export function resizeFloatingWindow(win: BrowserWindow, width: number, height: number): void {
  setFloatingBounds(win, { ...win.getBounds(), width, height });
}
