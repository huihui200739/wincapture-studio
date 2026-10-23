import { useEffect, useRef, useState } from 'react';
import type { Clip, Project } from '@domain/project';
import { clipTimelineDuration } from '@domain/project';
import { evaluateScene } from '@domain/scene';
import type { PreviewMediaCache } from '../lib/previewSource';
import { shouldUseSyntheticPreview } from '../lib/previewSource';
import { syntheticScreen, syntheticCamera } from '../lib/syntheticMedia';

export function VideoThumbnails({ project, clip, width, camera, media }: { project: Project; clip: Clip; width: number; camera: boolean; media: PreviewMediaCache | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { root: canvas.closest('.timeline-scroll'), rootMargin: '160px' });
    observer.observe(canvas); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !visible) return;
    const context = canvas.getContext('2d'); if (!context) return;
    let cancelled = false;
    const count = Math.max(1, Math.min(12, Math.ceil(width / 80)));
    canvas.width = Math.min(2048, count * 96); canvas.height = 54;
    context.fillStyle = '#101418'; context.fillRect(0, 0, canvas.width, canvas.height);
    void (async () => {
      for (let i = 0; i < count; i++) {
        if (cancelled) return;
        const tick = Math.min(clip.timelineInTicks + clipTimelineDuration(clip) - 1, clip.timelineInTicks + Math.round(clipTimelineDuration(clip) * (i + 0.5) / count));
        let image: CanvasImageSource | null = null;
        if (shouldUseSyntheticPreview()) image = camera ? syntheticCamera(tick / 10_000_000) : syntheticScreen(tick / 10_000_000);
        else if (media) {
          const scene = evaluateScene(project, tick, { outputWidth: 320, outputHeight: 180 });
          // The camera track thumbnail remains visible even when its canvas overlay is hidden.
          if (camera) scene.camera = { ...scene.camera, visible: true };
          const resource = await media.resolve(project, scene, tick, canvas);
          image = camera ? resource?.camera ?? null : resource?.screen ?? null;
        }
        if (!cancelled && image) context.drawImage(image, i * canvas.width / count, 0, canvas.width / count, canvas.height);
      }
    })().catch(() => { /* Leave unavailable thumbnails dark; never substitute demo frames. */ });
    return () => { cancelled = true; };
  }, [project, clip, width, camera, media, visible]);
  return <canvas ref={ref} className="tl-video-thumbnails" aria-hidden="true" />;
}
