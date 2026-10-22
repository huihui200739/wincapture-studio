/**
 * 首页：最近工程、新建录制、恢复未完成录制、教程入口
 */

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/store';
import { Badge, Button, EmptyState, Icon, IconButton, InlineNote, Modal, Panel, Spinner } from '../components/ui';
import { cn, describeError, formatBytes, formatClock, formatDurationLong, formatRelativeTime, unwrap } from '../lib/format';
import { TICKS_PER_SECOND } from '@domain/timebase';
import type { RecoverableSession } from '@shared/ipc';
import { wcs } from '../lib/wcs';

export function HomeView() {
  const {
    recents,
    recoverables,
    refreshRecents,
    refreshRecoverables,
    openProject,
    createProject,
    projectLoading,
    setView,
    pushToast,
    apiMode,
    systemInfo,
    project,
    duration,
    pushError,
  } = useApp();

  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; name: string } | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);

  const stats = useMemo(() => {
    const total = recents.reduce((acc, item) => acc + item.durationTicks, 0);
    return {
      count: recents.length,
      duration: total / TICKS_PER_SECOND,
      missing: recents.filter((item) => item.missingMedia).length,
      recoverable: recoverables.length,
    };
  }, [recents, recoverables]);

  const handleOpen = async (path: string) => {
    await openProject(path);
    setView('editor');
  };

  const handleRecover = async (session: RecoverableSession) => {
    setRecovering(session.projectPath);
    try {
      const handle = unwrap(await wcs().recoverSession(session.projectPath));
      await openProject(handle.path);
      await refreshRecoverables();
      setView('editor');
      pushToast({
        tone: 'ok',
        title: '已恢复未完成录制',
        message: `恢复了 ${session.committedSegments} 个已提交分段，可能丢失约 ${(session.estimatedLossTicks / TICKS_PER_SECOND).toFixed(1)} 秒尾段。`,
      });
    } catch (error) {
      pushError(error, '恢复会话失败');
    } finally {
      setRecovering(null);
    }
  };

  const handleDiscard = async (session: RecoverableSession) => {
    setDiscarding(session.projectPath);
    try {
      unwrap(await wcs().discardRecovery(session.projectPath));
      await refreshRecoverables();
      pushToast({ tone: 'info', title: '已丢弃恢复会话', message: '该会话的临时分段会在后台清理。' });
    } catch (error) {
      pushError(error, '丢弃恢复会话失败');
    } finally {
      setDiscarding(null);
    }
  };

  const handleRemoveRecent = async (path: string) => {
    setRemoving(path);
    try {
      unwrap(await wcs().removeRecentProject(path));
      await refreshRecents();
      pushToast({ tone: 'info', title: '已从最近列表移除', message: '工程文件仍保留在磁盘上。' });
    } catch (error) {
      pushError(error, '移除最近工程失败');
    } finally {
      setRemoving(null);
    }
  };

  const handleDeleteProject = async () => {
    if (!confirmDelete) return;
    setRemoving(confirmDelete.path);
    try {
      unwrap(await wcs().deleteProject(confirmDelete.path));
      await refreshRecents();
      pushToast({ tone: 'warn', title: '工程已删除', message: `${confirmDelete.name} 的工程目录已删除。` });
    } catch (error) {
      pushError(error, '删除工程失败');
    } finally {
      setRemoving(null);
      setConfirmDelete(null);
    }
  };

  return (
    <div className="view">
      <section className="home-hero">
        <h1>录制、剪辑、出教程，一个工程走完</h1>
        <p>
          选好来源就能开始录制；停止后自动进入编辑器，按标记生成教程步骤草稿。
          所有遮挡都会在导出前再检查一次，未确认的区域不会被当作「已遮挡」。
        </p>
        <div className="home-hero-actions">
          <Button variant="primary" size="lg" icon="record" onClick={() => setView('record')}>
            新建录制
          </Button>
          <Button size="lg" icon="editor" onClick={() => void createProject()} disabled={projectLoading}>
            空白工程
          </Button>
          <Button size="lg" variant="ghost" icon="book" onClick={() => setView('tutorial')}>
            打开教程步骤
          </Button>
          {project && (
            <Button size="lg" variant="ghost" icon="play" onClick={() => setView('editor')}>
              继续编辑当前工程
            </Button>
          )}
        </div>

        <div className="home-stats">
          <div>
            <div className="home-stat-label">最近工程</div>
            <div className="home-stat-value">{stats.count}</div>
          </div>
          <div>
            <div className="home-stat-label">累计时长</div>
            <div className="home-stat-value">{formatDurationLong(stats.duration)}</div>
          </div>
          <div>
            <div className="home-stat-label">待恢复会话</div>
            <div className={cn('home-stat-value', stats.recoverable > 0 && 'is-warn')}>{stats.recoverable}</div>
          </div>
          <div>
            <div className="home-stat-label">素材缺失</div>
            <div className={cn('home-stat-value', stats.missing > 0 && 'is-warn')}>{stats.missing}</div>
          </div>
        </div>
      </section>

      <div className="home-grid">
        <div>
          {recoverables.length > 0 && (
            <Panel
              title="恢复未完成录制"
              icon="refresh"
              subtitle={`${recoverables.length} 个会话可恢复`}
              className=""
              actions={
                <IconButton icon="refresh" label="刷新可恢复会话" size="sm" onClick={() => void refreshRecoverables()} />
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recoverables.map((session) => (
                  <div key={session.projectPath} className="recover-card">
                    <div className="recover-title">
                      <Icon name="warning" size={14} />
                      {session.name}
                    </div>
                    <div className="recover-meta">
                      <span>已提交分段 {session.committedSegments}</span>
                      <span>已录 {formatClock(session.durationTicks)}</span>
                      <span>可能丢失尾段 ≈ {(session.estimatedLossTicks / TICKS_PER_SECOND).toFixed(1)} 秒</span>
                      <span>{formatRelativeTime(session.createdAt)}</span>
                    </div>
                    <div className="recover-actions">
                      <Button
                        size="sm"
                        variant="primary"
                        icon="refresh"
                        loading={recovering === session.projectPath}
                        onClick={() => void handleRecover(session)}
                      >
                        恢复并继续编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={discarding === session.projectPath}
                        onClick={() => void handleDiscard(session)}
                      >
                        丢弃会话
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel
            title="最近工程"
            icon="clock"
            subtitle={projectLoading ? '正在读取…' : `${recents.length} 个`}
            actions={
              <>
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refreshRecents()}>
                  刷新
                </Button>
                <Button size="sm" variant="ghost" icon="folder" onClick={() => void wcs().pickDirectory()}>
                  打开目录
                </Button>
              </>
            }
          >
            {recents.length === 0 ? (
              <EmptyState
                icon="editor"
                title="还没有工程"
                description="新建一次录制，或从已有素材开始一个空白工程。"
                actions={
                  <>
                    <Button variant="primary" size="sm" icon="record" onClick={() => setView('record')}>
                      新建录制
                    </Button>
                    <Button size="sm" onClick={() => void createProject()}>
                      空白工程
                    </Button>
                  </>
                }
              />
            ) : (
              <div className="recent-list">
                {recents.map((item) => (
                  <div
                    key={item.path}
                    className="recent-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => void handleOpen(item.path)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void handleOpen(item.path);
                      }
                    }}
                  >
                    <div className="recent-thumb">
                      {item.thumbnail ? (
                        <img src={item.thumbnail} alt={`${item.name} 缩略图`} />
                      ) : (
                        <div className="recent-thumb-fallback">
                          <Icon name="image" size={18} />
                        </div>
                      )}
                    </div>
                    <div className="recent-main">
                      <div className="recent-name">{item.name}</div>
                      <div className="recent-meta">
                        <span>{formatClock(item.durationTicks)}</span>
                        <span>·</span>
                        <span>{formatRelativeTime(item.updatedAt)}</span>
                        {item.missingMedia && <Badge tone="warn" icon="warning">素材缺失</Badge>}
                        {item.recoverable && <Badge tone="warn" icon="refresh">可恢复</Badge>}
                      </div>
                      <div className="recent-path" title={item.path}>
                        {item.path}
                      </div>
                    </div>
                    <div className="recent-actions" onClick={(event) => event.stopPropagation()}>
                      <IconButton icon="external" label="在资源管理器中显示" size="sm" onClick={() => void wcs().revealProject(item.path)} />
                      <IconButton
                        icon="close"
                        label="从最近列表移除（不删除文件）"
                        size="sm"
                        disabled={removing === item.path}
                        onClick={() => void handleRemoveRecent(item.path)}
                      />
                      <IconButton
                        icon="trash"
                        label="删除工程目录"
                        size="sm"
                        variant="danger"
                        onClick={() => setConfirmDelete({ path: item.path, name: item.name })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="side-stack">
          <Panel title="开始" icon="record">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button type="button" className="quick-action" onClick={() => setView('record')}>
                <span className="quick-action-icon">
                  <Icon name="record" size={16} />
                </span>
                <span>
                  <span className="quick-action-title">新建录制</span>
                  <span className="quick-action-desc">选择显示器或窗口，检查麦克风与摄像头</span>
                </span>
              </button>
              <button type="button" className="quick-action" onClick={() => setView('editor')}>
                <span className="quick-action-icon">
                  <Icon name="editor" size={16} />
                </span>
                <span>
                  <span className="quick-action-title">打开编辑器</span>
                  <span className="quick-action-desc">预览、剪辑、运镜、遮挡与画幅</span>
                </span>
              </button>
              <button type="button" className="quick-action" onClick={() => setView('tutorial')}>
                <span className="quick-action-icon">
                  <Icon name="book" size={16} />
                </span>
                <span>
                  <span className="quick-action-title">教程步骤</span>
                  <span className="quick-action-desc">由标记生成草稿，编辑标题与截图</span>
                </span>
              </button>
              <button type="button" className="quick-action" onClick={() => setView('export')}>
                <span className="quick-action-icon">
                  <Icon name="export" size={16} />
                </span>
                <span>
                  <span className="quick-action-title">导出视频或教程</span>
                  <span className="quick-action-desc">选择画幅、输出路径与预计体积</span>
                </span>
              </button>
            </div>
          </Panel>

          <Panel title="当前工程" icon="layers">
            {project ? (
              <div className="kv-list">
                <div className="kv-row">
                  <span className="kv-key">名称</span>
                  <span className="kv-value" style={{ fontFamily: 'inherit' }}>{project.name}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">时长</span>
                  <span className="kv-value">{formatClock(duration)}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">片段 / 效果</span>
                  <span className="kv-value">
                    {project.tracks.reduce((acc, t) => acc + t.clips.length, 0)} / {project.effects.length}
                  </span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">教程步骤</span>
                  <span className="kv-value">{project.steps.length}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">未确认遮挡</span>
                  <span className="kv-value">
                    {project.effects.filter((e) => e.kind === 'privacy' && !(e.parameters as { confirmed?: boolean }).confirmed).length}
                  </span>
                </div>
              </div>
            ) : (
              <EmptyState title="没有打开的工程" description="从最近工程打开，或新建一个录制。" />
            )}
          </Panel>

          <Panel title="系统" icon="info">
            {systemInfo ? (
              <div className="kv-list">
                <div className="kv-row">
                  <span className="kv-key">系统</span>
                  <span className="kv-value">{systemInfo.osVersion}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">可用内存</span>
                  <span className="kv-value">{formatBytes(systemInfo.freeMemoryBytes)}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">硬件编码</span>
                  <span className="kv-value">{systemInfo.hardwareEncoding ? '可用' : '不可用'}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-key">默认输出目录</span>
                  <span className="kv-value" title={systemInfo.videosPath}>
                    {systemInfo.videosPath}
                  </span>
                </div>
              </div>
            ) : (
              <div className="wcs-empty">
                <Spinner />
                <p>正在读取系统信息…</p>
              </div>
            )}
          </Panel>

          {apiMode === 'mock' && (
            <InlineNote tone="warn">
              <strong>示例数据模式。</strong> 未检测到 <code>window.wcs</code>，界面使用内置示例工程运行，所有操作都在内存中完成。
            </InlineNote>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal
          title="删除工程目录？"
          tone="danger"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" icon="trash" loading={removing === confirmDelete.path} onClick={() => void handleDeleteProject()}>
                删除工程目录
              </Button>
            </>
          }
        >
          <p>
            将从磁盘删除工程 <strong>{confirmDelete.name}</strong> 的整个目录（含素材）。
          </p>
          <p style={{ marginTop: 8, color: 'var(--text-muted)' }}>
            这只删除工程与工程内的素材文件，不会影响系统里其它位置的原始文件。该操作不可撤销。
          </p>
        </Modal>
      )}
    </div>
  );
}
