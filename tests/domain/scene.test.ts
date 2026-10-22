import { describe, it, expect } from 'vitest';
import {
  evaluateScene,
  outputSizeForAspect,
  fitRect,
  screenRectPx,
  sourceToOutput,
  zoomEffectAt,
  stepAt,
  hasContent,
  sceneDuration,
  defaultZoomParams,
} from '../../src/domain/scene';
import { createEmptyProject } from '../../src/domain/project';
import type { Project, Effect } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function projectWithContent(): Project {
  const project = createEmptyProject('p1', 'scene');
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
  return project;
}

function zoomEffect(id: string, start: number, end: number, scale = 2): Effect {
  return {
    id,
    kind: 'zoom',
    range: { start, end },
    parameters: { scale, focusX: 0.5, focusY: 0.5, easeInTicks: S / 2, easeOutTicks: S / 2 },
    origin: 'manual',
    locked: true,
  };
}

function privacyEffect(id: string, start: number, end: number, confirmed = true): Effect {
  return {
    id,
    kind: 'privacy',
    range: { start, end },
    anchor: 'screen',
    parameters: { x: 0.1, y: 0.2, width: 0.3, height: 0.1, anchor: 'screen', style: 'solid', confirmed },
    origin: 'manual',
    locked: true,
  };
}

describe('outputSizeForAspect', () => {
  it('16:9 → 1920×1080', () => {
    expect(outputSizeForAspect([16, 9])).toEqual({ width: 1920, height: 1080 });
  });

  it('9:16 → 1080×1920', () => {
    expect(outputSizeForAspect([9, 16])).toEqual({ width: 1080, height: 1920 });
  });

  it('1:1 → 1920×1920（长边 1920）', () => {
    expect(outputSizeForAspect([1, 1])).toEqual({ width: 1920, height: 1920 });
  });

  it('4:3 → 1920×1440', () => {
    expect(outputSizeForAspect([4, 3])).toEqual({ width: 1920, height: 1440 });
  });

  it('输出宽高都是偶数（编码器要求）', () => {
    for (const aspect of [[16, 9], [9, 16], [1, 1], [4, 3], [21, 9], [3, 2]] as [number, number][]) {
      const size = outputSizeForAspect(aspect);
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
    }
  });

  it('支持自定义长边', () => {
    expect(outputSizeForAspect([16, 9], 1280)).toEqual({ width: 1280, height: 720 });
  });
});

describe('fitRect', () => {
  it('内容比容器宽时按宽度铺满并垂直居中', () => {
    const out = fitRect(16 / 9, { x: 0, y: 0, width: 1, height: 1 });
    expect(out.width).toBe(1);
    expect(out.height).toBeCloseTo(9 / 16, 5);
    expect(out.y).toBeCloseTo((1 - 9 / 16) / 2, 5);
  });

  it('内容比容器高时按高度铺满并水平居中', () => {
    const out = fitRect(9 / 16, { x: 0, y: 0, width: 1, height: 1 });
    expect(out.height).toBe(1);
    expect(out.width).toBeCloseTo(9 / 16, 5);
    expect(out.x).toBeCloseTo((1 - 9 / 16) / 2, 5);
  });

  it('比例相同时铺满容器', () => {
    const out = fitRect(1, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    expect(out.x).toBeCloseTo(0.1, 5);
    expect(out.y).toBeCloseTo(0.1, 5);
    expect(out.width).toBeCloseTo(0.8, 5);
    expect(out.height).toBeCloseTo(0.8, 5);
  });
});

describe('evaluateScene: 基本求值', () => {
  it('命中片段时 hasSourceFrame 为 true 且给出来源 tick', () => {
    const project = projectWithContent();
    const scene = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.hasSourceFrame).toBe(true);
    expect(scene.sourceTick).toBe(2 * S);
    expect(scene.clipId).toBe('main-clip');
  });

  it('片段外 hasSourceFrame 为 false（渲染层复用上一帧）', () => {
    const project = projectWithContent();
    const scene = evaluateScene(project, 20 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.hasSourceFrame).toBe(false);
    expect(scene.sourceTick).toBeNull();
    expect(scene.clipId).toBeNull();
  });

  it('片段终点属于区间外（右开）', () => {
    const project = projectWithContent();
    const scene = evaluateScene(project, 10 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.hasSourceFrame).toBe(false);
  });

  it('输出尺寸与画幅写入场景', () => {
    const project = projectWithContent();
    const scene = evaluateScene(project, 0, { outputWidth: 1080, outputHeight: 1920, variantId: 'portrait' });
    expect(scene.outputWidth).toBe(1080);
    expect(scene.outputHeight).toBe(1920);
    expect(scene.aspect).toEqual([9, 16]);
  });

  it('色彩配置为 srgb', () => {
    const project = projectWithContent();
    expect(evaluateScene(project, 0, { outputWidth: 1920, outputHeight: 1080 }).colorSpace).toBe('srgb');
  });

  it('空工程可求值（无内容）', () => {
    const scene = evaluateScene(createEmptyProject('p', 'e'), 0, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.hasSourceFrame).toBe(false);
    expect(scene.zoom.scale).toBe(1);
    expect(scene.camera.visible).toBe(false);
  });

  it('camera 可见性取决于摄像头轨是否有片段', () => {
    const withCam = projectWithContent();
    expect(evaluateScene(withCam, 0, { outputWidth: 1920, outputHeight: 1080 }).camera.visible).toBe(true);
    const withoutCam = projectWithContent();
    withoutCam.tracks.find((t) => t.kind === 'camera')!.clips = [];
    expect(evaluateScene(withoutCam, 0, { outputWidth: 1920, outputHeight: 1080 }).camera.visible).toBe(false);
  });
});

describe('evaluateScene: 遮挡（§11.2 / §12.2）', () => {
  it('已确认遮挡在区间内生效', () => {
    const project = projectWithContent();
    project.effects.push(privacyEffect('pv-1', 0, 5 * S));
    const scene = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.screenPrivacy).toHaveLength(1);
    expect(scene.screenPrivacy[0].effectId).toBe('pv-1');
    expect(scene.screenPrivacy[0].style).toBe('solid');
  });

  it('未确认遮挡不生效（未确认不等于已遮挡）', () => {
    const project = projectWithContent();
    project.effects.push(privacyEffect('pv-1', 0, 5 * S, false));
    expect(evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 }).screenPrivacy).toHaveLength(0);
  });

  it('区间外遮挡不生效（左闭右开）', () => {
    const project = projectWithContent();
    project.effects.push(privacyEffect('pv-1', S, 5 * S));
    expect(evaluateScene(project, 0, { outputWidth: 1920, outputHeight: 1080 }).screenPrivacy).toHaveLength(0);
    expect(evaluateScene(project, 5 * S, { outputWidth: 1920, outputHeight: 1080 }).screenPrivacy).toHaveLength(0);
    expect(evaluateScene(project, S, { outputWidth: 1920, outputHeight: 1080 }).screenPrivacy).toHaveLength(1);
  });

  it('屏幕遮挡不自动保护摄像头（§11.2）', () => {
    const project = projectWithContent();
    project.effects.push(privacyEffect('pv-1', 0, 5 * S));
    const scene = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.screenPrivacy).toHaveLength(1);
    expect(scene.camera.privacy).toHaveLength(0);
  });

  it('多个遮挡同时生效', () => {
    const project = projectWithContent();
    project.effects.push(privacyEffect('pv-1', 0, 5 * S), privacyEffect('pv-2', S, 6 * S));
    expect(evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 }).screenPrivacy).toHaveLength(2);
  });
});

describe('evaluateScene: 运镜与光标', () => {
  it('运镜在区间内生效', () => {
    const project = projectWithContent();
    project.effects.push(zoomEffect('z1', 0, 5 * S, 2));
    const scene = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.zoom.scale).toBeGreaterThan(1);
    expect(scene.zoom.scale).toBeLessThanOrEqual(2);
  });

  it('运镜区间外 scale = 1', () => {
    const project = projectWithContent();
    project.effects.push(zoomEffect('z1', 0, 5 * S, 2));
    expect(evaluateScene(project, 6 * S, { outputWidth: 1920, outputHeight: 1080 }).zoom.scale).toBe(1);
  });

  it('光标默认可见但需要 pointer 输入', () => {
    const project = projectWithContent();
    const noPointer = evaluateScene(project, 0, { outputWidth: 1920, outputHeight: 1080 });
    expect(noPointer.cursor.visible).toBe(false);
    const withPointer = evaluateScene(project, 0, {
      outputWidth: 1920,
      outputHeight: 1080,
      pointer: { x: 0.3, y: 0.4, visible: true },
    });
    expect(withPointer.cursor.visible).toBe(true);
    expect(withPointer.cursor.x).toBe(0.3);
  });

  it('烧录光标模式不再叠加后期光标（避免双光标）', () => {
    const project = projectWithContent();
    project.effects.push({
      id: 'cursor-1',
      kind: 'cursor',
      range: { start: 0, end: 10 * S },
      parameters: { size: 24, clickRipple: 1, visible: true, burnedIn: true },
      origin: 'manual',
      locked: true,
    });
    const scene = evaluateScene(project, 0, {
      outputWidth: 1920,
      outputHeight: 1080,
      pointer: { x: 0.5, y: 0.5, visible: true },
    });
    expect(scene.cursor.visible).toBe(false);
  });
});

describe('evaluateScene: 标注', () => {
  it('标注在区间内生效', () => {
    const project = projectWithContent();
    project.effects.push({
      id: 'an-1',
      kind: 'annotation',
      range: { start: 0, end: 5 * S },
      parameters: { text: '注意这里', x: 0.5, y: 0.1, fontSize: 32, color: '#fff' },
      origin: 'manual',
      locked: true,
    });
    const scene = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.annotations).toHaveLength(1);
    expect(scene.annotations[0].text).toBe('注意这里');
  });

  it('标注区间外不生效', () => {
    const project = projectWithContent();
    project.effects.push({
      id: 'an-1',
      kind: 'annotation',
      range: { start: 0, end: 5 * S },
      parameters: { text: 't', x: 0.5, y: 0.1, fontSize: 32, color: '#fff' },
      origin: 'manual',
      locked: true,
    });
    expect(evaluateScene(project, 6 * S, { outputWidth: 1920, outputHeight: 1080 }).annotations).toHaveLength(0);
  });
});

describe('evaluateScene: 缓存键（预览/导出共用）', () => {
  it('同 revision/privacyVersion/tick/尺寸/画幅 → 同 cacheKey', () => {
    const project = projectWithContent();
    const a = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    const b = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(a.cacheKey).toBe(b.cacheKey);
  });

  it('revision 变化使 cacheKey 变化', () => {
    const project = projectWithContent();
    const a = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    project.revision += 1;
    const b = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it('privacyVersion 变化使 cacheKey 变化（遮挡缓存失效）', () => {
    const project = projectWithContent();
    const a = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    project.privacyVersion += 1;
    const b = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it('tick 变化使 cacheKey 变化', () => {
    const project = projectWithContent();
    const a = evaluateScene(project, 2 * S, { outputWidth: 1920, outputHeight: 1080 });
    const b = evaluateScene(project, 3 * S, { outputWidth: 1920, outputHeight: 1080 });
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });
});

describe('screenRectPx / sourceToOutput', () => {
  it('screenRectPx 换算为像素', () => {
    const project = projectWithContent();
    const scene = evaluateScene(project, 0, { outputWidth: 1920, outputHeight: 1080 });
    const px = screenRectPx(scene);
    expect(px.width).toBeCloseTo(scene.screenRect.width * 1920, 5);
    expect(px.height).toBeCloseTo(scene.screenRect.height * 1080, 5);
  });

  it('无运镜时源中心映射到屏幕中心', () => {
    const project = projectWithContent();
    const scene = evaluateScene(project, 0, { outputWidth: 1920, outputHeight: 1080 });
    const px = screenRectPx(scene);
    const out = sourceToOutput(scene, 0.5, 0.5);
    expect(out.x).toBeCloseTo(px.x + px.width / 2, 3);
    expect(out.y).toBeCloseTo(px.y + px.height / 2, 3);
  });

  it('有运镜时焦点映射到屏幕中心附近', () => {
    const project = projectWithContent();
    project.effects.push({
      ...zoomEffect('z1', 0, 10 * S, 2),
      parameters: { scale: 2, focusX: 0.25, focusY: 0.75, easeInTicks: S, easeOutTicks: S },
    });
    const scene = evaluateScene(project, 5 * S, { outputWidth: 1920, outputHeight: 1080 });
    const px = screenRectPx(scene);
    const out = sourceToOutput(scene, 0.25, 0.75);
    expect(out.x).toBeCloseTo(px.x + px.width / 2, 1);
    expect(out.y).toBeCloseTo(px.y + px.height / 2, 1);
  });

  it('运镜只映射可见窗口：窗口内的源坐标落在画布内，窗口外的被裁掉', () => {
    const project = projectWithContent();
    project.effects.push(zoomEffect('z1', 0, 10 * S, 2));
    const scene = evaluateScene(project, 5 * S, { outputWidth: 1920, outputHeight: 1080 });
    const px = screenRectPx(scene);
    const { scale, focusX, focusY } = scene.zoom;
    // 与 sourceToOutput 相同的可见窗口推导（§11.2 源裁切）
    const viewW = 1 / scale;
    const viewH = 1 / scale;
    const viewX = Math.min(Math.max(focusX - viewW / 2, 0), 1 - viewW);
    const viewY = Math.min(Math.max(focusY - viewH / 2, 0), 1 - viewH);

    // 可见窗口的四个角必须落在画布内
    for (const [nx, ny] of [
      [viewX, viewY],
      [viewX + viewW, viewY],
      [viewX, viewY + viewH],
      [viewX + viewW, viewY + viewH],
      [viewX + viewW / 2, viewY + viewH / 2],
    ]) {
      const out = sourceToOutput(scene, nx, ny);
      expect(out.x).toBeGreaterThanOrEqual(px.x - 1);
      expect(out.x).toBeLessThanOrEqual(px.x + px.width + 1);
      expect(out.y).toBeGreaterThanOrEqual(px.y - 1);
      expect(out.y).toBeLessThanOrEqual(px.y + px.height + 1);
    }

    // 窗口外的源坐标被裁掉（映射到画布外），这是放大裁切的正确行为
    const outside = sourceToOutput(scene, 0, 0);
    expect(outside.x < px.x || outside.y < px.y).toBe(true);
  });
});

describe('辅助查询', () => {
  it('zoomEffectAt 命中当前时间点运镜', () => {
    const project = projectWithContent();
    project.effects.push(zoomEffect('z1', S, 5 * S));
    expect(zoomEffectAt(project, 2 * S)?.id).toBe('z1');
    expect(zoomEffectAt(project, 0)).toBeNull();
    expect(zoomEffectAt(project, 5 * S)).toBeNull(); // 右开
  });

  it('stepAt 命中当前时间点步骤', () => {
    const project = projectWithContent();
    project.steps.push({
      id: 's1',
      sourceRange: { start: S, end: 3 * S },
      title: 't',
      description: '',
      imageTick: 2 * S,
      actionRect: null,
      source: 'marker',
      privacyVersion: 0,
    });
    expect(stepAt(project, 2 * S)?.id).toBe('s1');
    expect(stepAt(project, 3 * S)).toBeNull();
  });

  it('hasContent 反映主轨是否有片段', () => {
    expect(hasContent(projectWithContent())).toBe(true);
    expect(hasContent(createEmptyProject('p', 'e'))).toBe(false);
  });

  it('sceneDuration 与工程时长一致', () => {
    expect(sceneDuration(projectWithContent())).toBe(10 * S);
  });

  it('defaultZoomParams 给出可用默认值', () => {
    const params = defaultZoomParams();
    expect(params.scale).toBeGreaterThan(1);
    expect(params.focusX).toBe(0.5);
    expect(params.easeInTicks).toBeGreaterThan(0);
  });
});
