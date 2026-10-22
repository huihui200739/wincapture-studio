/**
 * 渲染进程入口
 *
 * 四种窗口角色，由 window.wcs.role 决定（preload 依据 URL hash 判定）：
 *   main     — 完整应用（首页/录制/编辑/导出/教程/设置）
 *   overlay  — 录制悬浮控制条
 *   recorder — 隐藏的录制编码窗口（WebCodecs 分段编码）
 *   exporter — 隐藏的导出编码窗口（解码→合成→编码→封装→校验）
 *
 * recorder / exporter 不渲染任何 React 界面，只安装运行时桥接后立即返回，
 * 因此不能把它们的逻辑塞进 React 树里。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OverlayWindow } from './views/OverlayWindow';
import { AppProvider } from './lib/store';
// 隐藏窗口的运行时必须在构建期静态引入，否则 Vite 不会把它打进产物，
// 运行时动态 import 会 404（实测 "Failed to fetch dynamically imported module"）。
// 三个模块只在对应角色下才会被调用，静态引入不会影响主窗口行为。
import './recorderRuntime';
import './exporterRuntime';
import './cameraRuntime';
import './styles.css';

type Role = 'main' | 'overlay' | 'recorder' | 'exporter' | 'camera';

function resolveRole(): Role {
  const declared = typeof window !== 'undefined' ? window.wcs?.role : undefined;
  if (
    declared === 'overlay' ||
    declared === 'recorder' ||
    declared === 'exporter' ||
    declared === 'camera'
  ) {
    return declared;
  }
  if (typeof location !== 'undefined') {
    const hash = location.hash + location.search;
    if (/(^#\/?overlay\b)|([?&]role=overlay)/.test(hash)) return 'overlay';
    if (/(^#\/?recorder\b)|([?&]role=recorder)/.test(hash)) return 'recorder';
    if (/(^#\/?exporter\b)|([?&]role=exporter)/.test(hash)) return 'exporter';
    if (/(^#\/?camera\b)|([?&]role=camera)/.test(hash)) return 'camera';
  }
  return 'main';
}

window.addEventListener('error', (event) => {
  console.error('[renderer] uncaught error:', event.message, event.filename, event.lineno);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled rejection:', String(event.reason));
});

const role = resolveRole();

/**
 * 隐藏窗口的角色：运行时已由静态 import 安装完毕（window.__wcsRecorder /
 * window.__wcsExporter / window.__wcsCamera），这里只需标记就绪并返回，
 * 不渲染任何界面。主进程通过 executeJavaScript 调用这些全局对象。
 */
if (role === 'recorder' || role === 'exporter' || role === 'camera') {
  document.documentElement.dataset.ready = '1';
} else {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('缺少 #root 挂载点');
  }

  createRoot(container).render(
    <StrictMode>
      <AppProvider>
        {role === 'overlay' ? <OverlayWindow /> : <App />}
      </AppProvider>
    </StrictMode>,
  );

  // 供验证脚本判断渲染是否完成（不含业务逻辑）
  requestAnimationFrame(() => {
    document.documentElement.dataset.ready = '1';
  });
}
