import { useEffect, useRef, useState } from 'react';
import type { PeakBucket } from '../lib/waveform';
import type { WaveformPeakLoader } from '../lib/waveformSource';

export interface AudioWaveformProps {
  assetId: string;
  relativePath: string;
  sourceFromSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
  loadPeaks: WaveformPeakLoader;
  className?: string;
}

export const MAX_WAVEFORM_PAINT_WIDTH = 4096;
export function waveformPaintWidth(cssWidth: number): number {
  const finite = Number.isFinite(cssWidth) ? cssWidth : 0;
  return Math.max(1, Math.min(Math.round(finite), MAX_WAVEFORM_PAINT_WIDTH));
}

export function AudioWaveform({ assetId, relativePath, sourceFromSeconds, durationSeconds,
  width, height, loadPeaks, className }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'silent' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let peaks: PeakBucket[] = [];
    setStatus('loading');
    const paint = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const paintW = waveformPaintWidth(width);
      const cssH = Math.max(1, Math.round(height));
      canvas.width = Math.round(paintW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mid = cssH / 2;
      ctx.fillStyle = getComputedStyle(canvas).color;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(0, mid, paintW, 1 / dpr);
      ctx.globalAlpha = 1;
      const maximum = peaks.reduce((max, peak) => Math.max(max, Math.abs(peak.min), Math.abs(peak.max)), 0);
      // Display gain only: keep quiet speech legible without changing playback or inventing peaks in silence.
      const gain = maximum > 0.000001 ? Math.min(64, 0.9 / maximum) : 1;
      const barWidth = paintW / Math.max(1, peaks.length);
      peaks.forEach((peak, i) => {
        const top = mid - Math.min(1, Math.max(0, peak.max) * gain) * (mid - 1);
        const bottom = mid + Math.min(1, Math.max(0, -peak.min) * gain) * (mid - 1);
        ctx.fillRect(i * barWidth, top, Math.max(1 / dpr, barWidth - 0.5), Math.max(1 / dpr, bottom - top));
      });
    };
    const theme = new MutationObserver(paint);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    paint();
    void loadPeaks(assetId, relativePath, sourceFromSeconds, sourceFromSeconds + durationSeconds,
      Math.ceil(waveformPaintWidth(width) / 2)).then(result => {
      if (cancelled) return;
      if (!result.length) throw new Error('无波形数据');
      peaks = result;
      setStatus(peaks.some(p => Math.abs(p.min) > 0.000001 || Math.abs(p.max) > 0.000001) ? 'ready' : 'silent');
      paint();
    }).catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; theme.disconnect(); };
  }, [assetId, relativePath, sourceFromSeconds, durationSeconds, width, height, loadPeaks]);

  const message = status === 'loading' ? '正在生成波形…' : status === 'silent' ? '无声音' : status === 'error' ? '波形读取失败' : null;
  return <>
    <canvas ref={canvasRef} className={className} data-waveform-state={status} aria-label="音频波形"
      role="img" style={{ width, height, pointerEvents: 'none' }} />
    {message && <span className="tl-waveform-status" role="status">{message}</span>}
  </>;
}
