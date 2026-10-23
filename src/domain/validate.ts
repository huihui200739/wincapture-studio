/**
 * 工程校验器（开发文档 §13.1 / §13.3 / §13.4 / §18.3 T11）
 *
 * 校验原则：
 * - 返回**结构化错误列表**，不抛第一个错就停——导入一个坏工程时用户需要一次看到
 *   全部问题，而不是修一个报一个。
 * - 路径必须是工程相对路径：拒绝绝对路径、盘符、UNC、`..` 越界、NUL 字节，
 *   以及指向工程目录之外的符号链接（symlink 越界）。
 * - 时间区间严格 [start, end) 且 start >= 0、start < end。
 * - revision 单调（不允许 0 或负数，且必须 >= 1）。
 *
 * 纯逻辑：不访问磁盘。符号链接越界通过 `resolvePath` 回调注入（主进程用
 * fs.realpath 实现），默认实现为纯字符串归一化，可在单元测试中完全复现。
 */

import type { Project, MediaAsset, Track, Effect, TutorialStep, CanvasVariant } from './project';
import { PROJECT_SCHEMA_VERSION, timelineDuration } from './project';
import type { TickRange, Ticks } from './timebase';
import { TICKS_PER_SECOND, rangeIsEmpty, rangeLength } from './timebase';

export type ValidationSeverity = 'error' | 'warning';

export type ValidationCode =
  | 'schema-future'
  | 'schema-unsupported'
  | 'revision-invalid'
  | 'timebase-invalid'
  | 'id-duplicate'
  | 'asset-path-absolute'
  | 'asset-path-traversal'
  | 'asset-path-empty'
  | 'asset-path-symlink-escape'
  | 'asset-duration-invalid'
  | 'asset-dimension-invalid'
  | 'clip-asset-missing'
  | 'clip-source-out-of-range'
  | 'clip-range-invalid'
  | 'clip-timeline-overlap'
  | 'clip-rate-invalid'
  | 'clip-link-group-missing'
  | 'track-kind-duplicate'
  | 'effect-range-invalid'
  | 'effect-range-out-of-project'
  | 'effect-parameters-invalid'
  | 'step-range-invalid'
  | 'step-range-out-of-project'
  | 'step-image-out-of-range'
  | 'variant-invalid'
  | 'fps-invalid'
  | 'marker-out-of-range'
  | 'privacy-unconfirmed'
  | 'media-duration-mismatch';

export interface ValidationIssue {
  code: ValidationCode;
  severity: ValidationSeverity;
  /** 面向用户的中文说明 */
  message: string;
  /** 出问题的实体类型，便于界面定位 */
  entity: 'project' | 'asset' | 'track' | 'clip' | 'effect' | 'step' | 'variant' | 'marker' | 'settings';
  /** 实体 ID（project 级问题为工程 ID） */
  entityId: string;
  /** 可选：具体字段路径 */
  field?: string;
  /** 可选：相关 tick 位置，便于时间线定位 */
  tick?: Ticks;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** 仅 error 级别 */
  errors: ValidationIssue[];
  /** 仅 warning 级别 */
  warnings: ValidationIssue[];
}

export interface ValidationOptions {
  /** 是否允许未来版本（默认 false：未来版本只能只读，不得写入） */
  allowFutureSchema?: boolean;
  /** 是否检查时间线片段重叠（默认 true） */
  checkOverlap?: boolean;
  /** 把工程相对路径解析为真实绝对路径（用于符号链接越界检查）；返回 null 表示无法解析 */
  resolvePath?: (relativePath: string) => string | null;
  /** 工程根目录真实绝对路径；提供时与 resolvePath 配合做越界检查 */
  projectRoot?: string;
  /** 素材时长容差（tick），默认 1ms */
  durationToleranceTicks?: Ticks;
}

const DEFAULT_TOLERANCE = 10_000; // 1ms

// ---------------------------------------------------------------------------
// 路径校验（§13.1 / T11）
// ---------------------------------------------------------------------------

export interface PathCheck {
  ok: boolean;
  code?: ValidationCode;
  reason?: string;
}

/** Windows 保留设备名，即使作为相对路径也会被系统特殊解释。 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 校验工程相对路径。
 *
 * 拒绝：
 * - 空路径、NUL 字节、控制字符；
 * - 绝对路径：`C:\`、`C:/`、`\\server\share`、`/unix/abs`；
 * - 任何 `..` 段（即使归一化后回到工程内，也拒绝——ZIP 解包路径穿越的经典手法
 *   是 `a/../../b`，一律不放过）；
 * - 归一化后仍以 `..` 开头（理论上不会发生，保留为纵深防御）。
 */
export function checkProjectRelativePath(path: string): PathCheck {
  if (typeof path !== 'string') return { ok: false, code: 'asset-path-empty', reason: '路径不是字符串' };
  if (path.length === 0) return { ok: false, code: 'asset-path-empty', reason: '路径为空' };
  if (/[\u0000-\u001f]/.test(path)) {
    return { ok: false, code: 'asset-path-traversal', reason: '路径包含控制字符或 NUL 字节' };
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) return { ok: false, code: 'asset-path-empty', reason: '路径为空' };

  // 绝对路径
  if (/^[a-zA-Z]:/.test(trimmed)) return { ok: false, code: 'asset-path-absolute', reason: '不允许盘符绝对路径' };
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return { ok: false, code: 'asset-path-absolute', reason: '不允许 UNC 网络路径' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return { ok: false, code: 'asset-path-absolute', reason: '不允许绝对路径' };
  }
  if (trimmed.startsWith('~')) return { ok: false, code: 'asset-path-absolute', reason: '不允许用户目录展开路径' };

  const segments = trimmed.split(/[\\/]+/);
  for (const rawSegment of segments) {
    if (rawSegment === '') continue;
    // ':' 只可能出现在盘符/ADS（备用数据流）中；盘符前面已拒绝，其余一律拒绝，
    // 否则 `media/a.mp4:evil` 会写到同名文件的数据流上。
    if (rawSegment.includes(':')) {
      return { ok: false, code: 'asset-path-traversal', reason: '路径段包含冒号（拒绝备用数据流 ADS）' };
    }
    // Windows 会忽略段尾的点与空格（`.. ` 等价于 `..`，`con.` 等价于 `con`），
    // 必须先按系统行为归一化再判断越界与保留名，否则是路径穿越校验的经典绕过。
    const segment = rawSegment.replace(/[. ]+$/, '');
    if (segment === '..') return { ok: false, code: 'asset-path-traversal', reason: '路径包含 .. 越界' };
    if (segment === '') {
      if (rawSegment === '.') continue; // 当前目录
      return { ok: false, code: 'asset-path-traversal', reason: '路径段仅由点/空格组成' };
    }
    const base = segment.split('.')[0]?.toLowerCase() ?? '';
    if (RESERVED_NAMES.has(base)) {
      return { ok: false, code: 'asset-path-traversal', reason: `路径包含 Windows 保留名 ${segment}` };
    }
    if (segment.length > 255) {
      return { ok: false, code: 'asset-path-traversal', reason: '路径段过长' };
    }
  }
  if (trimmed.length > 1024) return { ok: false, code: 'asset-path-traversal', reason: '路径过长' };

  return { ok: true };
}

/**
 * 符号链接越界检查：把相对路径解析为真实绝对路径后，必须仍在工程根目录内。
 * 解析失败（文件不存在等）视为无法判定，返回 ok（缺失素材由素材重定位流程处理）。
 */
export function checkSymlinkEscape(
  relativePath: string,
  resolvePath: (relativePath: string) => string | null,
  projectRoot: string,
): PathCheck {
  const resolved = resolvePath(relativePath);
  if (resolved === null) return { ok: true };
  const normalizedRoot = normalizeForCompare(projectRoot);
  const normalizedTarget = normalizeForCompare(resolved);
  if (normalizedTarget === normalizedRoot) return { ok: true };
  if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return { ok: false, code: 'asset-path-symlink-escape', reason: '符号链接指向工程目录之外' };
  }
  return { ok: true };
}

function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// 区间校验
// ---------------------------------------------------------------------------

/** 严格左闭右开：要求整数、非负、start < end。 */
export function checkRange(range: TickRange | null | undefined, allowEmpty = false): boolean {
  if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') return false;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return false;
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return false;
  if (range.start < 0) return false;
  if (allowEmpty) return range.start <= range.end;
  return range.start < range.end;
}

/** 两个左闭右开区间是否重叠（相邻不算重叠，空区间不与任何区间重叠）。 */
export function rangesOverlap(a: TickRange, b: TickRange): boolean {
  if (rangeIsEmpty(a) || rangeIsEmpty(b)) return false;
  return a.start < b.end && b.start < a.end;
}

// ---------------------------------------------------------------------------
// 主校验入口
// ---------------------------------------------------------------------------

/**
 * 校验整个工程。返回全部问题（不短路）。
 *
 * 注意：本函数不修改工程，也不做迁移；schemaVersion 高于当前版本时返回
 * `schema-future` error（调用方应转为只读模式，见 migration.ts）。
 */
export function validateProject(project: Project, options: ValidationOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const tolerance = options.durationToleranceTicks ?? DEFAULT_TOLERANCE;
  const checkOverlap = options.checkOverlap ?? true;

  const push = (issue: ValidationIssue): void => {
    issues.push(issue);
  };

  if (!project || typeof project !== 'object') {
    const issue: ValidationIssue = {
      code: 'schema-unsupported',
      severity: 'error',
      message: '工程对象为空或格式错误。',
      entity: 'project',
      entityId: '',
    };
    return { ok: false, issues: [issue], errors: [issue], warnings: [] };
  }

  const projectId = typeof project.id === 'string' ? project.id : '';

  /**
   * 集合字段必须真的是数组。
   *
   * 校验器的契约是「返回结构化错误、不抛异常」：损坏的 project.json 可能把
   * assets/tracks 写成对象或缺失，旧实现直接 `for...of`/`timelineDuration` 会抛
   * TypeError，导入流程因此拿不到可展示的错误列表。
   */
  const requireCollection = <T>(value: unknown, field: string): T[] => {
    if (Array.isArray(value)) return value as T[];
    push({
      code: 'schema-unsupported',
      severity: 'error',
      message: `工程结构损坏：${field} 必须是数组（实际为 ${value === null ? 'null' : typeof value}）。`,
      entity: 'project',
      entityId: projectId,
      field,
    });
    return [];
  };
  const pushStructure = (entity: ValidationIssue['entity'], entityId: string, field: string, detail: string): void => {
    push({
      code: 'schema-unsupported',
      severity: 'error',
      message: `工程结构损坏：${detail}。`,
      entity,
      entityId,
      field,
    });
  };

  const assets = requireCollection<MediaAsset>(project.assets, 'assets');
  const tracks = requireCollection<Track>(project.tracks, 'tracks');
  const effects = requireCollection<Effect>(project.effects, 'effects');
  const steps = requireCollection<TutorialStep>(project.steps, 'steps');
  const variants = requireCollection<CanvasVariant>(project.variants, 'variants');
  const markers = requireCollection<Project['markers'][number]>(project.markers, 'markers');

  // ---- 工程级 ----
  if (!Number.isInteger(project.schemaVersion) || project.schemaVersion < 1) {
    push({
      code: 'schema-unsupported',
      severity: 'error',
      message: '工程文件缺少有效的 schemaVersion。',
      entity: 'project',
      entityId: project.id ?? '',
      field: 'schemaVersion',
    });
  } else if (project.schemaVersion > PROJECT_SCHEMA_VERSION && !options.allowFutureSchema) {
    push({
      code: 'schema-future',
      severity: 'error',
      message: `工程由更高版本创建（v${project.schemaVersion}），当前版本只支持到 v${PROJECT_SCHEMA_VERSION}，请升级后再编辑，本次以只读方式打开。`,
      entity: 'project',
      entityId: project.id ?? '',
      field: 'schemaVersion',
    });
  }

  if (!Number.isInteger(project.revision) || project.revision < 1) {
    push({
      code: 'revision-invalid',
      severity: 'error',
      message: '工程 revision 必须为 >= 1 的整数（版本单调递增）。',
      entity: 'project',
      entityId: project.id ?? '',
      field: 'revision',
    });
  }

  if (!project.timebase || project.timebase.ticksPerSecond !== TICKS_PER_SECOND) {
    push({
      code: 'timebase-invalid',
      severity: 'error',
      message: `工程时间基准必须为每秒 ${TICKS_PER_SECOND} tick。`,
      entity: 'project',
      entityId: project.id ?? '',
      field: 'timebase.ticksPerSecond',
    });
  }

  if (!project.settings || !isValidFps(project.settings.fps)) {
    push({
      code: 'fps-invalid',
      severity: 'error',
      message: '工程帧率必须是正的有理数。',
      entity: 'settings',
      entityId: project.id ?? '',
      field: 'settings.fps',
    });
  }

  // ---- 素材 ----
  const assetIds = new Set<string>();
  const assetsById = new Map<string, MediaAsset>();
  const duplicateIds = new Set<string>();
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') {
      pushStructure('asset', '', 'assets[]', 'assets 中存在空条目');
      continue;
    }
    if (assetIds.has(asset.id)) duplicateIds.add(asset.id);
    assetIds.add(asset.id);
    assetsById.set(asset.id, asset);

    const pathCheck = checkProjectRelativePath(asset.path);
    if (!pathCheck.ok) {
      push({
        code: pathCheck.code ?? 'asset-path-traversal',
        severity: 'error',
        message: `素材 ${asset.id} 的路径不安全：${pathCheck.reason ?? '必须是工程相对路径'}。`,
        entity: 'asset',
        entityId: asset.id,
        field: 'path',
      });
    } else if (options.resolvePath && options.projectRoot) {
      const linkCheck = checkSymlinkEscape(asset.path, options.resolvePath, options.projectRoot);
      if (!linkCheck.ok) {
        push({
          code: 'asset-path-symlink-escape',
          severity: 'error',
          message: `素材 ${asset.id} 的路径通过符号链接指向工程目录之外，已拒绝。`,
          entity: 'asset',
          entityId: asset.id,
          field: 'path',
        });
      }
    }

    if (!Number.isInteger(asset.durationTicks) || asset.durationTicks <= 0) {
      push({
        code: 'asset-duration-invalid',
        severity: 'error',
        message: `素材 ${asset.id} 的时长必须为正整数 tick。`,
        entity: 'asset',
        entityId: asset.id,
        field: 'durationTicks',
      });
    }
    if (asset.kind === 'screen' || asset.kind === 'camera') {
      if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width <= 0 || asset.height <= 0) {
        push({
          code: 'asset-dimension-invalid',
          severity: 'error',
          message: `视频素材 ${asset.id} 的宽高必须为正整数。`,
          entity: 'asset',
          entityId: asset.id,
          field: 'width',
        });
      }
    }
    if (asset.kind === 'mic' || asset.kind === 'system') {
      if (!Number.isInteger(asset.sampleRate) || asset.sampleRate <= 0) {
        push({
          code: 'asset-dimension-invalid',
          severity: 'warning',
          message: `音频素材 ${asset.id} 缺少有效采样率，导出时按 48kHz 处理。`,
          entity: 'asset',
          entityId: asset.id,
          field: 'sampleRate',
        });
      }
    }
  }
  for (const id of duplicateIds) {
    push({
      code: 'id-duplicate',
      severity: 'error',
      message: `素材 ID ${id} 重复。`,
      entity: 'asset',
      entityId: id,
      field: 'id',
    });
  }

  // ---- 轨道与片段 ----
  const duration = timelineDuration(project);
  const trackKinds = new Set<string>();
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of tracks) {
    if (!track || typeof track !== 'object') {
      pushStructure('track', '', 'tracks[]', 'tracks 中存在空条目');
      continue;
    }
    if (trackIds.has(track.id)) {
      push({
        code: 'id-duplicate',
        severity: 'error',
        message: `轨道 ID ${track.id} 重复。`,
        entity: 'track',
        entityId: track.id,
        field: 'id',
      });
    }
    trackIds.add(track.id);
    if (trackKinds.has(track.kind)) {
      push({
        code: 'track-kind-duplicate',
        severity: 'error',
        message: `轨道类型 ${track.kind} 重复出现。`,
        entity: 'track',
        entityId: track.id,
        field: 'kind',
      });
    }
    trackKinds.add(track.kind);

    if (track.kind === 'mic' || track.kind === 'system') {
      if (!Number.isFinite(track.gain) || track.gain < 0 || track.gain > 4) {
        push({
          code: 'effect-parameters-invalid',
          severity: 'warning',
          message: `轨道 ${track.kind} 的增益应在 0..4 之间，已超出范围。`,
          entity: 'track',
          entityId: track.id,
          field: 'gain',
        });
      }
    }

    if (!Array.isArray(track.clips)) {
      pushStructure('track', track.id, 'clips', `轨道 ${track.id} 的 clips 必须是数组`);
      continue;
    }
    const sorted = track.clips
      .filter((clip): clip is NonNullable<typeof clip> => !!clip && typeof clip === 'object')
      .sort((a, b) => (a.timelineInTicks - b.timelineInTicks) || 0);
    // 已遍历片段的最大结束时间与对应片段：用于检出嵌套重叠（见下方注释）
    let prevMaxEnd = -Infinity;
    let prevMaxEndOwner: (typeof sorted)[number] | null = null;
    for (let i = 0; i < sorted.length; i++) {
      const clip = sorted[i];
      if (clipIds.has(clip.id)) {
        push({
          code: 'id-duplicate',
          severity: 'error',
          message: `片段 ID ${clip.id} 重复。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'id',
        });
      }
      clipIds.add(clip.id);

      const asset = assetsById.get(clip.assetId);
      if (!asset) {
        push({
          code: 'clip-asset-missing',
          severity: 'error',
          message: `片段 ${clip.id} 引用的素材 ${clip.assetId} 不存在。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'assetId',
        });
      }

      if (!isValidRate(clip.rate)) {
        push({
          code: 'clip-rate-invalid',
          severity: 'error',
          message: `片段 ${clip.id} 的播放速率必须是正的有理数。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'rate',
        });
      }

      if (
        !Number.isInteger(clip.sourceInTicks) ||
        !Number.isInteger(clip.sourceDurationTicks) ||
        clip.sourceInTicks < 0 ||
        clip.sourceDurationTicks <= 0
      ) {
        push({
          code: 'clip-range-invalid',
          severity: 'error',
          message: `片段 ${clip.id} 的源区间必须为非负整数且时长大于 0。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'sourceInTicks',
        });
      } else if (asset && clip.sourceInTicks + clip.sourceDurationTicks > asset.durationTicks + tolerance) {
        push({
          code: 'clip-source-out-of-range',
          severity: 'error',
          message: `片段 ${clip.id} 的源区间超出素材 ${asset.id} 的时长（${clip.sourceInTicks + clip.sourceDurationTicks} > ${asset.durationTicks}）。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'sourceDurationTicks',
          tick: clip.sourceInTicks + clip.sourceDurationTicks,
        });
      }

      if (!Number.isInteger(clip.timelineInTicks) || clip.timelineInTicks < 0) {
        push({
          code: 'clip-range-invalid',
          severity: 'error',
          message: `片段 ${clip.id} 的时间线起点必须为非负整数。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'timelineInTicks',
        });
      }

      if (!clip.linkGroupId) {
        push({
          code: 'clip-link-group-missing',
          severity: 'warning',
          message: `片段 ${clip.id} 没有 linkGroupId，删除/重排时不会与其他轨同步。`,
          entity: 'clip',
          entityId: clip.id,
          field: 'linkGroupId',
        });
      }

      if (checkOverlap && i > 0) {
        // 只和「紧邻的前一个」比较会漏掉嵌套重叠：
        // A[0,10s) + B[2s,3s) + C[4s,5s) 里 C 的前一个是 B（3s < 4s），
        // 但 C 整段落在 A 内部。用前面所有片段的最大结束时间判定才是正确的。
        const start = clip.timelineInTicks;
        if (start < prevMaxEnd) {
          const prevId = prevMaxEndOwner?.id ?? sorted[i - 1].id;
          push({
            code: 'clip-timeline-overlap',
            severity: 'error',
            message: `同一轨道上片段 ${prevId} 与 ${clip.id} 的时间线区间重叠（${prevMaxEnd} > ${start}）。`,
            entity: 'clip',
            entityId: clip.id,
            field: 'timelineInTicks',
            tick: start,
          });
        }
      }
      const end = clip.timelineInTicks + scaleDuration(clip.sourceDurationTicks, clip.rate);
      if (end > prevMaxEnd) {
        prevMaxEnd = end;
        prevMaxEndOwner = clip;
      }
    }
  }

  // ---- 效果 ----
  const effectIds = new Set<string>();
  for (const effect of effects) {
    if (!effect || typeof effect !== 'object') {
      pushStructure('effect', '', 'effects[]', 'effects 中存在空条目');
      continue;
    }
    if (effectIds.has(effect.id)) {
      push({
        code: 'id-duplicate',
        severity: 'error',
        message: `效果 ID ${effect.id} 重复（SetEffect 只会更新第一条，DeleteEffect 会删除全部）。`,
        entity: 'effect',
        entityId: effect.id,
        field: 'id',
      });
    }
    effectIds.add(effect.id);
    if (!checkRange(effect.range)) {
      push({
        code: 'effect-range-invalid',
        severity: 'error',
        message: `效果 ${effect.id} 的时间区间非法（必须是 start >= 0 且 start < end 的整数 tick）。`,
        entity: 'effect',
        entityId: effect.id,
        field: 'range',
      });
      continue;
    }
    if (duration > 0 && effect.range.start >= duration) {
      push({
        code: 'effect-range-out-of-project',
        severity: 'warning',
        message: `效果 ${effect.id} 的区间在工程时长（${duration}）之外，不会生效。`,
        entity: 'effect',
        entityId: effect.id,
        field: 'range',
        tick: effect.range.start,
      });
    }
    if (effect.kind === 'privacy') {
      const p = effect.parameters as { x?: number; y?: number; width?: number; height?: number; confirmed?: boolean };
      if (![p.x, p.y, p.width, p.height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        push({
          code: 'effect-parameters-invalid',
          severity: 'error',
          message: `遮挡效果 ${effect.id} 的矩形参数不完整。`,
          entity: 'effect',
          entityId: effect.id,
          field: 'parameters',
        });
      } else if ((p.width ?? 0) <= 0 || (p.height ?? 0) <= 0) {
        push({
          code: 'effect-parameters-invalid',
          severity: 'error',
          message: `遮挡效果 ${effect.id} 的宽高必须大于 0。`,
          entity: 'effect',
          entityId: effect.id,
          field: 'parameters',
        });
      }
      if (!p.confirmed) {
        push({
          code: 'privacy-unconfirmed',
          severity: 'warning',
          message: `遮挡效果 ${effect.id} 尚未确认，未确认不等于已遮挡，导出前请复核。`,
          entity: 'effect',
          entityId: effect.id,
          field: 'parameters.confirmed',
        });
      }
    }
    if (effect.kind === 'zoom') {
      const motion = effect.parameters as import('./project').ZoomParameters;
      for (const [field, min, max] of [['rotateX', -45, 45], ['rotateY', -45, 45], ['rotateZ', -45, 45], ['perspective', 1, 5]] as const) {
        const value = motion[field];
        if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
          push({ code: 'effect-parameters-invalid', severity: 'error', message: `3D 运镜 ${field} 必须在 ${min} 到 ${max} 之间。`, entity: 'effect', entityId: effect.id, field: `parameters.${field}` });
        }
      }
      const p = effect.parameters as { scale?: number; focusX?: number; focusY?: number };
      if (typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale < 1) {
        push({
          code: 'effect-parameters-invalid',
          severity: 'error',
          message: `运镜效果 ${effect.id} 的缩放倍数必须 >= 1。`,
          entity: 'effect',
          entityId: effect.id,
          field: 'parameters.scale',
        });
      }
      if (
        // NaN 的 typeof 也是 'number'，且 NaN < 0 / NaN > 1 都为 false，
        // 只用范围比较会让 focusX/focusY 为 NaN 的工程「校验通过」，
        // 之后 evaluateZoom 把它带进合成器，drawImage 收到非有限值整帧不绘制。
        typeof p.focusX !== 'number' ||
        !Number.isFinite(p.focusX) ||
        typeof p.focusY !== 'number' ||
        !Number.isFinite(p.focusY) ||
        p.focusX < 0 ||
        p.focusX > 1 ||
        p.focusY < 0 ||
        p.focusY > 1
      ) {
        push({
          code: 'effect-parameters-invalid',
          severity: 'error',
          message: `运镜效果 ${effect.id} 的焦点必须归一化到 [0,1]。`,
          entity: 'effect',
          entityId: effect.id,
          field: 'parameters.focusX',
        });
      }
    }
  }

  // ---- 步骤 ----
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      pushStructure('step', '', 'steps[]', 'steps 中存在空条目');
      continue;
    }
    if (stepIds.has(step.id)) {
      push({
        code: 'id-duplicate',
        severity: 'error',
        message: `步骤 ID ${step.id} 重复。`,
        entity: 'step',
        entityId: step.id,
        field: 'id',
      });
    }
    stepIds.add(step.id);
    if (!checkRange(step.sourceRange)) {
      push({
        code: 'step-range-invalid',
        severity: 'error',
        message: `步骤 ${step.id} 的源区间非法（必须是 start >= 0 且 start < end 的整数 tick）。`,
        entity: 'step',
        entityId: step.id,
        field: 'sourceRange',
      });
    } else if (duration > 0 && !tracks.some((track) => track?.kind === 'primaryVideo' && Array.isArray(track.clips) &&
      track.clips.some((clip) => clip && step.sourceRange.start < clip.sourceInTicks + clip.sourceDurationTicks &&
        step.sourceRange.end > clip.sourceInTicks))) {
      push({
        code: 'step-range-out-of-project',
        severity: 'warning',
        message: `步骤 ${step.id} 对应的源画面已不在成片中。`,
        entity: 'step',
        entityId: step.id,
        field: 'sourceRange',
        tick: step.sourceRange.start,
      });
    }
    if (!Number.isInteger(step.imageTick) || step.imageTick < 0) {
      push({
        code: 'step-image-out-of-range',
        severity: 'error',
        message: `步骤 ${step.id} 的截图时间必须为非负整数 tick。`,
        entity: 'step',
        entityId: step.id,
        field: 'imageTick',
      });
    } else if (duration > 0 && !tracks.some((track) => track?.kind === 'primaryVideo' && Array.isArray(track.clips) &&
      track.clips.some((clip) => clip && step.imageTick >= clip.sourceInTicks &&
        step.imageTick < clip.sourceInTicks + clip.sourceDurationTicks))) {
      push({
        code: 'step-image-out-of-range',
        severity: 'warning',
        message: `步骤 ${step.id} 的截图画面已被剪掉，请重新选择截图时间。`,
        entity: 'step',
        entityId: step.id,
        field: 'imageTick',
        tick: step.imageTick,
      });
    }
  }

  // ---- 画幅 ----
  const variantIds = new Set<string>();
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') {
      pushStructure('variant', '', 'variants[]', 'variants 中存在空条目');
      continue;
    }
    if (variantIds.has(variant.id)) {
      push({
        code: 'id-duplicate',
        severity: 'error',
        message: `画幅 ID ${variant.id} 重复。`,
        entity: 'variant',
        entityId: variant.id,
        field: 'id',
      });
    }
    variantIds.add(variant.id);
    if (
      !Array.isArray(variant.aspect) ||
      variant.aspect.length !== 2 ||
      !Number.isFinite(variant.aspect[0]) ||
      !Number.isFinite(variant.aspect[1]) ||
      variant.aspect[0] <= 0 ||
      variant.aspect[1] <= 0
    ) {
      push({
        code: 'variant-invalid',
        severity: 'error',
        message: `画幅 ${variant.id} 的宽高比必须为两个正数。`,
        entity: 'variant',
        entityId: variant.id,
        field: 'aspect',
      });
    }
  }
  if (variants.length > 0) {
    if (!variants.some((v) => v?.id === project.settings?.activeVariantId)) {
      push({
        code: 'variant-invalid',
        severity: 'error',
        message: `当前激活画幅 ${project.settings?.activeVariantId} 不存在。`,
        entity: 'variant',
        entityId: project.settings?.activeVariantId ?? '',
        field: 'settings.activeVariantId',
      });
    }
  }

  // ---- 标记 ----
  const markerIds = new Set<string>();
  for (const marker of markers) {
    if (!marker || typeof marker !== 'object') {
      pushStructure('marker', '', 'markers[]', 'markers 中存在空条目');
      continue;
    }
    if (markerIds.has(marker.id)) {
      push({
        code: 'id-duplicate',
        severity: 'error',
        message: `标记 ID ${marker.id} 重复。`,
        entity: 'marker',
        entityId: marker.id,
        field: 'id',
      });
    }
    markerIds.add(marker.id);
    if (!Number.isInteger(marker.mediaTick) || marker.mediaTick < 0) {
      push({
        code: 'marker-out-of-range',
        severity: 'error',
        message: `标记 ${marker.id} 的时间必须为非负整数 tick。`,
        entity: 'marker',
        entityId: marker.id,
        field: 'mediaTick',
      });
    } else if (duration > 0 && marker.mediaTick > duration) {
      push({
        code: 'marker-out-of-range',
        severity: 'warning',
        message: `标记 ${marker.id} 的时间超过工程时长。`,
        entity: 'marker',
        entityId: marker.id,
        field: 'mediaTick',
        tick: marker.mediaTick,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, issues, errors, warnings };
}

/** 校验并抛错（用于「必须可保存」的路径）。错误信息汇总前 5 条。 */
export function assertProjectValid(project: Project, options: ValidationOptions = {}): ValidationResult {
  const result = validateProject(project, options);
  if (!result.ok) {
    const head = result.errors
      .slice(0, 5)
      .map((e) => e.message)
      .join(' ');
    throw new Error(`工程校验未通过（${result.errors.length} 项）：${head}`);
  }
  return result;
}

function isValidFps(fps: { num: number; den: number } | undefined): boolean {
  if (!fps) return false;
  return Number.isFinite(fps.num) && Number.isFinite(fps.den) && fps.num > 0 && fps.den > 0;
}

function isValidRate(rate: { num: number; den: number } | undefined): boolean {
  if (!rate) return false;
  return Number.isFinite(rate.num) && Number.isFinite(rate.den) && rate.num > 0 && rate.den > 0;
}

function scaleDuration(duration: Ticks, rate: { num: number; den: number }): Ticks {
  return Math.round((duration * rate.den) / rate.num);
}

/** 工程总时长（供校验与界面复用）。 */
export function projectDuration(project: Project): Ticks {
  return timelineDuration(project);
}

/** 区间总长度（供界面展示被删长度）。 */
export function removedLength(ranges: readonly TickRange[]): Ticks {
  return ranges.reduce((acc, r) => acc + rangeLength(r), 0);
}

export type { Track };
