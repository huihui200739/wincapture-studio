/**
 * 录制 / 导出 / 悬浮窗的纯逻辑（无 React、无 DOM、无 window 依赖）。
 *
 * 抽出来的原因：这三块界面最容易出错的地方都是「事件与状态的归约」——
 * 高频状态推送的合并节流、导出结果的归类、输出路径的归一化、来源切换时的选择收敛。
 * 它们放在 .tsx 里无法测试，也没有明确契约，故集中到这里，由 tests/renderer/uiSync.test.ts 覆盖。
 *
 * 约束：本文件不得引入 React / browser API，保证 node 环境下可直接单元测试。
 */

// ---------------------------------------------------------------------------
// 1) 悬浮窗状态合并节流（§14.3：高频事件最多每秒 10 次）
// ---------------------------------------------------------------------------

export interface StatusCoalescerOptions<T> {
  /** 两次真正 emit 的最小间隔（毫秒），默认 100ms ≈ 10 次/秒 */
  intervalMs?: number;
  /** 时钟，测试可注入 */
  now?: () => number;
  /** 真正应用状态的地方 */
  emit: (value: T) => void;
  /** 定时器注入，测试可注入假调度器 */
  schedule?: (fn: () => void, delayMs: number) => number;
  cancel?: (handle: number) => void;
}

export interface StatusCoalescer<T> {
  /** 收到一次状态推送：立即应用或合并到本窗口末尾 */
  push: (value: T) => void;
  /** 立即应用最后一次待处理值（没有待处理值则什么都不做） */
  flush: () => void;
  /** 取最后一次待处理值（未应用），没有则为 null */
  pending: () => T | null;
  /** 卸载：丢弃待处理值并取消定时器 */
  dispose: () => void;
  /** 是否已 dispose */
  disposed: () => boolean;
}

/**
 * 状态合并器：最多每 intervalMs 应用一次，窗口内多次 push 只保留最后一次。
 *
 * 为什么需要：主进程的状态推送并不保证正好 ≤10 次/秒——
 * 暂停/恢复/标记会用 force 立即推送，帧到达与电平又各自节流，
 * 叠加起来可能瞬间超过 10 次/秒；悬浮窗是常驻窗口，直接 setState 会造成
 * 长时间录制时的重复渲染与掉帧。合并后仍保留「最后一次」，
 * 不会因为节流把最终状态丢掉（这是单纯的 throttle 做不到的）。
 */
export function createStatusCoalescer<T>(options: StatusCoalescerOptions<T>): StatusCoalescer<T> {
  const intervalMs = options.intervalMs !== undefined && options.intervalMs >= 0 ? options.intervalMs : 100;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs) as unknown as number);
  const cancel = options.cancel ?? ((handle: number) => clearTimeout(handle));

  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let timer: number | null = null;
  let pendingValue: T | null = null;
  let isDisposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const flush = (): void => {
    clearTimer();
    if (isDisposed || pendingValue === null) return;
    const value = pendingValue;
    pendingValue = null;
    lastEmitAt = now();
    options.emit(value);
  };

  const push = (value: T): void => {
    if (isDisposed) return;
    // 只保留最后一次：节流不会让最终状态丢失
    pendingValue = value;
    const elapsed = now() - lastEmitAt;
    if (elapsed >= intervalMs) {
      flush();
      return;
    }
    if (timer === null) {
      timer = schedule(flush, Math.max(0, intervalMs - elapsed));
    }
  };

  return {
    push,
    flush,
    pending: () => pendingValue,
    dispose: () => {
      isDisposed = true;
      pendingValue = null;
      clearTimer();
    },
    disposed: () => isDisposed,
  };
}

// ---------------------------------------------------------------------------
// 2) 导出结果归类
// ---------------------------------------------------------------------------

export interface ExportErrorShape {
  code?: string;
  message?: string;
  retryable?: boolean;
  preservedData?: boolean;
}

export interface ExportVideoLike {
  ok: boolean;
  outputPath?: string | null;
  verified?: boolean;
  error?: ExportErrorShape | null;
  /** 导出过程中的非致命降级（素材缺失、解码失败等） */
  warnings?: string[];
}

export interface ExportTutorialLike {
  ok: boolean;
  error?: string;
}

/** 隐藏导出窗口（exporterRuntime）返回的载荷。 */
export interface ExportBundleLike {
  video: ExportVideoLike | null;
  tutorial: ExportTutorialLike | null;
  snapshotHash?: string;
  /** 隐藏窗口捕获到的异常信息（即使 IPC 外层 ok，也可能有业务失败） */
  error?: string | null;
  /** 是否因取消而结束 */
  cancelled?: boolean;
}

export type ExportOutcome =
  | { kind: 'done'; warnings: string[] }
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string; code: string; preservedData: boolean; retryable: boolean };

/** 取消类错误码：隐藏窗口在取消时回报的 code。 */
const CANCEL_CODES = new Set(['E_EXPORT_CANCELLED']);

/**
 * 把「导出窗口的返回载荷」归类为界面需要的三种结果。
 *
 * 关键点：导出窗口用 executeJavaScript 被主进程调用，异常会被它自己捕获并
 * **以正常返回值带回**（而不是让 Promise reject），因此 IPC 外层 `ok:true`
 * 不代表导出成功。UI 必须检查 video.ok / tutorial.ok / error / cancelled，
 * 否则取消与编码失败都会被误显示成「导出完成」。
 */
export function classifyExportBundle(bundle: ExportBundleLike | null | undefined): ExportOutcome {
  if (!bundle) {
    return {
      kind: 'failed',
      message: '导出进程没有返回结果，请重试。',
      code: 'E_UNKNOWN',
      preservedData: true,
      retryable: true,
    };
  }

  const topError = typeof bundle.error === 'string' ? bundle.error.trim() : '';
  const videoError = bundle.video?.error ?? null;
  const errorCode = videoError?.code ?? '';
  if (bundle.cancelled || CANCEL_CODES.has(errorCode) || /取消/.test(topError)) {
    return { kind: 'cancelled', message: topError || videoError?.message || '导出已取消。' };
  }

  if (bundle.video && bundle.video.ok === false) {
    return {
      kind: 'failed',
      message: videoError?.message?.trim() || topError || '导出失败，请重试或查看诊断日志。',
      code: errorCode || 'E_EXPORT_FAILED',
      preservedData: videoError?.preservedData ?? true,
      retryable: videoError?.retryable ?? true,
    };
  }

  const hasVideo = !!bundle.video?.ok;
  const hasTutorial = !!bundle.tutorial?.ok;
  if (!hasVideo && !hasTutorial) {
    return {
      kind: 'failed',
      message: topError || '导出没有产出任何产物，请重试或查看诊断日志。',
      code: 'E_EXPORT_FAILED',
      preservedData: true,
      retryable: true,
    };
  }

  const warnings: string[] = [];
  // 导出管线自己报告的降级（缺素材、音频解码失败、临时文件残留……）优先展示，
  // 这是用户判断「这份成片能不能直接用」的唯一线索。
  if (bundle.video?.warnings?.length) {
    for (const item of bundle.video.warnings) {
      const text = typeof item === 'string' ? item.trim() : '';
      if (text && !warnings.includes(text)) warnings.push(text);
    }
  }
  if (bundle.video?.ok && bundle.video.verified === false) {
    warnings.push('视频完整性校验未通过，请播放确认后再使用。');
  }
  if (bundle.tutorial && bundle.tutorial.ok === false) {
    warnings.push(`教程包生成失败：${bundle.tutorial.error ?? '未知原因'}`);
  }
  if (topError) warnings.push(topError);
  return { kind: 'done', warnings };
}

// ---------------------------------------------------------------------------
// 3) 导出输出路径
// ---------------------------------------------------------------------------

/** Windows 文件名非法字符（也覆盖 / ，防止拼出子目录）。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 把工程名收敛为安全的文件名主干，空名回退为默认名。 */
export function sanitizeFileStem(name: string | null | undefined, fallback = 'WinCapture 录制'): string {
  const cleaned = (name ?? '').replace(ILLEGAL_FILENAME, '-').replace(/\s+/g, ' ').trim();
  const trimmed = cleaned.replace(/[.\s]+$/, '').slice(0, 120);
  return trimmed || fallback;
}

/**
 * 推导默认输出路径：`<视频目录>\<工程名>.mp4`。
 * `videosPath` 为空（系统信息还没加载）时返回空串，让界面显示占位而不是猜一个假路径。
 */
export function deriveDefaultOutputPath(
  videosPath: string | null | undefined,
  projectName: string | null | undefined,
  separator = '\\',
): string {
  const base = (videosPath ?? '').trim().replace(/[\\/]+$/, '');
  if (!base) return '';
  return `${base}${separator}${sanitizeFileStem(projectName)}.mp4`;
}

/** 路径是否以目录分隔符结尾（说明用户填的是目录而不是文件）。 */
export function looksLikeDirectoryPath(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.endsWith('\\') || trimmed.endsWith('/');
}

/**
 * 归一化用户输入路径：去空白；没有扩展名时补 `.mp4`；已有扩展名保持不变。
 * 只是归一化，不做授权/存在性检查（那属于主进程）。
 */
export function normalizeOutputPath(raw: string, extension: 'mp4' | 'm4a' = 'mp4'): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (looksLikeDirectoryPath(trimmed)) {
    return `${trimmed}${sanitizeFileStem('')}.${extension}`;
  }
  const lastSeparator = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  const fileName = trimmed.slice(lastSeparator + 1);
  if (fileName.includes('.')) return trimmed;
  return `${trimmed}.${extension}`;
}

export interface OutputPathValidation {
  ok: boolean;
  /** 归一化后的路径（ok 时可用） */
  normalized: string;
  reason?: string;
}

/**
 * 校验导出路径。这里只做「能立刻判断」的检查：
 * 非空、不像目录、扩展名是 .mp4、文件名不是保留名。
 * 目录是否存在/可写由主进程的 checkPath 决定，不在前端假装校验。
 */
export function validateOutputPath(raw: string, extension: 'mp4' | 'm4a' = 'mp4'): OutputPathValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, normalized: '', reason: '请先选择输出路径。' };
  }
  if (looksLikeDirectoryPath(trimmed)) {
    return { ok: false, normalized: trimmed, reason: `这是一个目录，请选择以 .${extension} 结尾的文件路径。` };
  }
  const normalized = normalizeOutputPath(trimmed, extension);
  if (!normalized.toLowerCase().endsWith(`.${extension}`)) {
    return { ok: false, normalized, reason: `输出文件需要以 .${extension} 结尾。` };
  }
  const fileName = normalized.slice(Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/')) + 1);
  if (!fileName || /^\.+$/.test(fileName)) {
    return { ok: false, normalized, reason: '文件名不能为空。' };
  }
  return { ok: true, normalized };
}

// ---------------------------------------------------------------------------
// 4) 录制备忘录 → 标记备注
// ---------------------------------------------------------------------------

/**
 * 取备忘录中作为标记 note 的内容：优先「光标所在行」，该行为空时回退为最后一行非空内容。
 * （R12：Ctrl+Alt+M 添加标记时把当前行作为备注。）
 *
 * 注意取的是**整行**而不是「光标之前的半行」：旧实现用 `slice(0, caret)` 再 trim，
 * 光标停在行中间时会把备注截成半句（实测「第二行内容」变成「第二」）。
 */
export function memoMarkNote(text: string, caretIndex: number): string {
  const safeText = typeof text === 'string' ? text : '';
  const caret = Number.isFinite(caretIndex)
    ? Math.max(0, Math.min(safeText.length, Math.floor(caretIndex)))
    : safeText.length;
  const lineStart = safeText.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const lineEndRaw = safeText.indexOf('\n', caret);
  const lineEnd = lineEndRaw === -1 ? safeText.length : lineEndRaw;
  const currentLine = safeText.slice(lineStart, lineEnd).trim();
  if (currentLine) return currentLine;
  const lines = safeText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

// ---------------------------------------------------------------------------
// 5) 录制来源切换收敛
// ---------------------------------------------------------------------------

export interface SourceOptionLike {
  id: string;
  kind: 'screen' | 'window';
  available: boolean;
}

export interface SourceSelection {
  sourceId: string;
  sourceKind: 'screen' | 'window';
}

/**
 * 切换「显示器 / 窗口」分栏时决定选中项。
 *
 * 修复的问题：以前 Segmented 只改本地 sourceKind，config.sourceId 仍指向上一个
 * 分栏的来源；此时按「开始录制」会静默录到一个用户看不见的对象
 * （界面显示「窗口」分栏，实际录的是显示器）。
 * 规则：当前选中项仍属于新分栏且可用 → 保持；否则选该分栏第一个可用来源；
 * 都没有则清空 sourceId（让「开始录制」被禁用，而不是拿旧来源开录）。
 */
export function pickSourceForKind(
  sources: readonly SourceOptionLike[],
  kind: 'screen' | 'window',
  currentSourceId: string | null | undefined,
): SourceSelection {
  const inKind = sources.filter((source) => source.kind === kind);
  const current = inKind.find((source) => source.id === currentSourceId);
  const usable = current?.available
    ? current
    : inKind.find((source) => source.available) ?? inKind[0];
  return { sourceId: usable?.id ?? '', sourceKind: kind };
}

/**
 * 判断「选中的来源」与当前分栏是否一致；不一致时界面必须提示，不能拿它开录。
 */
export function isSourceInKind(
  sources: readonly SourceOptionLike[],
  kind: 'screen' | 'window',
  sourceId: string | null | undefined,
): boolean {
  if (!sourceId) return false;
  const found = sources.find((source) => source.id === sourceId);
  return !!found && found.kind === kind;
}

// ---------------------------------------------------------------------------
// 6) 录制分段选帧
// ---------------------------------------------------------------------------

/**
 * 把采集到的帧序列重采样为「严格段长 × fps」的帧数。
 *
 * 规则（见 recorderRuntime 的注释）：
 * - 源帧多于目标帧 → 均匀抽稀（避免时间轴被拉长）；
 * - 少于目标帧 → 重复末帧补齐（画面停住，而不是时间轴变短）。
 *
 * 返回的是「源帧下标」数组，长度恒为 targetFrames。
 */
export function planFramePicks(sourceCount: number, targetFrames: number): number[] {
  const target = Math.max(1, Math.floor(targetFrames));
  const source = Math.max(1, Math.floor(sourceCount));
  const picks: number[] = [];
  if (source >= target) {
    for (let i = 0; i < target; i++) {
      picks.push(Math.min(source - 1, Math.floor((i * source) / target)));
    }
    return picks;
  }
  for (let i = 0; i < source; i++) picks.push(i);
  while (picks.length < target) picks.push(source - 1);
  return picks;
}

/** 录制帧的最小时间戳字段（mediaTick = 会话媒体时间）。 */
export interface StampedFrame {
  mediaTick: number;
}

/**
 * 按帧的真实时间戳把采集帧落到段内目标槽位。
 *
 * 为什么不能均匀抽样（planFramePicks）：采集端掉帧时，N 个真实分布在 2 秒内的帧
 * 会被均匀压进 N/30 秒、末尾再用末帧填满——段内画面整体"快放"然后卡住，
 * 而音频按真实时长生成，于是一段里就产生最多一个段长的音画错位，且逐段累积。
 *
 * 这里改为：每帧按 (mediaTick - 段起点) / 帧步长 落到最近槽位，空槽沿用上一帧
 * （首段空洞用第一帧）。掉帧只表现为该时刻画面静止，时间轴不会被压缩。
 *
 * 时间戳不可用（缺失、非有限、全相同）时退回均匀抽样，保证不会把所有槽位都指向第 0 帧。
 *
 * @returns 长度恒为 targetFrames 的「源帧下标」数组（空输入返回空数组）
 */
export function planFrameSlots(
  frames: readonly StampedFrame[],
  segmentStartTick: number,
  targetFrames: number,
  frameStepTicks: number,
): number[] {
  const target = Math.max(1, Math.floor(targetFrames));
  if (frames.length === 0) return [];
  const step = Math.max(1, Math.round(frameStepTicks));
  const start = Number.isFinite(segmentStartTick) ? segmentStartTick : frames[0].mediaTick;
  const first = frames[0].mediaTick;
  const last = frames[frames.length - 1].mediaTick;
  const usable =
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    frames.every((frame) => Number.isFinite(frame.mediaTick)) &&
    last - first > step / 2;
  if (!usable) return planFramePicks(frames.length, target);

  const slots = new Array<number>(target).fill(-1);
  let lastSlot = 0;
  for (let i = 0; i < frames.length; i++) {
    const raw = Math.round((frames[i].mediaTick - start) / step);
    // 槽位单调不减：时间戳抖动/乱序时也不能把后面的帧塞到前面去
    const slot = Math.min(target - 1, Math.max(lastSlot, Math.max(0, raw)));
    lastSlot = slot;
    // 同一槽位多帧：保留更晚的一帧（画面更新）
    slots[slot] = i;
  }

  // 空洞沿用上一帧
  let prev = -1;
  for (let s = 0; s < target; s++) {
    if (slots[s] >= 0) prev = slots[s];
    else if (prev >= 0) slots[s] = prev;
  }
  // 首段空洞（第一帧晚于段起点）用第一帧补齐
  const firstFilled = slots.find((value) => value >= 0);
  if (firstFilled === undefined) return planFramePicks(frames.length, target);
  for (let s = 0; s < target && slots[s] < 0; s++) slots[s] = firstFilled;
  return slots;
}
