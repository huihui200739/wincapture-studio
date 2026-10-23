import { useEffect, useRef, useState } from 'react';
import type { Project } from '@domain/project';
import { buildExportPlan } from '@domain/exportPlan';
import { TICKS_PER_SECOND } from '@domain/timebase';
import { TimelineAudioMixer, type FrameProvider } from '../../media/exporter';
import { VideoFrameSource, configureMediabunny } from '../../media/decoder';
import * as mediabunny from 'mediabunny';
import { absoluteMediaPath } from './previewSource';
import { wcs } from './wcs';

/** Cancels scheduled nodes on pause/seek, and schedules PCM against the visual playhead. */
export class AudioPreviewScheduler {
  private nodes = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private cursor = -1;
  private lastTick = 0;
  private lastTime = 0;
  private busy = false;
  constructor(private readonly context: AudioContext, private readonly mixer: Pick<TimelineAudioMixer, 'renderChunk'>,
    private readonly totalSamples: number, private readonly getTick: () => number, private readonly onError: (e: unknown) => void) {}

  stop(): void {
    this.generation++;
    for (const node of this.nodes) { try { node.stop(); } catch { /* already ended */ } node.disconnect(); }
    this.nodes.clear(); this.cursor = -1;
  }

  async pump(): Promise<void> {
    if (this.busy || this.context.state !== 'running') return;
    const sr = 48_000, now = this.context.currentTime, tick = this.getTick();
    if (this.cursor >= 0 && Math.abs((tick - this.lastTick) / TICKS_PER_SECOND - (now - this.lastTime)) > 0.08) this.stop();
    this.lastTick = tick; this.lastTime = now;
    if (this.cursor < 0) this.cursor = Math.round((tick / TICKS_PER_SECOND + 0.04) * sr);
    const generation = this.generation;
    this.busy = true;
    try {
      while (this.cursor < this.totalSamples && this.cursor / sr < this.getTick() / TICKS_PER_SECOND + 0.3) {
        const start = this.cursor, count = Math.min(4800, this.totalSamples - start);
        const buffer = await this.mixer.renderChunk(start, count);
        if (generation !== this.generation) return;
        const delay = start / sr - this.getTick() / TICKS_PER_SECOND;
        if (delay < -0.02) { this.cursor = Math.round((this.getTick() / TICKS_PER_SECOND + 0.04) * sr); continue; }
        if (buffer) {
          const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.context.destination);
          node.onended = () => { this.nodes.delete(node); node.disconnect(); };
          this.nodes.add(node); node.start(this.context.currentTime + Math.max(0, delay));
        }
        this.cursor = start + count;
      }
    } catch (e) { if (generation === this.generation) { this.stop(); this.onError(e); } }
    finally { this.busy = false; }
  }
}

export function useAudioPreview(project: Project | null, projectPath: string | null, tick: number, playing: boolean, enabled: boolean) {
  const tickRef = useRef(tick); tickRef.current = tick;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!project || !projectPath || !playing || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let scheduler: AudioPreviewScheduler | undefined;
    const context = new AudioContext({ sampleRate: 48_000 });
    const sources = new Map<string, FrameProvider>();
    const fail = (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); };
    void (async () => {
      await context.resume();
      configureMediabunny(mediabunny as unknown as Parameters<typeof configureMediabunny>[0]);
      const plan = buildExportPlan(project, { width: 1280, height: 720, fps: project.settings.fps,
        videoBitrate: 0, audioBitrate: 192_000, audioOnly: true });
      const api = wcs();
      for (const id of new Set(plan.audioIntervals.filter(i => !i.muted && i.gain > 0).map(i => i.assetId))) {
        if (cancelled) return;
        const asset = project.assets.find(a => a.id === id);
        if (!asset) throw new Error(`试听音频素材缺失：${id}`);
        const listed = await api.listMediaSegments(projectPath, asset.path);
        if (!listed.ok || !listed.data?.length) throw new Error(`无法读取试听音频：${asset.path}`);
        const source = new VideoFrameSource({ sampleRate: 48_000, nodeFilePaths: false, readFile: async path => {
          const response = await api.readExportFile(absoluteMediaPath(projectPath, path));
          if (!response.ok || !response.data) throw new Error(response.error?.message ?? '音频读取失败');
          return response.data;
        } }, listed.data.map(s => ({ ...s, path: absoluteMediaPath(projectPath, s.path) })));
        sources.set(id, source); await source.open();
      }
      if (cancelled) return;
      const rates = new Map(project.tracks.flatMap(t => t.clips.map(c => [c.id, c.rate.num / c.rate.den] as const)));
      const warnings: string[] = [];
      const mixer = new TimelineAudioMixer(plan, sources, { audioBufferFactory: context, addAudio: async () => {} }, () => {}, rates, warnings);
      scheduler = new AudioPreviewScheduler(context, mixer, plan.audioTotalSamples, () => tickRef.current, fail);
      const pump = () => { void scheduler?.pump().then(() => { if (warnings.length) fail(new Error(warnings[0])); }); };
      pump(); timer = setInterval(pump, 40);
    })().catch(fail).finally(() => { if (cancelled) for (const source of sources.values()) source.close?.(); });
    return () => {
      cancelled = true; clearInterval(timer); scheduler?.stop();
      for (const source of sources.values()) source.close?.();
      void context.close().catch(() => undefined);
    };
  }, [project, projectPath, playing, enabled]);
  return error;
}
