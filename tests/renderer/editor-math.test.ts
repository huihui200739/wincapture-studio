/**
 * 编辑器/时间线纯逻辑单测（无 DOM）
 *
 * 这些函数都从渲染层组件里导出：UI 组件本身没有 DOM 测试环境，
 * 但坐标换算、拖拽落点、区间夹紧这些「算错了用户也看不出来、却会导出坏工程」
 * 的逻辑必须能回归。
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject, findTrack, type Clip, type Project } from '@domain/project';
import { secondsToTicks } from '@domain/timebase';
import { clipEndTick, planClipMove, planClipTrim, splittableTick } from '../../src/renderer/components/Timeline';
import {
  clampCameraRect,
  clampEffectRange,
  clampPrivacyRect,
  clampTrimSource,
} from '../../src/renderer/components/InspectorPanel';
import { displayRectToSourceRect, sourceRectToDisplayRect } from '../../src/renderer/components/PreviewCanvas';
import { waveformPaintWidth } from '../../src/renderer/components/AudioWaveform';
import {
  absoluteMediaPath,
  screenFrameKey,
  shouldUseSyntheticPreview,
} from '../../src/renderer/lib/previewSource';
import { clampImageTickForStep } from '../../src/renderer/views/TutorialView';
import { evaluateScene } from '@domain/scene';

const S = secondsToTicks(1);

function makeClip(id: string, startSeconds: number, durationSeconds: number, opts: Partial<Clip> = {}): Clip {
  return {
    id,
    assetId: 'asset-1',
    sourceInTicks: 0,
    sourceDurationTicks: secondsToTicks(durationSeconds),
    timelineInTicks: secondsToTicks(startSeconds),
    rate: { num: 1, den: 1 },
    linkGroupId: '',
    ...opts,
  };
}

function makeProject(clips: Clip[]): Project {
  const project = createEmptyProject('p-1', 'test');
  const main = findTrack(project, 'primaryVideo');
  if (!main) throw new Error('缺少主视频轨');
  main.clips = clips;
  return project;
}

describe('Timeline: planClipMove 拖拽落点', () => {
  it('画面轨空闲但关联音频会碰撞时，为整组寻找安全落点', () => {
    const p = makeProject([makeClip('main', 0, 5, { linkGroupId: 'g' })]);
    findTrack(p, 'mic')!.clips = [makeClip('mic', 0, 5, { linkGroupId: 'g' }), makeClip('other', 10, 5)];
    expect(planClipMove(p, 'main', 12 * S)?.tick).toBe(15 * S);
  });
  it('空位置直接落点', () => {
    const project = makeProject([makeClip('a', 0, 10), makeClip('b', 10, 20)]);
    // b 占 10-30，a 放到 35 之后完全空出来
    const plan = planClipMove(project, 'a', secondsToTicks(35));
    expect(plan).not.toBeNull();
    expect(plan?.tick).toBe(secondsToTicks(35));
    expect(plan?.adjusted).toBe(false);
  });

  it('紧贴下一段结束点落点是允许的（左闭右开相邻不算重叠）', () => {
    const project = makeProject([makeClip('a', 0, 10), makeClip('b', 10, 20)]);
    const plan = planClipMove(project, 'a', secondsToTicks(30));
    expect(plan?.tick).toBe(secondsToTicks(30));
    expect(plan?.adjusted).toBe(false);
  });

  it('与下一段重叠时夹到最近的不重叠位置（回退到原位置）', () => {
    const project = makeProject([makeClip('a', 0, 10), makeClip('b', 10, 20)]);
    const plan = planClipMove(project, 'a', secondsToTicks(2));
    expect(plan?.tick).toBe(0);
    expect(plan?.adjusted).toBe(true);
    expect(plan?.originTick).toBe(0);
  });

  it('把后段往前挪到重叠位置时保留原位置而不是叠上去', () => {
    const project = makeProject([makeClip('a', 0, 10), makeClip('b', 10, 20)]);
    const plan = planClipMove(project, 'b', secondsToTicks(5));
    expect(plan?.tick).toBe(secondsToTicks(10));
    expect(plan?.adjusted).toBe(true);
  });

  it('负目标位置夹到 0', () => {
    const project = makeProject([makeClip('a', 5, 5), makeClip('b', 10, 20)]);
    const plan = planClipMove(project, 'a', -S * 3);
    expect(plan?.desiredTick).toBe(0);
    expect(plan?.tick).toBe(0);
  });

  it('零长度片段不会与左闭右开区间冲突', () => {
    const project = makeProject([makeClip('a', 0, 0), makeClip('b', 10, 10)]);
    const plan = planClipMove(project, 'a', secondsToTicks(10));
    expect(plan?.tick).toBe(secondsToTicks(10));
    expect(plan?.adjusted).toBe(false);
  });

  it('片段不存在返回 null', () => {
    const project = makeProject([makeClip('a', 0, 10)]);
    expect(planClipMove(project, 'missing', 0)).toBeNull();
  });

  it('clipEndTick 计入播放速率', () => {
    const clip = makeClip('a', 0, 10, { rate: { num: 1, den: 2 } });
    expect(clipEndTick(clip)).toBe(secondsToTicks(20));
  });
});

describe('Timeline: planClipTrim 手柄裁剪', () => {
  it('拖右手柄延长片段', () => {
    const project = makeProject([makeClip('a', 0, 10)]);
    const plan = planClipTrim(project, 'a', 'right', secondsToTicks(2));
    expect(plan?.sourceDurationTicks).toBe(secondsToTicks(12));
    expect(plan?.spanTicks).toBe(secondsToTicks(12));
  });

  it('右手柄不会越过同轨下一段的起点', () => {
    const project = makeProject([makeClip('a', 0, 10), makeClip('b', 12, 5)]);
    const plan = planClipTrim(project, 'a', 'right', secondsToTicks(30));
    expect(plan?.spanTicks).toBe(secondsToTicks(12));
  });

  it('左手柄向内拖：源入点与时间线起点同步前移，长度变短', () => {
    const project = makeProject([makeClip('a', 0, 10)]);
    const plan = planClipTrim(project, 'a', 'left', secondsToTicks(3));
    expect(plan?.timelineInTicks).toBe(secondsToTicks(3));
    expect(plan?.sourceInTicks).toBe(secondsToTicks(3));
    expect(plan?.sourceDurationTicks).toBe(secondsToTicks(7));
  });

  it('左手柄不会越过同轨上一段的结束点', () => {
    const project = makeProject([makeClip('a', 0, 4), makeClip('b', 4, 10)]);
    const plan = planClipTrim(project, 'b', 'left', -secondsToTicks(5));
    expect(plan?.timelineInTicks).toBe(secondsToTicks(4));
  });

  it('最短时长被夹住（不会把片段裁成 0）', () => {
    const project = makeProject([makeClip('a', 0, 10)]);
    const plan = planClipTrim(project, 'a', 'right', -secondsToTicks(30));
    expect(plan!.sourceDurationTicks).toBeGreaterThan(0);
    expect(plan!.spanTicks).toBeGreaterThan(0);
  });

  it('片段不存在返回 null', () => {
    expect(planClipTrim(makeProject([makeClip('a', 0, 10)]), 'missing', 'left', 0)).toBeNull();
  });
});

describe('Timeline: splittableTick 分割边界', () => {
  const project = makeProject([makeClip('a', 0, 10)]);

  it('片段内部可分割', () => {
    expect(splittableTick(project, secondsToTicks(5))).toBe(true);
  });

  it('片段边界不可分割', () => {
    expect(splittableTick(project, 0)).toBe(false);
    expect(splittableTick(project, secondsToTicks(10))).toBe(false);
  });

  it('距端点不足 1ms 不可分割（与 domain MIN_CLIP_TICKS 一致）', () => {
    expect(splittableTick(project, secondsToTicks(10) - 5_000)).toBe(false);
    expect(splittableTick(project, 5_000)).toBe(false);
  });
});

describe('Inspector: 区间与几何夹紧', () => {
  it('遮挡矩形整块留在画面内', () => {
    expect(clampPrivacyRect({ x: 0.9, y: -1, width: 0.5, height: 0.2 })).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.2,
    });
  });

  it('遮挡矩形非法数值回退成最小有效矩形', () => {
    const rect = clampPrivacyRect({ x: Number.NaN, y: Number.NaN, width: Number.NaN, height: -5 });
    expect(rect).toEqual({ x: 0, y: 0, width: 0.01, height: 0.01 });
  });

  it('超宽矩形夹到 1 宽并贴左', () => {
    expect(clampPrivacyRect({ x: 0.4, y: 0, width: 3, height: 3 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it('效果区间越界夹到工程时长内', () => {
    const duration = secondsToTicks(10);
    expect(clampEffectRange({ start: secondsToTicks(20), end: secondsToTicks(21) }, duration)).toEqual({
      start: secondsToTicks(10) - 2_000_000,
      end: secondsToTicks(10),
    });
  });

  it('零长度区间被撑到最短 0.2 秒', () => {
    const duration = secondsToTicks(10);
    const range = clampEffectRange({ start: secondsToTicks(5), end: secondsToTicks(5) }, duration);
    expect(range.start).toBe(secondsToTicks(5));
    expect(range.end - range.start).toBe(2_000_000);
  });

  it('空工程返回一个非零长度区间（不会 start===end）', () => {
    const range = clampEffectRange({ start: 0, end: 0 }, 0);
    expect(range.end).toBeGreaterThan(range.start);
  });

  it('裁剪时长不超过素材剩余长度', () => {
    const clip = { sourceInTicks: secondsToTicks(1), sourceDurationTicks: secondsToTicks(5) };
    const patch = clampTrimSource(clip, secondsToTicks(8), { sourceDurationTicks: secondsToTicks(10) });
    expect(patch.sourceDurationTicks).toBe(secondsToTicks(7));
    expect(patch.sourceInTicks).toBe(secondsToTicks(1));
  });

  it('同时改源入点与时长时优先保证时长，再回推入点', () => {
    const clip = { sourceInTicks: 0, sourceDurationTicks: secondsToTicks(5) };
    const patch = clampTrimSource(clip, secondsToTicks(8), {
      sourceInTicks: secondsToTicks(7),
      sourceDurationTicks: secondsToTicks(2),
    });
    expect(patch.sourceDurationTicks).toBe(secondsToTicks(2));
    expect(patch.sourceInTicks).toBe(secondsToTicks(6));
  });

  it('素材时长未知时不限制（保持原有行为）', () => {
    const patch = clampTrimSource({ sourceInTicks: 0, sourceDurationTicks: S }, null, {
      sourceDurationTicks: secondsToTicks(100),
    });
    expect(patch.sourceDurationTicks).toBe(secondsToTicks(100));
  });

  it('摄像头画中画被夹到画布内', () => {
    const camera = {
      x: 0.95,
      y: 0.95,
      width: 0.24,
      height: 0.24,
      visible: true,
      cornerRadius: 12,
    };
    const clamped = clampCameraRect(camera);
    expect(clamped.x).toBeCloseTo(0.76, 6);
    expect(clamped.y).toBeCloseTo(0.76, 6);
    expect(clamped.width).toBe(0.24);
  });
});

describe('PreviewCanvas: 源坐标 ↔ 显示坐标（含运镜）', () => {
  const rect = { x: 0.3, y: 0.25, width: 0.2, height: 0.1 };

  it('无运镜时往返一致', () => {
    const project = createEmptyProject('p-1', 'test');
    const scene = evaluateScene(project, 0, { outputWidth: 1280, outputHeight: 720 });
    const display = sourceRectToDisplayRect(scene, rect);
    const back = displayRectToSourceRect(scene, display);
    expect(back.x).toBeCloseTo(rect.x, 6);
    expect(back.y).toBeCloseTo(rect.y, 6);
    expect(back.width).toBeCloseTo(rect.width, 6);
    expect(back.height).toBeCloseTo(rect.height, 6);
  });

  it('2× 运镜时往返一致（框选必须按逆变换写回源坐标）', () => {
    const project = createEmptyProject('p-1', 'test');
    project.effects.push({
      id: 'zoom-1',
      kind: 'zoom',
      range: { start: 0, end: secondsToTicks(10) },
      parameters: { scale: 2, focusX: 0.3, focusY: 0.6, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    const scene = evaluateScene(project, secondsToTicks(5), { outputWidth: 1280, outputHeight: 720 });
    expect(scene.zoom.scale).toBeCloseTo(2, 6);
    const display = sourceRectToDisplayRect(scene, rect);
    const back = displayRectToSourceRect(scene, display);
    expect(back.x).toBeCloseTo(rect.x, 6);
    expect(back.y).toBeCloseTo(rect.y, 6);
    expect(back.width).toBeCloseTo(rect.width, 6);
    expect(back.height).toBeCloseTo(rect.height, 6);
  });

  it('运镜下同一显示框换算出的源框比无运镜时更小（放大后框选更精确）', () => {
    const project = createEmptyProject('p-1', 'test');
    const plain = evaluateScene(project, 0, { outputWidth: 1280, outputHeight: 720 });
    const zoomedProject = createEmptyProject('p-1', 'test');
    zoomedProject.effects.push({
      id: 'zoom-1',
      kind: 'zoom',
      range: { start: 0, end: secondsToTicks(10) },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    const zoomed = evaluateScene(zoomedProject, secondsToTicks(5), { outputWidth: 1280, outputHeight: 720 });
    const a = displayRectToSourceRect(plain, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 });
    const b = displayRectToSourceRect(zoomed, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 });
    expect(b.width).toBeCloseTo(a.width / 2, 6);
  });
});

describe('AudioWaveform: 画布宽度上限', () => {
  it('普通宽度原样返回', () => {
    expect(waveformPaintWidth(320)).toBe(320);
  });

  it('超宽片段被限制在上限内（避免超过浏览器最大 canvas 尺寸）', () => {
    expect(waveformPaintWidth(612_000)).toBe(4096);
  });

  it('非法宽度回退到 1', () => {
    expect(waveformPaintWidth(Number.NaN)).toBe(1);
    expect(waveformPaintWidth(-10)).toBe(1);
  });
});

describe('预览画面来源：真实工程不得回退到合成演示画面（P0）', () => {
  it('node/无 window.wcs 环境判定为 mock，才允许 synthetic', () => {
    expect(shouldUseSyntheticPreview()).toBe(true);
  });

  it('工程相对路径补成 IPC 可读的绝对路径', () => {
    expect(absoluteMediaPath('C:\\proj\\demo.wcaproj', 'media/screen/seg-1.mp4')).toBe(
      'C:\\proj\\demo.wcaproj\\media\\screen\\seg-1.mp4',
    );
  });

  it('已经是绝对路径时原样返回', () => {
    expect(absoluteMediaPath('C:\\proj\\demo.wcaproj', 'D:\\media\\seg-1.mp4')).toBe('D:\\media\\seg-1.mp4');
  });

  it('解码缓存键跟随片段与源时间变化', () => {
    const project = createEmptyProject('p-1', 'test');
    const scene = evaluateScene(project, 0, { outputWidth: 1280, outputHeight: 720 });
    expect(screenFrameKey(scene)).toBe('');
    const withHit = {
      ...scene,
      hasSourceFrame: true,
      clipId: 'clip-1',
      sourceTick: secondsToTicks(2),
    };
    expect(screenFrameKey(withHit)).toBe(`clip-1@${secondsToTicks(2)}`);
    expect(screenFrameKey({ ...withHit, sourceTick: secondsToTicks(3) })).not.toBe(screenFrameKey(withHit));
  });
});

describe('Tutorial: 截图时间夹紧', () => {
  const range = { start: secondsToTicks(2), end: secondsToTicks(8) };

  it('区间内的值原样保留', () => {
    expect(clampImageTickForStep(secondsToTicks(5), range, secondsToTicks(10))).toBe(secondsToTicks(5));
  });

  it('小于开始时间的值夹到开始时间', () => {
    expect(clampImageTickForStep(0, range, secondsToTicks(10))).toBe(secondsToTicks(2));
  });

  it('越过结束时间的值夹到结束前一个 tick', () => {
    expect(clampImageTickForStep(secondsToTicks(9), range, secondsToTicks(10))).toBe(secondsToTicks(8) - 1);
  });

  it('空工程不会返回负数', () => {
    expect(clampImageTickForStep(-100, { start: 0, end: 100 }, 0)).toBe(0);
  });
});
