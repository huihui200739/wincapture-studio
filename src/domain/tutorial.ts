/**
 * 操作事件 → 图文教程步骤（开发文档 §12.1 / §5.2）
 *
 * P0 只按人工标记生成草稿：不承诺自动理解全部操作。
 * 每个步骤包含标题、说明、截图、操作区域和对应视频时间；
 * 用户可以合并、拆分、删除或替换截图。
 */

import type { Project, TutorialStep } from './project';
import { findTrack } from './project';
import type { RecordingMarker, PointerEventLike } from './types';
import type { Ticks, TickRange } from './timebase';
import { secondsToTicks } from './timebase';
import { TimeMap } from './timeMap';

export interface StepBuilderInput {
  markers: readonly RecordingMarker[];
  clicks: readonly PointerEventLike[];
  /** 录制总时长，用于夹紧时间 */
  durationTicks: Ticks;
  /** 截图延迟：点击后约 300–800ms 内视觉稳定的一帧（§12.1） */
  screenshotDelayTicks?: Ticks;
}

export interface StepDraftOptions {
  /** 是否把点击事件也生成步骤（P0 默认 false，只按标记） */
  includeClicks: boolean;
  /** 相邻标记合并的时间阈值 */
  mergeGapTicks: Ticks;
}

export const DEFAULT_STEP_OPTIONS: StepDraftOptions = {
  includeClicks: false,
  mergeGapTicks: secondsToTicks(1.2),
};

/**
 * 合法录制时长：非有限值或 <= 0 视为没有可截图的画面。
 * 最后可用 tick 是 duration - 1（区间右开），因此所有时间都要夹紧到 [0, duration)。
 */
function usableDuration(value: Ticks): Ticks {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function safeDelay(value: Ticks | undefined): Ticks {
  const fallback = secondsToTicks(0.55);
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

/**
 * 由事件时间生成合法的步骤窗口。
 * 必须保证 sourceRange 非空（start < end 且 start < duration），
 * 且 imageTick 落在 sourceRange 内——否则会生成无法截图/无法通过校验的步骤。
 */
function stepWindow(
  duration: Ticks,
  eventTick: Ticks,
  delay: Ticks,
): { start: Ticks; end: Ticks; imageTick: Ticks } {
  const start = Math.min(duration - 1, Math.max(0, Math.round(eventTick)));
  const end = Math.min(duration, Math.max(start + 1, start + delay * 2));
  const imageTick = Math.min(end - 1, Math.max(start, start + delay));
  return { start, end, imageTick };
}

/**
 * 由标记生成步骤草稿。
 * 标题使用模板填空，没有读到控件名称时显示「步骤 N 待补充说明」，不编造页面功能。
 */
export function buildStepDrafts(
  input: StepBuilderInput,
  options: Partial<StepDraftOptions> = {},
): TutorialStep[] {
  const opt = { ...DEFAULT_STEP_OPTIONS, ...options };
  const delay = safeDelay(input.screenshotDelayTicks);
  const duration = usableDuration(input.durationTicks);
  const marks =
    duration <= 0
      ? []
      : input.markers
          .filter((m) => m && Number.isFinite(m.mediaTick) && m.mediaTick >= 0 && m.mediaTick <= duration)
          .slice()
          .sort((a, b) => a.mediaTick - b.mediaTick);

  const steps: TutorialStep[] = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const prev = marks[i - 1];
    // 与上一个标记过近：视为同一操作阶段，合并（保留后一个的时间点，note 拼接）
    if (prev && mark.mediaTick - prev.mediaTick <= opt.mergeGapTicks && steps.length > 0) {
      const last = steps[steps.length - 1];
      const end = Math.min(duration, Math.max(last.sourceRange.end, mark.mediaTick));
      last.sourceRange = { start: last.sourceRange.start, end: Math.max(last.sourceRange.start + 1, end) };
      last.imageTick = Math.min(last.sourceRange.end - 1, Math.max(last.sourceRange.start, last.imageTick));
      if (mark.note && !last.description.includes(mark.note)) {
        last.description = last.description ? `${last.description} ${mark.note}` : mark.note;
      }
      continue;
    }
    const window = stepWindow(duration, mark.mediaTick, delay);
    const title = mark.note.trim() ? mark.note.trim() : `步骤 ${steps.length + 1} 待补充说明`;
    steps.push({
      id: `step-${i + 1}-${Math.random().toString(36).slice(2, 6)}`,
      sourceRange: { start: window.start, end: window.end },
      title,
      description: '',
      imageTick: window.imageTick,
      actionRect: null,
      source: 'marker',
      privacyVersion: 0,
    });
  }

  if (opt.includeClicks && duration > 0) {
    const clickSteps = buildClickSteps(input.clicks, duration, delay, steps.length);
    steps.push(...clickSteps);
    steps.sort((a, b) => a.sourceRange.start - b.sourceRange.start);
  }

  return steps.map((s, index) => ({ ...s, title: s.title || `步骤 ${index + 1} 待补充说明` }));
}

/** P1 能力：按点击事件生成候选步骤（MVP 默认关闭）。 */
function buildClickSteps(
  clicks: readonly PointerEventLike[],
  durationTicks: Ticks,
  delay: Ticks,
  startIndex: number,
): TutorialStep[] {
  const sorted = clicks
    .filter((c) => c && c.kind === 'down' && Number.isFinite(c.tick) && c.tick >= 0 && c.tick < durationTicks)
    .sort((a, b) => a.tick - b.tick);
  const steps: TutorialStep[] = [];
  let lastTick = -Infinity;
  for (const click of sorted) {
    if (click.tick - lastTick < secondsToTicks(0.8)) continue;
    lastTick = click.tick;
    const rect = click.controlRect ?? null;
    const window = stepWindow(durationTicks, click.tick, delay);
    steps.push({
      id: `step-click-${steps.length + 1}`,
      sourceRange: { start: window.start, end: window.end },
      title: click.controlName ? `点击 ${click.controlName}` : `步骤 ${startIndex + steps.length + 1} 待补充说明`,
      description: '',
      imageTick: window.imageTick,
      actionRect: rect,
      source: 'click',
      privacyVersion: 0,
    });
  }
  return steps;
}

/**
 * 步骤随剪辑重新映射（§12.1）：
 * 已被删除的步骤标记为 dangling，界面提示用户确认，禁止跳到错误视频时刻。
 */
export interface MappedStep {
  step: TutorialStep;
  /** 映射后的成片时间；null 表示已被剪辑删除 */
  timelineTick: Ticks | null;
  dangling: boolean;
}

export function mapStepsToTimeline(
  steps: readonly TutorialStep[],
  mapSource: (sourceTick: Ticks) => Ticks | null,
): MappedStep[] {
  return steps.map((step) => {
    const mapped = mapSource(step.sourceRange.start);
    return { step, timelineTick: mapped, dangling: mapped === null };
  });
}

/**
 * 源/媒体时间 → 成片时间线时间。
 *
 * 步骤记录的是「源时间」（标记、点击都出现在录制素材的媒体时间轴上），
 * 而播放头、预览、导出都用成片时间线时间。修剪/删除/重排之后两者不再相等，
 * 渲染前必须过这一层映射，否则步骤缩略图会拍到错位的画面。
 *
 * @returns null 表示该源时刻已经不在成片里（被剪掉），调用方应标为 dangling
 */
export function sourceTickToTimeline(
  project: Project,
  sourceTick: Ticks,
  map: TimeMap = new TimeMap(project),
): Ticks | null {
  const track = findTrack(project, 'primaryVideo');
  if (!track || !Number.isFinite(sourceTick)) return null;
  const tick = Math.round(sourceTick);
  let best: Ticks | null = null;
  for (const clip of track.clips) {
    for (const hit of map.toTimeline('primaryVideo', clip.assetId, tick)) {
      // 同一段源画面可能被引用多次：取成片里最靠前的那个位置，行为确定可复现
      if (best === null || hit.timelineTick < best) best = hit.timelineTick;
    }
  }
  return best;
}

/** 步骤截图时刻映射到成片时间；该时刻已被剪掉时返回 null。 */
export function stepTimelineTick(
  project: Project,
  step: TutorialStep,
  map: TimeMap = new TimeMap(project),
): Ticks | null {
  return sourceTickToTimeline(project, step.imageTick, map);
}

/** Map one surviving step region; never span unrelated clips after reordering. */
export function stepTimelineRange(
  project: Project,
  step: TutorialStep,
  map: TimeMap = new TimeMap(project),
): TickRange | null {
  const candidates: { range: TickRange; containsImage: boolean }[] = [];
  for (const clip of findTrack(project, 'primaryVideo')?.clips ?? []) {
    const a = Math.max(step.sourceRange.start, clip.sourceInTicks);
    const b = Math.min(step.sourceRange.end, clip.sourceInTicks + clip.sourceDurationTicks);
    if (b <= a) continue;
    const start = map.toTimeline('primaryVideo', clip.assetId, a)
      .find((hit) => hit.clip.id === clip.id)?.timelineTick;
    if (start === undefined) continue;
    const end = clip.timelineInTicks + Math.round((b - clip.sourceInTicks) * clip.rate.den / clip.rate.num);
    candidates.push({ range: { start, end: Math.max(start + 1, end) },
      containsImage: step.imageTick >= a && step.imageTick < b });
  }
  candidates.sort((a, b) => Number(b.containsImage) - Number(a.containsImage) ||
    (b.range.end - b.range.start) - (a.range.end - a.range.start) || a.range.start - b.range.start);
  return candidates[0]?.range ?? null;
}

/**
 * 成片时间 → 步骤区间内的源时间（编辑「截图时间」时把用户输入换算回存储字段）。
 * 目标时刻不在主轨片段内时返回 null。
 */
export function timelineTickToStepSource(
  project: Project,
  step: TutorialStep,
  timelineTick: Ticks,
  map: TimeMap = new TimeMap(project),
): Ticks | null {
  if (!Number.isFinite(timelineTick)) return null;
  const hit = map.toSource('primaryVideo', Math.round(timelineTick));
  if (!hit) return null;
  const lower = step.sourceRange.start;
  const upper = Math.max(lower, step.sourceRange.end - 1);
  return Math.min(upper, Math.max(lower, hit.sourceTick));
}

/** 步骤截图时间夹紧到有效范围，避免取到已删除区间。 */
export function clampStepImageTick(step: TutorialStep, durationTicks: Ticks): Ticks {
  return Math.min(Math.max(0, step.imageTick), Math.max(0, durationTicks - 1));
}

/** 生成 Markdown 教程（§5.2 首发支持 Markdown、静态 HTML 和图片目录） */
export function stepsToMarkdown(
  steps: readonly TutorialStep[],
  meta: { title: string; createdAt: number; imagePath: (step: TutorialStep, index: number) => string },
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  lines.push(`> 由 WinCapture Studio 生成于 ${new Date(meta.createdAt).toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push(`共 ${steps.length} 个步骤。`);
  lines.push('');
  steps.forEach((step, index) => {
    lines.push(`## ${index + 1}. ${escapeMarkdown(step.title)}`);
    lines.push('');
    if (step.description.trim()) {
      lines.push(escapeMarkdown(step.description));
      lines.push('');
    }
    lines.push(`![步骤 ${index + 1} 截图](${meta.imagePath(step, index)})`);
    lines.push('');
    if (step.actionRect) {
      const r = step.actionRect;
      lines.push(`操作区域：x ${(r.x * 100).toFixed(1)}% · y ${(r.y * 100).toFixed(1)}% · 宽 ${(r.width * 100).toFixed(1)}% · 高 ${(r.height * 100).toFixed(1)}%`);
      lines.push('');
    }
  });
  return lines.join('\n');
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 生成静态 HTML 教程；只引用本地资源，不依赖第三方脚本（§5.2）。 */
export function stepsToHtml(
  steps: readonly TutorialStep[],
  meta: { title: string; createdAt: number; imagePath: (step: TutorialStep, index: number) => string },
): string {
  const cards = steps
    .map((step, index) => {
      const desc = step.description.trim() ? `<p class="desc">${escapeHtml(step.description)}</p>` : '';
      return `    <li class="step">
      <h2><span class="num">${index + 1}</span>${escapeHtml(step.title)}</h2>
      ${desc}
      <img src="${escapeHtml(meta.imagePath(step, index))}" alt="步骤 ${index + 1} 截图" loading="lazy">
    </li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px 64px; font-family: "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
         background: #f5f6f8; color: #1b1f24; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .meta { color: #5c6672; font-size: 13px; margin-bottom: 28px; }
  ol.steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 22px; }
  li.step { background: #fff; border: 1px solid #e2e6eb; border-radius: 14px; padding: 20px;
            box-shadow: 0 6px 20px rgba(20,30,45,.06); }
  h2 { font-size: 18px; margin: 0 0 10px; display: flex; align-items: center; gap: 10px; }
  .num { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
         background: #2f6df6; color: #fff; font-size: 14px; }
  .desc { color: #404a56; margin: 0 0 12px; line-height: 1.6; white-space: pre-wrap; }
  img { max-width: 100%; border-radius: 10px; border: 1px solid #e2e6eb; display: block; }
  @media (prefers-color-scheme: dark) {
    body { background: #14181d; color: #e7ecf2; }
    li.step { background: #1c2229; border-color: #2b3440; box-shadow: none; }
    .desc { color: #b7c2cf; }
    img { border-color: #2b3440; }
    .meta { color: #93a1b1; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(meta.title)}</h1>
  <p class="meta">由 WinCapture Studio 生成于 ${escapeHtml(new Date(meta.createdAt).toLocaleString('zh-CN'))} · 共 ${steps.length} 个步骤</p>
  <ol class="steps">
${cards}
  </ol>
</main>
</body>
</html>
`;
}
