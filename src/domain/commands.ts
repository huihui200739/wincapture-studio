/**
 * 剪辑命令与撤销（开发文档 §10.2）
 *
 * - 所有编辑都是显式命令，携带命令 ID、目标工程版本和修改前后差异。
 * - 同一次删除作为一个事务作用于所有关联轨道。
 * - 连续拖动只在结束时形成一条撤销记录。
 * - 工程版本冲突时先刷新状态再重试，不能覆盖后到的更新。
 */

import type { Project, Effect, TutorialStep, CanvasVariant, TrackKind, Clip, ZoomParameters } from './project';
import { cloneProject, findTrack, timelineDuration } from './project';
import type { Ticks, TickRange } from './timebase';
import { rangeLength } from './timebase';
import { TimeMap } from './timeMap';
import { AppError } from '../shared/errors';
import { planGroupMove, linkedClips } from './clipEditing';
import { retimeClip } from './retime';
import { regenerateAutoZoom } from './zoom';

export type CommandKind =
  | 'SplitClip'
  | 'TrimClip'
  | 'DeleteRange'
  | 'MoveClip'
  | 'SetClipRate'
  | 'SetEffect'
  | 'RegenerateAutoZoom'
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

export interface SetClipRateCommand extends CommandBase {
  kind: 'SetClipRate';
  clipId: string;
  rate: Clip['rate'];
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

export interface RegenerateAutoZoomCommand extends CommandBase {
  kind: 'RegenerateAutoZoom';
  planned: Effect[];
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
  | SetClipRateCommand
  | SetEffectCommand
  | RegenerateAutoZoomCommand
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
        linkGroupId: clip.linkGroupId ? `${clip.linkGroupId}:split:${tick}` : '',
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
          // ripple：后方内容前移到删除区间起点；非 ripple：存活内容保持原时间线位置，
          // 因此起点必须落到 range.end（删除区间右开边界），否则音画会整体提前。
          timelineInTicks: ripple ? range.start : range.end,
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
        linkGroupId: clip.linkGroupId ? `${clip.linkGroupId}:cut:${range.end}` : '',
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
      const piece = { ...effect, range: main };
      if (effect.kind === 'zoom') {
        const params = effect.parameters as ZoomParameters;
        piece.parameters = { ...params, focusPath: params.focusPath?.filter(p => p.tick < range.start || p.tick >= range.end)
          .map(p => ({ ...p, tick: ripple && p.tick >= range.end ? p.tick - length : p.tick })) };
      }
      nextEffects.push(piece);
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
  const next = { ...effect, range: shiftRange(effect.range, delta) };
  if (effect.kind === 'zoom') {
    const params = effect.parameters as ZoomParameters;
    next.parameters = { ...params, focusPath: params.focusPath?.map(p => ({ ...p, tick: Math.max(0, p.tick + delta) })) };
  }
  return next;
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

/**
 * 片段在时间线上占据的长度。
 *
 * rate 是「播放速度倍数」：rate=2 表示源 10s 只占时间线 5s，
 * 因此时长 = sourceDuration × den/num（与 TimeMap 的 source = timeline × rate 互逆）。
 */
function timelineSpanOf(clip: Clip): Ticks {
  const num = clip.rate.num > 0 ? clip.rate.num : 1;
  const den = clip.rate.den > 0 ? clip.rate.den : 1;
  return Math.round((clip.sourceDurationTicks * den) / num);
}

/** 在执行中的工程里按 ID 找片段及其所属轨道。 */
function findClipById(
  project: Project,
  clipId: string,
): { clip: Clip; track: Project['tracks'][number] } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

/**
 * 与给定片段共用 linkGroupId 的全部片段（含自身）。
 *
 * 录制产物按「画面 / 摄像头 / 麦克风 / 系统声音」各一条片段，共用同一个 linkGroupId；
 * 编辑时必须整组移动，否则音画会从移动点开始永久错位。
 * linkGroupId 为空表示未关联，只有它自己。
 */
function groupClips(project: Project, clip: Clip): Clip[] {
  return linkedClips(project, clip);
}

/** 深拷贝命令载荷后再写入工程。
 *
 * applyCommand 的契约是「返回新工程、不改动传入对象」，但只浅拷贝命令里的
 * effect/canvas/layoutOverrides 会让工程与调用方共享同一个 parameters 对象：
 * 调用方之后修改自己持有的命令对象，工程内容就悄悄变了而 revision 不变，
 * 依赖 cacheKey 的预览缓存、以及历史里的 after 快照都会失真。
 */
function clonePayload<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

function assertEditedClips(project: Project, ids: readonly string[]): void {
  for (const track of project.tracks) {
    for (const clip of track.clips.filter((c) => ids.includes(c.id))) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset && asset.durationTicks > 0 && clip.sourceInTicks + clip.sourceDurationTicks > asset.durationTicks) {
        throw invalidCommand('裁剪范围超过关联素材可用长度');
      }
      if (track.clips.some((other) => other.id !== clip.id &&
        clip.timelineInTicks < clipEnd(other) && other.timelineInTicks < clipEnd(clip))) {
        throw invalidCommand('裁剪范围与同轨或关联轨道上的其它片段重叠');
      }
    }
  }
}

/** 执行一条命令，返回新工程（不改动传入对象）。 */
export function applyCommand(project: Project, command: ProjectCommand): ApplyResult {
  assertRevision(project, command);
  const next = cloneProject(project);
  let diff: CommandDiff;

  switch (command.kind) {
    case 'SplitClip': {
      assertFiniteTick('分割时间', command.timelineTick);
      diff = splitOne(next, command.timelineTick);
      break;
    }
    case 'TrimClip': {
      if (command.sourceInTicks !== undefined) assertFiniteTick('源起点', command.sourceInTicks);
      if (command.sourceDurationTicks !== undefined) assertFiniteTick('源时长', command.sourceDurationTicks);
      if (command.timelineInTicks !== undefined) assertFiniteTick('时间线起点', command.timelineInTicks);
      diff = { kind: 'TrimClip', tracks: [], removed: [], added: [], entities: [command.clipId] };
      for (const track of next.tracks) {
        const clip = track.clips.find((c) => c.id === command.clipId);
        if (!clip) continue;
        const oldStart = clip.timelineInTicks;
        const oldEnd = oldStart + timelineSpanOf(clip);
        const oldSourceIn = clip.sourceInTicks;
        if (command.sourceInTicks !== undefined) clip.sourceInTicks = Math.max(0, command.sourceInTicks);
        if (command.sourceDurationTicks !== undefined) {
          clip.sourceDurationTicks = Math.max(MIN_CLIP_TICKS, command.sourceDurationTicks);
        }
        if (command.timelineInTicks !== undefined) clip.timelineInTicks = Math.max(0, command.timelineInTicks);

        // 关联组联动裁剪：录制的画面/摄像头/麦克风/系统声音必须保持等长且同起点。
        // 只裁其中一条会让另一条多出（或缺少）一段，导出时音画从裁剪点开始错位。
        // 左边缘变化同时平移起点与源入点；右边缘变化只改时长（扩展时不动，
        // 音频比画面短本来就是「末尾静音」的正常结果）。
        const newStart = clip.timelineInTicks;
        const newEnd = newStart + timelineSpanOf(clip);
        const leftDelta = newStart - oldStart;
        const endShift = newEnd - oldEnd;
        const sourceShift = (clip.sourceInTicks - oldSourceIn) / (clip.rate.num / clip.rate.den);
        const spanShift = (newEnd - newStart) - (oldEnd - oldStart);
        const linked = groupClips(next, clip);
        if (leftDelta !== 0 || spanShift !== 0 || sourceShift !== 0) {
          for (const other of linked) {
            if (other.id === clip.id) continue;
            const otherRate = other.rate.den > 0 ? other.rate.num / other.rate.den : 1;
            other.timelineInTicks += leftDelta;
            other.sourceInTicks += Math.round(sourceShift * otherRate);
            other.sourceDurationTicks += Math.round(spanShift * otherRate);
            if (other.timelineInTicks < 0 || other.sourceInTicks < 0 || other.sourceDurationTicks < MIN_CLIP_TICKS) {
              throw invalidCommand('关联片段没有足够的源素材完成这次裁剪');
            }
            if (!diff.entities.includes(other.id)) diff.entities.push(other.id);
          }
        }

        // ripple：裁剪改变片段在时间线上的长度后，同轨后续片段跟着前移/后移，
        // 不留空隙也不重叠（与 DeleteRange 的波纹语义一致）。
        // 旧实现声明了 ripple 字段却从不读取，传 true 也毫无效果且无提示。
        if (command.ripple) {
          const delta = endShift;
          if (delta !== 0) {
            for (const linkedTrack of next.tracks) {
              for (const other of linkedTrack.clips) {
                if (linked.includes(other)) continue;
                if (other.timelineInTicks >= oldEnd) {
                  other.timelineInTicks = Math.max(0, other.timelineInTicks + delta);
                  if (!diff.entities.includes(other.id)) diff.entities.push(other.id);
                }
              }
              linkedTrack.clips.sort((a, b) => a.timelineInTicks - b.timelineInTicks);
            }
          }
        }
        diff.tracks.push(track.kind);
      }
      if (diff.tracks.length === 0) throw invalidCommand(`片段 ${command.clipId} 不存在`);
      assertEditedClips(next, diff.entities);
      diff.tracks = next.tracks.filter((t) => t.clips.some((c) => diff.entities.includes(c.id))).map((t) => t.kind);
      break;
    }
    case 'DeleteRange': {
      // 空区间（start === end）是合法的 no-op；负起点或反向区间会破坏时间线，直接拒绝。
      assertRange('删除区间', command.range);
      diff = deleteRange(next, command.range, command.ripple);
      break;
    }
    case 'MoveClip': {
      assertFiniteTick('时间线起点', command.timelineInTicks);
      diff = { kind: 'MoveClip', tracks: [], removed: [], added: [], entities: [command.clipId] };
      const target = findClipById(next, command.clipId);
      if (!target) throw invalidCommand(`片段 ${command.clipId} 不存在`);
      const plan = planGroupMove(next, command.clipId, command.timelineInTicks);
      if (plan && plan.tick !== Math.max(0, Math.round(command.timelineInTicks))) {
        throw invalidCommand('目标位置与关联轨道片段重叠，或会使关联片段越过时间线起点');
      }
      // 关联组联动：录制的画面/摄像头/麦克风/系统声音共用同一个 linkGroupId，
      // 只移动其中一个会让音画从此错位（导出按各自片段的位置混音）。
      // 这里按整组平移，delta 以被拖动的片段为准。
      const group = groupClips(next, target.clip);
      const delta = Math.round(command.timelineInTicks) - target.clip.timelineInTicks;
      // 整组都不能被推到 0 之前：按组内最靠前的片段限制
      const earliest = Math.min(...group.map((clip) => clip.timelineInTicks));
      const applied = Math.max(delta, -earliest);
      if (applied !== 0) {
        for (const track of next.tracks) {
          let touched = false;
          for (const clip of track.clips) {
            if (!group.includes(clip)) continue;
            clip.timelineInTicks = Math.max(0, clip.timelineInTicks + applied);
            touched = true;
            if (clip.id !== command.clipId) diff.entities.push(clip.id);
          }
          if (touched) {
            track.clips.sort((a, b) => a.timelineInTicks - b.timelineInTicks);
            diff.tracks.push(track.kind);
          }
        }
      }
      // 即使 delta 为 0（拖回原位）也要如实报告涉及的轨道，界面据此刷新
      for (const track of next.tracks) {
        if (diff.tracks.includes(track.kind)) continue;
        if (track.clips.some((clip) => group.includes(clip))) diff.tracks.push(track.kind);
      }
      break;
    }
    case 'SetClipRate': {
      const target = findClipById(next, command.clipId);
      if (!target || target.track.kind !== 'primaryVideo') throw invalidCommand('请选择主视频片段调整速度');
      try {
        const entities = retimeClip(next, target.clip, command.rate);
        assertEditedClips(next, entities);
        diff = { kind: 'SetClipRate', tracks: next.tracks.filter((t) => t.clips.some((c) => entities.includes(c.id))).map((t) => t.kind),
          removed: [], added: [], entities };
      } catch (error) {
        throw invalidCommand(error instanceof Error ? error.message : '无法调整片段速度');
      }
      break;
    }
    case 'RegenerateAutoZoom': {
      for (const effect of command.planned) {
        if (effect.kind !== 'zoom' || effect.origin !== 'automatic' || effect.locked) throw invalidCommand('自动运镜数据无效');
        assertRange('自动运镜区间', effect.range, true);
      }
      const removed = next.effects.filter(e => e.kind === 'zoom' && e.origin === 'automatic' && !e.locked);
      next.effects = regenerateAutoZoom(next.effects, command.planned);
      diff = { kind: command.kind, tracks: [], removed: removed.map(e => e.range),
        added: command.planned.map(e => e.range), entities: next.effects.filter(e => e.kind === 'zoom').map(e => e.id) };
      break;
    }
    case 'SetEffect': {
      if (!command.effect || typeof command.effect !== 'object') throw invalidCommand('效果数据缺失');
      assertRange('效果区间', command.effect.range, true);
      const index = next.effects.findIndex((e) => e.id === command.effect.id);
      // §10.3：人工修改后切换 manual 并锁定，自动重生成不得覆盖。
      // 因此 SetEffect（人工编辑命令）默认 locked=true，只有显式传 lock:false 才不锁。
      const effect: Effect = {
        ...clonePayload(command.effect),
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
      variant.layoutOverrides = clonePayload(command.layoutOverrides);
      diff = { kind: 'SetVariantOverride', tracks: [], removed: [], added: [], entities: [variant.id] };
      break;
    }
    case 'SetCanvasStyle': {
      next.settings.canvas = { ...next.settings.canvas, ...clonePayload(command.canvas) };
      diff = { kind: 'SetCanvasStyle', tracks: [], removed: [], added: [], entities: [] };
      break;
    }
    case 'SetTrackAudio': {
      const track = findTrack(next, command.track);
      if (!track) throw invalidCommand(`轨道 ${command.track} 不存在`);
      if (command.muted !== undefined) track.muted = command.muted;
      if (command.gain !== undefined) {
        assertFiniteTick('轨道增益', command.gain);
        track.gain = Math.max(0, Math.min(4, command.gain));
      }
      diff = { kind: 'SetTrackAudio', tracks: [track.kind], removed: [], added: [], entities: [track.id] };
      break;
    }
    case 'SetStep': {
      if (!command.step || typeof command.step !== 'object') throw invalidCommand('步骤数据缺失');
      assertRange('步骤源区间', command.step.sourceRange, true);
      assertFiniteTick('步骤截图时间', command.step.imageTick);
      const index = next.steps.findIndex((s) => s.id === command.step.id);
      const step = clonePayload(command.step);
      if (index >= 0) next.steps[index] = step;
      else next.steps.push(step);
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
      // 去重：重复 id 只会排列一次，否则 steps 中会出现同 ID 的多份副本。
      const seen = new Set<string>();
      const ordered: TutorialStep[] = [];
      for (const id of command.orderedIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const step = byId.get(id);
        if (step) ordered.push(step);
      }
      for (const step of next.steps) if (!seen.has(step.id)) ordered.push(step);
      next.steps = ordered;
      diff = { kind: 'ReorderSteps', tracks: [], removed: [], added: [], entities: [...seen] };
      break;
    }
    case 'SetMarker': {
      if (!command.marker || typeof command.marker !== 'object') throw invalidCommand('标记数据缺失');
      assertFiniteTick('标记时间', command.marker.mediaTick);
      if (command.marker.mediaTick < 0) throw invalidCommand(`标记时间不能为负（${command.marker.mediaTick}）`);
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
      // 帧率是有理数，den=0 会让 frameIndexToTicks / ticksToFrameCount 立刻变成 NaN/Infinity。
      if (
        !command.fps ||
        !Number.isFinite(command.fps.num) ||
        !Number.isFinite(command.fps.den) ||
        command.fps.num <= 0 ||
        command.fps.den <= 0
      ) {
        throw invalidCommand(`帧率必须是正有理数（收到 ${JSON.stringify(command.fps)}）`);
      }
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
    message: detail,
    retryable: false,
    preservedData: true,
    detail,
  });
}

/**
 * 拒绝非有限 tick。
 *
 * 命令参数来自 IPC / 界面输入，NaN/Infinity 一旦写入时间字段会污染整个工程
 * （timelineDuration、导出计划、缓存键全部变成 NaN），且无法再通过撤销以外的方式恢复。
 * 因此必须在命令入口拦截，抛 E_INVALID_COMMAND 而不是静默 clamp。
 */
function assertFiniteTick(label: string, value: number): void {
  if (!Number.isFinite(value)) throw invalidCommand(`${label} 必须是有限数字（收到 ${String(value)}）`);
}

/** 校验时间区间：有限、非负、start <= end（空区间在某些命令中合法）。 */
function assertRange(label: string, range: TickRange | null | undefined, requireNonEmpty = false): void {
  if (!range || typeof range !== 'object') throw invalidCommand(`${label} 缺失`);
  assertFiniteTick(`${label}起点`, range.start);
  assertFiniteTick(`${label}终点`, range.end);
  if (range.start < 0) throw invalidCommand(`${label}起点不能为负（${range.start}）`);
  if (requireNonEmpty ? range.start >= range.end : range.end < range.start) {
    throw invalidCommand(`${label}必须满足 ${requireNonEmpty ? 'start < end' : 'start <= end'}`);
  }
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
    case 'SetClipRate':
      return '调整播放速度';
    case 'SetEffect':
      return command.effect?.kind === 'zoom' ? '调整运镜' : command.effect?.kind === 'privacy' ? '调整遮挡' : '调整效果';
    case 'RegenerateAutoZoom':
      return '根据鼠标生成运镜';
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
