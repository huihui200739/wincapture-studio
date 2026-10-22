/**
 * 剪辑命令与撤销（开发文档 §10.2）
 *
 * - 所有编辑都是显式命令，携带命令 ID、目标工程版本和修改前后差异。
 * - 同一次删除作为一个事务作用于所有关联轨道。
 * - 连续拖动只在结束时形成一条撤销记录。
 * - 工程版本冲突时先刷新状态再重试，不能覆盖后到的更新。
 */

import type { Project, Effect, TutorialStep, CanvasVariant, TrackKind, Clip } from './project';
import { cloneProject, findTrack, timelineDuration } from './project';
import type { Ticks, TickRange } from './timebase';
import { rangeLength } from './timebase';
import { TimeMap } from './timeMap';
import { AppError } from '../shared/errors';

export type CommandKind =
  | 'SplitClip'
  | 'TrimClip'
  | 'DeleteRange'
  | 'MoveClip'
  | 'SetEffect'
  | 'DeleteEffect'
  | 'SetVariantOverride'
  | 'SetCanvasStyle'
  | 'SetTrackAudio'
  | 'SetStep'
  | 'DeleteStep'
  | 'ReorderSteps'
  | 'SetMarker'
  | 'SetActiveVariant'
  | 'SetFrameRate';

export interface CommandBase {
  /** 命令 ID，用于日志与幂等排查 */
  id: string;
  kind: CommandKind;
  /** 目标工程版本；与当前 revision 不一致时拒绝执行（§10.2） */
  expectedRevision: number;
}

export interface SplitClipCommand extends CommandBase {
  kind: 'SplitClip';
  /** 在时间线 tick 处分割（作用于所有关联轨） */
  timelineTick: Ticks;
}

export interface TrimClipCommand extends CommandBase {
  kind: 'TrimClip';
  clipId: string;
  /** 新的源区间（可选），不传表示保持 */
  sourceInTicks?: Ticks;
  sourceDurationTicks?: Ticks;
  /** 新的时间线起点（可选） */
  timelineInTicks?: Ticks;
  ripple?: boolean;
}

export interface DeleteRangeCommand extends CommandBase {
  kind: 'DeleteRange';
  range: TickRange;
  /** 默认 ripple 删除，后方主轨前移（§10.2） */
  ripple: boolean;
}

export interface MoveClipCommand extends CommandBase {
  kind: 'MoveClip';
  clipId: string;
  timelineInTicks: Ticks;
}

export interface SetEffectCommand extends CommandBase {
  kind: 'SetEffect';
  effect: Effect;
  /** 人工修改后是否锁定，默认 true（自动轨重生成不覆盖，§10.3） */
  lock?: boolean;
}

export interface DeleteEffectCommand extends CommandBase {
  kind: 'DeleteEffect';
  effectId: string;
}

export interface SetVariantOverrideCommand extends CommandBase {
  kind: 'SetVariantOverride';
  variantId: string;
  layoutOverrides: CanvasVariant['layoutOverrides'];
}

export interface SetCanvasStyleCommand extends CommandBase {
  kind: 'SetCanvasStyle';
  canvas: Partial<Project['settings']['canvas']>;
}

export interface SetTrackAudioCommand extends CommandBase {
  kind: 'SetTrackAudio';
  track: TrackKind;
  muted?: boolean;
  gain?: number;
}

export interface SetStepCommand extends CommandBase {
  kind: 'SetStep';
  step: TutorialStep;
}

export interface DeleteStepCommand extends CommandBase {
  kind: 'DeleteStep';
  stepId: string;
}

export interface ReorderStepsCommand extends CommandBase {
  kind: 'ReorderSteps';
  orderedIds: string[];
}

export interface SetMarkerCommand extends CommandBase {
  kind: 'SetMarker';
  marker: { id: string; mediaTick: Ticks; note: string; createdAt: number };
  remove?: boolean;
}

export interface SetActiveVariantCommand extends CommandBase {
  kind: 'SetActiveVariant';
  variantId: string;
}

export interface SetFrameRateCommand extends CommandBase {
  kind: 'SetFrameRate';
  fps: { num: number; den: number };
}

export type ProjectCommand =
  | SplitClipCommand
  | TrimClipCommand
  | DeleteRangeCommand
  | MoveClipCommand
  | SetEffectCommand
  | DeleteEffectCommand
  | SetVariantOverrideCommand
  | SetCanvasStyleCommand
  | SetTrackAudioCommand
  | SetStepCommand
  | DeleteStepCommand
  | ReorderStepsCommand
  | SetMarkerCommand
  | SetActiveVariantCommand
  | SetFrameRateCommand;

export interface CommandDiff {
  kind: CommandKind;
  /** 受影响轨道 */
  tracks: TrackKind[];
  removed: TickRange[];
  added: TickRange[];
  /** 受影响的实体 ID（片段/效果/步骤等） */
  entities: string[];
}

export interface ApplyResult {
  project: Project;
  diff: CommandDiff;
}

const MIN_CLIP_TICKS = 10_000; // 1ms，短于此的分割无意义

function assertRevision(project: Project, command: ProjectCommand): void {
  if (command.expectedRevision !== project.revision) {
    throw new AppError({
      code: 'E_REVISION_CONFLICT',
      message: `工程版本已变化（期望 ${command.expectedRevision}，当前 ${project.revision}），请刷新后重试。`,
      retryable: true,
      preservedData: true,
    });
  }
}

function clipEnd(clip: { timelineInTicks: Ticks; sourceDurationTicks: Ticks; rate: { num: number; den: number } }): Ticks {
  return clip.timelineInTicks + Math.round((clip.sourceDurationTicks * clip.rate.den) / clip.rate.num);
}

/** 找到包含某时间线 tick 的所有轨道片段（用于关联事务）。左闭右开：tick 落在 [start, end)。 */
function clipsAt(project: Project, tick: Ticks) {
  const hits: { kind: TrackKind; index: number }[] = [];
  for (const track of project.tracks) {
    track.clips.forEach((clip, index) => {
      if (tick > clip.timelineInTicks && tick < clipEnd(clip)) hits.push({ kind: track.kind, index });
    });
  }
  return hits;
}

/** 分割：同一次分割作用于所有关联轨（§10.2），ID 确定性生成以便命令幂等重放。 */
function splitOne(project: Project, tick: Ticks): CommandDiff {
  const diff: CommandDiff = { kind: 'SplitClip', tracks: [], removed: [], added: [], entities: [] };
  const hits = clipsAt(project, tick);
  if (hits.length === 0) return diff;
  const takenIds = collectIds(project);

  for (const track of project.tracks) {
    const nextClips: Clip[] = [];
    let touched = false;
    for (const clip of track.clips) {
      const inRange = tick > clip.timelineInTicks && tick < clipEnd(clip);
      if (!inRange) {
        nextClips.push(clip);
        continue;
      }
      const leftDurationTicks = Math.round((tick - clip.timelineInTicks) * (clip.rate.num / clip.rate.den));
      // 任一侧短于 1ms 时不做分割，避免产生无意义碎片
      if (leftDurationTicks < MIN_CLIP_TICKS || clip.sourceDurationTicks - leftDurationTicks < MIN_CLIP_TICKS) {
        nextClips.push(clip);
        continue;
      }
      const left = { ...clip, sourceDurationTicks: leftDurationTicks };
      const right = {
        ...clip,
        id: uniqueId(`${clip.id}-b`, takenIds),
        sourceInTicks: clip.sourceInTicks + leftDurationTicks,
        sourceDurationTicks: clip.sourceDurationTicks - leftDurationTicks,
        timelineInTicks: tick,
      };
      nextClips.push(left, right);
      touched = true;
      diff.added.push({ start: tick, end: clipEnd(clip) });
      diff.entities.push(left.id, right.id);
    }
    if (touched) {
      track.clips = nextClips;
      diff.tracks.push(track.kind);
    }
  }
  return diff;
}

/** 删除时间线区间；ripple 时后方片段前移（§10.2）。
 *
 * 语义要点：
 * 1. ripple 是**工程级事务**：主轨与所有关联轨（同 linkGroupId）以及任何位于删除区间
 *    之后的片段都按同一 length 前移，保证音画/摄像头/指针保持对齐。
 * 2. 事件（效果/步骤）按类型裁断（§10.1）：
 *    - privacy：被切成多段时拆成多个独立 effect，各自新 id（遮挡不能只保留第一段，
 *      否则第二段区域会重新暴露）；
 *    - zoom：只保留主段（最长段），多个镜头叠加会过度放大；
 *    - step：保留最大段并更新 imageTick，避免截图落到已删除区间；
 *    - cursor / annotation：保留主段。
 * 3. ripple 删除后，位于删除区间之后的效果与步骤时间也要同步前移。
 */
function deleteRange(project: Project, range: TickRange, ripple: boolean): CommandDiff {
  const diff: CommandDiff = { kind: 'DeleteRange', tracks: [], removed: [range], added: [], entities: [] };
  const length = range.end - range.start;
  if (length <= 0) return diff;

  // 删除区间对应的源区间（步骤/标记以源时间记录）。必须在改动片段之前计算。
  const sourceCuts = new TimeMap(project).mapTimelineRange('primaryVideo', range);
  const effectiveSourceCuts = sourceCuts.length > 0 ? sourceCuts : [{ ...range }];
  const takenIds = collectIds(project);

  for (const track of project.tracks) {
    const nextClips: Clip[] = [];
    let touched = false;
    for (const clip of track.clips) {
      const start = clip.timelineInTicks;
      const end = clipEnd(clip);
      if (end <= range.start || start >= range.end) {
        // 完全不与删除区间相交：ripple 时后方片段整体前移
        if (ripple && start >= range.end) {
          nextClips.push({ ...clip, timelineInTicks: start - length });
          touched = true;
        } else {
          nextClips.push(clip);
        }
        continue;
      }
      touched = true;
      // 区间覆盖整个片段 → 删除
      if (start >= range.start && end <= range.end) {
        diff.entities.push(clip.id);
        continue;
      }
      // 只切掉头部（片段起点在删除区间之前，尾部被覆盖）
      if (start < range.start && end <= range.end) {
        const keep = range.start - start;
        const keepSource = Math.round(keep * (clip.rate.num / clip.rate.den));
        if (keepSource < MIN_CLIP_TICKS) {
          diff.entities.push(clip.id);
          continue;
        }
        nextClips.push({ ...clip, sourceDurationTicks: keepSource });
        continue;
      }
      // 只切掉尾部（片段起点在删除区间内或之后）
      if (start >= range.start && end > range.end) {
        const drop = range.end - start;
        const dropSource = Math.round(drop * (clip.rate.num / clip.rate.den));
        const newDuration = clip.sourceDurationTicks - dropSource;
        if (newDuration < MIN_CLIP_TICKS) {
          diff.entities.push(clip.id);
          continue;
        }
        nextClips.push({
          ...clip,
          sourceInTicks: clip.sourceInTicks + dropSource,
          sourceDurationTicks: newDuration,
          timelineInTicks: ripple ? range.start : start,
        });
        continue;
      }
      // 中间挖空 → 切成两段
      const leftKeep = range.start - start;
      const leftSource = Math.round(leftKeep * (clip.rate.num / clip.rate.den));
      const rightDropSource = Math.round((range.end - start) * (clip.rate.num / clip.rate.den));
      const rightDuration = clip.sourceDurationTicks - rightDropSource;
      if (leftSource < MIN_CLIP_TICKS || rightDuration < MIN_CLIP_TICKS) {
        // 一段太短：退化为只保留较长的一段，避免产生 1ms 级碎片
        if (leftSource >= rightDuration) {
          nextClips.push({ ...clip, sourceDurationTicks: Math.max(MIN_CLIP_TICKS, leftSource) });
        } else {
          nextClips.push({
            ...clip,
            sourceInTicks: clip.sourceInTicks + rightDropSource,
            sourceDurationTicks: Math.max(MIN_CLIP_TICKS, rightDuration),
            timelineInTicks: ripple ? range.start : range.end,
          });
        }
        continue;
      }
      nextClips.push({ ...clip, sourceDurationTicks: leftSource });
      nextClips.push({
        ...clip,
        id: uniqueId(`${clip.id}-r`, takenIds),
        sourceInTicks: clip.sourceInTicks + rightDropSource,
        sourceDurationTicks: rightDuration,
        timelineInTicks: ripple ? range.start : range.end,
      });
    }
    if (touched) {
      nextClips.sort((a, b) => a.timelineInTicks - b.timelineInTicks);
      track.clips = nextClips;
      diff.tracks.push(track.kind);
    }
  }

  // ---- 效果：按类型裁断，并随 ripple 前移 ----
  const nextEffects: Effect[] = [];
  let privacyChanged = false;
  for (const effect of project.effects) {
    const pieces = TimeMap.subtractRemoved(effect.range, [range]);
    if (pieces.length === 0) {
      privacyChanged = privacyChanged || effect.kind === 'privacy';
      diff.entities.push(effect.id);
      continue;
    }
    const unchanged = pieces.length === 1 && pieces[0].start === effect.range.start && pieces[0].end === effect.range.end;
    if (unchanged) {
      nextEffects.push(ripple && effect.range.start >= range.end ? shiftEffect(effect, -length) : effect);
      continue;
    }
    const shifted = pieces.map((piece) => (ripple && piece.start >= range.end ? shiftRange(piece, -length) : piece));
    privacyChanged = privacyChanged || effect.kind === 'privacy';
    diff.entities.push(effect.id);
    if (effect.kind === 'privacy' || effect.kind === 'annotation') {
      // 拆成多个独立效果，各自新 id：每个片段都要继续生效
      shifted.forEach((piece, index) => {
        const id = index === 0 ? effect.id : uniqueId(`${effect.id}-p`, takenIds);
        nextEffects.push({ ...effect, id, range: piece });
        if (index > 0) diff.entities.push(id);
        diff.added.push(piece);
      });
    } else {
      // zoom / cursor：只保留最长主段，避免叠加
      const main = pickLongest(shifted);
      nextEffects.push({ ...effect, range: main });
      diff.added.push(main);
    }
  }
  project.effects = nextEffects.sort((a, b) => a.range.start - b.range.start);
  if (privacyChanged) project.privacyVersion += 1;

  // ---- 步骤：保留最大段并更新 imageTick ----
  const nextSteps: TutorialStep[] = [];
  for (const step of project.steps) {
    const pieces = TimeMap.subtractRemoved(step.sourceRange, effectiveSourceCuts);
    if (pieces.length === 0) {
      diff.entities.push(step.id);
      continue;
    }
    const main = pickLongest(pieces);
    if (main.start === step.sourceRange.start && main.end === step.sourceRange.end) {
      nextSteps.push(step);
      continue;
    }
    const imageTick = Math.min(Math.max(step.imageTick, main.start), Math.max(main.start, main.end - 1));
    nextSteps.push({ ...step, sourceRange: main, imageTick });
    diff.entities.push(step.id);
  }
  project.steps = nextSteps.sort((a, b) => a.sourceRange.start - b.sourceRange.start);

  // ---- 标记：落在被删除源区间内的删除 ----
  project.markers = project.markers.filter(
    (m) => !effectiveSourceCuts.some((cut) => m.mediaTick >= cut.start && m.mediaTick < cut.end),
  );

  return diff;
}

function shiftRange(r: TickRange, delta: Ticks): TickRange {
  return { start: Math.max(0, r.start + delta), end: Math.max(0, r.end + delta) };
}

function shiftEffect(effect: Effect, delta: Ticks): Effect {
  return { ...effect, range: shiftRange(effect.range, delta) };
}

function pickLongest(ranges: readonly TickRange[]): TickRange {
  let best = ranges[0];
  for (const r of ranges) if (rangeLength(r) > rangeLength(best)) best = r;
  return { start: best.start, end: best.end };
}

/** 收集工程中已存在的实体 ID，供新 ID 去重（保证同一命令结果确定）。 */
function collectIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) ids.add(clip.id);
  for (const effect of project.effects) ids.add(effect.id);
  for (const step of project.steps) ids.add(step.id);
  return ids;
}

/** 确定性 ID：base、base-2、base-3… 中第一个未占用的。 */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  taken.add(id);
  return id;
}

/** 执行一条命令，返回新工程（不改动传入对象）。 */
export function applyCommand(project: Project, command: ProjectCommand): ApplyResult {
  assertRevision(project, command);
  const next = cloneProject(project);
  let diff: CommandDiff;

  switch (command.kind) {
    case 'SplitClip': {
      diff = splitOne(next, command.timelineTick);
      break;
    }
    case 'TrimClip': {
      diff = { kind: 'TrimClip', tracks: [], removed: [], added: [], entities: [command.clipId] };
      for (const track of next.tracks) {
        const clip = track.clips.find((c) => c.id === command.clipId);
        if (!clip) continue;
        if (command.sourceInTicks !== undefined) clip.sourceInTicks = Math.max(0, command.sourceInTicks);
        if (command.sourceDurationTicks !== undefined) {
          clip.sourceDurationTicks = Math.max(MIN_CLIP_TICKS, command.sourceDurationTicks);
        }
        if (command.timelineInTicks !== undefined) clip.timelineInTicks = Math.max(0, command.timelineInTicks);
        diff.tracks.push(track.kind);
      }
      if (diff.tracks.length === 0) throw invalidCommand(`片段 ${command.clipId} 不存在`);
      break;
    }
    case 'DeleteRange': {
      diff = deleteRange(next, command.range, command.ripple);
      break;
    }
    case 'MoveClip': {
      diff = { kind: 'MoveClip', tracks: [], removed: [], added: [], entities: [command.clipId] };
      for (const track of next.tracks) {
        const clip = track.clips.find((c) => c.id === command.clipId);
        if (!clip) continue;
        clip.timelineInTicks = Math.max(0, command.timelineInTicks);
        track.clips.sort((a, b) => a.timelineInTicks - b.timelineInTicks);
        diff.tracks.push(track.kind);
      }
      if (diff.tracks.length === 0) throw invalidCommand(`片段 ${command.clipId} 不存在`);
      break;
    }
    case 'SetEffect': {
      const index = next.effects.findIndex((e) => e.id === command.effect.id);
      // §10.3：人工修改后切换 manual 并锁定，自动重生成不得覆盖。
      // 因此 SetEffect（人工编辑命令）默认 locked=true，只有显式传 lock:false 才不锁。
      const effect: Effect = {
        ...command.effect,
        origin: command.effect.origin ?? 'manual',
        locked: command.lock ?? true,
      };
      if (index >= 0) next.effects[index] = effect;
      else next.effects.push(effect);
      if (effect.kind === 'privacy') next.privacyVersion += 1;
      diff = { kind: 'SetEffect', tracks: [], removed: [], added: [effect.range], entities: [effect.id] };
      break;
    }
    case 'DeleteEffect': {
      const before = next.effects.length;
      const target = next.effects.find((e) => e.id === command.effectId);
      next.effects = next.effects.filter((e) => e.id !== command.effectId);
      if (next.effects.length === before) throw invalidCommand(`效果 ${command.effectId} 不存在`);
      if (target?.kind === 'privacy') next.privacyVersion += 1;
      diff = {
        kind: 'DeleteEffect',
        tracks: [],
        removed: target ? [target.range] : [],
        added: [],
        entities: [command.effectId],
      };
      break;
    }
    case 'SetVariantOverride': {
      const variant = next.variants.find((v) => v.id === command.variantId);
      if (!variant) throw invalidCommand(`画幅 ${command.variantId} 不存在`);
      variant.layoutOverrides = command.layoutOverrides;
      diff = { kind: 'SetVariantOverride', tracks: [], removed: [], added: [], entities: [variant.id] };
      break;
    }
    case 'SetCanvasStyle': {
      next.settings.canvas = { ...next.settings.canvas, ...command.canvas };
      diff = { kind: 'SetCanvasStyle', tracks: [], removed: [], added: [], entities: [] };
      break;
    }
    case 'SetTrackAudio': {
      const track = findTrack(next, command.track);
      if (!track) throw invalidCommand(`轨道 ${command.track} 不存在`);
      if (command.muted !== undefined) track.muted = command.muted;
      if (command.gain !== undefined) track.gain = Math.max(0, Math.min(4, command.gain));
      diff = { kind: 'SetTrackAudio', tracks: [track.kind], removed: [], added: [], entities: [track.id] };
      break;
    }
    case 'SetStep': {
      const index = next.steps.findIndex((s) => s.id === command.step.id);
      if (index >= 0) next.steps[index] = { ...command.step };
      else next.steps.push({ ...command.step });
      next.steps.sort((a, b) => a.sourceRange.start - b.sourceRange.start);
      diff = { kind: 'SetStep', tracks: [], removed: [], added: [command.step.sourceRange], entities: [command.step.id] };
      break;
    }
    case 'DeleteStep': {
      next.steps = next.steps.filter((s) => s.id !== command.stepId);
      diff = { kind: 'DeleteStep', tracks: [], removed: [], added: [], entities: [command.stepId] };
      break;
    }
    case 'ReorderSteps': {
      const byId = new Map(next.steps.map((s) => [s.id, s]));
      const ordered = command.orderedIds.map((id) => byId.get(id)).filter((s): s is TutorialStep => !!s);
      for (const step of next.steps) if (!command.orderedIds.includes(step.id)) ordered.push(step);
      next.steps = ordered;
      diff = { kind: 'ReorderSteps', tracks: [], removed: [], added: [], entities: command.orderedIds };
      break;
    }
    case 'SetMarker': {
      if (command.remove) {
        next.markers = next.markers.filter((m) => m.id !== command.marker.id);
      } else {
        const index = next.markers.findIndex((m) => m.id === command.marker.id);
        if (index >= 0) next.markers[index] = { ...command.marker };
        else next.markers.push({ ...command.marker });
        next.markers.sort((a, b) => a.mediaTick - b.mediaTick);
      }
      diff = { kind: 'SetMarker', tracks: [], removed: [], added: [], entities: [command.marker.id] };
      break;
    }
    case 'SetActiveVariant': {
      if (!next.variants.some((v) => v.id === command.variantId)) {
        throw invalidCommand(`画幅 ${command.variantId} 不存在`);
      }
      next.settings.activeVariantId = command.variantId;
      diff = { kind: 'SetActiveVariant', tracks: [], removed: [], added: [], entities: [command.variantId] };
      break;
    }
    case 'SetFrameRate': {
      next.settings.fps = { ...command.fps };
      diff = { kind: 'SetFrameRate', tracks: [], removed: [], added: [], entities: [] };
      break;
    }
    default: {
      const exhaustive: never = command;
      throw invalidCommand(`未知命令 ${(exhaustive as { kind?: string }).kind}`);
    }
  }

  next.revision = project.revision + 1;
  next.updatedAt = Date.now();
  // 规整主轨，保证时长可计算
  void timelineDuration(next);
  return { project: next, diff };
}

function invalidCommand(detail: string): AppError {
  return new AppError({
    code: 'E_INVALID_COMMAND',
    message: '编辑命令无法执行，请刷新工程后重试。',
    retryable: false,
    preservedData: true,
    detail,
  });
}

// ---------------------------------------------------------------------------
// 撤销栈
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  command: ProjectCommand;
  /** 命令执行前的工程快照，用于撤销 */
  before: Project;
  /** 命令执行后的工程快照，用于重做（保证重做内容与首次执行完全一致） */
  after?: Project;
  diff: CommandDiff;
  label: string;
  timestamp: number;
}

export const MAX_HISTORY = 200;

/**
 * 撤销/重做时必须保持 revision 单调递增（§13.2）。
 *
 * 外部（主进程、渲染层缓存、导出快照）持有 revision 判断工程是否变化；
 * 如果撤销把 revision 回退到旧值，外部会误判「工程没变」而继续使用过期缓存，
 * 或者误判版本冲突。因此内容回到旧状态，但 revision 必须取 current.revision + 1。
 */
function snapshotAtRevision(source: Project, revision: number): Project {
  const copy = cloneProject(source);
  copy.revision = revision;
  copy.updatedAt = Date.now();
  return copy;
}

export class CommandHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /** 执行命令并记录撤销点；返回新工程。 */
  execute(project: Project, command: ProjectCommand, label?: string): ApplyResult {
    const result = applyCommand(project, command);
    this.undoStack.push({
      command,
      before: project,
      after: result.project,
      diff: result.diff,
      label: label ?? describeCommand(command),
      timestamp: Date.now(),
    });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    return result;
  }

  /**
   * 撤销：内容回到命令执行前，但 revision = current.revision + 1（不回退）。
   * 无历史时返回 null。
   */
  undo(current: Project): Project | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return snapshotAtRevision(entry.before, current.revision + 1);
  }

  /**
   * 重做：内容回到命令执行后，revision 同样继续递增。
   * 无重做历史时返回 null。
   */
  redo(current: Project): Project | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    // after 缺省（外部构造的历史）时回退到重放命令，仍保证 revision 递增
    if (!entry.after) {
      const result = applyCommand(current, { ...entry.command, expectedRevision: current.revision });
      return result.project;
    }
    return snapshotAtRevision(entry.after, current.revision + 1);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get depth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }
}

// ---------------------------------------------------------------------------
// 幂等执行与版本冲突重试
// ---------------------------------------------------------------------------

export interface IdempotentResult extends ApplyResult {
  /** 是否命中了幂等缓存（未真正执行） */
  deduped: boolean;
}

/**
 * 按命令 ID（requestId）去重的执行器（§14.1 幂等结果）。
 *
 * 同一 requestId 重复执行（用户重复点击、IPC 重发、取消竞争后重试）返回同一结果，
 * 不会把同一个操作执行两次。缓存按 command.id 记录。
 */
export class IdempotentCommandRunner {
  private readonly cache = new Map<string, ApplyResult>();

  execute(project: Project, command: ProjectCommand): IdempotentResult {
    const cached = this.cache.get(command.id);
    if (cached) return { ...cached, deduped: true };
    const result = applyCommand(project, command);
    this.cache.set(command.id, result);
    return { ...result, deduped: false };
  }

  has(requestId: string): boolean {
    return this.cache.has(requestId);
  }

  /** 取回已执行结果（用于重复请求直接回放） */
  get(requestId: string): ApplyResult | undefined {
    return this.cache.get(requestId);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * 版本冲突重试：先用新 revision 重新绑定命令，再执行（§10.2 先刷新状态再重试）。
 * 若命令依赖的实体在新版本中已不存在，applyCommand 会抛 E_INVALID_COMMAND。
 */
export function rebaseCommand(project: Project, command: ProjectCommand): ProjectCommand {
  return { ...command, expectedRevision: project.revision };
}

export function describeCommand(command: ProjectCommand): string {
  switch (command.kind) {
    case 'SplitClip':
      return '分割片段';
    case 'TrimClip':
      return '裁剪片段';
    case 'DeleteRange':
      return command.ripple ? '删除区间（波纹）' : '删除区间';
    case 'MoveClip':
      return '移动片段';
    case 'SetEffect':
      return command.effect?.kind === 'zoom' ? '调整运镜' : command.effect?.kind === 'privacy' ? '调整遮挡' : '调整效果';
    case 'DeleteEffect':
      return '删除效果';
    case 'SetVariantOverride':
      return '调整画幅布局';
    case 'SetCanvasStyle':
      return '调整画布样式';
    case 'SetTrackAudio':
      return '调整轨道音量';
    case 'SetStep':
      return '编辑教程步骤';
    case 'DeleteStep':
      return '删除教程步骤';
    case 'ReorderSteps':
      return '重排教程步骤';
    case 'SetMarker':
      return command.remove ? '删除标记' : '添加标记';
    case 'SetActiveVariant':
      return '切换画幅';
    case 'SetFrameRate':
      return '切换帧率';
    default:
      return '编辑操作';
  }
}

/**
 * 对联合类型逐个成员做 Omit。
 * 直接用 `Omit<ProjectCommand, K>` 只会保留所有成员的公共字段，
 * 导致 `{ kind: 'DeleteRange', range }` 这类对象字面量无法通过类型检查。
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 构造命令时可省略的字段（id 与 expectedRevision 由 makeCommand 填充）。 */
export type CommandSpec = DistributiveOmit<ProjectCommand, 'id' | 'expectedRevision'>;

/**
 * makeCommand 的入参类型。
 *
 * 同时接受「分发后的 Omit」和「联合类型整体的 Omit」：
 * 前者让 `{ kind: 'DeleteRange', range }` 这类字面量能直接推断，
 * 后者兼容调用方已有的 `as Omit<ProjectCommand, 'id' | 'expectedRevision'>` 断言，
 * 避免为了类型细节去改调用方代码。
 */
export type CommandSpecInput<T extends ProjectCommand = ProjectCommand> =
  | DistributiveOmit<T, 'id' | 'expectedRevision'>
  | Omit<ProjectCommand, 'id' | 'expectedRevision'>;

/** 便捷构造命令（自动填 id 与 expectedRevision）。 */
export function makeCommand<T extends ProjectCommand = ProjectCommand>(
  project: Project,
  command: CommandSpecInput<T>,
): T {
  return {
    ...command,
    id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    expectedRevision: project.revision,
  } as unknown as T;
}
