import type React from 'react';

/**
 * 无边框窗口拖拽。
 *
 * 为什么不用 -webkit-app-region: drag：主窗口/悬浮条都是 frameless + transparent +
 * resizable:false 的组合，实机验证 app-region 拖不动（Chromium 对透明窗口的拖拽
 * 区域命中不可靠，同类问题见 Cap 的手动 hit-test 设计）。这里改为渲染层 pointer
 * capture 采样位移、主进程按增量移动窗口，不依赖任何 app-region。
 *
 * 用法：<span onPointerDown={handleWindowDrag}>⠿</span>
 * 注意：不要在把手上再叠加 app-region:drag——那样 pointerdown 根本到不了 JS。
 */
export function handleWindowDrag(event: React.PointerEvent<HTMLElement>): void {
  // 只响应主键；触摸/笔也可以拖，但避免与右键菜单冲突
  if (event.button !== 0) return;
  event.preventDefault();
  const target = event.currentTarget;
  try {
    // 捕获后指针移出窗口（甚至移出屏幕）也能持续收到 move/up
    target.setPointerCapture(event.pointerId);
  } catch {
    // 个别环境不支持 capture：退化为窗口内拖拽
  }
  let lastX = event.screenX;
  let lastY = event.screenY;
  let raf = 0;
  let pending: { x: number; y: number } | null = null;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const { x, y } = pending;
    pending = null;
    void window.wcs?.moveWindowBy(x, y);
  };
  const onMove = (move: PointerEvent) => {
    const dx = move.screenX - lastX;
    const dy = move.screenY - lastY;
    if (dx === 0 && dy === 0) return;
    lastX = move.screenX;
    lastY = move.screenY;
    // pointermove 频率可能高于刷新率：合并到每帧一次 IPC，避免长拖拽刷爆通道
    pending = { x: (pending?.x ?? 0) + dx, y: (pending?.y ?? 0) + dy };
    if (!raf) raf = window.requestAnimationFrame(flush);
  };
  const onUp = () => {
    if (raf) window.cancelAnimationFrame(raf);
    // 松手时最后一帧的位移还没到 rAF：立刻补发，否则拖拽末端丢几个像素
    if (pending) {
      const { x, y } = pending;
      pending = null;
      void window.wcs?.moveWindowBy(x, y);
    }
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onUp);
    target.removeEventListener('lostpointercapture', onUp);
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onUp);
  target.addEventListener('lostpointercapture', onUp);
}
