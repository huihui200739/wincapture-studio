/**
 * 应用外壳：左侧导航 + 顶栏 + 视图切换 + 状态栏 + 提示条
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useApp, VIEWS, type ViewId } from './lib/store';
import { useShortcuts } from './lib/hooks';
import { Icon, IconButton, ErrorBoundary } from './components/ui';
import { formatClock, cn } from './lib/format';
import { HomeView } from './views/HomeView';
import { RecordView } from './views/RecordView';
import { EditorView } from './views/EditorView';
import { ExportView } from './views/ExportView';
import { TutorialView } from './views/TutorialView';
import { SettingsView } from './views/SettingsView';
import { CaptureLauncher } from './views/CaptureLauncher';
import { StudioHeader } from './components/StudioHeader';
import { wcs } from './lib/wcs';

// 应用图标（public/app-icon.png，用户确认的白瓷叠帧稿）。用相对路径，兼容 file:// 加载。
const APP_ICON_URL = './app-icon.png';

function ToastStack() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="操作提示" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn('toast', `is-${toast.tone}`)}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
        >
          <span className="toast-icon">
            <Icon
              name={toast.tone === 'ok' ? 'check' : toast.tone === 'danger' ? 'warning' : toast.tone === 'warn' ? 'warning' : 'info'}
              size={15}
            />
          </span>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.message && <div className="toast-message">{toast.message}</div>}
            {toast.detail && <div className="toast-detail">{toast.detail}</div>}
          </div>
          <IconButton icon="close" label="关闭提示" size="sm" onClick={() => dismissToast(toast.id)} />
        </div>
      ))}
    </div>
  );
}

function Rail() {
  const { view, setView } = useApp();
  return (
    <nav className="app-rail" aria-label="主导航">
      <div className="rail-brand">
        <div className="rail-logo" aria-hidden="true">
          <img src={APP_ICON_URL} alt="" width={28} height={28} />
        </div>
      </div>
      <div className="rail-nav">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cn('rail-item', view === item.id && 'is-active')}
            aria-current={view === item.id ? 'page' : undefined}
            aria-label={`${item.label} · ${item.hint}`}
            title={`${item.label} — ${item.hint}`}
            onClick={() => setView(item.id)}
          >
            <Icon name={item.icon} size={18} />
            <span className="rail-item-label">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <span className="rail-brand-name">v0.1</span>
      </div>
    </nav>
  );
}

const VIEW_TITLES: Record<ViewId, { title: string; sub: string }> = {
  home: { title: '首页', sub: '最近工程 · 新建录制 · 恢复未完成录制' },
  record: { title: '录制设置', sub: '来源、声音、摄像头、画质与磁盘检查' },
  editor: { title: '编辑器', sub: '预览 · 时间线 · 属性 · 隐私遮挡' },
  export: { title: '导出', sub: '视频与图文教程产物' },
  tutorial: { title: '图文教程', sub: '步骤草稿与图文编排' },
  settings: { title: '设置', sub: '设备、快捷键与诊断' },
};

/**
 * 状态栏（§P2）：正常状态只显示「已保存」这类用户能理解的事实。
 * 进程连接、revision、内存、原生采集能力等内部信息移到设置页，
 * 只有真正需要用户处理的异常才在这里露出。
 */
function StatusBar() {
  const { project, duration, dirty, saving, systemInfo } = useApp();
  const durationText = useMemo(() => formatClock(duration), [duration]);
  const saveText = saving ? '保存中…' : dirty ? '有未保存修改' : project ? '已保存' : '—';
  const lowMemory = systemInfo ? systemInfo.freeMemoryBytes < 512 * 1024 * 1024 : false;

  return (
    <footer className="app-status" aria-label="状态栏">
      <span className="status-item">
        <span className={cn('status-dot', dirty ? 'is-warn' : 'is-ok')} />
        {saveText}
      </span>
      {project && (
        <span className="status-item" title={project.name}>
          <Icon name="clock" size={11} />
          {durationText}
        </span>
      )}
      {lowMemory && (
        <span className="status-item" style={{ color: 'var(--warn)' }}>
          <Icon name="warning" size={11} />
          可用内存偏低，长录制可能中断
        </span>
      )}
      <span className="status-item" style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>
        WinCapture Studio
      </span>
    </footer>
  );
}

function ViewRouter({ view }: { view: ViewId }): ReactNode {
  switch (view) {
    case 'home':
      return <HomeView />;
    case 'record':
      return <RecordView />;
    case 'editor':
      return <EditorView />;
    case 'export':
      return <ExportView />;
    case 'tutorial':
      return <TutorialView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <HomeView />;
  }
}

export function App() {
  const { view, setView, capture, apiMode, project, setPlaying } = useApp();
  const previousView = useRef<ViewId>('editor');
  const dialogOpen = view === 'settings' || view === 'export';
  if (!dialogOpen) previousView.current = view;
  const baseView = dialogOpen ? (previousView.current === 'record' && apiMode === 'native' ? (project ? 'editor' : 'home') : previousView.current) : view;
  const closeDialog = () => setView(baseView);
  useEffect(() => { if (dialogOpen) setPlaying(false); }, [dialogOpen, setPlaying]);
  const launcher = view === 'record' && apiMode === 'native';
  useEffect(() => {
    document.documentElement.dataset.surface = launcher ? 'launcher' : 'studio';
    if (!launcher && apiMode === 'native') void wcs().windowLayout({ mode: 'editor' });
  }, [launcher, apiMode]);

  // 快捷键：Ctrl+1..6 切换视图。
  // 复用统一的 useShortcuts：自动跳过输入框，且模态框打开时不再切换视图
  //（旧实现会在删除确认框打开时把视图切走，确认框随之消失）。
  useShortcuts(
    useMemo(
      () =>
        VIEWS.map((item, index) => ({
          combo: `ctrl+${index + 1}`,
          handler: () => setView(item.id),
          allowInModal: false,
        })),
      [setView],
    ),
  );

  // 录制异常状态：顶部提示不遮挡主流程
  const recordingBanner =
    capture && (capture.state === 'RecoverableFailure' || capture.state === 'RecoveryReady') ? (
      <div style={{ padding: '0 18px', marginTop: 10 }}>
        <div className="wcs-note is-danger" role="alert">
          <Icon name="warning" size={14} />
          <div className="wcs-note-body">
            <strong>录制中断，已保留可用片段。</strong> {capture.error?.message ?? '可以恢复已提交的分段后继续编辑，或丢弃本次会话。'}
          </div>
        </div>
      </div>
    ) : null;

  if (launcher) return <><CaptureLauncher /><ToastStack /></>;
  return (
    <div className={cn('app-shell studio-shell', baseView === 'editor' ? 'is-editing' : 'has-navigation')}>
      {baseView !== 'editor' && <Rail />}
      <StudioHeader />
      <main className="app-main" id="main-content" inert={dialogOpen}>
        {recordingBanner}
        {/* 单个视图崩溃不应导致整窗白屏：保留导航与状态栏，只降级出错区域 */}
        <ErrorBoundary key={baseView} scope={VIEW_TITLES[baseView].title}>
          <ViewRouter view={baseView} />
        </ErrorBoundary>
      </main>
      {/* 编辑台没有状态栏：时间线直达窗口底缘（参考应用同款停靠布局） */}
      {baseView !== 'editor' && <StatusBar />}
      {view === 'settings' && <SettingsView onClose={closeDialog} />}
      {view === 'export' && <ExportView onClose={closeDialog} />}
      <ToastStack />
    </div>
  );
}

export default App;
