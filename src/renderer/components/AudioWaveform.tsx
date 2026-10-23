/**
 * 时间线音频轨波形（§10.4）
 *
 * 单独一个组件是因为它要做「异步读 WAV → 算峰值 → 画 canvas」三件事，
 * 混在 Timeline 里会让那个已经很长的渲染函数更难读。
 *
 * 设计取舍：
 * - 只在轨道可见时加载；不可见就不读盘，避免打开工程瞬间把所有 WAV 读一遍。
 * - 读失败静默降级为纯色块：波形是辅助信息，不能因为读不到就报错（§10.4）。
 * - 按当前缩放算桶数，缩放变化只重算切片不重读文件（分层缓存的用处）。
 */

import { useEffect, useRef, useState } from 'react';
import { getCachedWaveform, buildWaveformFromWav, slicePeaks, waveformCacheKey } from '../lib/waveform';

export interface AudioWaveformProps {
  /** 素材在工程里的 id（缓存键的一部分） */
  assetId: string;
  /** 素材相对工程根目录的路径，用于按需读取 */
  relativePath: string;
  /** 片段在素材内的起点（秒） */
  sourceFromSeconds: number;
  /** 片段时长（秒） */
  durationSeconds: number;
  /** 画布宽度（CSS 像素） */
  width: number;
  height: number;
  /** 读取文件字节（由调用方注入，便于测试与复用） */
  readFile: (path: string) => Promise<ArrayBuffer | null>;
  className?: string;
}

/**
 * 波形 canvas 的物理像素宽度上限。
 *
 * 时间线放大到 5× 后，一小时的音频片段会有 60 多万 CSS 像素宽；
 * 直接按 CSS 宽度建 canvas 会超过浏览器的最大画布尺寸（约 32767），
 * 拿不到 2D 上下文，波形永远空白，还会占用巨量内存。
 * 这里上限内绘制、再用 CSS 拉伸回真实宽度。
 */
export const MAX_WAVEFORM_PAINT_WIDTH = 4096;

/** 按 CSS 宽度算出实际要绘制的像素宽度（跨缩放比稳定、可单测）。 */
export function waveformPaintWidth(cssWidth: number): number {
  const finite = Number.isFinite(cssWidth) ? cssWidth : 0;
  return Math.max(1, Math.min(Math.round(finite), MAX_WAVEFORM_PAINT_WIDTH));
}

export function AudioWaveform({
  assetId,
  relativePath,
  sourceFromSeconds,
  durationSeconds,
  width,
  height,
  readFile,
  className,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 失败状态只属于「这一次 props」：素材/时长/缩放变化后重新尝试，
    // 否则一次瞬时读取失败会让这条轨道永远没有波形。
    setFailed(false);

    const paint = (peaks: { min: number; max: number }[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = Math.max(1, Math.round(width));
      const cssH = Math.max(1, Math.round(height));
      const paintW = waveformPaintWidth(cssW);
      canvas.width = Math.max(1, Math.round(paintW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, paintW, cssH);

      const mid = cssH / 2;
      // 上下一半留给正负峰，留 1px 边距避免贴边
      const amp = Math.max(1, mid - 1);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      if (peaks.length === 0) return;
      // 峰值桶可能比物理像素宽/窄：按比例铺满整块画布，保证波形横跨整个片段
      const barWidth = Math.max(1 / dpr, paintW / peaks.length);
      for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i];
        const top = mid - Math.min(1, Math.abs(p.max)) * amp;
        const bottom = mid + Math.min(1, Math.abs(p.min)) * amp;
        const barHeight = Math.max(1, bottom - top);
        ctx.fillRect((i * paintW) / peaks.length, top, barWidth, barHeight);
      }
    };

    const run = async () => {
      // 缓存的是「整个文件的峰值」，与片段时长/入点无关。
      // 旧实现把 durationSeconds 塞进指纹，于是每次裁剪（滑杆每松一次手）
      // 都必然 miss：把整个 WAV 重新读进渲染进程并在主线程全量解析
      // （10 分钟 48kHz 立体声约 230MB），界面卡死，还最多堆 64 份峰值。
      // 片段区间只需要在 slicePeaks 里切，不必重读文件。
      const key = waveformCacheKey({
        assetId,
        byteLength: -1,
        sampleRate: 48_000,
        channels: 2,
      });
      const buckets = waveformPaintWidth(width);

      const cached = getCachedWaveform(key);
      if (cached) {
        if (cancelled) return;
        paint(slicePeaks(cached, sourceFromSeconds, sourceFromSeconds + durationSeconds, buckets));
        return;
      }

      try {
        const buffer = await readFile(relativePath);
        if (cancelled) return;
        if (!buffer) {
          setFailed(true);
          return;
        }
        const data = buildWaveformFromWav(key, buffer);
        if (cancelled) return;
        if (!data) {
          setFailed(true);
          return;
        }
        paint(slicePeaks(data, sourceFromSeconds, sourceFromSeconds + durationSeconds, buckets));
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [assetId, relativePath, sourceFromSeconds, durationSeconds, width, height, readFile]);

  // 读不到波形就不显示任何东西，底下露出轨道的纯色块——不留错误占位。
  // 注意 canvas 仍然挂载：若因为瞬时读取失败把 canvas 卸载，后续 props 变化时
  // paint() 拿不到 ref，波形将永远无法恢复。
  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ width, height, display: failed ? 'none' : 'block', pointerEvents: 'none' }}
    />
  );
}
