/**
 * 录制悬浮控制条（§6.1 / §6.4 / R12）
 *
 * 状态用「文字 + 图标 + 计时」共同表达，不只依赖红绿颜色：
 * - 每个状态都有中文名、图标形状差异（圆点 / 方块 / 三角）与计时。
 * - 暂停时计时变色且前面加「已暂停」文字，颜色不是唯一线索。
 *
 * 备忘录（R12）：
 * - 可折叠，默认折叠保持悬浮条紧凑；展开时用绝对定位浮层，不撑开 460×132 主布局。
 * - 内容只存本机（localStorage），不做任何网络同步。
 * - 录制中按 Ctrl+Alt+M 添加标记时，若备忘录有内容，把当前行作为标记 note 传给 addMarker。
 *
 * 状态同步（本轮修复）：
 * - 主进程的 capture:status 是「推送 + 可丢失」的：窗口刚创建、主进程忙、窗口重载时都可能漏。
 *   这里对推送做 100ms 合并（§14.3 最多 10 次/秒），并用 1.5s 轮询兜底纠偏；
 *   同时按钮操作的结果会 await IPC 返回值，失败时在状态文字里明确提示，不再「假装成功」。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CaptureState, CaptureStatus, IpcResponse } from '@shared/ipc';
import { cn, formatBytes, formatClock } from '../lib/format';
import { Icon } from '../components/ui';
import { createStatusCoalescer, memoMarkNote, type StatusCoalescer } from '../uiSync';

const MEMO_TEXT_KEY = 'wcs.overlay.memoText';
const MEMO_OPEN_KEY = 'wcs.overlay.memoOpen';

/** 读取本机存储的备忘录文本（不可用时静默回退为空）。 */
function loadMemoText(): string {
  try {
    return window.localStorage.getItem(MEMO_TEXT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 读取备忘录展开状态（默认折叠）。 */
function loadMemoOpen(): boolean {
  try {
    return window.localStorage.getItem(MEMO_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 窄窗口下的按钮内联样式（styles.css 里 .rec-bar.is-narrow 已有兜底，这里保留密度微调）。 */
function narrowBtnStyle(narrow: boolean | undefined): CSSProperties | undefined {
  return narrow ? { height: 27, padding: '0 8px', fontSize: 11, gap: 4 } : undefined;
}

/** 命令结果：按钮操作必须知道自己成没成功，而不是无条件显示「暂停中」。 */
export interface CommandOutcome {
  ok: boolean;
  message?: string;
}

export type CommandHandler = () => Promise<CommandOutcome> | CommandOutcome | void | Promise<void>;

export interface OverlayBarProps {
  status: CaptureStatus | null;
  onPause?: CommandHandler;
  onResume?: CommandHandler;
  onStop?: CommandHandler;
  onMark?: CommandHandler;
  onOpenEditor?: () => void;
  compact?: boolean;
  /**
   * 窄窗口（真实悬浮窗 460×132）：隐藏电平与写入统计等次要信息，
   * 保证控制条不会被裁切；备忘录浮层另外用绝对定位。
   */
  narrow?: boolean;
  /** 备忘录当前文本（R12，只存本机）。 */
  memoText?: string;
  /** 备忘录展开状态（默认折叠）。 */
  memoOpen?: boolean;
  onMemoOpenChange?: (open: boolean) => void;
}

interface StateVisual {
  label: string;
  icon: 'record' | 'pause' | 'play' | 'stop' | 'clock' | 'check';
  className: string;
}

export const CAPTURE_STATE_TEXT: Record<CaptureState, string> = {
  Idle: '空闲',
  Preparing: '准备中',
  Countdown: '倒计时',
  Recording: '录制中',
  Pausing: '暂停中',
  Paused: '已暂停',
  Resuming: '恢复中',
  Stopping: '停止中',
  Finalizing: '封装中',
  ReadyToEdit: '可编辑',
  RecoverableFailure: '中断（可恢复）',
  RecoveryReady: '待恢复',
  Cancelled: '已取消',
};

function visualFor(state: CaptureState | null): StateVisual {
  switch (state) {
    case 'Recording':
      return { label: '录制中', icon: 'record', className: 'is-recording' };
    case 'Paused':
      return { label: '已暂停', icon: 'pause', className: 'is-paused' };
    case 'Pausing':
      return { label: '暂停中', icon: 'pause', className: 'is-paused' };
    case 'Resuming':
      return { label: '恢复中', icon: 'play', className: 'is-countdown' };
    case 'Countdown':
      return { label: '倒计时', icon: 'clock', className: 'is-countdown' };
    case 'Preparing':
      return { label: '准备中', icon: 'clock', className: 'is-countdown' };
    case 'Stopping':
      return { label: '停止中', icon: 'stop', className: 'is-finalizing' };
    case 'Finalizing':
      return { label: '封装中', icon: 'clock', className: 'is-finalizing' };
    case 'ReadyToEdit':
      return { label: '可编辑', icon: 'check', className: 'is-countdown' };
    case 'RecoverableFailure':
      return { label: '中断', icon: 'record', className: 'is-paused' };
    default:
      return { label: '空闲', icon: 'clock', className: '' };
  }
}

export function OverlayBar({
  status,
  onPause,
  onResume,
  onStop,
  onMark,
  onOpenEditor,
  compact,
  narrow,
  memoText = '',
  memoOpen = false,
  onMemoOpenChange,
}: OverlayBarProps) {
  const state = status?.state ?? null;
  const visual = visualFor(state);
  const paused = state === 'Paused' || state === 'Pausing';
  const canPause = state === 'Recording';
  const canResume = state === 'Paused';
  const canMark = state === 'Recording' || state === 'Paused' || state === 'Pausing' || state === 'Resuming';
  const canStop = !!state && !['Idle', 'ReadyToEdit', 'Cancelled', 'RecoveryReady'].includes(state);
  const levels = status?.levels ?? { mic: 0, system: 0 };
  const memoLines = memoText.split('\n').filter((line) => line.trim()).length;

  const [flash, setFlash] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // 用 ref 同步挡重入：state 更新是异步的，同一 tick 内连点两次会都通过检查
  const pendingRef = useRef<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const pulse = useCallback((text: string, tone: 'info' | 'ok' | 'error' = 'info') => {
    const label = tone === 'error' ? `失败 · ${text}` : text;
    setFlash(label);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), tone === 'error' ? 2600 : 1600);
  }, []);

  /**
   * 执行一次命令：先乐观显示「进行中」，再 await 真实 IPC 结果。
   * 失败时把原因写进状态文字（悬浮窗没有 toast，这是唯一的错误出口），
   * 不再出现「点暂停后显示暂停中、实际还在录」的假反馈。
   */
  const runAction = useCallback(
    async (key: string, pendingText: string, okText: string, handler: CommandHandler | undefined) => {
      if (!handler || pendingRef.current !== null) return;
      pendingRef.current = key;
      setPendingAction(key);
      pulse(pendingText);
      try {
        const outcome = await handler();
        if (outcome && outcome.ok === false) {
          pulse(outcome.message?.slice(0, 10) || '操作未生效', 'error');
        } else {
          pulse(okText, 'ok');
        }
      } catch (error) {
        console.error(`[overlay] ${key} 失败`, error);
        pulse('操作未生效', 'error');
      } finally {
        pendingRef.current = null;
        setPendingAction(null);
      }
    },
    [pulse],
  );

  return (
    <div
      className={cn('rec-bar', narrow && 'is-narrow')}
      role="toolbar"
      aria-label="录制控制条"
      style={narrow ? { minWidth: 0, width: '100%', gap: 7, padding: '6px 8px' } : undefined}
    >
      <div
        className={cn('rec-state', visual.className)}
        role="status"
        aria-live="polite"
        style={narrow ? { minWidth: 0, padding: '3px 7px 3px 6px' } : undefined}
      >
        <span className="rec-state-dot" aria-hidden="true" />
        <Icon name={visual.icon} size={13} />
        <span className="rec-state-text" title={flash ?? visual.label}>
          {flash ?? visual.label}
        </span>
      </div>

      <div
        className={cn('rec-time', paused && 'is-paused')}
        aria-label={`录制计时 ${formatClock(status?.mediaTick ?? 0)}`}
        style={narrow ? { minWidth: 0, fontSize: 15, letterSpacing: 0 } : undefined}
      >
        {formatClock(status?.mediaTick ?? 0)}
      </div>

      {!narrow && <div className="rec-divider" />}

      {!narrow && (
        <div className="rec-levels" aria-hidden={compact}>
          <div className="rec-level-row">
            <Icon name="mic" size={10} />
            <span className="rec-level-bar">
              <span className="rec-level-fill" style={{ width: `${Math.round(levels.mic * 100)}%` }} />
            </span>
          </div>
          <div className="rec-level-row">
            <Icon name="volume" size={10} />
            <span className="rec-level-bar">
              <span className="rec-level-fill is-system" style={{ width: `${Math.round(levels.system * 100)}%` }} />
            </span>
          </div>
        </div>
      )}

      {!narrow && (
        <div className="rec-meta">
          <span>
            标记 <strong>{status?.markerCount ?? 0}</strong>
          </span>
          <span>
            已写 <strong>{formatBytes(status?.bytesWritten ?? 0)}</strong>
          </span>
          {status?.freeDiskBytes != null && (
            <span>
              剩余 <strong>{formatBytes(status.freeDiskBytes)}</strong>
            </span>
          )}
        </div>
      )}
      <div className="rec-actions" style={narrow ? { gap: 4, marginLeft: 'auto' } : undefined}>
        <button
          type="button"
          className="rec-btn"
          disabled={(!canPause && !canResume) || pendingAction !== null}
          aria-label={canResume ? '继续录制' : '暂停录制'}
          title={canResume ? '继续录制（Ctrl+Alt+P）' : '暂停录制（Ctrl+Alt+P）'}
          style={narrowBtnStyle(narrow)}
          onClick={() => {
            if (canResume) void runAction('resume', '继续中', '已继续', onResume);
            else void runAction('pause', '暂停中', '已暂停', onPause);
          }}
        >
          <Icon name={canResume ? 'play' : 'pause'} size={12} />
          {canResume ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          className="rec-btn"
          disabled={!canMark || pendingAction !== null}
          aria-label="添加标记"
          title="添加标记（Ctrl+Alt+M），之后可生成教程步骤"
          style={narrowBtnStyle(narrow)}
          onClick={() => void runAction('mark', '标记中', '已标记', onMark)}
        >
          <Icon name="flag" size={12} />
          标记
        </button>
        <button
          type="button"
          className="rec-btn"
          aria-label={memoOpen ? '收起备忘录' : '展开备忘录'}
          aria-expanded={memoOpen}
          title={memoOpen ? '收起备忘录' : `展开备忘录${memoLines > 0 ? `（已记录 ${memoLines} 条）` : ''}`}
          style={{
            ...(narrowBtnStyle(narrow) ?? {}),
            ...(memoLines > 0 ? { borderColor: 'rgba(76, 141, 255, 0.55)', color: '#b9d3ff' } : {}),
          }}
          onClick={() => onMemoOpenChange?.(!memoOpen)}
        >
          <Icon name={memoOpen ? 'chevronDown' : 'book'} size={12} />
          {memoLines > 0 ? memoLines : ''}
        </button>
        <button
          type="button"
          className="rec-btn is-stop"
          disabled={!canStop || pendingAction !== null}
          aria-label="停止录制"
          title="停止录制（Ctrl+Alt+R）"
          style={narrowBtnStyle(narrow)}
          onClick={() => void runAction('stop', '停止中', '已停止', onStop)}
        >
          <Icon name="stop" size={12} />
          停止
        </button>
        {onOpenEditor && (
          <button type="button" className="rec-btn" aria-label="打开编辑器" title="打开编辑器" onClick={onOpenEditor}>
            <Icon name="editor" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

/** 把 IPC 响应折叠成按钮需要的成败信息（错误信息截断，避免撑破悬浮条）。 */
function toOutcome(response: IpcResponse<unknown> | null | undefined): CommandOutcome {
  if (!response) return { ok: false, message: '主进程无响应' };
  if (response.ok) return { ok: true };
  return { ok: false, message: response.error?.message ?? '操作未生效' };
}

/** 录制悬浮窗窗口（window.wcs.role === 'overlay' 时渲染）。 */
export function OverlayWindow() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  // 备忘录（R12）：只存本机，localStorage 失败时退化为组件状态
  const [memoText, setMemoText] = useState(loadMemoText);
  const [memoOpen, setMemoOpen] = useState(loadMemoOpen);
  const memoRef = useRef<HTMLTextAreaElement | null>(null);
  const memoTextRef = useRef(memoText);
  memoTextRef.current = memoText;

  const setMemoTextPersist = (text: string) => {
    setMemoText(text);
    try {
      window.localStorage.setItem(MEMO_TEXT_KEY, text);
    } catch {
      /* 隐私模式等场景写入失败，仅保留内存状态 */
    }
  };

  const setMemoOpenPersist = (open: boolean) => {
    setMemoOpen(open);
    try {
      window.localStorage.setItem(MEMO_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* 同上 */
    }
  };

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.wcs : undefined;
    if (!api) return;
    let mounted = true;

    // 100ms 合并：主进程的 force 推送 + 高频电平叠加时可能超过 10 次/秒，
    // 直接 setState 会让常驻悬浮窗在长录制里反复整窗重渲染。
    const coalescer: StatusCoalescer<CaptureStatus> = createStatusCoalescer<CaptureStatus>({
      intervalMs: 100,
      emit: (next) => {
        if (mounted) setStatus(next);
      },
    });

    void api.captureStatus().then((response) => {
      if (mounted && response.ok && response.data) coalescer.push(response.data);
    });
    const off = api.onCaptureStatus((next) => coalescer.push(next));

    // 兜底轮询：事件通道没有序列号，丢一条就永远不知道。
    // 1.5s 拉一次状态把计时/状态纠回来，代价可忽略。
    const poll = window.setInterval(() => {
      void api.captureStatus().then((response) => {
        if (mounted && response.ok && response.data) coalescer.push(response.data);
      });
    }, 1500);

    const offCommand = api.overlay?.onCommand((command) => {
      // 说明：主进程当前没有发送 'overlay:command' 的代码（协议未接通）。
      // 这里保留订阅，等 main 侧补齐「快捷键 → 悬浮窗命令」后即可生效；
      // 不依赖它工作，按钮走的是下面的直接 IPC。
      const run = async (promise: Promise<IpcResponse<unknown>>, label: string): Promise<void> => {
        try {
          const response = await promise;
          if (!response.ok) console.warn(`[overlay] 命令 ${label} 未生效：${response.error?.message ?? '未知原因'}`);
        } catch (error) {
          console.warn(`[overlay] 命令 ${label} 失败`, error);
        }
      };
      if (command === 'pause') void run(api.pauseCapture(), 'pause');
      else if (command === 'resume') void run(api.resumeCapture(), 'resume');
      else if (command === 'stop') void run(api.stopCapture(), 'stop');
      else if (command === 'mark') {
        const textarea = memoRef.current;
        const caret = textarea ? textarea.selectionStart : memoTextRef.current.length;
        const note = memoMarkNote(memoTextRef.current, caret);
        void run(api.addMarker(note), 'mark');
      }
    });
    api.overlay?.ready();

    return () => {
      mounted = false;
      window.clearInterval(poll);
      coalescer.flush();
      coalescer.dispose();
      off();
      offCommand?.();
    };
  }, []);

  // Ctrl+Alt+N 展开/收起备忘录（窗口内快捷键；全局 Ctrl+Alt+M 仍是加标记）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        setMemoOpenPersist(!memoOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoOpen]);

  const api = typeof window !== 'undefined' ? window.wcs : undefined;

  // 真实悬浮窗只有 460×132：窗口较窄时切到紧凑布局，避免控制条被裁切。
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : true));
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const markNow = useCallback(async (): Promise<CommandOutcome> => {
    const textarea = memoRef.current;
    const caret = textarea ? textarea.selectionStart : memoTextRef.current.length;
    const note = memoMarkNote(memoTextRef.current, caret);
    if (!api) return { ok: false, message: '接口不可用' };
    return toOutcome(await api.addMarker(note));
  }, [api]);

  return (
    <div
      style={{
        height: '100vh',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        padding: 8,
      }}
    >
      <OverlayBar
        status={status}
        compact
        narrow={narrow}
        onPause={async () => (api ? toOutcome(await api.pauseCapture()) : { ok: false, message: '接口不可用' })}
        onResume={async () => (api ? toOutcome(await api.resumeCapture()) : { ok: false, message: '接口不可用' })}
        onStop={async () => (api ? toOutcome(await api.stopCapture()) : { ok: false, message: '接口不可用' })}
        onMark={markNow}
        memoText={memoText}
        memoOpen={memoOpen}
        onMemoOpenChange={setMemoOpenPersist}
      />

      {/* 备忘录浮层：绝对定位展开，不撑开 460×132 主布局 */}
      {memoOpen && (
        <div
          className="overlay-memo-popover"
          role="region"
          aria-label="录制备忘录"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            top: 8,
            padding: 8,
            borderRadius: 10,
            border: '1px solid #313d4b',
            background: 'linear-gradient(180deg, #1b232d, #141a22)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            zIndex: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-soft)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon name="book" size={12} />
              录制备忘录（Ctrl+Alt+N 收起）
            </span>
            <button
              type="button"
              className="rec-btn"
              aria-label="收起备忘录"
              title="收起备忘录（Ctrl+Alt+N）"
              onClick={() => setMemoOpenPersist(false)}
            >
              <Icon name="close" size={11} />
              收起
            </button>
          </div>
          <textarea
            ref={memoRef}
            className="wcs-textarea"
            aria-label="备忘录内容"
            placeholder="记录要点，每行一条。添加标记（Ctrl+Alt+M）时把当前行作为标记备注。"
            value={memoText}
            onChange={(event) => setMemoTextPersist(event.target.value)}
            style={{ height: 46, fontSize: 11.5, resize: 'none' }}
          />
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            仅保存在本机（localStorage），不随录制上传或分享。
          </span>
        </div>
      )}
    </div>
  );
}
