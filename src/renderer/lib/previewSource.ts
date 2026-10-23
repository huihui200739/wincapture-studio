/**
 * 编辑器 / 教程预览的真实媒体来源（开发文档 §11.5 预览一致性）
 *
 * 背景（P0 修复）：
 * 旧实现里 PreviewCanvas / StepThumb 无条件用 `syntheticScreen()/syntheticCamera()`
 * 作为「已解码源帧」，于是真实录制工程在编辑器里显示的是内置演示桌面（含合成的
 * 邮箱、手机号），与导出（exporterRuntime 用 VideoFrameSource 解码真实分段）
 * 完全不一致，直接违背「所见即所得」。
 *
 * 本模块只做两件事：
 * 1. 判定当前是否 mock 模式（只有 mock 才允许合成演示画面）；
 * 2. 真实模式下按素材分段建 VideoFrameSource，把任意 tick 解码成 OffscreenCanvas。
 *
 * 约束：
 * - 不修改 src/media/**，只调用其公开 API（decoder.VideoFrameSource）。
 * - 渲染进程没有 node:fs：段列表与字节都走 window.wcs 的 IPC。
 * - 解码是异步的，组件负责「同步画占位 / 拿到帧后重绘」，这里只提供帧数据。
 */

import { useEffect, useState } from 'react';
import type { Project } from '@domain/project';
import type { FrameScene } from '@domain/scene';
import type { Ticks } from '@domain/timebase';
import { TimeMap } from '@domain/timeMap';
import { createPointerLookup, pointerForScene, type PointerLookup } from '@domain/pointer';
import type { SceneOptions } from '@domain/scene';
import { VideoFrameSource, configureMediabunny, loadMediabunny, type MediaSegment } from '../../media/decoder';
import { detectApiMode, wcs } from './wcs';

export interface PreviewResources {
  screen: CanvasImageSource | null;
  screenWidth: number;
  screenHeight: number;
  camera: CanvasImageSource | null;
}

export interface PreviewFrameResult extends PreviewResources {
  pointer?: SceneOptions['pointer'];
  /** ready：有真实帧；loading：还在解码；error：解码失败（附 message） */
  status: 'ready' | 'loading' | 'error';
  message?: string;
}

const EMPTY_RESOURCES: PreviewResources = { screen: null, screenWidth: 0, screenHeight: 0, camera: null };

/**
 * 是否允许使用合成演示画面。
 *
 * 只有「没有 window.wcs」的 mock 模式才允许：真实工程一旦回退到 synthetic，
 * 用户看到的画面就和导出/录制内容无关了。
 */
export function shouldUseSyntheticPreview(): boolean {
  // 只看「有没有 window.wcs」：detectApiMode 不构造 mock API，
  // 因此也能在 Node 测试环境安全调用（isMockMode() 会实例化 MockWcs）。
  return detectApiMode() === 'mock';
}

/** 工程内相对路径 → IPC 可读的绝对路径（渲染进程没有 node:path）。 */
export function absoluteMediaPath(projectPath: string, relativePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith('\\\\')) return relativePath;
  const normalized = relativePath.replace(/[\\/]+/g, '\\');
  const base = projectPath.replace(/[\\/]+$/, '');
  return `${base}\\${normalized}`;
}

/** 主画面解码缓存键：片段 + 源时间（同一条素材的同一帧不重复解码）。 */
export function screenFrameKey(scene: FrameScene): string {
  if (!scene.hasSourceFrame || scene.sourceTick === null || !scene.clipId) return '';
  return `${scene.clipId}@${Math.round(scene.sourceTick)}`;
}

function clipAssetId(project: Project, clipId: string): string | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return clip.assetId;
  }
  return null;
}

interface FrameEntry {
  key: string;
  frame: OffscreenCanvas;
  width: number;
  height: number;
}

/**
 * 预览用的解码缓存（一个工程目录一个实例）。
 *
 * - 每个素材只建一个 VideoFrameSource，复用段解码器；
 * - 请求串行执行，避免同一个解码器被并发调用（VideoFrameSource 内部游标非线程安全）；
 * - 组件卸载时 dispose() 关闭全部解码器，避免文件句柄/解码上下文泄漏。
 */
export class PreviewMediaCache {
  private readonly projectPath: string;
  private readonly sources = new Map<string, Promise<VideoFrameSource | null>>();
  private readonly failedAssets = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly latestTokens = new WeakMap<object, number>();
  private pointerLookup: Promise<PointerLookup> | null = null;
  private disposed = false;
  private lastScreen: FrameEntry | null = null;
  private lastCamera: FrameEntry | null = null;
  private lastError: string | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /** 关闭所有解码器。可重复调用。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.sources.values()) {
      void pending
        .then((source) => {
          try {
            source?.close();
          } catch {
            // 关闭失败不阻塞卸载：进程/窗口随后回收
          }
        })
        .catch(() => undefined);
    }
    this.sources.clear();
    this.lastScreen = null;
    this.lastCamera = null;
  }

  private async ensureSource(project: Project, assetId: string): Promise<VideoFrameSource | null> {
    const existing = this.sources.get(assetId);
    if (existing) return existing;
    if (this.failedAssets.has(assetId)) return null;
    const created = (async (): Promise<VideoFrameSource | null> => {
      const asset = project.assets.find((item) => item.id === assetId);
      if (!asset) return null;
      if (!(await ensureMediabunnyReady())) {
        throw new Error('解码器未就绪：mediabunny 未加载');
      }
      const api = wcs();
      const listed = await api.listMediaSegments(this.projectPath, asset.path);
      if (!listed.ok || !listed.data || listed.data.length === 0) return null;
      const segments: MediaSegment[] = listed.data.map((item) => ({
        path: absoluteMediaPath(this.projectPath, item.path),
        startTick: item.startTick,
        durationTicks: item.durationTicks,
      }));
      const source = new VideoFrameSource(
        {
          readFile: async (path) => {
            const response = await api.readExportFile(absoluteMediaPath(this.projectPath, path));
            if (!response.ok || !response.data) {
              throw new Error(response.error?.message ?? `读取素材失败：${path}`);
            }
            return response.data;
          },
          nodeFilePaths: false,
          sampleRate: 48_000,
        },
        segments,
      );
      await source.open();
      if (this.disposed) {
        source.close();
        return null;
      }
      return source;
    })();
    this.sources.set(assetId, created);
    const source = await created.catch(() => null);
    if (!source) {
      this.sources.delete(assetId);
      this.failedAssets.add(assetId);
    }
    return source;
  }

  private async load(project: Project, scene: FrameScene, tick: Ticks): Promise<PreviewFrameResult> {
    const key = screenFrameKey(scene);
    let status: PreviewFrameResult['status'] = 'ready';
    let message: string | undefined;

    if (key && key !== this.lastScreen?.key) {
      const assetId = scene.clipId ? clipAssetId(project, scene.clipId) : null;
      const source = assetId ? await this.ensureSource(project, assetId) : null;
      if (source && scene.sourceTick !== null) {
        const frame = await source.getFrameAt(scene.sourceTick);
        if (frame) {
          this.lastScreen = { key, frame, width: frame.width, height: frame.height };
        } else {
          status = 'loading';
        }
      } else {
        status = 'error';
        message = '无法读取该素材的视频分段，预览不可用（导出可能仍然正常）。';
      }
    }

    // 摄像头：按同一 TimeMap 求源时间。摄像头不可见时不画。
    let camera: CanvasImageSource | null = null;
    if (scene.camera.visible) {
      const hit = new TimeMap(project).toSource('camera', tick);
      if (hit) {
        const cameraKey = `${hit.clip.assetId}@${Math.round(hit.sourceTick)}`;
        if (cameraKey !== this.lastCamera?.key) {
          const source = await this.ensureSource(project, hit.clip.assetId);
          const frame = source ? await source.getFrameAt(hit.sourceTick) : null;
          if (frame) this.lastCamera = { key: cameraKey, frame, width: frame.width, height: frame.height };
        }
        camera = this.lastCamera?.key === cameraKey ? this.lastCamera.frame : null;
      }
    }

    // 解码失败优先于「沿用上一帧」：旧实现无条件先返回 lastScreen，
    // 把 status='error' 覆盖成 ready，用户看到的是一张看似正常的旧画面，
    // 却不知道当前时间点其实没能解出画面（导出侧是空画面，两边不一致）。
    if (status === 'error') {
      this.lastError = message ?? '预览画面解码失败。';
      return { ...EMPTY_RESOURCES, camera, status: 'error', message: this.lastError };
    }

    if (key && this.lastScreen?.key === key) {
      this.lastError = null;
      return {
        screen: this.lastScreen.frame,
        screenWidth: this.lastScreen.width,
        screenHeight: this.lastScreen.height,
        camera,
        status: 'ready',
      };
    }
    if (status === 'ready' && scene.hasSourceFrame) {
      // 有主轨片段但这一帧还没解出来
      return { ...EMPTY_RESOURCES, camera, status: this.lastError ? 'error' : 'loading', message: this.lastError ?? undefined };
    }
    if (!scene.hasSourceFrame) {
      // 片段间空隙：画面本来就是空的（静态复帧由上层决定是否保留上一帧）
      return { ...EMPTY_RESOURCES, camera, status: 'ready' };
    }
    this.lastError = message ?? '预览画面解码失败。';
    return { ...EMPTY_RESOURCES, camera, status: status === 'loading' ? 'loading' : 'error', message: this.lastError ?? undefined };
  }

  /**
   * 求值某时间点的预览资源。
   *
   * 串行执行；调用方连续拖时间线时，排在队列里的旧请求会在真正解码前被跳过
   * （返回 null），只有最新一次请求会真正解出画面。
   */
  async resolve(project: Project, scene: FrameScene, tick: Ticks, consumer?: object): Promise<PreviewFrameResult | null> {
    if (this.disposed) return null;
    // Thumbnails share the cache but must only cancel their own stale requests.
    const token = consumer ? (this.latestTokens.get(consumer) ?? 0) + 1 : 0;
    if (consumer) this.latestTokens.set(consumer, token);
    const job = async (): Promise<PreviewFrameResult | null> => {
      if (this.disposed || (consumer && token !== this.latestTokens.get(consumer))) return null;
      try {
        this.pointerLookup ??= wcs().readPointerLog(this.projectPath)
          .then((result) => createPointerLookup(result.ok ? result.data?.events ?? [] : []))
          .catch(() => createPointerLookup([]));
        const lookup = await this.pointerLookup;
        const result = await this.load(project, scene, tick);
        return { ...result, pointer: pointerForScene(project, tick, lookup) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...EMPTY_RESOURCES, camera: null, status: 'error', message };
      }
    };
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * 给组件用的媒体缓存 hook：真实模式按工程目录建一个实例，卸载/换工程时关闭。
 *
 * mock 模式或没有工程路径时返回 null（调用方继续用 synthetic 演示画面）。
 */
export function createPreviewMedia(projectPath: string | null): PreviewMediaCache | null {
  if (!projectPath || shouldUseSyntheticPreview()) return null;
  return new PreviewMediaCache(projectPath);
}

/**
 * React hook：真实模式按工程目录维护一个共享解码缓存，卸载/换工程时关闭。
 *
 * 用 state 而不是 ref：父组件的 effect 晚于子组件执行，ref 变化不会触发子组件重渲染，
 * 子组件（教程截图）会永远拿不到缓存实例。
 */
export function usePreviewMedia(projectPath: string | null): PreviewMediaCache | null {
  const [media, setMedia] = useState<PreviewMediaCache | null>(null);
  useEffect(() => {
    const created = createPreviewMedia(projectPath);
    setMedia(created);
    return () => {
      created?.dispose();
    };
  }, [projectPath]);
  return media;
}

/** 在 canvas 上画中性占位（真实画面未就绪时用，绝不用合成演示画面顶替）。 */
export function paintPreviewPlaceholder(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  message: string,
): void {
  ctx.save();
  ctx.fillStyle = '#151a20';
  ctx.fillRect(0, 0, width, height);
  const fontSize = Math.max(12, Math.round(width / 46));
  ctx.fillStyle = '#9aa7b5';
  ctx.font = `${fontSize}px "Microsoft YaHei UI", "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
  ctx.restore();
}

/**
 * 确保 mediabunny 已注入 decoder。
 *
 * 主窗口在 main.tsx 里静态 import 了 exporterRuntime，它启动时已调用
 * configureMediabunny(mediabunny)；这里再做一次兜底，独立渲染（测试/验证脚本）
 * 也不至于因为「解码器未就绪」直接空白。
 */
export async function ensureMediabunnyReady(): Promise<boolean> {
  try {
    loadMediabunny();
    return true;
  } catch {
    try {
      const mod = await import('mediabunny');
      configureMediabunny(mod as unknown as Parameters<typeof configureMediabunny>[0]);
      return true;
    } catch {
      return false;
    }
  }
}
