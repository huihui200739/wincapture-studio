/**
 * 首页：最近工程、新建录制、恢复未完成录制、教程入口
 */

import { useMemo, useState } from 'react';
import { useApp } from '../lib/store';
import { Badge, Button, EmptyState, Icon, IconButton, InlineNote, Modal, Panel } from '../components/ui';
import { cn, formatClock, formatDurationLong, formatRelativeTime, isCancelledError, unwrap } from '../lib/format';
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
    projectLoading,
    setView,
    pushToast,
    apiMode,
    project,
    projectPath,
    duration,
    dirty,
    save,
    saving,
    closeProject,
    pushError,
  } = useApp();

  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; name: string } | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<RecoverableSession | null>(null);
  /** 有未保存修改时，先确认再切换工程 */
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);

  const stats = useMemo(() => {
    const total = recents.reduce((acc, item) => acc + item.durationTicks, 0);
    return {
      count: recents.length,
      duration: total / TICKS_PER_SECOND,
      missing: recents.filter((item) => item.missingMedia).length,
      recoverable: recoverables.length,
    };
  }, [recents, recoverables]);

  const doOpen = async (path?: string) => {
    const opened = await openProject(path);
    if (opened) setView('editor');
  };

  /**
   * 统一的失败提示：用户主动取消（E_EXPORT_CANCELLED）不能显示成失败，
   * 更不能显示成成功（例如删除确认框取消后提示「工程已删除」）。
   */
  const reportActionError = (error: unknown, title: string, cancelledTitle: string) => {
    if (isCancelledError(error)) {
      pushToast({ tone: 'info', title: cancelledTitle });
      return;
    }
    pushError(error, title);
  };

  /** 打开最近工程：切走前如果当前有未保存修改，先让用户确认。 */
  const handleOpen = async (path: string) => {
    if (dirty && project && path !== projectPath) {
      setPendingOpen(path);
      return;
    }
    await doOpen(path);
  };

  const handleSaveThenOpen = async () => {
    const target = pendingOpen;
    if (!target) return;
    const saved = await save();
    if (!saved) {
      // 保存失败时保留对话框，让用户看到错误提示后自行选择「放弃修改并打开」
      return;
    }
    setPendingOpen(null);
    await doOpen(target);
  };

  const handleOpenFolder = async (path: string) => {
    try {
      unwrap(await wcs().revealProject(path));
    } catch (error) {
      pushError(error, '打开工程所在位置失败');
    }
  };

  const handleRecover = async (session: RecoverableSession) => {
    setRecovering(session.projectPath);
    try {
      const handle = unwrap(await wcs().recoverSession(session.projectPath));
      await refreshRecoverables();
      const opened = await openProject(handle.path);
      if (!opened) return; // 打开失败已由 openProject 提示
      setView('editor');
      pushToast({
        tone: 'ok',
        title: '已恢复未完成录制',
        message: `恢复了 ${session.committedSegments} 个已提交分段，可能丢失约 ${(session.estimatedLossTicks / TICKS_PER_SECOND).toFixed(1)} 秒尾段。`,
      });
    } catch (error) {
      reportActionError(error, '恢复会话失败', '已取消恢复会话');
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
      reportActionError(error, '丢弃恢复会话失败', '已取消丢弃会话');
    } finally {
      setDiscarding(null);
      setConfirmDiscard(null);
    }
  };

  const handleRemoveRecent = async (path: string) => {
    setRemoving(path);
    try {
      unwrap(await wcs().removeRecentProject(path));
      await refreshRecents();
      pushToast({ tone: 'info', title: '已从最近列表移除', message: '工程文件仍保留在磁盘上。' });
    } catch (error) {
      reportActionError(error, '移除最近工程失败', '已取消移除');
    } finally {
      setRemoving(null);
    }
  };

  const handleDeleteProject = async () => {
    if (!confirmDelete) return;
    setRemoving(confirmDelete.path);
    try {
      // 主进程可能还有一次系统级确认；返回 ok(null) 表示删除完成，
      // 用户取消则走 E_EXPORT_CANCELLED 错误码 —— 绝不能提示「已删除」。
      unwrap(await wcs().deleteProject(confirmDelete.path));
      // 删除的是当前打开的工程：必须关闭，否则后续保存会写回已删除路径
      if (confirmDelete.path === projectPath) closeProject();
      await refreshRecents();
      pushToast({ tone: 'warn', title: '工程已删除', message: `${confirmDelete.name} 的工程目录已删除。` });
    } catch (error) {
      reportActionError(error, '删除工程失败', '已取消删除工程');
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
          <Button size="lg" icon="folder" onClick={() => void doOpen()} disabled={projectLoading}>
            打开工程
          </Button>
          {project && (
            <Button size="lg" variant="ghost" icon="editor" onClick={() => setView('editor')}>
              继续编辑「{project.name}」
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
            <div className="home-stat-value">{stats.duration > 0 ? formatDurationLong(stats.duration) : '0 分钟'}</div>
          </div>
          <div>
            <div className="home-stat-label">待恢复</div>
            <div className={cn('home-stat-value', stats.recoverable > 0 && 'is-warn')}>{stats.recoverable}</div>
          </div>
          <div>
            <div className="home-stat-label">素材缺失</div>
            <div className={cn('home-stat-value', stats.missing > 0 && 'is-warn')}>{stats.missing}</div>
          </div>
        </div>
      </section>

      <div className="home-grid">
        <div style={{ minWidth: 0 }}>
          {/* 恢复会话（§P1）：只在存在时显示一条可操作提示，不常驻占版面 */}
          {recoverables.length > 0 && (
            <Panel
              title="恢复未完成录制"
              icon="refresh"
              subtitle={`${recoverables.length} 个会话可恢复`}
              actions={<IconButton icon="refresh" label="刷新可恢复会话" size="sm" onClick={() => void refreshRecoverables()} />}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                        onClick={() => setConfirmDiscard(session)}
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
                <Button size="sm" variant="ghost" icon="folder" onClick={() => void doOpen()}>
                  打开工程…
                </Button>
              </>
            }
          >
            {recents.length === 0 ? (
              <EmptyState
                icon="editor"
                title="还没有工程"
                description="使用上方「新建录制」开始，或打开一个已有工程。"
              />
            ) : (
              <div className="recent-list">
                {recents.map((item) => (
                  // 外层是普通容器（不再 role="button"）：里面还有三个图标按钮，
                  // 把按钮嵌在 role=button 里既不符合 ARIA，键盘语义也会打架。
                  // 打开动作由内部真实 <button> 承担，占满缩略图 + 标题两列。
                  <div key={item.path} className="recent-item">
                    <button
                      type="button"
                      className="recent-open"
                      aria-label={`打开工程 ${item.name}`}
                      onClick={() => void handleOpen(item.path)}
                      style={{
                        gridColumn: '1 / 3',
                        display: 'grid',
                        gridTemplateColumns: '128px minmax(0, 1fr)',
                        gap: 12,
                        alignItems: 'center',
                        padding: 0,
                        border: 0,
                        background: 'transparent',
                        color: 'inherit',
                        font: 'inherit',
                        textAlign: 'left',
                        cursor: 'pointer',
                        minWidth: 0,
                      }}
                    >
                      <div className="recent-thumb">
                        {item.thumbnail ? (
                          <img src={item.thumbnail} alt="" />
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
                    </button>
                    <div className="recent-actions">
                      <IconButton
                        icon="external"
                        label="在资源管理器中显示"
                        size="sm"
                        onClick={() => void handleOpenFolder(item.path)}
                      />
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
          <Panel title="当前工程" icon="layers">
            {project ? (
              <>
                <div className="side-project-name" title={project.name}>
                  {project.name}
                </div>
                <div className="side-project-meta">
                  {formatClock(duration)} ·{' '}
                  {project.tracks.reduce((acc, t) => acc + t.clips.length, 0)} 个片段 · {project.steps.length} 个步骤
                </div>
                <div className="side-project-actions">
                  <Button size="sm" variant="primary" icon="editor" onClick={() => setView('editor')}>
                    继续编辑
                  </Button>
                  <Button size="sm" variant="ghost" icon="export" onClick={() => setView('export')}>
                    导出
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState title="没有打开的工程" description="从最近工程打开，或新建一次录制。" />
            )}
          </Panel>

          {apiMode === 'mock' && (
            <InlineNote tone="warn">
              <strong>示例数据模式。</strong> 未检测到 <code>window.wcs</code>，界面使用内置示例工程运行，所有操作都在内存中完成。
            </InlineNote>
          )}
        </div>
      </div>

      {pendingOpen && (
        <Modal
          title="当前工程有未保存修改"
          onClose={() => setPendingOpen(null)}
          footer={
            <>
              <Button onClick={() => setPendingOpen(null)} disabled={saving}>
                取消
              </Button>
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  const target = pendingOpen;
                  setPendingOpen(null);
                  void doOpen(target);
                }}
              >
                放弃修改并打开
              </Button>
              <Button variant="primary" icon="save" loading={saving} onClick={() => void handleSaveThenOpen()}>
                保存并打开
              </Button>
            </>
          }
        >
          <p>继续打开另一个工程会丢弃当前工程里尚未保存的修改。</p>
          <p style={{ marginTop: 8, color: 'var(--text-muted)' }}>
            自动保存大约在停止编辑 2 秒后触发；如果刚改完就打开别的工程，仍可能丢失最后一次修改。
          </p>
        </Modal>
      )}

      {confirmDiscard && (
        <Modal
          title="丢弃未完成的录制会话？"
          tone="danger"
          onClose={() => setConfirmDiscard(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDiscard(null)} disabled={discarding !== null}>
                取消
              </Button>
              <Button
                variant="danger"
                icon="trash"
                loading={discarding === confirmDiscard.projectPath}
                onClick={() => void handleDiscard(confirmDiscard)}
              >
                丢弃会话
              </Button>
            </>
          }
        >
          <p>
            将丢弃「<strong>{confirmDiscard.name}</strong>」的 {confirmDiscard.committedSegments} 个已提交分段，
            临时素材会在后台清理。该操作不可撤销。
          </p>
        </Modal>
      )}

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
