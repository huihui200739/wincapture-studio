/**
 * 应用外壳：左侧导航 + 顶栏 + 视图切换 + 状态栏 + 提示条
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { useApp, VIEWS, type ViewId } from './lib/store';
import { Icon, IconButton, Badge, Kbd } from './components/ui';
import { formatClock, formatDateTime, formatBytes } from './lib/format';
import { ticksToSeconds } from './lib/format';
import { HomeView } from './views/HomeView';
import { RecordView } from './views/RecordView';
import { EditorView } from './views/EditorView';
import { ExportView } from './views/ExportView';
import { TutorialView } from './views/TutorialView';
import { SettingsView } from './views/SettingsView';
import { cn } from './lib/format';

function ToastStack() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="操作提示">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn('toast', `is-${toast.tone}`)}>
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
          WC
        </div>
        <span className="rail-brand-name">Studio</span>
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

function TopBar() {
  const {
    view,
    project,
    dirty,
    canUndo,
    canRedo,
    undo,
    redo,
    save,
    saving,
    savedAt,
    apiMode,
    capture,
    setView,
    capturing,
  } = useApp();
  const meta = VIEW_TITLES[view];

  return (
    <header className="app-topbar">
      <div className="topbar-title">
        <h1>{meta.title}</h1>
        <span className="topbar-sub">{view === 'editor' && project ? project.name : meta.sub}</span>
      </div>
      <div className="topbar-spacer" />

      {capturing && (
        <div className="topbar-group">
          <Badge tone={capture?.state === 'Paused' ? 'warn' : 'danger'} icon="record">
            {capture?.state === 'Paused' ? '录制暂停' : '正在录制'} {formatClock(capture?.mediaTick ?? 0)}
          </Badge>
          <button type="button" className="wcs-btn is-sm is-ghost" onClick={() => setView('record')}>
            回到录制页
          </button>
          <div className="topbar-divider" />
        </div>
      )}

      {view === 'editor' && project && (
        <div className="topbar-group">
          <IconButton icon="undo" label={canUndo ? `撤销（${undo})` : '撤销（无可撤销操作）'} size="sm" onClick={undo} disabled={!canUndo} />
          <IconButton icon="redo" label="重做" size="sm" onClick={redo} disabled={!canRedo} />
          <button type="button" className="wcs-btn is-sm" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? <span className="wcs-spinner" style={{ width: 12, height: 12 }} /> : <Icon name="save" size={13} />}
            {dirty ? '保存' : '已保存'}
          </button>
          <span className="topbar-sub" style={{ fontSize: 10.5 }}>
            {savedAt ? `上次保存 ${new Date(savedAt).toLocaleTimeString('zh-CN')}` : dirty ? '有未保存修改' : '—'}
          </span>
          <div className="topbar-divider" />
        </div>
      )}

      <div className="topbar-group">
        <Badge tone={apiMode === 'native' ? 'ok' : 'warn'} title={apiMode === 'native' ? '已连接主进程' : '未检测到 window.wcs，使用内置示例数据'}>
          {apiMode === 'native' ? '主进程已连接' : '示例数据模式'}
        </Badge>
      </div>
    </header>
  );
}

function StatusBar() {
  const { apiMode, project, duration, systemInfo, recents, quality } = useApp();
  const durationText = useMemo(() => formatClock(duration), [duration]);
  return (
    <footer className="app-status" aria-label="状态栏">
      <span className="status-item">
        <span className={cn('status-dot', apiMode === 'native' ? 'is-ok' : 'is-warn')} />
        {apiMode === 'native' ? '原生采集可用' : '示例数据（未连接主进程）'}
      </span>
      <span className="status-item">
        <Icon name="clock" size={11} />
        工程时长 {durationText}
      </span>
      {project && (
        <span className="status-item">
          版本 {project.revision} · {project.tracks.reduce((acc, t) => acc + t.clips.length, 0)} 个片段 · {project.effects.length} 个效果
        </span>
      )}
      {systemInfo && (
        <span className="status-item">
          <Icon name="disk" size={11} />
          内存可用 {formatBytes(systemInfo.freeMemoryBytes)}
        </span>
      )}
      <span className="status-item">
        <Icon name="screen" size={11} />
        默认档位 {quality.label}
      </span>
      <span className="status-item" style={{ marginLeft: 'auto' }}>
        {recents.length} 个最近工程 · {formatDateTime(Date.now())}
      </span>
    </footer>
  );
}

function ViewRouter(): ReactNode {
  const { view } = useApp();
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
  const { setView, capture } = useApp();

  // 快捷键：Ctrl+1..6 切换视图（输入框内不触发）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!event.ctrlKey || event.altKey) return;
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= VIEWS.length) {
        event.preventDefault();
        setView(VIEWS[index - 1].id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setView]);

  // 录制异常状态：顶部提示不遮挡主流程
  const recordingBanner =
    capture && (capture.state === 'RecoverableFailure' || capture.state === 'RecoveryReady') ? (
      <div style={{ padding: '0 18px', marginTop: 10 }}>
        <div className="wcs-note is-danger">
          <Icon name="warning" size={14} />
          <div className="wcs-note-body">
            <strong>录制中断，已保留可用片段。</strong> {capture.error?.message ?? '可以恢复已提交的分段后继续编辑，或丢弃本次会话。'}
          </div>
        </div>
      </div>
    ) : null;

  return (
    <div className="app-shell">
      <Rail />
      <TopBar />
      <main className="app-main">
        {recordingBanner}
        <ViewRouter />
      </main>
      <StatusBar />
      <ToastStack />
    </div>
  );
}

export default App;
