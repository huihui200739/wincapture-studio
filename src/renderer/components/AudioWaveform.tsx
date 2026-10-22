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

    const paint = (peaks: { min: number; max: number }[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const mid = h / 2;
      // 上下一半留给正负峰，留 1px 边距避免贴边
      const amp = Math.max(1, mid - 1);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i];
        const top = mid - Math.min(1, Math.abs(p.max)) * amp;
        const bottom = mid + Math.min(1, Math.abs(p.min)) * amp;
        const barHeight = Math.max(1, bottom - top);
        ctx.fillRect(i, top, 1, barHeight);
      }
    };

    const run = async () => {
      const key = waveformCacheKey({
        assetId,
        // 这里没法先知道字节数，用相对路径长度 + 时长做廉价指纹，
        // 真正的字节数在首次读取后由 buildWaveformFromWav 内部缓存兜住。
        byteLength: relativePath.length + Math.round(durationSeconds * 1000),
        sampleRate: 48_000,
        channels: 2,
      });

      const cached = getCachedWaveform(key);
      if (cached) {
        if (cancelled) return;
        paint(slicePeaks(cached, sourceFromSeconds, sourceFromSeconds + durationSeconds, width));
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
        paint(slicePeaks(data, sourceFromSeconds, sourceFromSeconds + durationSeconds, width));
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [assetId, relativePath, sourceFromSeconds, durationSeconds, width, height, readFile]);

  // 读不到波形就什么都不画，底下露出轨道的纯色块——不留错误占位
  if (failed) return null;

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ width, height, display: 'block', pointerEvents: 'none' }}
    />
  );
}
