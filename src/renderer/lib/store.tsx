/**
 * 应用状态（渲染层唯一状态源）
 *
 * 设计要点：
 * - 工程修改一律走 domain 的命令层（applyCommand / CommandHistory），
 *   保证撤销、重做、revision 递增与导出快照一致。
 * - 业务代码只通过 wcs() 访问主进程能力（见 lib/wcs.ts）。
 * - 录制状态由主进程推送（onCaptureStatus），界面只做呈现。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CaptureConfig,
  CaptureStatus,
  ExportProfile,
  RecoverableSession,
  RecentProject,
  SystemInfo,
} from '@shared/ipc';
import type { ProjectHandle } from '@shared/api';
import { QUALITY_PROFILES } from '@shared/ipc';
import type { Project } from '@domain/project';
import { activeVariant, timelineDuration } from '@domain/project';
import type { ProjectCommand } from '@domain/commands';
import { CommandHistory, describeCommand, makeCommand } from '@domain/commands';
import { TICKS_PER_SECOND, ticksToSeconds } from '@domain/timebase';
import { apiMode, wcs, withTimeout, IPC_TIMEOUT, type ApiMode } from './wcs';
import { describeError, isCancelledError, unwrap, unwrapOptional, type PresentedError } from './format';
import {
  autoSaveDeadline as autoSaveDeadlineFor,
  clampTickToDuration,
  isCaptureActive,
  nextAutoSaveDelay,
  AUTO_SAVE_RETRY_MS,
} from './state';
import {
  captureConfigFromDefaults,
  captureDefaultsOf,
  loadSettings,
  mergeCaptureConfig,
  saveSettings,
} from './settings';
import { clearWaveformCache } from './waveform';

export type ViewId = 'home' | 'record' | 'editor' | 'export' | 'tutorial' | 'settings';

/**
 * 命令描述（去掉 id / expectedRevision，由 store 补齐）。
 * 用分配式条件类型，保证每条命令都能只写自己的字段，同时支持显式泛型参数。
 */
export type SpecOf<T> = T extends unknown ? Omit<T, 'id' | 'expectedRevision'> : never;
export type CommandSpec = SpecOf<ProjectCommand>;

export const VIEWS: { id: ViewId; label: string; icon: string; hint: string }[] = [
  { id: 'home', label: '首页', icon: 'home', hint: '最近工程与新建录制' },
  { id: 'record', label: '录制设置', icon: 'record', hint: '来源、声音、画质与磁盘' },
  { id: 'editor', label: '编辑器', icon: 'editor', hint: '预览、时间线与属性' },
  { id: 'export', label: '导出', icon: 'export', hint: '视频与图文教程' },
  { id: 'tutorial', label: '教程', icon: 'book', hint: '步骤草稿与图文编排' },
  { id: 'settings', label: '设置', icon: 'settings', hint: '设备、快捷键与诊断' },
];

export interface ToastItem {
  id: string;
  tone: 'info' | 'ok' | 'warn' | 'danger';
  title: string;
  message?: string;
  detail?: string;
}

const DEFAULT_CONFIG: CaptureConfig = captureConfigFromDefaults(loadSettings().captureDefaults);

function readHashView(): ViewId {
  const hash = typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '') : '';
  const found = VIEWS.find((v) => v.id === hash);
  return found ? found.id : typeof window !== 'undefined' && window.wcs ? 'record' : 'home';
}

interface AppContextValue {
  // 导航
  view: ViewId;
  setView: (view: ViewId) => void;
  apiMode: ApiMode;

  // 工程
  project: Project | null;
  projectPath: string | null;
  projectLoading: boolean;
  projectError: PresentedError | null;
  /** 打开工程；返回是否真的打开了（用户取消对话框时返回 false，不跳转、不报错） */
  openProject: (path?: string) => Promise<boolean>;
  /** 新建工程；返回是否成功 */
  createProject: (name?: string) => Promise<boolean>;
  /** 关闭当前工程（删除当前工程目录后调用），回到未打开状态 */
  closeProject: () => void;
  execute: <T extends ProjectCommand = ProjectCommand>(spec: SpecOf<T>, label?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** 保存工程；返回是否确认写入成功（自动保存失败时也走同一入口） */
  save: (options?: { reason?: 'manual' | 'auto' }) => Promise<boolean>;
  saving: boolean;
  dirty: boolean;
  savedAt: number | null;
  removeSourceAsset: (assetId: string) => void;

  // 选择
  selectedClipId: string | null;
  selectClip: (id: string | null) => void;
  selectedEffectId: string | null;
  selectEffect: (id: string | null) => void;
  selectedStepId: string | null;
  selectStep: (id: string | null) => void;

  // 播放
  tick: number;
  setTick: (tick: number) => void;
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  duration: number;

  // 录制
  config: CaptureConfig;
  updateConfig: (patch: Partial<CaptureConfig>) => void;
  capture: CaptureStatus | null;
  capturing: boolean;
  startRecording: (overrides?: Partial<CaptureConfig>) => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  addMarker: (note?: string) => Promise<void>;
  busy: Record<string, boolean>;
  setBusy: (key: string, value: boolean) => void;

  // 列表 / 系统
  recents: RecentProject[];
  refreshRecents: () => Promise<void>;
  recoverables: RecoverableSession[];
  refreshRecoverables: () => Promise<void>;
  systemInfo: SystemInfo | null;
  refreshSystemInfo: () => Promise<void>;

  // 提示
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  pushError: (error: unknown, title?: string) => PresentedError;
  dismissToast: (id: string) => void;

  quality: (typeof QUALITY_PROFILES)[number];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<ViewId>(readHashView);
  const [project, setProject] = useState<Project | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<PresentedError | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const [redoLabel, setRedoLabel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  /**
   * 三种选择必须互斥。
   *
   * EditorView 的 deleteSelection 按「效果 → 步骤 → 片段」的优先级删除，
   * 而旧实现的三个选择各自独立：在预览上点过一个遮挡框、再去时间线点片段，
   * 按 Delete 删掉的是那个遮挡效果（画面仍高亮片段）。对隐私遮挡来说，
   * 这意味着用户以为在删视频，实际把已确认的遮挡删掉了。
   */
  const selectClip = useCallback((id: string | null) => {
    setSelectedClipId(id);
    if (id !== null) {
      setSelectedEffectId(null);
      setSelectedStepId(null);
    }
  }, []);

  const selectEffect = useCallback((id: string | null) => {
    setSelectedEffectId(id);
    if (id !== null) {
      setSelectedClipId(null);
      setSelectedStepId(null);
    }
  }, []);

  const selectStep = useCallback((id: string | null) => {
    setSelectedStepId(id);
    if (id !== null) {
      setSelectedClipId(null);
      setSelectedEffectId(null);
    }
  }, []);

  const [tick, setTickState] = useState(0);
  const [playing, setPlayingState] = useState(false);

  const [config, setConfig] = useState<CaptureConfig>(DEFAULT_CONFIG);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [busy, setBusyState] = useState<Record<string, boolean>>({});

  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [recoverables, setRecoverables] = useState<RecoverableSession[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const projectRef = useRef<Project | null>(null);
  /** 录制状态的最新值：应用事件订阅里不能依赖闭包里的旧 state */
  const captureStatusRef = useRef<CaptureStatus | null>(null);
  captureStatusRef.current = capture;
  const tickRef = useRef(0);
  const historyRef = useRef(new CommandHistory());
  const capturePathRef = useRef<string | null>(null);
  const readyHandledRef = useRef<string | null>(null);
  const toastTimers = useRef(new Map<string, number>());
  const toastsRef = useRef<ToastItem[]>([]);
  /** 工程打开/新建请求序号：迟到的旧响应直接丢弃，避免「后点先到」覆盖新工程。 */
  const projectRequestSeq = useRef(0);
  /** 正在进行的保存（手动/自动共用），保证同一时刻只有一次写盘。 */
  const savingRef = useRef(false);
  /** 保存期间又发生编辑 → 完成后补一次保存。 */
  const pendingSaveRef = useRef(false);
  /** 自动保存失败后的退避截止时刻（避免每 2 秒弹一次错误）。 */
  const autoSaveRetryAt = useRef<number | null>(null);
  const autoSaveErrorShownAt = useRef(0);
  /** stopRecording 正在自己打开工程，避免状态事件重复打开。 */
  const stopFlowRef = useRef(false);
  /** 同一录制错误只提示一次（状态按 10Hz 推送，不去重会变成提示风暴）。 */
  const lastCaptureErrorRef = useRef<string | null>(null);

  const setProjectBoth = useCallback((next: Project | null) => {
    projectRef.current = next;
    setProject(next);
    const history = historyRef.current;
    setCanUndo(history.canUndo);
    setCanRedo(history.canRedo);
    setUndoLabel(history.undoLabel);
    setRedoLabel(history.redoLabel);
  }, []);

  const setTick = useCallback((next: number) => {
    const current = projectRef.current;
    const total = current ? timelineDuration(current) : 0;
    const clamped = clampTickToDuration(next, total);
    tickRef.current = clamped;
    setTickState(clamped);
  }, []);

  const setPlaying = useCallback((next: boolean) => {
    setPlayingState(next);
  }, []);

  const setBusy = useCallback((key: string, value: boolean) => {
    setBusyState((prev) => {
      if (value) return { ...prev, [key]: true };
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    toastsRef.current = toastsRef.current.filter((t) => t.id !== id);
    setToasts(toastsRef.current);
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item: ToastItem = { ...toast, id };
    // 最多保留 4 条；被挤掉的最旧提示必须同时清掉它的定时器，否则定时器泄漏。
    const next = [...toastsRef.current, item];
    const dropped = next.length > 4 ? next.splice(0, next.length - 4) : [];
    for (const old of dropped) {
      const timer = toastTimers.current.get(old.id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        toastTimers.current.delete(old.id);
      }
    }
    toastsRef.current = next;
    setToasts(next);
    const timer = window.setTimeout(
      () => {
        toastsRef.current = toastsRef.current.filter((t) => t.id !== id);
        setToasts(toastsRef.current);
        toastTimers.current.delete(id);
      },
      toast.tone === 'danger' ? 9000 : 5200,
    );
    toastTimers.current.set(id, timer);
  }, []);

  useEffect(
    () => () => {
      for (const timer of toastTimers.current.values()) window.clearTimeout(timer);
      toastTimers.current.clear();
    },
    [],
  );

  const pushError = useCallback(
    (error: unknown, title?: string) => {
      const presented = describeError(error);
      pushToast({
        tone: 'danger',
        title: title ?? presented.title,
        message: presented.message,
        detail: presented.detail,
      });
      return presented;
    },
    [pushToast],
  );

  // ---- 路由（hash 同步，便于直接打开某个视图） ----
  const setView = useCallback((next: ViewId) => {
    setViewState(next);
    if (typeof location !== 'undefined' && location.hash !== `#/${next}`) {
      location.hash = `#/${next}`;
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setViewState(readHashView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // ---- 列表 / 系统信息 ----
  const refreshRecents = useCallback(async () => {
    try {
      setRecents(unwrap(await withTimeout(wcs().listRecentProjects(), IPC_TIMEOUT.list, '读取最近工程')));
    } catch (error) {
      pushError(error, '读取最近工程失败');
    }
  }, [pushError]);

  const refreshRecoverables = useCallback(async () => {
    try {
      setRecoverables(unwrap(await withTimeout(wcs().listRecoverable(), IPC_TIMEOUT.list, '读取可恢复会话')));
    } catch (error) {
      pushError(error, '读取可恢复会话失败');
    }
  }, [pushError]);

  const refreshSystemInfo = useCallback(async () => {
    try {
      setSystemInfo(unwrap(await withTimeout(wcs().systemInfo(), IPC_TIMEOUT.system, '读取系统信息')));
    } catch (error) {
      pushError(error, '读取系统信息失败');
    }
  }, [pushError]);

  // ---- 工程 ----
  /** 应用一次成功打开/新建的工程：统一重置撤销栈、选择、播放头与保存状态。 */
  const adoptProject = useCallback(
    (handle: ProjectHandle) => {
      historyRef.current.clear();
      // 波形峰值缓存按「素材 id + 字节数」做键，跨工程可能撞到同 id 素材的旧数据，切换时清空
      clearWaveformCache();
      setProjectBoth(handle.project);
      setProjectPath(handle.path);
      setDirty(false);
      setSavedAt(null);
      setSelectedClipId(null);
      setSelectedEffectId(null);
      setSelectedStepId(null);
      setTick(0);
      setPlaying(false);
      void refreshRecents();
    },
    [refreshRecents, setPlaying, setProjectBoth, setTick],
  );

  const openProject = useCallback(
    async (path?: string): Promise<boolean> => {
      const seq = ++projectRequestSeq.current;
      setProjectLoading(true);
      setProjectError(null);
      try {
        // 用户在系统「打开工程」对话框点取消时主进程返回 ok(null)：
        // 这是合法空结果，必须当作“什么都没发生”，不能报错也不能跳编辑器。
        const handle = unwrapOptional(await wcs().openProject(path));
        if (seq !== projectRequestSeq.current) return false;
        if (!handle) return false;
        adoptProject(handle);
        return true;
      } catch (error) {
        // 用户在主进程对话框里取消（E_EXPORT_CANCELLED）是正常结果：不报错、不跳转
        if (isCancelledError(error)) return false;
        if (seq === projectRequestSeq.current) setProjectError(pushError(error, '打开工程失败'));
        return false;
      } finally {
        if (seq === projectRequestSeq.current) setProjectLoading(false);
      }
    },
    [adoptProject, pushError],
  );

  const createProject = useCallback(
    async (name?: string): Promise<boolean> => {
      const seq = ++projectRequestSeq.current;
      setProjectLoading(true);
      setProjectError(null);
      try {
        const handle = unwrap(await wcs().createProject(name));
        if (seq !== projectRequestSeq.current) return false;
        adoptProject(handle);
        setView('editor');
        pushToast({ tone: 'ok', title: '已新建工程', message: handle.project.name });
        return true;
      } catch (error) {
        if (isCancelledError(error)) return false;
        if (seq === projectRequestSeq.current) {
          setProjectError(pushError(error, '新建工程失败'));
        }
        return false;
      } finally {
        if (seq === projectRequestSeq.current) setProjectLoading(false);
      }
    },
    [adoptProject, pushError, pushToast, setView],
  );

  const closeProject = useCallback(() => {
    // 递增序号让在途的打开请求结果失效，避免关闭后被旧响应“重新打开”
    projectRequestSeq.current += 1;
    historyRef.current.clear();
    clearWaveformCache();
    setProjectBoth(null);
    setProjectPath(null);
    setProjectError(null);
    setDirty(false);
    setSavedAt(null);
    setTick(0);
    setPlaying(false);
    setSelectedClipId(null);
    setSelectedEffectId(null);
    setSelectedStepId(null);
    setProjectLoading(false);
  }, [setPlaying, setProjectBoth, setTick]);

  const execute = useCallback(
    (spec: CommandSpec, label?: string) => {
      const current = projectRef.current;
      if (!current) {
        pushToast({ tone: 'warn', title: '还没有打开工程', message: '请先在首页新建或打开一个工程。' });
        return;
      }
      try {
        const command = makeCommand<ProjectCommand>(current, spec as unknown as Omit<ProjectCommand, 'id' | 'expectedRevision'> as never);
        const result = historyRef.current.execute(current, command, label ?? describeCommand(command));
        setProjectBoth(result.project);
        setDirty(true);
      } catch (error) {
        pushError(error);
      }
    },
    [pushError, pushToast, setProjectBoth],
  );

  const undo = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    const next = historyRef.current.undo(current);
    if (!next) {
      pushToast({ tone: 'info', title: '没有可撤销的操作' });
      return;
    }
    setProjectBoth(next);
    setDirty(true);
  }, [pushToast, setProjectBoth]);

  const redo = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    const next = historyRef.current.redo(current);
    if (!next) {
      pushToast({ tone: 'info', title: '没有可重做的操作' });
      return;
    }
    setProjectBoth(next);
    setDirty(true);
  }, [pushToast, setProjectBoth]);

  /**
   * 保存工程（手动与自动共用）。
   *
   * 并发正确性要求：
   * 1. 同一时刻只允许一次写盘（savingRef），否则两次 IPC 的响应顺序不可控，
   *    旧响应会把新状态标成「已保存」；
   * 2. 写盘期间如果用户继续编辑（projectRef 换了对象），响应回来后**不能**清 dirty，
   *    否则这段编辑永远不会被自动保存；
   * 3. 自动保存失败要退避，不能每 2 秒弹一次错误提示。
   *
   * @returns 是否确认完成了一次写盘
   */
  const save = useCallback(
    async (options?: { reason?: 'manual' | 'auto' }): Promise<boolean> => {
      const reason = options?.reason ?? 'manual';
      const current = projectRef.current;
      if (!current) {
        if (reason === 'manual') pushToast({ tone: 'warn', title: '没有可保存的工程' });
        return false;
      }
      if (savingRef.current) {
        // 已有保存在进行：只记「完成后补一次」，绝不并发写盘
        pendingSaveRef.current = true;
        if (reason === 'manual') {
          pushToast({ tone: 'info', title: '正在保存，请稍候', message: '当前保存完成后会自动补存最新修改。' });
        }
        return false;
      }
      savingRef.current = true;
      setSaving(true);
      setBusy('save', true);
      try {
        const result = unwrap(await withTimeout(wcs().saveProject(current), IPC_TIMEOUT.save, '保存工程'));
        setSavedAt(result.savedAt);
        autoSaveRetryAt.current = null;
        if (projectRef.current === current) {
          setDirty(false);
        } else {
          // 保存的快照已过期：保留 dirty 并在 finally 里补存
          pendingSaveRef.current = true;
        }
        if (apiMode() === 'mock') {
          pushToast({
            tone: 'warn',
            title: '示例数据模式：未写入磁盘',
            message: '未连接主进程，工程只保存在内存里；重启后不会保留。',
          });
        } else if (reason === 'manual') {
          pushToast({
            tone: 'ok',
            title: '工程已保存',
            message: `版本 ${result.revision} · ${new Date(result.savedAt).toLocaleTimeString('zh-CN')}`,
          });
        }
        void refreshRecents();
        return true;
      } catch (error) {
        if (reason === 'manual') {
          pushError(error, '保存工程失败');
        } else {
          autoSaveRetryAt.current = Date.now() + AUTO_SAVE_RETRY_MS;
          // 自动保存失败同一分钟内只提示一次，避免提示风暴
          if (Date.now() - autoSaveErrorShownAt.current > 60_000) {
            autoSaveErrorShownAt.current = Date.now();
            pushError(error, '自动保存失败');
          }
        }
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
        setBusy('save', false);
        if (pendingSaveRef.current) {
          pendingSaveRef.current = false;
          void saveRef.current({ reason: 'auto' });
        }
      }
    },
    [pushError, pushToast, refreshRecents, setBusy],
  );

  /**
   * 自动保存（§15.3）：编辑命令停止变化 2 秒后保存；持续编辑时最长 10 秒保存一次。
   *
   * 为什么要两个计时器：只做 debounce 时，用户连续拖滑杆 3 分钟会一次都不保存，
   * 崩了就全丢；只做 interval 又会每 10 秒写一次盘。两个一起才既省盘又兜底。
   *
   * 只在编辑器/教程里、有工程、且确实有未保存改动时触发；
   * 示例数据模式没有落盘语义，直接跳过（否则等于伪造「已保存」）。
   */
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveDeadlineAt = useRef<number | null>(null);
  const saveRef = useRef<(options?: { reason?: 'manual' | 'auto' }) => Promise<boolean>>(async () => false);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (apiMode() === 'mock') return;
    if (!dirty || !project || !projectPath) return;
    if (view !== 'editor' && view !== 'tutorial') return;
    if (saving) return;

    const now = Date.now();
    // 首次变脏时记录「最晚必须保存」的时刻
    if (autoSaveDeadlineAt.current === null) autoSaveDeadlineAt.current = autoSaveDeadlineFor(now);

    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
    const delay = nextAutoSaveDelay({
      now,
      deadline: autoSaveDeadlineAt.current,
      retryAt: autoSaveRetryAt.current,
    });
    autoSaveTimer.current = window.setTimeout(() => {
      autoSaveTimer.current = null;
      autoSaveDeadlineAt.current = null;
      void saveRef.current({ reason: 'auto' });
    }, delay);

    return () => {
      if (autoSaveTimer.current !== null) {
        window.clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, project, projectPath, saving, view]);

  // 保存成功（dirty 变 false）后清掉「最晚保存」标记
  useEffect(() => {
    if (!dirty) autoSaveDeadlineAt.current = null;
  }, [dirty]);

  // 关窗前兜底保存：主进程会先问一次，这里同步等保存完成
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /**
   * 删除源素材（与「删除时间线片段」不同）：
   * 从工程中移除素材记录及其全部时间线片段，源文件本身保留在磁盘。
   * 该操作不可撤销，调用方必须先让用户确认。
   */
  const removeSourceAsset = useCallback(
    (assetId: string) => {
      const current = projectRef.current;
      if (!current) return;
      const next: Project = structuredClone(current);
      next.assets = next.assets.filter((asset) => asset.id !== assetId);
      for (const track of next.tracks) track.clips = track.clips.filter((clip) => clip.assetId !== assetId);
      next.revision = current.revision + 1;
      next.updatedAt = Date.now();
      historyRef.current.clear();
      setProjectBoth(next);
      setDirty(true);
      // 选择态可能指向已被移除的片段/效果/步骤，必须同步清理，否则属性面板会展示幽灵对象
      const clipIds = new Set(next.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
      const effectIds = new Set(next.effects.map((effect) => effect.id));
      const stepIds = new Set(next.steps.map((step) => step.id));
      setSelectedClipId((prev) => (prev && clipIds.has(prev) ? prev : null));
      setSelectedEffectId((prev) => (prev && effectIds.has(prev) ? prev : null));
      setSelectedStepId((prev) => (prev && stepIds.has(prev) ? prev : null));
      setTick(Math.min(tickRef.current, timelineDuration(next)));
      pushToast({
        tone: 'warn',
        title: '已从工程移除源素材',
        message: '引用该素材的时间线片段已一并移除，源文件仍保留在磁盘上。',
      });
    },
    [pushToast, setProjectBoth, setTick],
  );

  // ---- 录制 ----
  const updateConfig = useCallback((patch: Partial<CaptureConfig>) => {
    // 画质档位与 fps 必须联动（settings.mergeCaptureConfig 负责派生一致性）
    setConfig((prev) => mergeCaptureConfig(prev, patch));
  }, []);

  // 采集默认值持久化：只存界面偏好，不存 sourceId/region 等会话临时状态
  useEffect(() => {
    saveSettings({ captureDefaults: captureDefaultsOf(config) });
  }, [config]);

  const startRecording = useCallback(async (overrides?: Partial<CaptureConfig>) => {
    const recordingConfig = { ...config, ...overrides };
    if (!recordingConfig.sourceId) {
      pushToast({ tone: 'warn', title: '请先选择录制来源', message: '在「来源」里选择显示器或窗口后再开始。' });
      return;
    }
    setBusy('capture', true);
    try {
      const result = unwrap(await wcs().startCapture(recordingConfig));
      capturePathRef.current = result.projectPath;
      readyHandledRef.current = null;
      pushToast({ tone: 'ok', title: '录制已开始', message: '倒计时结束后开始采集画面与声音。' });
    } catch (error) {
      pushError(error, '开始录制失败');
    } finally {
      setBusy('capture', false);
    }
  }, [config, pushError, pushToast, setBusy]);

  const pauseRecording = useCallback(async () => {
    setBusy('capture', true);
    try {
      setCapture(unwrap(await wcs().pauseCapture()));
      pushToast({ tone: 'info', title: '录制已暂停', message: '画面与声音都不再写入，计时冻结。' });
    } catch (error) {
      pushError(error, '暂停失败');
    } finally {
      setBusy('capture', false);
    }
  }, [pushError, pushToast, setBusy]);

  const resumeRecording = useCallback(async () => {
    setBusy('capture', true);
    try {
      setCapture(unwrap(await wcs().resumeCapture()));
      pushToast({ tone: 'info', title: '继续录制' });
    } catch (error) {
      pushError(error, '继续录制失败');
    } finally {
      setBusy('capture', false);
    }
  }, [pushError, pushToast, setBusy]);

  const stopRecording = useCallback(async () => {
    setBusy('capture', true);
    // 主进程会先推送 ReadyToEdit 状态、再返回 stopCapture 结果。
    // 置位后状态订阅不再自己打开工程，避免同一次停止触发两次 openProject。
    stopFlowRef.current = true;
    try {
      const result = unwrap(await wcs().stopCapture());
      setCapture(result.status);
      capturePathRef.current = result.projectPath;
      if (result.status.state === 'ReadyToEdit') {
        const opened = await openProject(result.projectPath);
        if (opened) {
          setView('editor');
          pushToast({ tone: 'ok', title: '录制完成，已进入编辑器', message: '素材封装完成，可以开始剪辑与遮挡检查。' });
        }
      }
    } catch (error) {
      pushError(error, '停止录制失败');
    } finally {
      stopFlowRef.current = false;
      setBusy('capture', false);
    }
  }, [openProject, pushError, pushToast, setBusy, setView]);

  const cancelRecording = useCallback(async () => {
    setBusy('capture', true);
    try {
      // 取消是破坏性操作：必须让 {ok:false} 冒泡成错误提示，不能静默当作成功
      unwrap(await withTimeout(wcs().cancelCapture(), IPC_TIMEOUT.recovery, '取消录制'));
      setCapture(null);
      capturePathRef.current = null;
      pushToast({ tone: 'info', title: '已取消录制', message: '未完成的素材已清理。' });
    } catch (error) {
      pushError(error, '取消录制失败');
    } finally {
      setBusy('capture', false);
    }
  }, [pushError, pushToast, setBusy]);

  const addMarker = useCallback(
    async (note = '') => {
      try {
        const marker = unwrap(await wcs().addMarker(note));
        pushToast({
          tone: 'ok',
          title: '已添加标记',
          message: `${(marker.mediaTick / TICKS_PER_SECOND).toFixed(1)} 秒处已记录，之后可生成教程步骤。`,
        });
      } catch (error) {
        pushError(error, '添加标记失败');
      }
    },
    [pushError, pushToast],
  );

  // ---- 录制状态订阅 ----
  useEffect(() => {
    const off = wcs().onCaptureStatus((status) => {
      setCapture(status);
      if (status.error) {
        const key = `${status.error.code}:${status.error.message}`;
        if (lastCaptureErrorRef.current !== key) {
          lastCaptureErrorRef.current = key;
          const presented = describeError(status.error);
          pushToast({ tone: 'danger', title: presented.title, message: presented.message, detail: presented.detail });
        }
      } else {
        lastCaptureErrorRef.current = null;
      }
      if (status.state === 'ReadyToEdit' && !stopFlowRef.current) {
        const key = `${status.sessionId ?? 'session'}:${status.mediaTick}`;
        if (readyHandledRef.current !== key) {
          readyHandledRef.current = key;
          const path = capturePathRef.current;
          if (path) {
            // openProject 自己会处理失败提示；只有成功才跳编辑器
            void openProject(path).then((opened) => {
              if (opened) setView('editor');
            });
          }
        }
      }
    });
    // 防御：某些实现可能不返回取消函数，避免 effect 清理时抛错
    return () => {
      if (typeof off === 'function') off();
    };
  }, [openProject, pushToast, setView]);

  // ---- 主进程应用事件订阅 ----
  //
  // 主进程一直在 sendAppEvent 推送快捷键、磁盘不足、丢段、摄像头降级、录制崩溃等
  // 事件，但渲染层此前没有任何订阅方：Ctrl+Alt+R 开始录制完全没反应，
  // 「编码积压丢段」「磁盘不足自动停止」这类必须让用户知道的事全部静默丢弃。
  useEffect(() => {
    const seen = new Set<string>();
    const notify = (
      key: string,
      toast: Parameters<typeof pushToast>[0],
    ): void => {
      if (seen.has(key)) return;
      seen.add(key);
      pushToast(toast);
    };
    const off = wcs().onAppEvent(({ type, payload }) => {
      switch (type) {
        case 'shortcut': {
          const action = (payload as { action?: string } | null)?.action;
          // 已经在录制时按 Ctrl+Alt+R 不应该再触发一次「开始录制」并弹一条错误
          if (action === 'start-recording' && !isCaptureActive(captureStatusRef.current?.state)) {
            void startRecording();
          }
          break;
        }
        case 'disk-full':
          notify('disk-full', {
            tone: 'danger',
            title: '磁盘空间不足，录制已自动停止',
            message: '已完成的素材已保留，清理磁盘后可继续处理该录制。',
          });
          break;
        case 'segment-dropped':
          notify('segment-dropped', {
            tone: 'warn',
            title: '编码速度跟不上，已跳过部分帧',
            message: '导出时该段画面会短暂冻结。可以先调低画质或关闭摄像头以降低负载。',
          });
          break;
        case 'segment-corrupt':
        case 'segment-error':
          notify(`segment:${type}`, {
            tone: 'warn',
            title: '有一段素材写入失败',
            message: '该段已跳过，成片对应位置可能出现冻结或静音。',
          });
          break;
        case 'camera-degraded':
          notify('camera-degraded', {
            tone: 'warn',
            title: '摄像头不可用，已跳过摄像头轨',
            message: String((payload as { reason?: string } | null)?.reason ?? '设备可能被其它程序占用。'),
          });
          break;
        case 'recorder-crashed':
          notify('recorder-crashed', {
            tone: 'danger',
            title: '编码进程异常退出，已自动重启',
            message: '如果这种情况反复出现，建议停止录制并改用较低画质。',
          });
          break;
        case 'shortcut-conflict':
          notify('shortcut-conflict', {
            tone: 'warn',
            title: '快捷键被占用',
            message: `系统里已有其它程序注册了 ${String((payload as { accelerator?: string } | null)?.accelerator ?? '该组合键')}，相关快捷键可能无效。`,
          });
          break;
        case 'main-error':
          notify('main-error', {
            tone: 'danger',
            title: '后台任务出现异常',
            message: String((payload as { message?: string } | null)?.message ?? '已记录到诊断日志。'),
          });
          break;
        case 'media-missing':
          notify('media-missing', {
            tone: 'warn',
            title: '有素材文件缺失',
            message: '相关轨道会按静音/占位处理，导出前请检查。',
          });
          break;
        case 'journal-error':
          notify('journal-error', {
            tone: 'warn',
            title: '恢复日志写入失败',
            message: '录制仍在继续，但崩溃后可能无法完整恢复已录分段。',
          });
          break;
        case 'capture-ended':
          // 引擎自行结束（崩溃/磁盘满）时刷新一次真实状态，避免界面停在「录制中」
          void wcs()
            .captureStatus()
            .then((response) => setCapture(unwrap(response)))
            .catch(() => undefined);
          break;
        default:
          break;
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [pushToast, startRecording]);

  // ---- 启动引导 ----
  useEffect(() => {
    void refreshRecents();
    void refreshRecoverables();
    void refreshSystemInfo();
    // 恢复持久化的窗口置顶。旧实现只在用户打开设置页时才恢复，
    // 于是「重启后保留」的承诺实际不成立（不进设置页就一直不置顶）。
    if (loadSettings().alwaysOnTop) {
      void wcs()
        .setAlwaysOnTop(true)
        .then((response) => {
          if (!response.ok) console.warn('[store] 恢复窗口置顶被拒绝', response.error?.message);
        })
        .catch((error: unknown) => {
          console.warn('[store] 恢复窗口置顶失败', error);
        });
    }
    // 渲染进程重载（例如录制中刷新）后恢复录制状态，避免界面误显示「空闲」
    void (async () => {
      try {
        const status = unwrap(await withTimeout(wcs().captureStatus(), IPC_TIMEOUT.list, '读取录制状态'));
        setCapture(status);
      } catch (error) {
        // 状态探测失败不阻塞启动：只记录，不弹错（真正的操作失败会在按钮流程里提示）
        console.warn('[store] 读取录制状态失败', describeError(error).detail ?? error);
      }
    })();
    // 只有示例数据模式才自动打开示例工程。
    // 真实模式下 openProject() 会弹出系统「打开工程」对话框 —— 启动时不能替用户点开。
    if (apiMode() === 'mock') void openProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 播放推进 ----
  const duration = useMemo(() => (project ? timelineDuration(project) : 0), [project]);

  // 工程时长变短（删片段/撤销）时把播放头夹回合法区间
  useEffect(() => {
    setTick(tickRef.current);
  }, [duration, setTick]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const total = projectRef.current ? timelineDuration(projectRef.current) : 0;
      const next = tickRef.current + dt * TICKS_PER_SECOND;
      if (total > 0 && next >= total) {
        setTick(total);
        setPlaying(false);
        return;
      }
      setTick(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, setPlaying, setTick]);

  const togglePlay = useCallback(() => {
    if (!projectRef.current) return;
    if (!playing) {
      const total = timelineDuration(projectRef.current);
      // 播放头停在结尾时按播放应从开头重新播放，而不是卡住
      if (total > 0 && tickRef.current >= total) setTick(0);
    }
    setPlaying(!playing);
  }, [playing, setPlaying, setTick]);

  const quality = useMemo(
    () => QUALITY_PROFILES.find((q) => q.id === config.qualityId) ?? QUALITY_PROFILES[1],
    [config.qualityId],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      view,
      setView,
      apiMode: apiMode(),
      project,
      projectPath,
      projectLoading,
      projectError,
      openProject,
      createProject,
      closeProject,
      execute,
      undo,
      redo,
      canUndo,
      canRedo,
      undoLabel,
      redoLabel,
      save,
      saving,
      dirty,
      savedAt,
      removeSourceAsset,
      selectedClipId,
      selectClip,
      selectedEffectId,
      selectEffect,
      selectedStepId,
      selectStep,
      tick,
      setTick,
      playing,
      setPlaying,
      togglePlay,
      duration,
      config,
      updateConfig,
      capture,
      capturing: isCaptureActive(capture?.state),
      startRecording,
      pauseRecording,
      resumeRecording,
      stopRecording,
      cancelRecording,
      addMarker,
      busy,
      setBusy,
      recents,
      refreshRecents,
      recoverables,
      refreshRecoverables,
      systemInfo,
      refreshSystemInfo,
      toasts,
      pushToast,
      pushError,
      dismissToast,
      quality,
    }),
    [
      view,
      setView,
      project,
      projectPath,
      projectLoading,
      projectError,
      openProject,
      createProject,
      closeProject,
      execute,
      undo,
      redo,
      canUndo,
      canRedo,
      undoLabel,
      redoLabel,
      save,
      saving,
      dirty,
      savedAt,
      removeSourceAsset,
      selectedClipId,
      selectClip,
      selectedEffectId,
      selectEffect,
      selectedStepId,
      selectStep,
      tick,
      setTick,
      playing,
      setPlaying,
      togglePlay,
      duration,
      config,
      updateConfig,
      capture,
      startRecording,
      pauseRecording,
      resumeRecording,
      stopRecording,
      cancelRecording,
      addMarker,
      busy,
      setBusy,
      recents,
      refreshRecents,
      recoverables,
      refreshRecoverables,
      systemInfo,
      refreshSystemInfo,
      toasts,
      pushToast,
      pushError,
      dismissToast,
      quality,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

/** 便捷：当前画幅与输出时长（编辑器与导出共用）。 */
export function useProjectFacts(project: Project | null) {
  return useMemo(() => {
    if (!project) return { variant: null, duration: 0 };
    return { variant: activeVariant(project), duration: timelineDuration(project) };
  }, [project]);
}

/** 秒 → tick（界面层常用）。 */
export function secToTick(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export { ticksToSeconds };

/** 供导出面板构造 profile。 */
export function makeExportProfile(project: Project, options: { includeTutorial: boolean; variantId?: string }): ExportProfile {
  const variant = options.variantId ? project.variants.find((v) => v.id === options.variantId) ?? activeVariant(project) : activeVariant(project);
  const [w, h] = variant.aspect;
  const longEdge = 1920;
  const width = w >= h ? longEdge : Math.round((longEdge * w) / h);
  const height = w >= h ? Math.round((longEdge * h) / w) : longEdge;
  return {
    variantId: variant.id,
    width: width % 2 === 0 ? width : width + 1,
    height: height % 2 === 0 ? height : height + 1,
    fps: { ...project.settings.fps },
    videoBitrate: 12_000_000,
    audioBitrate: 192_000,
    audioOnly: false,
    includeTutorial: options.includeTutorial,
  };
}
