/**
 * src/media/compositor.ts 审计回归测试。
 *
 * 覆盖：
 *  - CSS linear-gradient 角度语义（此前 y 分量取反，导致背景样块与预览上下翻转）；
 *  - 源坐标遮挡在运镜下的映射（导出/预览/教程截图同一条绘制路径）；
 *  - 三种遮挡样式（实色 / 模糊 / 马赛克）确实产生绘制；
 *  - 光标、点击波纹、摄像头画中画（cover 裁切）、标注、编辑辅助层；
 *  - 未确认遮挡不进入成片（§13.2「未确认不等于已遮挡」）；
 *  - 无源帧时画占位而不是保留脏画面。
 */

import { describe, it, expect } from 'vitest';
import {
  drawScene,
  drawScreenPrivacy,
  mapSourceRectToScreen,
  cssLinearGradientGeometry,
  frameCacheKey,
  type SceneResources,
} from '../../src/media/compositor';
import { evaluateScene, screenRectPx, type FrameScene } from '../../src/domain/scene';
import { createEmptyProject } from '../../src/domain/project';
import type { Project } from '../../src/domain/project';
import { TICKS_PER_SECOND } from '../../src/domain/timebase';
import { Fake2DContext } from './helpers';

const S = TICKS_PER_SECOND;
const TICK = 0.5 * S;

function makeCtx(): Fake2DContext {
  return new Fake2DContext({ width: 1920, height: 1080 });
}

function baseProject(): Project {
  const project = createEmptyProject('proj-compositor', 'compositor');
  project.assets.push(
    {
      id: 'screen-1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'h1',
      durationTicks: 10 * S,
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
      durationTicks: 10 * S,
      width: 640,
      height: 480,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    },
  );
  project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
    {
      id: 'clip-screen',
      assetId: 'screen-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'link-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'camera')!.clips = [
    {
      id: 'clip-camera',
      assetId: 'cam-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'link-1',
    },
  ];
  return project;
}

function privacyEffect(
  id: string,
  style: 'solid' | 'blur' | 'mosaic',
  confirmed = true,
  rect = { x: 0.2, y: 0.3, width: 0.2, height: 0.2 },
): Project['effects'][number] {
  return {
    id,
    kind: 'privacy',
    range: { start: 0, end: 10 * S },
    anchor: 'screen',
    parameters: { ...rect, anchor: 'screen', style, confirmed },
    origin: 'manual',
    locked: false,
  };
}

function screenResources(): SceneResources {
  return {
    screen: { width: 1920, height: 1080 } as unknown as CanvasImageSource,
    screenWidth: 1920,
    screenHeight: 1080,
    camera: null,
    cursor: null,
  };
}

// ---------------------------------------------------------------------------
// 渐变几何
// ---------------------------------------------------------------------------

describe('CSS linear-gradient 几何', () => {
  it('180deg = 从顶部到底部（first stop 在顶部）', () => {
    const g = cssLinearGradientGeometry(180, 100, 100);
    expect(g.x0).toBeCloseTo(50, 6);
    expect(g.y0).toBeCloseTo(0, 6);
    expect(g.x1).toBeCloseTo(50, 6);
    expect(g.y1).toBeCloseTo(100, 6);
  });

  it('0deg = 从底部到顶部；90deg = 从左到右', () => {
    const up = cssLinearGradientGeometry(0, 100, 100);
    expect(up.y0).toBeCloseTo(100, 6);
    expect(up.y1).toBeCloseTo(0, 6);

    const right = cssLinearGradientGeometry(90, 200, 100);
    expect(right.x0).toBeCloseTo(0, 6);
    expect(right.x1).toBeCloseTo(200, 6);
  });

  it('150deg 指向右下（与 CSS 预览方向一致），且渐变线覆盖四角投影', () => {
    const g = cssLinearGradientGeometry(150, 100, 100);
    expect(g.x1).toBeGreaterThan(g.x0);
    expect(g.y1).toBeGreaterThan(g.y0); // 右下
    const length = Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
    expect(length).toBeCloseTo((Math.abs(100 * Math.sin((150 * Math.PI) / 180)) + Math.abs(100 * Math.cos((150 * Math.PI) / 180))) / 1, 6);
  });

  it('drawScene 使用与 CSS 一致的渐变端点', () => {
    const project = baseProject();
    project.settings.canvas.background = 'linear-gradient(180deg, #1b2432, #0d1219)';
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    const ctx = makeCtx();
    drawScene(ctx as any, scene, screenResources());

    const gradientOp = ctx.opsOf('createLinearGradient')[0];
    expect(gradientOp).toBeDefined();
    const gradient = gradientOp.args[0] as { x0: number; y0: number; x1: number; y1: number; stops: any[] };
    expect(gradient.y0).toBeCloseTo(0, 3);
    expect(gradient.y1).toBeCloseTo(1080, 3);
    expect(gradient.stops.map((s) => s.color)).toEqual(['#1b2432', '#0d1219']);
    expect(gradient.stops[0].offset).toBe(0);
    expect(gradient.stops[1].offset).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 遮挡绘制
// ---------------------------------------------------------------------------

describe('遮挡绘制', () => {
  it('点击反馈为零时不画波纹，圆点样式使用圆形绘制', () => {
    const project = baseProject();
    project.effects.push({ id: 'cursor', kind: 'cursor', range: { start: 0, end: S }, locked: false, origin: 'manual',
      parameters: { size: 26, visible: true, burnedIn: false, clickRipple: 0, style: 'dot' } });
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080,
      pointer: { x: 0.5, y: 0.5, visible: true, clickProgress: 0.5 } });
    const ctx = makeCtx();
    drawScene(ctx as any, scene, screenResources());
    // Rounded corners use arcTo; arc belongs only to the dot, with no ripple.
    expect(ctx.opsOf('arc')).toHaveLength(1);
    expect(ctx.opsOf('arc')[0].args[2]).toBeCloseTo(26 * 0.3);
  });
  const view = { x: 0, y: 0, width: 1, height: 1 };
  const target = { x: 0, y: 0, width: 1000, height: 500 };
  const rect = { x: 0.1, y: 0.2, width: 0.2, height: 0.4 };

  it('mapSourceRectToScreen 按取景窗口映射（含留黑边）', () => {
    expect(mapSourceRectToScreen(rect, view, target)).toEqual({ x: 100, y: 100, width: 200, height: 200 });

    const zoomed = mapSourceRectToScreen(rect, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, target);
    expect(zoomed.x).toBeCloseTo(-300, 6);
    expect(zoomed.y).toBeCloseTo(-50, 6);    expect(zoomed.width).toBeCloseTo(400, 6);
    expect(zoomed.height).toBeCloseTo(400, 6);
  });

  it('实色遮挡使用不透明黑覆盖', () => {
    const ctx = makeCtx();
    drawScreenPrivacy(ctx as any, [{ rect, style: 'solid', effectId: 'p1' }], view, target);
    const fills = ctx.opsOf('fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].args.slice(0, 4)).toEqual([100, 100, 200, 200]);
    expect(fills[0].args[4]).toBe('#000000');
  });

  it('模糊与马赛克样式各自产生对应绘制（不是只画一次实色）', () => {
    const ctx = makeCtx();
    drawScreenPrivacy(
      ctx as any,
      [
        { rect, style: 'blur', effectId: 'p-blur' },
        { rect, style: 'mosaic', effectId: 'p-mosaic' },
      ],
      view,
      target,
    );
    const styles = ctx.opsOf('fillRect').map((op) => op.args[4]);
    expect(styles).toContain('rgba(0,0,0,0.88)');
    expect(styles).toContain('rgba(24,24,24,0.94)');
    // 马赛克网格线
    expect(ctx.opsOf('stroke').length).toBeGreaterThan(10);
  });

  it('零宽/零高遮挡被跳过', () => {
    const ctx = makeCtx();
    drawScreenPrivacy(
      ctx as any,
      [
        { rect: { x: 0.1, y: 0.1, width: 0, height: 0.2 }, style: 'solid', effectId: 'zero-w' },
        { rect: { x: 0.1, y: 0.1, width: 0.2, height: 0 }, style: 'solid', effectId: 'zero-h' },
      ],
      view,
      target,
    );
    expect(ctx.opsOf('fillRect')).toHaveLength(0);
  });

  it('drawScene 在运镜下把遮挡映射到正确像素（随画面放大）', () => {
    const project = baseProject();
    project.effects.push(privacyEffect('privacy-solid', 'solid'));
    project.effects.push(privacyEffect('privacy-unconfirmed', 'solid', false));
    project.effects.push({
      id: 'zoom-1',
      kind: 'zoom',
      range: { start: 0, end: 10 * S },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 1, easeOutTicks: 1 },
      origin: 'manual',
      locked: false,
    });
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    const ctx = makeCtx();
    drawScene(ctx as any, scene, screenResources());

    // 只画已确认的那一条（未确认遮挡不进入成片）
    const privacyFills = ctx.opsOf('fillRect').filter((op) => op.args[4] === '#000000');
    expect(privacyFills).toHaveLength(1);

    const rectPx = screenRectPx(scene);
    const viewW = 1 / 2;
    const viewX = Math.min(1 - viewW, Math.max(0, 0.5 - viewW / 2));
    const expected = {
      x: rectPx.x + ((0.2 - viewX) / viewW) * rectPx.width,
      y: rectPx.y + ((0.3 - viewX) / viewW) * rectPx.height,
      width: (0.2 / viewW) * rectPx.width,
      height: (0.2 / viewW) * rectPx.height,
    };
    const args = privacyFills[0].args;
    expect(args[0]).toBeCloseTo(expected.x, 3);
    expect(args[1]).toBeCloseTo(expected.y, 3);
    expect(args[2]).toBeCloseTo(expected.width, 3);
    expect(args[3]).toBeCloseTo(expected.height, 3);
  });

  it('未确认遮挡不进入 scene.screenPrivacy', () => {
    const project = baseProject();
    project.effects.push(privacyEffect('p-confirmed', 'solid', true));
    project.effects.push(privacyEffect('p-pending', 'solid', false));
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    expect(scene.screenPrivacy.map((p) => p.effectId)).toEqual(['p-confirmed']);
  });
});

// ---------------------------------------------------------------------------
// 光标 / 摄像头 / 标注 / 辅助层
// ---------------------------------------------------------------------------

describe('光标、摄像头与标注', () => {
  it('光标按源坐标映射到屏幕矩形（含运镜）', () => {
    const project = baseProject();
    project.effects.push({
      id: 'zoom-1',
      kind: 'zoom',
      range: { start: 0, end: 10 * S },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 1, easeOutTicks: 1 },
      origin: 'manual',
      locked: false,
    });
    const scene = evaluateScene(project, TICK, {
      outputWidth: 1920,
      outputHeight: 1080,
      pointer: { x: 0.5, y: 0.5, visible: true, clickProgress: 0.5, clickX: 0.5, clickY: 0.5 },
    });
    const ctx = makeCtx();
    drawScene(ctx as any, scene, screenResources());

    const rectPx = screenRectPx(scene);
    const viewW = 1 / 2;
    const viewX = 0.25;
    const expectedX = rectPx.x + ((0.5 - viewX) / viewW) * rectPx.width;
    const expectedY = rectPx.y + ((0.5 - viewX) / viewW) * rectPx.height;
    const translate = ctx.opsOf('translate').find((op) => Math.abs(op.args[0] - expectedX) < 0.01);
    expect(translate).toBeDefined();
    expect(translate!.args[1]).toBeCloseTo(expectedY, 3);
    // 点击波纹
    expect(ctx.opsOf('arc').length).toBeGreaterThan(0);
  });

  it('摄像头画中画按 cover 方式裁切而不是拉伸', () => {
    const project = baseProject();
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    const camera = { width: 640, height: 480 } as unknown as CanvasImageSource;
    const resources: SceneResources = { ...screenResources(), camera };
    const ctx = makeCtx();
    drawScene(ctx as any, scene, resources);

    const camRect = scene.camera.rect;
    const px = camRect.x * 1920;
    const py = camRect.y * 1080;
    const pw = camRect.width * 1920;
    const ph = camRect.height * 1080;
    const scale = Math.max(pw / 640, ph / 480);
    const expected = {
      dx: px + (pw - 640 * scale) / 2,
      dy: py + (ph - 480 * scale) / 2,
      dw: 640 * scale,
      dh: 480 * scale,
    };
    const draw = ctx.opsOf('drawImage').find((op) => op.args[0] === camera);
    expect(draw).toBeDefined();
    expect(draw!.args[1]).toBeCloseTo(expected.dx, 3);
    expect(draw!.args[2]).toBeCloseTo(expected.dy, 3);
    expect(draw!.args[3]).toBeCloseTo(expected.dw, 3);
    expect(draw!.args[4]).toBeCloseTo(expected.dh, 3);
  });

  it('摄像头资源为 VideoFrame（只有 displayWidth/Height）时也能画出画中画', () => {
    const project = baseProject();
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    // 旧实现只认 videoWidth/width，VideoFrame 会被算成 0×0 → 画中画纯黑
    const camera = { displayWidth: 640, displayHeight: 480 } as unknown as CanvasImageSource;
    const ctx = makeCtx();
    drawScene(ctx as any, scene, { ...screenResources(), camera });
    const draw = ctx.opsOf('drawImage').find((op) => op.args[0] === camera);
    expect(draw).toBeDefined();
    const camRect = scene.camera.rect;
    const pw = camRect.width * 1920;
    const ph = camRect.height * 1080;
    const scale = Math.max(pw / 640, ph / 480);
    expect(draw!.args[3]).toBeCloseTo(640 * scale, 3);
    expect(draw!.args[4]).toBeCloseTo(480 * scale, 3);
  });

  it('标注按输出画布归一化坐标绘制文字', () => {
    const project = baseProject();
    project.effects.push({
      id: 'note-1',
      kind: 'annotation',
      range: { start: 0, end: 10 * S },
      parameters: { text: '点击发布', x: 0.25, y: 0.5, fontSize: 32, color: '#ffffff' },
      origin: 'manual',
      locked: false,
    });
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    const ctx = makeCtx();
    drawScene(ctx as any, scene, screenResources());
    const text = ctx.opsOf('fillText').find((op) => op.args[0] === '点击发布');
    expect(text).toBeDefined();
    expect(text!.args[1]).toBeCloseTo(0.25 * 1920, 6);
    expect(text!.args[2]).toBeCloseTo(0.5 * 1080, 6);
  });

  it('编辑辅助层只在 includeOverlays 时绘制（不进入视频）', () => {
    const project = baseProject();
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    const highlight = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };

    const plain = makeCtx();
    drawScene(plain as any, scene, screenResources(), { includeOverlays: false, highlight });
    expect(plain.opsOf('strokeRect')).toHaveLength(0);

    const editing = makeCtx();
    drawScene(editing as any, scene, screenResources(), { includeOverlays: true, highlight });
    expect(editing.opsOf('strokeRect')).toHaveLength(1);
    expect(editing.opsOf('setLineDash').length).toBeGreaterThan(0);
  });

  it('没有源帧时画占位色而不是保留脏画面', () => {
    const project = baseProject();
    const scene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    const ctx = makeCtx();
    drawScene(
      ctx as any,
      scene,
      { screen: null, screenWidth: 0, screenHeight: 0, camera: null, cursor: null },
    );
    const placeholder = ctx.opsOf('fillRect').find((op) => op.args[4] === '#0d1117');
    expect(placeholder).toBeDefined();
    const rectPx = screenRectPx(scene);
    expect(placeholder!.args.slice(0, 4)).toEqual([rectPx.x, rectPx.y, rectPx.width, rectPx.height]);
  });
});

// ---------------------------------------------------------------------------
// 缓存键
// ---------------------------------------------------------------------------

describe('frameCacheKey', () => {
  it('包含场景缓存键、片段 ID 与源时间戳', () => {
    const project = baseProject();
    const scene: FrameScene = evaluateScene(project, TICK, { outputWidth: 1920, outputHeight: 1080 });
    expect(frameCacheKey(scene)).toBe(`${scene.cacheKey}|${scene.clipId}|${scene.sourceTick}`);
  });
});
