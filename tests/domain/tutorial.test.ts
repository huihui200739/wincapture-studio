import { describe, it, expect } from 'vitest';
import {
  buildStepDrafts,
  mapStepsToTimeline,
  sourceTickToTimeline,
  stepTimelineTick,
  stepTimelineRange,
  timelineTickToStepSource,
  clampStepImageTick,
  stepsToMarkdown,
  stepsToHtml,
  escapeMarkdown,
  escapeHtml,
  DEFAULT_STEP_OPTIONS,
} from '../../src/domain/tutorial';
import type { RecordingMarker } from '../../src/domain/types';
import type { TutorialStep } from '../../src/domain/project';
import { createEmptyProject } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function marker(id: string, mediaTick: number, note = ''): RecordingMarker {
  return { id, mediaTick, note, createdAt: 0 };
}

function step(id: string, start: number, end: number, imageTick = start): TutorialStep {
  return {
    id,
    sourceRange: { start, end },
    title: `步骤 ${id}`,
    description: '',
    imageTick,
    actionRect: null,
    source: 'marker',
    privacyVersion: 0,
  };
}

describe('buildStepDrafts: 按标记生成步骤', () => {
  it('每个标记生成一个步骤，标题用标记备注', () => {
    const steps = buildStepDrafts({
      markers: [marker('m1', S, '打开设置'), marker('m2', 5 * S, '选择网络')],
      clicks: [],
      durationTicks: 10 * S,
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('打开设置');
    expect(steps[1].title).toBe('选择网络');
  });

  it('没有备注时使用「步骤 N 待补充说明」模板，不编造功能', () => {
    const steps = buildStepDrafts({ markers: [marker('m1', S)], clicks: [], durationTicks: 10 * S });
    expect(steps[0].title).toBe('步骤 1 待补充说明');
  });

  it('截图时间在标记之后约 300–800ms 内', () => {
    const steps = buildStepDrafts({ markers: [marker('m1', S)], clicks: [], durationTicks: 10 * S });
    const delay = steps[0].imageTick - S;
    expect(delay).toBeGreaterThanOrEqual(secondsToTicks(0.3));
    expect(delay).toBeLessThanOrEqual(secondsToTicks(0.8));
  });

  it('imageTick 不超过录制时长 − 1', () => {
    const steps = buildStepDrafts({ markers: [marker('m1', 10 * S)], clicks: [], durationTicks: 10 * S });
    expect(steps[0].imageTick).toBeLessThan(10 * S);
  });

  it('步骤按时间排序', () => {
    const steps = buildStepDrafts({
      markers: [marker('m2', 5 * S, 'b'), marker('m1', S, 'a')],
      clicks: [],
      durationTicks: 10 * S,
    });
    expect(steps.map((s) => s.title)).toEqual(['a', 'b']);
  });

  it('相邻标记在合并阈值内合并为一个步骤', () => {
    const steps = buildStepDrafts({
      markers: [marker('m1', S, '第一'), marker('m2', S + secondsToTicks(0.5), '补充')],
      clicks: [],
      durationTicks: 10 * S,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].description).toContain('补充');
  });

  it('超出录制时长的标记被过滤', () => {
    const steps = buildStepDrafts({
      markers: [marker('m1', 20 * S), marker('m2', -S)],
      clicks: [],
      durationTicks: 10 * S,
    });
    expect(steps).toHaveLength(0);
  });

  it('默认不把点击生成步骤（P0 只按标记）', () => {
    const steps = buildStepDrafts({
      markers: [],
      clicks: [{ tick: S, kind: 'down', x: 0.5, y: 0.5 }],
      durationTicks: 10 * S,
    });
    expect(steps).toHaveLength(0);
    expect(DEFAULT_STEP_OPTIONS.includeClicks).toBe(false);
  });

  it('开启 includeClicks 后按点击生成候选步骤', () => {
    const steps = buildStepDrafts(
      {
        markers: [],
        clicks: [
          { tick: S, kind: 'down', x: 0.5, y: 0.5, controlName: '确定', controlRect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } },
          { tick: 5 * S, kind: 'down', x: 0.2, y: 0.2 },
        ],
        durationTicks: 10 * S,
      },
      { includeClicks: true },
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('点击 确定');
    expect(steps[0].actionRect).not.toBeNull();
    expect(steps[1].actionRect).toBeNull();
  });

  it('步骤 ID 唯一', () => {
    const steps = buildStepDrafts({
      markers: [marker('m1', S), marker('m2', 3 * S), marker('m3', 6 * S)],
      clicks: [],
      durationTicks: 10 * S,
    });
    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sourceRange 为左闭右开且非空', () => {
    const steps = buildStepDrafts({ markers: [marker('m1', S)], clicks: [], durationTicks: 10 * S });
    for (const s of steps) {
      expect(s.sourceRange.start).toBeLessThan(s.sourceRange.end);
      expect(s.sourceRange.start).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('mapStepsToTimeline: 剪辑后重新映射', () => {
  it('映射成功的步骤不 dangling', () => {
    const steps = [step('s1', 0, S, S / 2)];
    const mapped = mapStepsToTimeline(steps, (tick) => tick + 2 * S);
    expect(mapped[0].timelineTick).toBe(2 * S);
    expect(mapped[0].dangling).toBe(false);
  });

  it('被删除的步骤标记为 dangling，不跳到错误时刻', () => {
    const steps = [step('s1', 0, S), step('s2', 5 * S, 6 * S)];
    const mapped = mapStepsToTimeline(steps, (tick) => (tick >= 5 * S ? null : tick));
    expect(mapped[0].dangling).toBe(false);
    expect(mapped[1].dangling).toBe(true);
    expect(mapped[1].timelineTick).toBeNull();
  });

  it('clampStepImageTick 夹紧到 [0, duration-1]', () => {
    expect(clampStepImageTick(step('s', 0, S, -5), 10 * S)).toBe(0);
    expect(clampStepImageTick(step('s', 0, S, 100 * S), 10 * S)).toBe(10 * S - 1);
    expect(clampStepImageTick(step('s', 0, S, S), 10 * S)).toBe(S);
  });

  it('时长为 0 时夹紧为 0', () => {
    expect(clampStepImageTick(step('s', 0, S, 5 * S), 0)).toBe(0);
  });
});

describe('stepsToMarkdown: 教程输出', () => {
  const steps = [
    { ...step('s1', 0, S, S / 2), title: '打开设置', description: '点击右上角齿轮' },
    { ...step('s2', S, 2 * S, 1.5 * S), title: '选择网络', description: '' },
  ];
  const meta = { title: '我的教程', createdAt: 1_700_000_000_000, imagePath: (_s: TutorialStep, i: number) => `assets/step-${i + 1}.png` };

  it('包含标题、步骤数、图片引用', () => {
    const md = stepsToMarkdown(steps, meta);
    expect(md).toContain('# 我的教程');
    expect(md).toContain('共 2 个步骤');
    expect(md).toContain('## 1. 打开设置');
    expect(md).toContain('![步骤 1 截图](assets/step-1.png)');
    expect(md).toContain('点击右上角齿轮');
  });

  it('操作区域按百分比输出', () => {
    const withRect = [
      { ...step('s1', 0, S), actionRect: { x: 0.25, y: 0.5, width: 0.1, height: 0.2 } },
    ];
    const md = stepsToMarkdown(withRect, meta);
    expect(md).toContain('x 25.0%');
    expect(md).toContain('宽 10.0%');
  });

  it('Markdown 特殊字符被转义（防止控件文字变成格式）', () => {
    const md = stepsToMarkdown([{ ...step('s', 0, S), title: '**加粗** [链接](x)' }], meta);
    expect(md).toContain('\\*\\*加粗\\*\\*');
    expect(md).toContain('\\[链接\\]');
  });

  it('空步骤列表仍生成合法文档', () => {
    const md = stepsToMarkdown([], meta);
    expect(md).toContain('# 我的教程');
    expect(md).toContain('共 0 个步骤');
  });
});

describe('stepsToHtml: 教程输出与转义', () => {
  const meta = { title: '教程 <测试>', createdAt: 1_700_000_000_000, imagePath: () => 'assets/step-1.png' };

  it('生成完整 HTML 文档，只引用本地资源', () => {
    const html = stepsToHtml([step('s1', 0, S)], meta);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('assets/step-1.png');
    expect(html).not.toContain('<script');
  });

  it('标题与文本被 HTML 转义（防注入）', () => {
    const html = stepsToHtml([{ ...step('s1', 0, S), title: '<img src=x onerror=alert(1)>' }], meta);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('教程 &lt;测试&gt;');
  });

  it('描述为空时不输出空段落', () => {
    const html = stepsToHtml([step('s1', 0, S)], meta);
    expect(html).not.toContain('<p class="desc"></p>');
  });

  it('escapeHtml 覆盖 5 个字符', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapeMarkdown 转义常见符号', () => {
    expect(escapeMarkdown('a*b_c')).toBe('a\\*b\\_c');
  });
});

// ---------------------------------------------------------------------------
// 回归测试：步骤生成的时间边界（空区间/越界点击/零时长/负延迟）
// ---------------------------------------------------------------------------

describe('回归：buildStepDrafts 的时间边界', () => {
  function expectValidStep(step: TutorialStep, durationTicks: number): void {
    expect(step.sourceRange.start).toBeGreaterThanOrEqual(0);
    expect(step.sourceRange.end).toBeGreaterThan(step.sourceRange.start);
    expect(step.sourceRange.start).toBeLessThan(durationTicks);
    expect(step.imageTick).toBeGreaterThanOrEqual(step.sourceRange.start);
    expect(step.imageTick).toBeLessThan(step.sourceRange.end);
  }

  it('标记恰好在录制终点时不产生空区间（imageTick 仍落在区间内）', () => {
    const steps = buildStepDrafts({
      markers: [marker('m-end', 10 * S)],
      clicks: [],
      durationTicks: 10 * S,
    });
    expect(steps).toHaveLength(1);
    expectValidStep(steps[0], 10 * S);
    expect(steps[0].imageTick).toBeLessThan(10 * S);
  });

  it('录制时长为 0 或负数时不生成步骤（旧实现 imageTick 为 -1）', () => {
    expect(buildStepDrafts({ markers: [marker('m', 0)], clicks: [], durationTicks: 0 })).toEqual([]);
    expect(buildStepDrafts({ markers: [marker('m', S)], clicks: [], durationTicks: -S })).toEqual([]);
  });

  it('越界点击不生成非法区间（负起点/反向/超出时长）', () => {
    const steps = buildStepDrafts(
      {
        markers: [],
        clicks: [
          { tick: -S, kind: 'down', x: 0.5, y: 0.5 },
          { tick: 20 * S, kind: 'down', x: 0.5, y: 0.5 },
        ],
        durationTicks: 10 * S,
      },
      { includeClicks: true },
    );
    expect(steps).toHaveLength(0);
    // 录制末尾的点击仍可生成合法步骤
    const atEnd = buildStepDrafts(
      { markers: [], clicks: [{ tick: 10 * S - 1, kind: 'down', x: 0.5, y: 0.5 }], durationTicks: 10 * S },
      { includeClicks: true },
    );
    expect(atEnd).toHaveLength(1);
    expectValidStep(atEnd[0], 10 * S);
  });

  it('负的截图延迟被夹到 0，不产生反向区间', () => {
    const steps = buildStepDrafts({
      markers: [marker('m', 5 * S)],
      clicks: [],
      durationTicks: 10 * S,
      screenshotDelayTicks: -2 * S,
    });
    expect(steps).toHaveLength(1);
    expectValidStep(steps[0], 10 * S);
  });

  it('合并后的步骤区间仍然合法（第二个标记在终点）', () => {
    const steps = buildStepDrafts({
      markers: [marker('m1', 10 * S - secondsToTicks(0.5)), marker('m2', 10 * S)],
      clicks: [],
      durationTicks: 10 * S,
    });
    expect(steps).toHaveLength(1);
    expectValidStep(steps[0], 10 * S);
  });
});

describe('步骤时间映射：源时间 ↔ 成片时间', () => {
  /** 主轨：源 5s..10s 放在时间线 0..5s（前面剪掉 5 秒）。 */
  function trimmedProject() {
    const project = createEmptyProject('p', 'trimmed');
    project.assets.push({
      id: 'screen-1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'h',
      durationTicks: 20 * S,
      width: 1920,
      height: 1080,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    });
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
      {
        id: 'clip-1',
        assetId: 'screen-1',
        sourceInTicks: 5 * S,
        sourceDurationTicks: 5 * S,
        timelineInTicks: 0,
        rate: { num: 1, den: 1 },
        linkGroupId: 'rec-1',
      },
    ];
    return project;
  }

  it('源时间减去被剪掉的前段后落到正确时间线位置', () => {
    const project = trimmedProject();
    expect(sourceTickToTimeline(project, 7 * S)).toBe(2 * S);
    expect(sourceTickToTimeline(project, 5 * S)).toBe(0);
  });

  it('被剪掉的源时刻返回 null（步骤应标为 dangling）', () => {
    const project = trimmedProject();
    expect(sourceTickToTimeline(project, 2 * S)).toBeNull();
    expect(sourceTickToTimeline(project, 12 * S)).toBeNull();
  });

  it('步骤截图时刻与区间都按同一张表映射', () => {
    const project = trimmedProject();
    const s = step('s1', 6 * S, 8 * S, 7 * S);
    expect(stepTimelineTick(project, s)).toBe(2 * S);
    expect(stepTimelineRange(project, s)).toEqual({ start: S, end: 3 * S });
  });

  it('步骤开头被裁掉后，保留的截图区间仍正确显示', () => {
    const project = trimmedProject();
    expect(stepTimelineRange(project, step('partial', 4 * S, 7 * S, 6 * S)))
      .toEqual({ start: 0, end: 2 * S });
  });

  it('倍速片段的右开终点不因 end-1 取整而多出一个 tick', () => {
    const project = trimmedProject();
    project.tracks[0].clips[0].rate = { num: 2, den: 1 };
    expect(stepTimelineRange(project, step('fast', 6 * S, 8 * S, 7 * S)))
      .toEqual({ start: S / 2, end: 1.5 * S });
  });

  it('区间起点被剪掉时不画步骤带（返回 null）', () => {
    expect(stepTimelineRange(trimmedProject(), step('s2', 0, 2 * S, S))).toBeNull();
  });

  it('成片时间可反查回步骤内的源时间（编辑截图时间用）', () => {
    const project = trimmedProject();
    const s = step('s1', 6 * S, 8 * S, 7 * S);
    expect(timelineTickToStepSource(project, s, 2 * S)).toBe(7 * S);
    // 反查结果被夹在步骤区间内
    expect(timelineTickToStepSource(project, s, 0)).toBe(6 * S);
    expect(timelineTickToStepSource(project, s, 4 * S)).toBe(8 * S - 1);
  });

  it('未修剪时映射是恒等（不破坏旧工程行为）', () => {
    const project = createEmptyProject('p2', 'plain');
    project.assets.push({
      id: 'a',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'h',
      durationTicks: 20 * S,
      width: 1920,
      height: 1080,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    });
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
      {
        id: 'c',
        assetId: 'a',
        sourceInTicks: 0,
        sourceDurationTicks: 10 * S,
        timelineInTicks: 0,
        rate: { num: 1, den: 1 },
        linkGroupId: 'g',
      },
    ];
    const s = step('s', 3 * S, 5 * S, 4 * S);
    expect(stepTimelineTick(project, s)).toBe(4 * S);
    expect(stepTimelineRange(project, s)).toEqual({ start: 3 * S, end: 5 * S });
  });
});
