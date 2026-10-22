/**
 * 导出窗口的运行时（开发文档 §11 / §12）
 *
 * 隐藏窗口，职责：跑完整导出管线（解码 → 逐帧合成 → 编码 → 封装 → 校验 → 落盘）
 * 以及教程包导出（截图 + Markdown + HTML + steps.json）。
 * 主进程通过 executeJavaScript 调用 window.__wcsExporter.run(...)。
 *
 * 文件系统：渲染进程没有 node:fs，所有读写都通过 window.wcs 的 IPC 回主进程。
 * 预览与导出共用同一个 drawScene（src/media/compositor.ts），保证所见即所得。
 */

import {
  exportProject,
  estimateOutputBytes,
  type ExportFileIO,
  type ExportMediaProvider,
  type ExportProgressEvent,
} from '../media/exporter';
import { VideoFrameSource, configureMediabunny, type MediaSegment } from '../media/decoder';
import * as mediabunny from 'mediabunny';
import { buildExportPlan, frameSceneOptions } from '../domain/exportPlan';
import { evaluateScene, type SceneOptions } from '../domain/scene';
import { drawScene, type SceneResources } from '../media/compositor';
import { buildStepDrafts, stepsToHtml, stepsToMarkdown } from '../domain/tutorial';
import { timelineDuration, type Project, type TutorialStep } from '../domain/project';
import { TICKS_PER_SECOND } from '../domain/timebase';
import { TimeMap } from '../domain/timeMap';
import type { ExportProfile, ExportProgress, ExportResult } from '../shared/ipc';
import type { PointerLog } from '../domain/types';

interface ExportRequest {
  jobId: string;
  project: Project;
  /** 工程目录绝对路径（素材解析需要） */
  projectPath: string;
  profile: ExportProfile;
  outputPath: string;
  includeTutorial: boolean;
}

interface TutorialPackResult {
  ok: boolean;
  outputDir: string;
  indexPath: string;
  markdownPath: string;
  stepsJsonPath: string;
  imageCount: number;
  error?: string;
}

interface ExportResponse {
  video: ExportResult | null;
  tutorial: TutorialPackResult | null;
  snapshotHash: string;
  error?: string;
}

function wcs() {
  if (!window.wcs) throw new Error('window.wcs 不可用（preload 未加载）');
  return window.wcs;
}

// 渲染进程里 mediabunny 是 ESM 包，直接静态 import 后注入给 decoder。
// 不注入的话 decoder.loadMediabunny() 找不到模块（渲染进程没有 require）。
configureMediabunny(mediabunny as unknown as Parameters<typeof configureMediabunny>[0]);
console.log('[exporter] mediabunny 已注入');

/** 拆包：IPC 返回 IpcResponse，业务层只关心 data，失败时抛错。 */
function unwrap<T>(response: { ok: boolean; data?: T; error?: { message: string } }): T {
  if (!response.ok) throw new Error(response.error?.message ?? 'IPC 调用失败');
  return response.data as T;
}

// ---------------------------------------------------------------------------
// 文件 IO
// ---------------------------------------------------------------------------

function makeFileIO(): ExportFileIO {
  const api = wcs();
  return {
    writeFile: async (path, data) => {
      unwrap(await api.writeExportFile(path, data));
    },
    rename: async (from, to) => {
      unwrap(await api.renamePath(from, to));
    },
    removeFile: async (path) => {
      unwrap(await api.removePath(path));
    },
    freeBytes: async (path) => {
      const info = unwrap(await api.checkPath(path));
      return info.freeBytes;
    },
    readFile: async (path) => unwrap(await api.readExportFile(path)),
  };
}

// ---------------------------------------------------------------------------
// 素材解析
// ---------------------------------------------------------------------------

async function makeMediaProvider(project: Project, projectPath: string): Promise<ExportMediaProvider> {
  const api = wcs();
  const segmentCache = new Map<string, MediaSegment[]>();
  const sourceCache = new Map<string, VideoFrameSource>();

  // 渲染进程没有 node:path，手工拼绝对路径。
  // 工程里的素材路径是「相对工程根目录」的，而 IPC 的读写接口要求绝对路径，
  // 必须在这里补全，否则 decoder 打开段文件会失败、导出只剩背景。
  const toAbsolute = (relativePath: string): string => {
    if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith('\\\\')) return relativePath;
    const normalized = relativePath.replace(/[\\/]+/g, '\\');
    const base = projectPath.replace(/[\\/]+$/, '');
    return `${base}\\${normalized}`;
  };

  const loadSegments = async (assetId: string): Promise<MediaSegment[]> => {
    const cached = segmentCache.get(assetId);
    if (cached) return cached;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) {
      segmentCache.set(assetId, []);
      return [];
    }
    const listed = unwrap(await api.listMediaSegments(projectPath, asset.path));
    const segments: MediaSegment[] = listed.map((item) => ({
      path: toAbsolute(item.path),
      startTick: item.startTick,
      durationTicks: item.durationTicks,
    }));
    segmentCache.set(assetId, segments);
    return segments;
  };

  return {
    segmentsFor: (assetId) => loadSegments(assetId),
    readFile: async (path) => unwrap(await api.readExportFile(toAbsolute(path))),
    providerFor: async (assetId) => {
      const existing = sourceCache.get(assetId);
      if (existing) return existing;
      const segments = await loadSegments(assetId);
      if (segments.length === 0) return null;
      const source = new VideoFrameSource(
        { readFile: async (p) => unwrap(await api.readExportFile(toAbsolute(p))), nodeFilePaths: false },
        segments,
      );
      await source.open();
      sourceCache.set(assetId, source);
      return source;
    },
  };
}

// ---------------------------------------------------------------------------
// 指针
// ---------------------------------------------------------------------------

/** 指针日志 → SceneOptions['pointer'] 求值函数。 */
async function makePointerLookup(
  projectPath: string,
): Promise<(tick: number) => SceneOptions['pointer']> {
  const api = wcs();
  let log: PointerLog | null = null;
  try {
    log = unwrap(await api.readPointerLog(projectPath)) ?? null;
  } catch {
    log = null;
  }
  const events = log?.events ?? [];
  if (events.length === 0) return () => null;

  /** 点击波纹持续时长（§10.3：约 450ms） */
  const RIPPLE_TICKS = Math.round(0.45 * TICKS_PER_SECOND);

  return (tick: number) => {
    let lo = 0;
    let hi = events.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].tick <= tick) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const event = events[found];

    // 往回找最近的按下事件，用于波纹进度
    let clickProgress: number | undefined;
    let clickX: number | undefined;
    let clickY: number | undefined;
    for (let i = found; i >= 0 && i > found - 96; i--) {
      if (events[i].kind === 'down') {
        const age = tick - events[i].tick;
        if (age >= 0 && age <= RIPPLE_TICKS) {
          clickProgress = age / RIPPLE_TICKS;
          clickX = events[i].x;
          clickY = events[i].y;
        }
        break;
      }
    }

    return { x: event.x, y: event.y, visible: true, clickProgress, clickX, clickY };
  };
}

// ---------------------------------------------------------------------------
// 教程包导出（§12）
// ---------------------------------------------------------------------------

/**
 * 教程截图与视频共用 evaluateScene + drawScene。
 * 这里自己实现一份 resolveResources（与 exporter 内部同构），
 * 因为 exporter 的该函数未导出。
 */
async function exportTutorialPack(
  request: ExportRequest,
  outputDir: string,
  onProgress: (percent: number, message: string) => void,
): Promise<TutorialPackResult> {
  const api = wcs();
  const { project, profile, projectPath } = request;
  const plan = buildExportPlan(project, profile);
  const provider = await makeMediaProvider(project, projectPath);
  const pointerAt = await makePointerLookup(projectPath);

  // 步骤来源：工程里已保存的步骤；没有则按标记生成草稿
  const steps: TutorialStep[] =
    project.steps.length > 0
      ? project.steps
      : buildStepDrafts({
          markers: project.markers,
          clicks: [],
          durationTicks: timelineDuration(project),
        });

  const canvas = new OffscreenCanvas(plan.outputWidth, plan.outputHeight);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法创建教程截图画布');

  const clipAsset = new Map<string, string>();
  for (const track of project.tracks) for (const clip of track.clips) clipAsset.set(clip.id, clip.assetId);

  // 静态复帧缓存：源片段空隙时复用上一帧（§9.4）
  let heldScreen: CanvasImageSource | null = null;
  let heldWidth = 0;
  let heldHeight = 0;

  const images: { name: string; bytes: Uint8Array }[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    onProgress(Math.round(((i + 1) / Math.max(1, steps.length)) * 100), `正在生成第 ${i + 1}/${steps.length} 张教程截图…`);

    const tick = Math.max(0, step.imageTick ?? 0);
    const scene = evaluateScene(project, tick, {
      ...frameSceneOptions(plan),
      pointer: pointerAt(tick),
      includeOverlays: false,
    });

    // 解析源画面
    let screen: CanvasImageSource | null = null;
    let screenWidth = 0;
    let screenHeight = 0;
    if (scene.hasSourceFrame && scene.sourceTick !== null && scene.clipId) {
      const assetId = clipAsset.get(scene.clipId);
      const source = assetId ? await provider.providerFor?.(assetId) : null;
      if (source) {
        const frame = await source.getFrameAt(scene.sourceTick);
        if (frame) {
          screen = frame;
          heldScreen = frame;
          const anyFrame = frame as unknown as { width?: number; height?: number };
          screenWidth = anyFrame.width ?? plan.outputWidth;
          screenHeight = anyFrame.height ?? plan.outputHeight;
          heldWidth = screenWidth;
          heldHeight = screenHeight;
        }
      }
    }
    if (!screen && heldScreen) {
      screen = heldScreen;
      screenWidth = heldWidth;
      screenHeight = heldHeight;
    }

    const resources: SceneResources = { screen, screenWidth, screenHeight, camera: null, cursor: null };
    drawScene(ctx, scene, resources, { includeOverlays: false });

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    images.push({ name: `step-${String(i + 1).padStart(2, '0')}.png`, bytes });
  }

  // 落盘
  unwrap(await api.makeDirectory(outputDir));
  unwrap(await api.makeDirectory(`${outputDir}/assets`));
  for (const image of images) {
    unwrap(await api.writeExportFile(`${outputDir}/assets/${image.name}`, image.bytes));
  }

  const meta = {
    title: project.name,
    createdAt: Date.now(),
    imagePath: (step: TutorialStep, index: number) => `assets/step-${String(index + 1).padStart(2, '0')}.png`,
  };
  const markdown = stepsToMarkdown(steps, meta);
  const html = stepsToHtml(steps, meta);
  const stepsJson = JSON.stringify(
    { project: project.name, generatedAt: new Date().toISOString(), steps },
    null,
    2,
  );

  const encoder = new TextEncoder();
  const markdownPath = `${outputDir}/tutorial.md`;
  const indexPath = `${outputDir}/index.html`;
  const stepsJsonPath = `${outputDir}/steps.json`;
  unwrap(await api.writeExportFile(markdownPath, encoder.encode(markdown)));
  unwrap(await api.writeExportFile(indexPath, encoder.encode(html)));
  unwrap(await api.writeExportFile(stepsJsonPath, encoder.encode(stepsJson)));

  return { ok: true, outputDir, indexPath, markdownPath, stepsJsonPath, imageCount: images.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function run(request: ExportRequest): Promise<ExportResponse> {
  const api = wcs();
  let snapshotHash = '';
  let video: ExportResult | null = null;
  let tutorial: TutorialPackResult | null = null;

  try {
    const io = makeFileIO();
    const media = await makeMediaProvider(request.project, request.projectPath);
    const pointerAt = await makePointerLookup(request.projectPath);
    const plan = buildExportPlan(request.project, request.profile);

    const controller = new AbortController();
    (window as unknown as { __wcsAbort?: AbortController }).__wcsAbort = controller;

    const result = await exportProject({
      jobId: request.jobId,
      project: request.project,
      profile: request.profile,
      outputPath: request.outputPath,
      io,
      media,
      pointerAt,
      estimatedBytes: estimateOutputBytes(plan),
      signal: controller.signal,
      onProgress: (progress: ExportProgressEvent) => {
        const payload: ExportProgress = {
          jobId: request.jobId,
          progress: progress.progress,
          phase: progress.phase,
          framesDone: progress.framesDone,
          framesTotal: progress.framesTotal,
          message: progress.message,
          bytesWritten: progress.bytesWritten,
        };
        api.reportExportProgress(payload);
      },
    });

    snapshotHash = result.snapshotHash;
    video = {
      jobId: request.jobId,
      ok: result.ok,
      outputPath: result.outputPath,
      encoder: result.encoder,
      error: result.error,
      durationTicks: result.durationTicks,
      frames: result.frames,
      bytes: result.bytes,
      verified: result.verified,
    };
    api.completeExport(video);

    if (request.includeTutorial) {
      const tutorialDir = request.outputPath.replace(/\.mp4$/i, '') + '-tutorial';
      tutorial = await exportTutorialPack(request, tutorialDir, (percent, message) => {
        const payload: ExportProgress = {
          jobId: request.jobId,
          progress: percent / 100,
          phase: 'finalizing',
          framesDone: percent,
          framesTotal: 100,
          message,
          bytesWritten: 0,
        };
        api.reportExportProgress(payload);
      });
    }

    return { video, tutorial, snapshotHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[exporter] 导出失败：' + message);
    return { video, tutorial, snapshotHash, error: message };
  }
}

function cancel(): void {
  (window as unknown as { __wcsAbort?: AbortController }).__wcsAbort?.abort();
}

/**
 * 探针：解码一个 MP4 的若干时间点，统计画面颜色多样性。
 *
 * 用途是自动化验证「录到的画面不是全黑/全白」——能解码 ≠ 画面有内容。
 * 只在渲染进程可用（需要 WebCodecs），所以放在这里而不是 Node 脚本里。
 */
async function probeVideo(
  filePath: string,
  timestamps: number[] = [0, 0.5, 1, 1.5],
): Promise<{
  ok: boolean;
  error?: string;
  samples: { atSeconds: number; width: number; height: number; distinctColors: number; avgLuma: number }[];
}> {
  try {
    const bytes = unwrap(await wcs().readExportFile(filePath));
    const input = new mediabunny.Input({
      formats: mediabunny.ALL_FORMATS,
      source: new mediabunny.BufferSource(bytes as unknown as ArrayBuffer),
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      await input.dispose?.();
      return { ok: false, error: '没有视频轨', samples: [] };
    }
    const sink = new mediabunny.CanvasSink(track);
    const samples: { atSeconds: number; width: number; height: number; distinctColors: number; avgLuma: number }[] = [];
    for (const seconds of timestamps) {
      const wrapped = await sink.getCanvas(seconds);
      if (!wrapped) continue;
      const canvas = (wrapped as unknown as { canvas: OffscreenCanvas }).canvas ?? (wrapped as unknown as OffscreenCanvas);
      const width = canvas.width;
      const height = canvas.height;
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) continue;
      const data = ctx.getImageData(0, 0, width, height).data;
      const colors = new Set<number>();
      let sum = 0;
      let count = 0;
      const step = 4 * 89;
      for (let i = 0; i + 3 < data.length; i += step) {
        colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
        sum += data[i] + data[i + 1] + data[i + 2];
        count++;
      }
      samples.push({
        atSeconds: seconds,
        width,
        height,
        distinctColors: colors.size,
        avgLuma: count > 0 ? Math.round(sum / (count * 3)) : 0,
      });
    }
    await input.dispose?.();
    return { ok: samples.length > 0 && samples.some((s) => s.distinctColors > 20), samples };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.stack ?? error.message : error), samples: [] };
  }
}

declare global {
  interface Window {
    __wcsExporter?: {
      run: (request: ExportRequest) => Promise<ExportResponse>;
      cancel: () => void;
      probeVideo: typeof probeVideo;
    };
  }
}

window.__wcsExporter = { run, cancel, probeVideo };
console.log('[exporter] 导出窗口就绪');
