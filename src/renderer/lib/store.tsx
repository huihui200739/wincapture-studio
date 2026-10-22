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
import { QUALITY_PROFILES } from '@shared/ipc';
import type { Project } from '@domain/project';
import { activeVariant, timelineDuration } from '@domain/project';
import type { ProjectCommand } from '@domain/commands';
import { CommandHistory, describeCommand, makeCommand } from '@domain/commands';
import { TICKS_PER_SECOND, ticksToSeconds } from '@domain/timebase';
import { apiMode, wcs, type ApiMode } from './wcs';
import { describeError, unwrap, type PresentedError } from './format';

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

const DEFAULT_CONFIG: CaptureConfig = {
  sourceId: '',
  sourceKind: 'screen',
  qualityId: '1080p30',
  fps: { num: 30, den: 1 },
  systemAudioEnabled: true,
  microphoneEnabled: true,
  cameraEnabled: true,
  countdownSeconds: 3,
};

function readHashView(): ViewId {
  const hash = typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '') : '';
  const found = VIEWS.find((v) => v.id === hash);
  return found ? found.id : 'home';
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
  openProject: (path?: string) => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  execute: <T extends ProjectCommand = ProjectCommand>(spec: SpecOf<T>, label?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  save: () => Promise<void>;
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
  startRecording: () => Promise<void>;
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
  const tickRef = useRef(0);
  const historyRef = useRef(new CommandHistory());
  const capturePathRef = useRef<string | null>(null);
  const readyHandledRef = useRef<string | null>(null);
  const toastTimers = useRef(new Map<string, number>());

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
    const clamped = Math.max(0, Math.round(next));
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
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      const timer = window.setTimeout(
        () => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
          toastTimers.current.delete(id);
        },
        toast.tone === 'danger' ? 9000 : 5200,
      );
      toastTimers.current.set(id, timer);
    },
    [],
  );

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
      setRecents(unwrap(await wcs().listRecentProjects()));
    } catch (error) {
      pushError(error, '读取最近工程失败');
    }
  }, [pushError]);

  const refreshRecoverables = useCallback(async () => {
    try {
      setRecoverables(unwrap(await wcs().listRecoverable()));
    } catch (error) {
      pushError(error, '读取可恢复会话失败');
    }
  }, [pushError]);

  // ---- 工程 ----
  const openProject = useCallback(
    async (path?: string) => {
      setProjectLoading(true);
      setProjectError(null);
      try {
        const handle = unwrap(await wcs().openProject(path));
        historyRef.current.clear();
        setProjectBoth(handle.project);
        setProjectPath(handle.path);
        setDirty(false);
        setSavedAt(null);
        setSelectedClipId(null);
        setSelectedEffectId(null);
        setSelectedStepId(null);
        setTick(0);
        setPlaying(false);
      } catch (error) {
        const presented = pushError(error, '打开工程失败');
        setProjectError(presented);
      } finally {
        setProjectLoading(false);
      }
    },
    [pushError, setPlaying, setProjectBoth, setTick],
  );

  const createProject = useCallback(
    async (name?: string) => {
      setProjectLoading(true);
      setProjectError(null);
      try {
        const handle = unwrap(await wcs().createProject(name));
        historyRef.current.clear();
        setProjectBoth(handle.project);
        setProjectPath(handle.path);
        setDirty(false);
        setSavedAt(null);
        setTick(0);
        setPlaying(false);
        setView('editor');
        pushToast({ tone: 'ok', title: '已新建工程', message: handle.project.name });
      } catch (error) {
        pushError(error, '新建工程失败');
      } finally {
        setProjectLoading(false);
      }
    },
    [pushError, pushToast, setPlaying, setProjectBoth, setTick, setView],
  );

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
        setSavedAt(null);
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

  const save = useCallback(async () => {
    const current = projectRef.current;
    if (!current) {
      pushToast({ tone: 'warn', title: '没有可保存的工程' });
      return;
    }
    setSaving(true);
    setBusy('save', true);
    try {
      const result = unwrap(await wcs().saveProject(current));
      setDirty(false);
      setSavedAt(result.savedAt);
      pushToast({ tone: 'ok', title: '工程已保存', message: `版本 ${result.revision} · ${new Date(result.savedAt).toLocaleTimeString('zh-CN')}` });
      void refreshRecents();
    } catch (error) {
      pushError(error, '保存工程失败');
    } finally {
      setSaving(false);
      setBusy('save', false);
    }
  }, [pushError, pushToast, refreshRecents, setBusy]);

  /**
   * 自动保存（§15.3）：编辑命令停止变化 2 秒后保存；持续编辑时最长 10 秒保存一次。
   *
   * 为什么要两个计时器：只做 debounce 时，用户连续拖滑杆 3 分钟会一次都不保存，
   * 崩了就全丢；只做 interval 又会每 10 秒写一次盘。两个一起才既省盘又兜底。
   *
   * 只在编辑器里、有工程、且确实有未保存改动时触发。
   */
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveDeadline = useRef<number | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!dirty || !project || !projectPath) return;
    if (view !== 'editor' && view !== 'tutorial') return;
    if (saving) return;

    const IDLE_MS = 2000;
    const MAX_MS = 10_000;
    const now = Date.now();

    // 首次变脏时记录"最晚必须保存"的时刻
    if (autoSaveDeadline.current === null) autoSaveDeadline.current = now + MAX_MS;

    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
    const idleDelay = Math.max(0, IDLE_MS);
    const maxDelay = Math.max(0, autoSaveDeadline.current - now);
    const delay = Math.min(idleDelay, maxDelay);

    autoSaveTimer.current = window.setTimeout(() => {
      autoSaveTimer.current = null;
      autoSaveDeadline.current = null;
      void saveRef.current();
    }, delay);

    return () => {
      if (autoSaveTimer.current !== null) {
        window.clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = null;
      }
    };
  }, [dirty, project, projectPath, saving, view]);

  // 保存成功（dirty 变 false）后清掉"最晚保存"标记
  useEffect(() => {
    if (!dirty) autoSaveDeadline.current = null;
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
      pushToast({
        tone: 'warn',
        title: '已从工程移除源素材',
        message: '引用该素材的时间线片段已一并移除，源文件仍保留在磁盘上。',
      });
    },
    [pushToast, setProjectBoth],
  );

  // ---- 录制 ----
  const updateConfig = useCallback((patch: Partial<CaptureConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const startRecording = useCallback(async () => {
    if (!config.sourceId) {
      pushToast({ tone: 'warn', title: '请先选择录制来源', message: '在「来源」里选择显示器或窗口后再开始。' });
      return;
    }
    setBusy('capture', true);
    try {
      const result = unwrap(await wcs().startCapture(config));
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
    try {
      const result = unwrap(await wcs().stopCapture());
      setCapture(result.status);
      capturePathRef.current = result.projectPath;
      if (result.status.state === 'ReadyToEdit') {
        await openProject(result.projectPath);
        setView('editor');
        pushToast({ tone: 'ok', title: '录制完成，已进入编辑器', message: '素材封装完成，可以开始剪辑与遮挡检查。' });
      }
    } catch (error) {
      pushError(error, '停止录制失败');
    } finally {
      setBusy('capture', false);
    }
  }, [openProject, pushError, pushToast, setBusy, setView]);

  const cancelRecording = useCallback(async () => {
    setBusy('capture', true);
    try {
      await wcs().cancelCapture();
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
        const presented = describeError(status.error);
        pushToast({ tone: 'danger', title: presented.title, message: presented.message, detail: presented.detail });
      }
      if (status.state === 'ReadyToEdit') {
        const key = `${status.sessionId ?? 'session'}:${status.mediaTick}`;
        if (readyHandledRef.current !== key) {
          readyHandledRef.current = key;
          const path = capturePathRef.current;
          if (path) {
            void openProject(path).then(() => setView('editor'));
          }
        }
      }
    });
    return off;
  }, [openProject, pushToast, setView]);

  // ---- 启动引导 ----
  useEffect(() => {
    void refreshRecents();
    void refreshRecoverables();
    void (async () => {
      try {
        setSystemInfo(unwrap(await wcs().systemInfo()));
      } catch (error) {
        pushError(error, '读取系统信息失败');
      }
    })();
    // mock 模式下自动打开示例工程，界面可独立验证
    void (async () => {
      try {
        const handle = unwrap(await wcs().openProject());
        historyRef.current.clear();
        setProjectBoth(handle.project);
        setProjectPath(handle.path);
      } catch (error) {
        pushError(error, '载入示例工程失败');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 播放推进 ----
  const duration = useMemo(() => (project ? timelineDuration(project) : 0), [project]);

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
    setPlaying(!playing);
  }, [playing, setPlaying]);

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
      selectClip: setSelectedClipId,
      selectedEffectId,
      selectEffect: setSelectedEffectId,
      selectedStepId,
      selectStep: setSelectedStepId,
      tick,
      setTick,
      playing,
      setPlaying,
      togglePlay,
      duration,
      config,
      updateConfig,
      capture,
      capturing: !!capture && !['Idle', 'ReadyToEdit', 'Cancelled', 'RecoveryReady'].includes(capture.state),
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
      selectedEffectId,
      selectedStepId,
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
