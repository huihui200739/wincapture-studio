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
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CaptureStatus, CaptureState } from '@shared/ipc';
import { formatBytes, formatClock } from '../lib/format';
import { Icon, Kbd } from '../components/ui';
import { cn } from '../lib/format';

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

/**
 * 取备忘录中作为标记 note 的内容：优先「当前光标所在行」，
 * 该行为空时回退为最后一行非空内容，均为空则返回空串。
 */
function memoMarkNote(text: string, caretIndex: number): string {
  const around = text.slice(0, caretIndex);
  const lineStart = around.lastIndexOf('\n');
  const currentLine = around.slice(lineStart + 1).trim();
  if (currentLine) return currentLine;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/** 窄窗口下的按钮内联样式（styles.css 不在本任务写入范围内，故用内联）。 */
function narrowBtnStyle(narrow: boolean | undefined): CSSProperties | undefined {
  return narrow ? { height: 27, padding: '0 8px', fontSize: 11, gap: 4 } : undefined;
}

export interface OverlayBarProps {
  status: CaptureStatus | null;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onMark?: () => void;
  onOpenEditor?: () => void;
  compact?: boolean;
  /**
   * 窄窗口（真实悬浮窗 460×132）：隐藏电平与写入统计等次要信息，
   * 保证控制条不会被裁切；备忘录浮层另外用绝对定位。
   */
  narrow?: boolean;
  /** 备忘录当前文本（R12，只存本机）。 */
  memoText?: string;
  onMemoTextChange?: (text: string) => void;
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
  onMemoTextChange,
  memoOpen = false,
  onMemoOpenChange,
}: OverlayBarProps) {
  const state = status?.state ?? null;
  const visual = visualFor(state);
  const paused = state === 'Paused' || state === 'Pausing';
  const canPause = state === 'Recording';
  const canResume = state === 'Paused';
  const canStop = !!state && !['Idle', 'ReadyToEdit', 'Cancelled', 'RecoveryReady'].includes(state);
  const levels = status?.levels ?? { mic: 0, system: 0 };
  const memoLines = memoText.split('\n').filter((line) => line.trim()).length;

  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const pulse = (text: string) => {
    setFlash(text);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  };

  return (
    <div
      className={cn('rec-bar', narrow && 'is-narrow')}
      role="toolbar"
      aria-label="录制控制条"
      style={
        narrow
          ? { minWidth: 0, width: '100%', gap: 7, padding: '6px 8px' }
          : undefined
      }
    >
      <div
        className={cn('rec-state', visual.className)}
        role="status"
        aria-live="polite"
        style={narrow ? { minWidth: 0, padding: '3px 7px 3px 6px' } : undefined}
      >
        <span className="rec-state-dot" aria-hidden="true" />
        <Icon name={visual.icon} size={13} />
        <span className="rec-state-text">{flash ?? visual.label}</span>
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
          disabled={!canPause && !canResume}
          aria-label={canResume ? '继续录制' : '暂停录制'}
          title={canResume ? '继续录制（Ctrl+Alt+P）' : '暂停录制（Ctrl+Alt+P）'}
          style={narrowBtnStyle(narrow)}
          onClick={() => {
            if (canResume) {
              pulse('继续中');
              onResume?.();
            } else {
              pulse('暂停中');
              onPause?.();
            }
          }}
        >
          <Icon name={canResume ? 'play' : 'pause'} size={12} />
          {canResume ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          className="rec-btn"
          aria-label="添加标记"
          title="添加标记（Ctrl+Alt+M），之后可生成教程步骤"
          style={narrowBtnStyle(narrow)}
          onClick={() => {
            pulse('已标记');
            onMark?.();
          }}
        >
          <Icon name="flag" size={12} />
          标记
        </button>
        <button
          type="button"
          className="rec-btn"
          aria-label={memoOpen ? '收起备忘录' : '展开备忘录'}
          aria-expanded={memoOpen}
          title={
            memoOpen
              ? '收起备忘录'
              : `展开备忘录${memoLines > 0 ? `（已记录 ${memoLines} 条）` : ''}`
          }
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
          disabled={!canStop}
          aria-label="停止录制"
          title="停止录制（Ctrl+Alt+R）"
          style={narrowBtnStyle(narrow)}
          onClick={() => {
            pulse('停止中');
            onStop?.();
          }}
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
    void api.captureStatus().then((response) => {
      if (mounted && response.ok && response.data) setStatus(response.data);
    });
    const off = api.onCaptureStatus((next) => setStatus(next));
    const offCommand = api.overlay?.onCommand((command) => {
      if (command === 'pause') void api.pauseCapture();
      else if (command === 'resume') void api.resumeCapture();
      else if (command === 'stop') void api.stopCapture();
      // Ctrl+Alt+M 添加标记：备忘录有内容时把当前行作为标记 note
      else if (command === 'mark') {
        const textarea = memoRef.current;
        const caret = textarea ? textarea.selectionStart : memoTextRef.current.length;
        const note = memoMarkNote(memoTextRef.current, caret);
        void api.addMarker(note);
      }
    });
    api.overlay?.ready();
    return () => {
      mounted = false;
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

  const markNow = () => {
    const textarea = memoRef.current;
    const caret = textarea ? textarea.selectionStart : memoText.length;
    const note = memoMarkNote(memoText, caret);
    void api?.addMarker(note);
  };

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
        onPause={() => void api?.pauseCapture()}
        onResume={() => void api?.resumeCapture()}
        onStop={() => void api?.stopCapture()}
        onMark={markNow}
        memoText={memoText}
        onMemoTextChange={setMemoTextPersist}
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
