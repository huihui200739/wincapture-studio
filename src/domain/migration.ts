/**
 * 工程版本迁移（开发文档 §13.4 / §13.2）
 *
 * 规则：
 * - 旧版本先备份再迁移（备份内容由调用方落盘，本模块只产出备份快照与建议文件名）；
 * - 遇到更高版本**拒绝覆盖写入**，抛 E_SCHEMA_FUTURE，并给出只读提示（§13.4）；
 * - 迁移是纯函数：输入旧清单，输出新清单 + 迁移记录，不做文件 IO。
 *
 * 迁移链：1 → 当前版本。每步只做「结构补全」与「类型修正」，不猜测用户意图。
 */

import type { Project, MediaAsset, CanvasVariant, Track, Clip, Effect, TutorialStep } from './project';
import { PROJECT_SCHEMA_VERSION, createEmptyProject, DEFAULT_CANVAS, DEFAULT_VARIANTS } from './project';
import type { Ticks } from './timebase';
import { TICKS_PER_SECOND, makeFrameRate, normalizeTicks } from './timebase';
import { AppError } from '../shared/errors';

export interface MigrationStep {
  from: number;
  to: number;
  /** 迁移说明，写入日志与「工程已升级」提示 */
  description: string;
  /** 迁移中做过的自动修正，供用户复核 */
  fixes: string[];
}

export interface MigrationResult {
  project: Project;
  /** 是否发生了迁移 */
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  steps: MigrationStep[];
  /** 迁移前备份快照（调用方负责写盘）；未迁移时为 null */
  backup: Project | null;
  /** 迁移前的建议备份文件名 */
  backupFileName: string | null;
  /** 只读提示：未来版本时为非 null */
  readOnlyNotice: string | null;
}

export interface MigrationOptions {
  /** 允许把未来版本读成只读（默认 true：读取允许，写入拒绝） */
  allowReadOnlyFuture?: boolean;
  /** 当前支持的目标版本，默认 PROJECT_SCHEMA_VERSION */
  targetVersion?: number;
}

export class SchemaFutureError extends AppError {
  constructor(readonly foundVersion: number, readonly supportedVersion: number) {
    super({
      code: 'E_SCHEMA_FUTURE',
      message: `工程由更高版本（v${foundVersion}）创建，当前版本最高支持 v${supportedVersion}。为避免损坏数据，已拒绝覆盖写入；你可以只读查看或升级应用后再编辑。`,
      retryable: false,
      preservedData: true,
      detail: `schemaVersion=${foundVersion} > supported=${supportedVersion}`,
    });
    this.name = 'SchemaFutureError';
  }
}

/** 未来版本的只读提示文案（界面直接展示，不显示原始版本号以外的技术细节）。 */
export function readOnlyNotice(foundVersion: number, supportedVersion = PROJECT_SCHEMA_VERSION): string {
  return `该工程由更新版本的 WinCapture Studio（v${foundVersion}）创建，当前版本（支持到 v${supportedVersion}）只能只读打开。请升级应用后再编辑，以免丢失新版本的数据。`;
}

/** 读取入口：任何版本都能读；未来版本只读。 */
export function readProject(raw: unknown, options: MigrationOptions = {}): MigrationResult {
  const target = options.targetVersion ?? PROJECT_SCHEMA_VERSION;
  const allowReadOnlyFuture = options.allowReadOnlyFuture ?? true;

  if (!raw || typeof raw !== 'object') {
    throw new AppError({
      code: 'E_PROJECT_CORRUPT',
      message: '工程清单无法解析，文件可能已损坏。',
      retryable: false,
      preservedData: true,
      detail: 'project.json 不是对象',
    });
  }

  const source = raw as Partial<Project> & Record<string, unknown>;
  const rawVersion = source.schemaVersion;

  // 「缺少 schemaVersion」与「schemaVersion = 0（早期原型）」是两件事：
  // 前者说明文件被截断/根本不是工程清单，必须拒绝；后者有 0 → 1 迁移器，可以升级。
  if (rawVersion === undefined || rawVersion === null) {
    throw new AppError({
      code: 'E_PROJECT_CORRUPT',
      message: '工程清单缺少有效的 schemaVersion，无法打开。',
      retryable: false,
      preservedData: true,
      detail: `schemaVersion=${String(rawVersion)}`,
    });
  }
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 0) {
    throw new AppError({
      code: 'E_PROJECT_CORRUPT',
      message: '工程清单缺少有效的 schemaVersion，无法打开。',
      retryable: false,
      preservedData: true,
      detail: `schemaVersion=${String(rawVersion)}`,
    });
  }
  const fromVersion = rawVersion;

  if (fromVersion > target) {
    if (!allowReadOnlyFuture) throw new SchemaFutureError(fromVersion, target);
    // 只读：保留未来版本新增的字段（不丢数据），同时把已知字段规整为当前结构，
    // 保证界面渲染时 assets/tracks/effects/steps/variants/markers/settings 一定存在。
    // normalizeProject 在 version !== 当前版本时会把 schemaVersion 写回原版本号。
    const normalized = normalizeProject(source, fromVersion);
    return {
      project: { ...(source as Project), ...normalized },
      migrated: false,
      fromVersion,
      toVersion: fromVersion,
      steps: [],
      backup: null,
      backupFileName: null,
      readOnlyNotice: readOnlyNotice(fromVersion, target),
    };
  }

  if (fromVersion === target) {
    return {
      project: normalizeProject(source, fromVersion),
      migrated: false,
      fromVersion,
      toVersion: target,
      steps: [],
      backup: null,
      backupFileName: null,
      readOnlyNotice: null,
    };
  }

  // 旧版本：先备份，再逐级迁移
  const backup = deepCloneRaw(source);
  const backupFileName = `project.v${fromVersion}.backup.json`;
  const steps: MigrationStep[] = [];
  let current: Record<string, unknown> = { ...source };

  for (let v = fromVersion; v < target; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: `缺少从 v${v} 到 v${v + 1} 的迁移器，无法打开该工程。`,
        retryable: false,
        preservedData: true,
        detail: `missing migration for schemaVersion ${v}`,
      });
    }
    current = step(current);
    steps.push({ from: v, to: v + 1, description: describeMigration(v, v + 1), fixes: [] });
  }

  const project = normalizeProject(current, target);
  return {
    project,
    migrated: true,
    fromVersion,
    toVersion: target,
    steps,
    backup: backup as Project,
    backupFileName,
    readOnlyNotice: null,
  };
}

/** 写入入口：未来版本拒绝写入（抛 E_SCHEMA_FUTURE）。 */
export function writeProject(project: Project, options: MigrationOptions = {}): Project {
  const target = options.targetVersion ?? PROJECT_SCHEMA_VERSION;
  if (project.schemaVersion > target) throw new SchemaFutureError(project.schemaVersion, target);
  return normalizeProject(project as unknown as Record<string, unknown>, target);
}

/** 序列化为 JSON 字符串（tick 超出安全范围时用十进制字符串，§13.3）。 */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, (_key, value) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return String(value);
    }
    return value;
  }, 2);
}

/** 反序列化：接受十进制字符串形式的 tick（§13.3 跨语言传递）。 */
export function parseProjectJson(text: string, options: MigrationOptions = {}): MigrationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AppError({
      code: 'E_PROJECT_CORRUPT',
      message: '工程清单不是合法 JSON，文件可能已损坏。',
      retryable: false,
      preservedData: true,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return readProject(raw, options);
}

// ---------------------------------------------------------------------------
// 迁移器
// ---------------------------------------------------------------------------

type Migration = (project: Record<string, unknown>) => Record<string, unknown>;

/** v0/v1 → v1：补全字段。v1 是首个正式版本，因此 0 视为「早期原型」同构处理。 */
const MIGRATIONS: Record<number, Migration> = {
  0: (project) => ({ ...project, schemaVersion: 1 }),
};

function describeMigration(from: number, to: number): string {
  if (from === 0) return '把早期原型清单补齐为 v1 正式结构（补默认时间基准、画布与画幅）。';
  return `从 v${from} 迁移到 v${to}。`;
}

/** 把任意版本的清单规整为当前结构（缺字段补默认值，类型做保守修正）。 */
function normalizeProject(source: Record<string, unknown>, version: number): Project {
  const base = createEmptyProject(
    typeof source.id === 'string' && source.id ? source.id : 'project',
    typeof source.name === 'string' && source.name ? source.name : '未命名工程',
    typeof source.createdAt === 'number' ? source.createdAt : Date.now(),
  );

  const rawTracks = Array.isArray(source.tracks) ? (source.tracks as Track[]) : [];
  const tracks: Track[] = rawTracks.map((track) => ({
    id: String(track?.id ?? 'track'),
    kind: track?.kind ?? 'primaryVideo',
    muted: !!track?.muted,
    gain: typeof track?.gain === 'number' && Number.isFinite(track.gain) ? track.gain : 1,
    clips: Array.isArray(track?.clips) ? track.clips.map(normalizeClip) : [],
  }));

  // 保证四条标准轨都存在（缺失轨补空轨，顺序稳定）
  const order: Track['kind'][] = ['primaryVideo', 'camera', 'mic', 'system'];
  for (const kind of order) {
    if (!tracks.some((t) => t.kind === kind)) {
      const fallback = base.tracks.find((t) => t.kind === kind);
      if (fallback) tracks.push({ ...fallback, clips: [] });
    }
  }
  tracks.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const track of tracks) track.clips.sort((a, b) => a.timelineInTicks - b.timelineInTicks);

  const variants: CanvasVariant[] =
    Array.isArray(source.variants) && source.variants.length > 0
      ? (source.variants as CanvasVariant[]).map((v) => ({
          id: String(v?.id ?? 'landscape'),
          aspect: Array.isArray(v?.aspect) && v.aspect.length === 2 ? [Number(v.aspect[0]) || 16, Number(v.aspect[1]) || 9] : [16, 9],
          layoutOverrides: (v?.layoutOverrides ?? {}) as CanvasVariant['layoutOverrides'],
        }))
      : DEFAULT_VARIANTS.map((v) => ({ ...v, layoutOverrides: { ...v.layoutOverrides } }));

  const settings = (source.settings ?? {}) as Project['settings'];
  const fps =
    settings.fps && Number.isFinite(settings.fps.num) && Number.isFinite(settings.fps.den) && settings.fps.num > 0 && settings.fps.den > 0
      ? makeFrameRate(settings.fps.num, settings.fps.den)
      : makeFrameRate(30, 1);

  const activeVariantId =
    typeof settings.activeVariantId === 'string' && variants.some((v) => v.id === settings.activeVariantId)
      ? settings.activeVariantId
      : variants[0].id;

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: base.id,
    revision: Number.isInteger(source.revision) && (source.revision as number) >= 1 ? (source.revision as number) : 1,
    timebase: { ticksPerSecond: TICKS_PER_SECOND },
    name: base.name,
    createdAt: base.createdAt,
    updatedAt:
      typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : base.createdAt,
    assets: Array.isArray(source.assets) ? (source.assets as MediaAsset[]).map(normalizeAsset) : [],
    tracks,
    effects: Array.isArray(source.effects) ? (source.effects as Effect[]).map(normalizeEffect) : [],
    steps: Array.isArray(source.steps) ? (source.steps as TutorialStep[]).map(normalizeStep) : [],
    variants,
    markers: Array.isArray(source.markers) ? (source.markers as Project['markers']).map(normalizeMarker) : [],
    settings: {
      fps,
      activeVariantId,
      canvas: { ...DEFAULT_CANVAS, ...(settings.canvas ?? {}), camera: { ...DEFAULT_CANVAS.camera, ...(settings.canvas?.camera ?? {}) } },
      pointerSampleHz: typeof settings.pointerSampleHz === 'number' ? settings.pointerSampleHz : 120,
      stepEnhancement: !!settings.stepEnhancement,
    },
    privacyVersion: Number.isInteger(source.privacyVersion) ? (source.privacyVersion as number) : 0,
    // 版本号仅在写入时统一为目标版本；这里由 readProject 决定 toVersion 语义
    ...(version !== PROJECT_SCHEMA_VERSION ? { schemaVersion: version } : {}),
  };
}

function normalizeClip(clip: Partial<Clip> | undefined): Clip {
  return {
    id: String(clip?.id ?? 'clip'),
    assetId: String(clip?.assetId ?? ''),
    sourceInTicks: toTicks(clip?.sourceInTicks),
    sourceDurationTicks: Math.max(1, toTicks(clip?.sourceDurationTicks)),
    timelineInTicks: toTicks(clip?.timelineInTicks),
    rate:
      clip?.rate && Number.isFinite(clip.rate.num) && Number.isFinite(clip.rate.den) && clip.rate.num > 0 && clip.rate.den > 0
        ? { num: clip.rate.num, den: clip.rate.den }
        : { num: 1, den: 1 },
    linkGroupId: String(clip?.linkGroupId ?? ''),
  };
}

function normalizeAsset(asset: Partial<MediaAsset> | undefined): MediaAsset {
  return {
    id: String(asset?.id ?? 'asset'),
    kind: asset?.kind ?? 'screen',
    path: String(asset?.path ?? ''),
    hash: String(asset?.hash ?? ''),
    durationTicks: Math.max(0, toTicks(asset?.durationTicks)),
    width: Number.isFinite(asset?.width) ? Number(asset?.width) : 0,
    height: Number.isFinite(asset?.height) ? Number(asset?.height) : 0,
    sampleRate: Number.isFinite(asset?.sampleRate) ? Number(asset?.sampleRate) : 0,
    channels: Number.isFinite(asset?.channels) ? Number(asset?.channels) : 0,
    createdAt: Number.isFinite(asset?.createdAt) ? Number(asset?.createdAt) : Date.now(),
  };
}

function normalizeEffect(effect: Partial<Effect> | undefined): Effect {
  return {
    id: String(effect?.id ?? 'effect'),
    kind: effect?.kind ?? 'zoom',
    range: {
      start: toTicks(effect?.range?.start),
      end: Math.max(toTicks(effect?.range?.start) + 1, toTicks(effect?.range?.end)),
    },
    anchor: effect?.anchor,
    parameters: (effect?.parameters ?? {}) as Effect['parameters'],
    origin: effect?.origin ?? 'manual',
    locked: effect?.locked ?? true,
    stepId: effect?.stepId,
  };
}

function normalizeStep(step: Partial<TutorialStep> | undefined): TutorialStep {
  const start = toTicks(step?.sourceRange?.start);
  return {
    id: String(step?.id ?? 'step'),
    sourceRange: { start, end: Math.max(start + 1, toTicks(step?.sourceRange?.end)) },
    title: String(step?.title ?? ''),
    description: String(step?.description ?? ''),
    imageTick: toTicks(step?.imageTick),
    actionRect: step?.actionRect ?? null,
    source: step?.source ?? 'manual',
    privacyVersion: Number.isInteger(step?.privacyVersion) ? Number(step?.privacyVersion) : 0,
  };
}

function normalizeMarker(marker: Partial<Project['markers'][number]> | undefined): Project['markers'][number] {
  return {
    id: String(marker?.id ?? 'marker'),
    mediaTick: toTicks(marker?.mediaTick),
    note: String(marker?.note ?? ''),
    createdAt: Number.isFinite(marker?.createdAt) ? Number(marker?.createdAt) : Date.now(),
  };
}

/** 接受 number 或十进制字符串（§13.3）。 */
function toTicks(value: unknown): Ticks {
  if (typeof value === 'number') return Math.max(0, normalizeTicks(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
  }
  return 0;
}

function deepCloneRaw<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
