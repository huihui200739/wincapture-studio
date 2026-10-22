import { describe, it, expect } from 'vitest';
import {
  buildStepDrafts,
  mapStepsToTimeline,
  clampStepImageTick,
  stepsToMarkdown,
  stepsToHtml,
  escapeMarkdown,
  escapeHtml,
  DEFAULT_STEP_OPTIONS,
} from '../../src/domain/tutorial';
import type { RecordingMarker } from '../../src/domain/types';
import type { TutorialStep } from '../../src/domain/project';
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
