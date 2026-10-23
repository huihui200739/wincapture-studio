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
import { buildStepDrafts, stepTimelineTick, stepsToHtml, stepsToMarkdown } from '../domain/tutorial';
import { timelineDuration, type Project, type TutorialStep } from '../domain/project';
import { TimeMap } from '../domain/timeMap';
import { TICKS_PER_SECOND } from '../domain/timebase';
import type { ExportProfile, ExportProgress, ExportResult } from '../shared/ipc';
import type { PointerLog } from '../domain/types';
import { createPointerLookup, pointerForScene } from '../domain/pointer';

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
  /**
   * 失败原因。注意本方法由主进程用 executeJavaScript 调用，
   * 异常会被这里捕获并**以正常返回值带回**——所以 IPC 外层 ok:true 不代表导出成功。
   * 界面必须同时检查 cancelled / error / video.ok，否则取消与失败会被显示成「导出完成」。
   */
  error?: string;
  /** 稳定错误码（E_EXPORT_CANCELLED / E_DISK_FULL / E_EXPORT_FAILED …） */
  errorCode?: string;
  /** 是否因为取消而结束（与 errorCode=E_EXPORT_CANCELLED 等价，便于界面判断） */
  cancelled: boolean;
}

/** 从异常里取稳定错误码（AppError 带 code，普通 Error 没有）。 */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'E_EXPORT_FAILED';
}

function wcs() {
  if (!window.wcs) throw new Error('window.wcs 不可用（preload 未加载）');
  return window.wcs;
}

/**
 * 只在 exporter 角色窗口安装运行时。
 *
 * main.tsx 会把本模块静态打进每一个窗口，但导出管线只应在隐藏的 exporter 窗口里跑：
 * 主窗口/录制窗口/悬浮窗不需要 __wcsExporter，也不该被主进程的
 * 「向所有窗口广播取消」误触发（旧实现下每个窗口都有一份 __wcsExporter）。
 * 与 cameraRuntime 的角色判断保持一致。
 */
function isExporterRole(): boolean {
  if (typeof window === 'undefined') return false;
  const declared = window.wcs?.role;
  if (declared) return declared === 'exporter';
  return typeof location !== 'undefined' && /exporter/.test(location.hash + location.search);
}

// 渲染进程里 mediabunny 是 ESM 包，直接静态 import 后注入给 decoder。
// 不注入的话 decoder.loadMediabunny() 找不到模块（渲染进程没有 require）。
if (isExporterRole()) {
  configureMediabunny(mediabunny as unknown as Parameters<typeof configureMediabunny>[0]);
  console.log('[exporter] mediabunny 已注入');
}

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

interface MediaProviderHandle {
  provider: ExportMediaProvider;
  /** 关闭本 handle 创建的全部解码器（VideoFrameSource 持有文件句柄与段级解码器）。 */
  disposeSources: () => void;
}

async function makeMediaProvider(project: Project, projectPath: string): Promise<MediaProviderHandle> {
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

  const disposeSources = (): void => {
    for (const source of sourceCache.values()) {
      try {
        source.close();
      } catch {
        // 忽略：窗口随后销毁，资源也会被进程回收
      }
    }
    sourceCache.clear();
  };

  const provider: ExportMediaProvider = {
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

  return { provider, disposeSources };
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
  return createPointerLookup(log?.events ?? []);
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
  signal?: AbortSignal,
): Promise<TutorialPackResult> {
  const api = wcs();
  const { project, profile, projectPath } = request;
  const plan = buildExportPlan(project, profile);
  const media = await makeMediaProvider(project, projectPath);
  const provider = media.provider;
  const pointerAt = await makePointerLookup(projectPath);
  const timeMap = new TimeMap(project);

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw Object.assign(new Error('导出已取消'), { code: 'E_EXPORT_CANCELLED' });
  };

  try {
    // 步骤来源：工程里已保存的步骤；没有则按标记生成草稿。
    // 标记是源时间，可能超出成片时长（前段被剪掉），因此先生成再按映射过滤。
    const steps: TutorialStep[] =
      project.steps.length > 0
        ? project.steps
        : buildStepDrafts({
            markers: project.markers,
            clicks: [],
            durationTicks: Number.MAX_SAFE_INTEGER,
          }).filter((draft) => stepTimelineTick(project, draft, timeMap) !== null);

    const canvas = new OffscreenCanvas(plan.outputWidth, plan.outputHeight);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建教程截图画布');

    const clipAsset = new Map<string, string>();
    for (const track of project.tracks) for (const clip of track.clips) clipAsset.set(clip.id, clip.assetId);

    // 静态复帧缓存：源片段空隙时复用上一帧（§9.4）
    let heldScreen: CanvasImageSource | null = null;
    let heldWidth = 0;
    let heldHeight = 0;
    let heldCamera: CanvasImageSource | null = null;

    // 先建目录，逐张截图立刻写盘。
    // 旧实现把所有 PNG 攒在 images 数组里最后统一写：100 张 1080p 截图
    // 在内存里能堆到几百 MB（每张 PNG 未压缩状态约 8MB），而隐藏导出窗口
    // 与视频编码同进程，容易把总工作集顶到 §16.2 的 1.2GB 上限。
    unwrap(await api.makeDirectory(outputDir));
    unwrap(await api.makeDirectory(`${outputDir}/assets`));

    let imageCount = 0;
    for (let i = 0; i < steps.length; i++) {
      throwIfAborted();
      const step = steps[i];
      onProgress(Math.round(((i + 1) / Math.max(1, steps.length)) * 100), `正在生成第 ${i + 1}/${steps.length} 张教程截图…`);

      // 步骤存的是源时间（与标记/指针日志同一时间轴），合成要求成片时间线时间。
      // 旧实现直接拿源时间当时间线时间，一旦剪辑过就会把截图拍成错位的画面。
      const tick = stepTimelineTick(project, step, timeMap) ?? 0;
      const scene = evaluateScene(project, tick, {
        ...frameSceneOptions(plan),
        pointer: pointerForScene(project, tick, pointerAt, timeMap),
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

      // 摄像头画中画：教程截图也必须画出来。
      // 旧实现恒传 camera: null，而 drawCamera 会先铺一块深色底再画资源，
      // 于是有摄像头轨的工程每张教程图里都是一个纯黑圆角矩形。
      let camera: CanvasImageSource | null = null;
      if (scene.camera.visible) {
        const hit = timeMap.toSource('camera', tick);
        if (hit) {
          const cameraSource = await provider.providerFor?.(hit.clip.assetId);
          const frame = await cameraSource?.getFrameAt(hit.sourceTick);
          if (frame) {
            camera = frame;
            heldCamera = frame;
          }
        }
        if (!camera) camera = heldCamera;
      }

      const resources: SceneResources = { screen, screenWidth, screenHeight, camera, cursor: null };
      drawScene(ctx, scene, resources, { includeOverlays: false });

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = `step-${String(i + 1).padStart(2, '0')}.png`;
      unwrap(await api.writeExportFile(`${outputDir}/assets/${name}`, bytes));
      imageCount += 1;
    }

    const meta = {
      title: project.name,
      createdAt: Date.now(),
      imagePath: (_step: TutorialStep, index: number) => `assets/step-${String(index + 1).padStart(2, '0')}.png`,
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

    return { ok: true, outputDir, indexPath, markdownPath, stepsJsonPath, imageCount };
  } finally {
    // 教程包自己创建的解码器必须关闭：隐藏窗口虽然随后销毁，
    // 但教程导出是在视频导出之后同窗口串行执行的，句柄与段解码器会一直占着。
    media.disposeSources();
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function run(request: ExportRequest): Promise<ExportResponse> {
  const api = wcs();
  let snapshotHash = '';
  let video: ExportResult | null = null;
  let tutorial: TutorialPackResult | null = null;

  // 取消信号必须在任何 await 之前创建。
  // 旧实现把 new AbortController() 放在 makeMediaProvider/makePointerLookup 之后，
  // 那两次 IPC 往返（几百毫秒）里用户点「取消」找不到 signal，取消被静默丢失，
  // 导出继续跑完并写出文件，而界面已经显示「已取消」。
  const controller = new AbortController();
  (window as unknown as { __wcsAbort?: AbortController }).__wcsAbort = controller;

  /** 上报终态进度：保证界面在导出失败/取消时一定能收到一条明确的终态事件。 */
  const reportTerminal = (phase: 'cancelled' | 'failed', message: string): void => {
    try {
      api.reportExportProgress({
        jobId: request.jobId,
        progress: 0,
        phase,
        framesDone: 0,
        framesTotal: 0,
        message,
        bytesWritten: 0,
      });
    } catch {
      // 进度通道不可用时由返回值的 error/cancelled 兜底
    }
  };

  let media: MediaProviderHandle | null = null;
  try {
    const io = makeFileIO();
    media = await makeMediaProvider(request.project, request.projectPath);
    const pointerAt = await makePointerLookup(request.projectPath);
    const plan = buildExportPlan(request.project, request.profile);

    const result = await exportProject({
      jobId: request.jobId,
      project: request.project,
      profile: request.profile,
      outputPath: request.outputPath,
      io,
      media: media.provider,
      pointerAt,
      // 按实际档位码率估算：写死 12Mbps 会让低码率档误判磁盘不足、
      // 高码率档低估体积（写到一半才因 ENOSPC 失败并丢弃全部已编码数据）。
      estimatedBytes: estimateOutputBytes(plan, {
        videoBitrate: request.profile.videoBitrate,
        audioBitrate: request.profile.audioBitrate,
      }),
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
      // 降级说明必须随结果一起回到界面：旧实现只收集不返回，
      // 用户拿到静音/缺画面的「导出成功」却看不到任何提示。
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
    api.completeExport(video);

    if (request.includeTutorial) {
      const tutorialDir = request.outputPath.replace(/\.mp4$/i, '') + '-tutorial';
      tutorial = await exportTutorialPack(
        request,
        tutorialDir,
        (percent, message) => {
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
        },
        controller.signal,
      );
    }

    return { video, tutorial, snapshotHash, cancelled: false };
  } catch (error) {
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = controller.signal.aborted || code === 'E_EXPORT_CANCELLED';
    console.error(`[exporter] 导出${cancelled ? '已取消' : '失败'}（${code}）：${message}`);
    // 终态进度：即使界面没等到主进程返回，也能立即看到失败/取消原因
    reportTerminal(cancelled ? 'cancelled' : 'failed', cancelled ? '导出已取消，临时文件已清理。' : message);
    return {
      video,
      tutorial,
      snapshotHash,
      error: message,
      errorCode: cancelled ? 'E_EXPORT_CANCELLED' : code,
      cancelled,
    };
  } finally {
    if ((window as unknown as { __wcsAbort?: AbortController | null }).__wcsAbort === controller) {
      (window as unknown as { __wcsAbort?: AbortController | null }).__wcsAbort = null;
    }
    // exportProject 自己会关闭它解析到的 provider，这里兜底关闭剩余的
    // （例如因取消而在 resolveProvider 之前就返回时创建的段缓存/句柄）。
    media?.disposeSources();
  }
}

function cancel(): void {
  const holder = window as unknown as { __wcsAbort?: AbortController | null };
  if (!holder.__wcsAbort) {
    console.warn('[exporter] 收到取消请求，但当前没有进行中的导出');
    return;
  }
  holder.__wcsAbort.abort();
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
  // 用闭包持有释放动作：Input.dispose() 在异常路径上也不能漏，
  // 否则每次探测都会留下一个打开的 demuxer 与文件句柄。
  let disposeInput: (() => void) | null = null;
  try {
    const bytes = unwrap(await wcs().readExportFile(filePath));
    const input = new mediabunny.Input({
      formats: mediabunny.ALL_FORMATS,
      source: new mediabunny.BufferSource(bytes as unknown as ArrayBuffer),
    });
    disposeInput = () => {
      try {
        (input as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        // 忽略
      }
    };
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      return { ok: false, error: '没有视频轨', samples: [] };
    }
    const sink = new mediabunny.CanvasSink(track);
    const samples: { atSeconds: number; width: number; height: number; distinctColors: number; avgLuma: number }[] = [];
    for (const seconds of timestamps) {
      const wrapped = await sink.getCanvas(seconds);
      if (!wrapped) continue;
      const canvas = wrapped.canvas as OffscreenCanvas;
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
    return { ok: samples.length > 0 && samples.some((s) => s.distinctColors > 20), samples };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.stack ?? error.message : error), samples: [] };
  } finally {
    disposeInput?.();
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

if (isExporterRole()) {
  window.__wcsExporter = { run, cancel, probeVideo };
  console.log('[exporter] 导出窗口就绪');
}
