import type { WcsApi } from '@shared/api';
import { TICKS_PER_SECOND } from '@domain/timebase';
import { buildWaveformFromWav, getCachedWaveform, slicePeaks, type PeakBucket, type WaveformData } from './waveform';

type Segment = { path: string; startTick: number; durationTicks: number; bytes: number };
type WaveformApi = Pick<WcsApi, 'listMediaSegments' | 'readExportFile'>;
export type WaveformPeakLoader = (assetId: string, path: string, from: number, to: number, buckets: number) => Promise<PeakBucket[]>;

/** Read each recorded WAV segment separately; never stretch the first segment over the whole clip. */
export class WaveformSource {
  private lists = new Map<string, Promise<Segment[]>>();
  private pending = new Map<string, Promise<WaveformData>>();

  constructor(private projectPath: string, private api: WaveformApi) {}

  private segments(path: string): Promise<Segment[]> {
    let list = this.lists.get(path);
    if (!list) {
      list = this.api.listMediaSegments(this.projectPath, path).then(response => {
        if (!response.ok || !response.data?.length) throw new Error('无法读取音频分段');
        return [...response.data].sort((a, b) => a.startTick - b.startTick);
      }).catch(error => { this.lists.delete(path); throw error; });
      this.lists.set(path, list);
    }
    return list;
  }

  private async data(segment: Segment): Promise<WaveformData> {
    const key = `${this.projectPath}|${segment.path}|${segment.bytes}|peaks-v2`;
    const cached = getCachedWaveform(key);
    if (cached) return cached;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        const absolute = `${this.projectPath.replace(/[\\/]+$/, '')}/${segment.path}`;
        const response = await this.api.readExportFile(absolute);
        if (!response.ok || !response.data) throw new Error('无法读取音频文件');
        const bytes = response.data;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const data = buildWaveformFromWav(key, buffer);
        if (!data) throw new Error('无法解析音频波形');
        return data;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  readonly load: WaveformPeakLoader = async (_assetId, path, from, to, buckets) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !Number.isFinite(buckets) || buckets < 1) return [];
    const count = Math.max(1, Math.min(4096, Math.round(buckets)));
    const result = Array.from({ length: count }, (): PeakBucket => ({ min: 0, max: 0 }));
    const step = (to - from) / count;
    for (const segment of await this.segments(path)) {
      const start = segment.startTick / TICKS_PER_SECOND;
      const end = start + segment.durationTicks / TICKS_PER_SECOND;
      if (end <= from || start >= to) continue;
      const data = await this.data(segment);
      const first = Math.max(0, Math.floor((start - from) / step));
      const last = Math.min(count, Math.ceil((end - from) / step));
      for (let i = first; i < last; i++) {
        const localFrom = Math.max(start, from + i * step) - start;
        const localTo = Math.min(end, from + (i + 1) * step) - start;
        const peak = slicePeaks(data, localFrom, localTo, 1)[0];
        if (peak) {
          result[i].min = Math.min(result[i].min, peak.min);
          result[i].max = Math.max(result[i].max, peak.max);
        }
      }
    }
    return result;
  };
}
