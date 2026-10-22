import { describe, it, expect } from 'vitest';
import {
  buildExportPlan,
  frameTickAt,
  lastFrameTick,
  frameSceneOptions,
  frameRangeForTicks,
  firstFrameAtOrAfter,
  sourceSegmentAtFrame,
  sourceTickAtFrame,
  audioIntervalsAtSample,
  buildAudioMixIntervals,
  describeExportPlan,
  DEFAULT_AUDIO_SAMPLE_RATE,
} from '../../src/domain/exportPlan';
import { evaluateScene, outputSizeForAspect } from '../../src/domain/scene';
import { createEmptyProject } from '../../src/domain/project';
import type { Project } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks, frameIndexToTicks, makeFrameRate } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function baseProject(): Project {
  const project = createEmptyProject('proj-1', 'export');
  project.assets.push(
    {
      id: 'screen-1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'h1',
      durationTicks: 20 * S,
      width: 1920,
      height: 1080,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    },
    {
      id: 'cam-1',
      kind: 'camera',
      path: 'media/camera/seg-000001.mp4',
      hash: 'h2',
      durationTicks: 20 * S,
      width: 1280,
      height: 720,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    },
    {
      id: 'mic-1',
      kind: 'mic',
      path: 'media/mic/seg-000001.wav',
      hash: 'h3',
      durationTicks: 20 * S,
      width: 0,
      height: 0,
      sampleRate: 48_000,
      channels: 1,
      createdAt: 0,
    },
    {
      id: 'sys-1',
      kind: 'system',
      path: 'media/system/seg-000001.wav',
      hash: 'h4',
      durationTicks: 20 * S,
      width: 0,
      height: 0,
      sampleRate: 48_000,
      channels: 2,
      createdAt: 0,
    },
  );
  project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
    {
      id: 'main-clip',
      assetId: 'screen-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'camera')!.clips = [
    {
      id: 'cam-clip',
      assetId: 'cam-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'mic')!.clips = [
    {
      id: 'mic-clip',
      assetId: 'mic-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'system')!.clips = [
    {
      id: 'sys-clip',
      assetId: 'sys-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  return project;
}

describe('buildExportPlan: 基本字段', () => {
  it('总帧数 = ticksToFrameCount（向上取整）', () => {
    const plan = buildExportPlan(baseProject(), { fps: { num: 30, den: 1 } });
    expect(plan.durationTicks).toBe(10 * S);
    expect(plan.totalFrames).toBe(300);
  });

  it('60fps 下总帧数翻倍', () => {
    const plan = buildExportPlan(baseProject(), { fps: { num: 60, den: 1 } });
    expect(plan.totalFrames).toBe(600);
  });

  it('非整数秒时长向上取整（不会少一帧）', () => {
    const project = baseProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].sourceDurationTicks = secondsToTicks(10.017);
    const plan = buildExportPlan(project, { fps: { num: 30, den: 1 } });
    expect(plan.totalFrames).toBe(Math.ceil((secondsToTicks(10.017) * 30) / S));
    expect(plan.totalFrames).toBeGreaterThan(300);
  });

  it('空工程总帧数为 0', () => {
    const plan = buildExportPlan(createEmptyProject('p', 'empty'));
    expect(plan.totalFrames).toBe(0);
    expect(plan.durationTicks).toBe(0);
    expect(plan.segments).toHaveLength(0);
  });

  it('输出尺寸按画幅计算并偶数对齐', () => {
    const plan = buildExportPlan(baseProject());
    expect(plan.outputWidth).toBe(1920);
    expect(plan.outputHeight).toBe(1080);
    expect(plan.outputWidth % 2).toBe(0);
    expect(plan.outputHeight % 2).toBe(0);
  });

  it('竖屏画幅输出 1080×1920', () => {
    const plan = buildExportPlan(baseProject(), { variantId: 'portrait' });
    expect(plan.aspect).toEqual([9, 16]);
    expect(plan.outputWidth).toBe(1080);
    expect(plan.outputHeight).toBe(1920);
  });

  it('方形画幅输出为长边 1920 的正方形（与 scene.outputSizeForAspect 一致）', () => {
    const plan = buildExportPlan(baseProject(), { variantId: 'square' });
    expect(plan.aspect).toEqual([1, 1]);
    expect(plan.outputWidth).toBe(plan.outputHeight);
    expect(plan.outputWidth).toBe(outputSizeForAspect([1, 1]).width);
  });

  it('profile 显式宽高优先', () => {
    const plan = buildExportPlan(baseProject(), { width: 1280, height: 721 });
    expect(plan.outputWidth).toBe(1280);
    expect(plan.outputHeight).toBe(722); // 奇数上取偶
  });

  it('不存在的画幅回退到当前画幅', () => {
    const plan = buildExportPlan(baseProject(), { variantId: 'nope' });
    expect(plan.variantId).toBe('landscape');
  });

  it('fps 可用数字传入', () => {
    const plan = buildExportPlan(baseProject(), { fps: 60 });
    expect(plan.fps).toEqual({ num: 60, den: 1 });
  });

  it('fps 缺省取工程设置', () => {
    const project = baseProject();
    project.settings.fps = makeFrameRate(24, 1);
    const plan = buildExportPlan(project);
    expect(plan.fps).toEqual({ num: 24, den: 1 });
    expect(plan.totalFrames).toBe(240);
  });

  it('记录 revision / privacyVersion / cacheKeyPrefix', () => {
    const project = baseProject();
    project.revision = 7;
    project.privacyVersion = 3;
    const plan = buildExportPlan(project);
    expect(plan.revision).toBe(7);
    expect(plan.privacyVersion).toBe(3);
    expect(plan.cacheKeyPrefix).toContain('7');
    expect(plan.cacheKeyPrefix).toContain('3');
  });

  it('计划可 JSON 序列化（跨进程传递）', () => {
    const plan = buildExportPlan(baseProject());
    const roundTrip = JSON.parse(JSON.stringify(plan));
    expect(roundTrip.totalFrames).toBe(plan.totalFrames);
    expect(roundTrip.segments.length).toBe(plan.segments.length);
  });

  it('不修改传入工程', () => {
    const project = baseProject();
    const snapshot = JSON.stringify(project);
    buildExportPlan(project, { fps: { num: 60, den: 1 } });
    expect(JSON.stringify(project)).toBe(snapshot);
  });

  it('describeExportPlan 含尺寸/帧率/帧数', () => {
    const text = describeExportPlan(buildExportPlan(baseProject(), { fps: { num: 30, den: 1 } }));
    expect(text).toContain('1920×1080');
    expect(text).toContain('300');
  });
});

describe('frameTickAt: 与预览求值一致（§11.5）', () => {
  it('帧时间点由 frameIndexToTicks 决定', () => {
    const plan = buildExportPlan(baseProject(), { fps: { num: 30, den: 1 } });
    for (const i of [0, 1, 2, 29, 30, 299]) {
      expect(frameTickAt(plan, i)).toBe(frameIndexToTicks(i, plan.fps));
    }
  });

  it('负数帧序号夹到 0', () => {
    const plan = buildExportPlan(baseProject());
    expect(frameTickAt(plan, -5)).toBe(0);
  });

  it('小数帧序号向下取整', () => {
    const plan = buildExportPlan(baseProject());
    expect(frameTickAt(plan, 2.9)).toBe(frameTickAt(plan, 2));
  });

  it('最后一帧时间点 < durationTicks', () => {
    const plan = buildExportPlan(baseProject(), { fps: { num: 30, den: 1 } });
    expect(lastFrameTick(plan)).toBeLessThan(plan.durationTicks);
    expect(lastFrameTick(plan)).toBeGreaterThan(plan.durationTicks - S / 30);
  });

  it('总帧数为 0 时最后一帧为 0', () => {
    const plan = buildExportPlan(createEmptyProject('p', 'e'));
    expect(lastFrameTick(plan)).toBe(0);
  });

  it('帧时间点严格递增', () => {
    const plan = buildExportPlan(baseProject(), { fps: { num: 30, den: 1 } });
    for (let i = 1; i < plan.totalFrames; i++) {
      expect(frameTickAt(plan, i)).toBeGreaterThan(frameTickAt(plan, i - 1));
    }
  });

  it('frameSceneOptions 与 evaluateScene 配合：每帧都能求值', () => {
    const project = baseProject();
    const plan = buildExportPlan(project, { fps: { num: 30, den: 1 } });
    const options = frameSceneOptions(plan);
    expect(options.outputWidth).toBe(plan.outputWidth);
    expect(options.variantId).toBe(plan.variantId);
    for (const i of [0, 1, 150, 299]) {
      const scene = evaluateScene(project, frameTickAt(plan, i), options);
      expect(scene.tick).toBe(frameTickAt(plan, i));
      expect(scene.outputWidth).toBe(plan.outputWidth);
      expect(scene.outputHeight).toBe(plan.outputHeight);
      expect(scene.hasSourceFrame).toBe(true);
      expect(scene.clipId).toBe('main-clip');
    }
  });

  it('导出帧时间点与预览同一 tick 得到同一 cacheKey', () => {
    const project = baseProject();
    const plan = buildExportPlan(project);
    const tick = frameTickAt(plan, 42);
    const a = evaluateScene(project, tick, frameSceneOptions(plan));
    const b = evaluateScene(project, tick, { outputWidth: plan.outputWidth, outputHeight: plan.outputHeight, variantId: plan.variantId });
    expect(a.cacheKey).toBe(b.cacheKey);
    expect(a.zoom).toEqual(b.zoom);
  });
});

describe('frameRangeForTicks / firstFrameAtOrAfter: 边界归属', () => {
  it('区间 [0, 1s) 在 30fps 下覆盖 30 帧', () => {
    const fps = makeFrameRate(30, 1);
    expect(frameRangeForTicks({ start: 0, end: S }, fps)).toEqual({ start: 0, end: 30 });
  });

  it('起点在帧中间时归到下一帧', () => {
    const fps = makeFrameRate(30, 1);
    // 第 0 帧 = 0，第 1 帧 = 333333
    expect(firstFrameAtOrAfter(1, fps)).toBe(1);
    expect(firstFrameAtOrAfter(333_332, fps)).toBe(1);
    expect(firstFrameAtOrAfter(333_333, fps)).toBe(1);
  });

  it('恰好落在帧边界时归到该帧（左闭）', () => {
    const fps = makeFrameRate(30, 1);
    for (const i of [0, 1, 5, 30]) {
      expect(firstFrameAtOrAfter(frameIndexToTicks(i, fps), fps)).toBe(i);
    }
  });

  it('空区间不产生负帧数', () => {
    const fps = makeFrameRate(30, 1);
    const out = frameRangeForTicks({ start: 5 * S, end: 5 * S }, fps);
    expect(out.end).toBeGreaterThanOrEqual(out.start);
  });

  it('firstFrameAtOrAfter 对 0 与负数返回 0', () => {
    const fps = makeFrameRate(30, 1);
    expect(firstFrameAtOrAfter(0, fps)).toBe(0);
    expect(firstFrameAtOrAfter(-100, fps)).toBe(0);
  });
});

describe('segments: 源区间与帧区间', () => {
  it('包含所有轨的片段，按时间线排序', () => {
    const plan = buildExportPlan(baseProject());
    const tracks = plan.segments.map((s) => s.track);
    expect(tracks).toContain('primaryVideo');
    expect(tracks).toContain('camera');
    expect(tracks).toContain('mic');
    expect(tracks).toContain('system');
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i].timeline.start).toBeGreaterThanOrEqual(plan.segments[i - 1].timeline.start);
    }
  });

  it('源区间 = sourceIn + sourceDuration', () => {
    const plan = buildExportPlan(baseProject());
    const seg = plan.segments.find((s) => s.track === 'primaryVideo')!;
    expect(seg.source).toEqual({ start: 0, end: 10 * S });
    expect(seg.timeline).toEqual({ start: 0, end: 10 * S });
  });

  it('frameEnd 不超过 totalFrames', () => {
    const plan = buildExportPlan(baseProject(), { fps: { num: 30, den: 1 } });
    for (const seg of plan.segments) {
      expect(seg.frameEnd).toBeLessThanOrEqual(plan.totalFrames);
      expect(seg.frameStart).toBeGreaterThanOrEqual(0);
    }
  });

  it('sourceSegmentAtFrame 命中主轨片段', () => {
    const plan = buildExportPlan(baseProject());
    const seg = sourceSegmentAtFrame(plan, 100);
    expect(seg).not.toBeNull();
    expect(seg!.clipId).toBe('main-clip');
  });

  it('sourceSegmentAtFrame 在空隙返回 null', () => {
    const project = baseProject();
    // 主轨只有 [0,2s)，但摄像头轨更长，制造空隙
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].sourceDurationTicks = 2 * S;
    project.tracks.find((t) => t.kind === 'camera')!.clips[0].sourceDurationTicks = 10 * S;
    project.tracks.find((t) => t.kind === 'camera')!.clips[0].timelineInTicks = 0;
    const plan = buildExportPlan(project);
    expect(sourceSegmentAtFrame(plan, 200)).toBeNull();
  });

  it('sourceTickAtFrame 返回源素材时间且不越界', () => {
    const project = baseProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].sourceInTicks = 3 * S;
    const plan = buildExportPlan(project);
    const tick0 = sourceTickAtFrame(plan, 0);
    expect(tick0).toBe(3 * S);
    const tickLast = sourceTickAtFrame(plan, plan.segments.find((s) => s.track === 'primaryVideo')!.frameEnd - 1);
    expect(tickLast).not.toBeNull();
    expect(tickLast!).toBeLessThan(3 * S + 10 * S);
  });

  it('sourceTickAtFrame 未命中返回 null', () => {
    const plan = buildExportPlan(createEmptyProject('p', 'e'));
    expect(sourceTickAtFrame(plan, 0)).toBeNull();
  });

  it('变速片段的帧区间按时间线长度计算', () => {
    const project = baseProject();
    const clip = project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0];
    clip.rate = { num: 2, den: 1 }; // 时间线时长 5s
    const plan = buildExportPlan(project, { fps: { num: 30, den: 1 } });
    expect(plan.durationTicks).toBe(5 * S);
    expect(plan.totalFrames).toBe(150);
    const seg = plan.segments.find((s) => s.track === 'primaryVideo')!;
    expect(seg.timeline).toEqual({ start: 0, end: 5 * S });
    expect(seg.frameEnd).toBe(150);
  });
});

describe('音频混合区间', () => {
  it('默认 48kHz、双声道', () => {
    const result = buildAudioMixIntervals(baseProject());
    expect(result.sampleRate).toBe(DEFAULT_AUDIO_SAMPLE_RATE);
    expect(result.sampleRate).toBe(48_000);
    expect(result.channels).toBe(2);
  });

  it('总采样数 = 时长 × 采样率（尾部对齐输出边界）', () => {
    const plan = buildExportPlan(baseProject());
    expect(plan.audioTotalSamples).toBe(10 * S / S * 48_000);
  });

  it('mic 与 system 两条轨都产生区间', () => {
    const plan = buildExportPlan(baseProject());
    const tracks = new Set(plan.audioIntervals.map((i) => i.track));
    expect(tracks.has('mic')).toBe(true);
    expect(tracks.has('system')).toBe(true);
  });

  it('音频区间不包含视频轨', () => {
    const plan = buildExportPlan(baseProject());
    for (const interval of plan.audioIntervals) {
      expect(['mic', 'system']).toContain(interval.track);
    }
  });

  it('采样区间 [sampleStart, sampleEnd) 左闭右开', () => {
    const plan = buildExportPlan(baseProject());
    for (const i of plan.audioIntervals) {
      expect(i.sampleEnd).toBeGreaterThan(i.sampleStart);
      expect(i.sampleStart).toBeGreaterThanOrEqual(0);
      expect(i.sampleEnd).toBeLessThanOrEqual(plan.audioTotalSamples);
    }
  });

  it('增益夹紧到 0..4，静音轨道仍保留区间', () => {
    const project = baseProject();
    const mic = project.tracks.find((t) => t.kind === 'mic')!;
    mic.gain = 99;
    mic.muted = true;
    const plan = buildExportPlan(project);
    const interval = plan.audioIntervals.find((i) => i.track === 'mic')!;
    expect(interval.gain).toBe(4);
    expect(interval.muted).toBe(true);
  });

  it('audioIntervalsAtSample 命中区间', () => {
    const plan = buildExportPlan(baseProject());
    const hits = audioIntervalsAtSample(plan, 48_000);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(48_000).toBeGreaterThanOrEqual(h.sampleStart);
      expect(48_000).toBeLessThan(h.sampleEnd);
    }
  });

  it('audioIntervalsAtSample 在区间外返回空', () => {
    const plan = buildExportPlan(baseProject());
    expect(audioIntervalsAtSample(plan, plan.audioTotalSamples + 1000)).toEqual([]);
  });

  it('sourceSampleStart 按源起点换算', () => {
    const project = baseProject();
    project.tracks.find((t) => t.kind === 'mic')!.clips[0].sourceInTicks = 2 * S;
    const plan = buildExportPlan(project);
    const interval = plan.audioIntervals.find((i) => i.track === 'mic')!;
    expect(interval.sourceSampleStart).toBe(2 * 48_000);
  });

  it('可指定采样率与声道数', () => {
    const result = buildAudioMixIntervals(baseProject(), { sampleRate: 44_100, channels: 1 });
    expect(result.sampleRate).toBe(44_100);
    expect(result.channels).toBe(1);
    expect(result.totalSamples).toBe(10 * 44_100);
  });

  it('空工程音频采样数为 0', () => {
    const result = buildAudioMixIntervals(createEmptyProject('p', 'e'));
    expect(result.totalSamples).toBe(0);
    expect(result.intervals).toHaveLength(0);
  });
});

describe('outputSizeForAspect 与 exportPlan 一致', () => {
  it('landscape/square/portrait 三种画幅输出尺寸与 scene 函数一致', () => {
    const project = baseProject();
    for (const variantId of ['landscape', 'square', 'portrait']) {
      const plan = buildExportPlan(project, { variantId });
      const expected = outputSizeForAspect(plan.aspect);
      expect(plan.outputWidth).toBe(expected.width);
      expect(plan.outputHeight).toBe(expected.height);
    }
  });
});
