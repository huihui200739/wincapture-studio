import { activeVariant, findTrack, type Project } from '@domain/project';
import { outputSizeForAspect } from '@domain/scene';
import type { ExportProfile } from '@shared/ipc';

export type ExportResolution = 'source' | '720' | '1080' | '1440' | '2160';
export type ExportFrameRate = 'project' | '30' | '60';
export type ExportQuality = 'compact' | 'balanced' | 'high';

/** Resolution names refer to a 16:9 frame; square output uses the same long edge. */
export function createExportProfile(project: Project, settings: {
  variantId: string; resolution: ExportResolution; fps: ExportFrameRate;
  quality: ExportQuality; includeTutorial: boolean;
}): ExportProfile {
  const variant = project.variants.find((v) => v.id === settings.variantId) ?? activeVariant(project);
  const main = findTrack(project, 'primaryVideo');
  const sources = project.assets.filter((a) => main?.clips.some((c) => c.assetId === a.id));
  const sourceLongEdge = Math.max(2, ...sources.map((a) => Math.max(a.width, a.height)));
  const longEdge = settings.resolution === 'source' ? (sources.length ? sourceLongEdge : 1920)
    : ({ '720': 1280, '1080': 1920, '1440': 2560, '2160': 3840 } as const)[settings.resolution];
  const size = outputSizeForAspect(variant.aspect, longEdge);
  const fps = settings.fps === 'project' ? { ...project.settings.fps } : { num: Number(settings.fps), den: 1 };
  const multiplier = { compact: 0.6, balanced: 1, high: 1.6 }[settings.quality];
  const bitrate = Math.round(12_000_000 * (size.width * size.height / (1920 * 1080)) *
    Math.max(1, fps.num / fps.den / 30) * multiplier);
  return {
    variantId: variant.id, ...size, fps,
    videoBitrate: Math.max(1_000_000, Math.min(120_000_000, bitrate)),
    audioBitrate: 192_000, audioOnly: false, includeTutorial: settings.includeTutorial,
  };
}
