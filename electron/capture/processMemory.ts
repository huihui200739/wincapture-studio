import { execFile } from 'node:child_process';

export interface NativeProcessMemory { pid: number; workingSetBytes: number; privateBytes: number }

/** Validate native diagnostic output and exclude unrelated or duplicate processes. */
export function parseProcessMemory(value: unknown, pids: readonly number[]): NativeProcessMemory[] {
  if (!Array.isArray(value)) throw new Error('原生进程内存协议无效');
  const allowed = new Set(pids), seen = new Set<number>();
  return value.filter((row): row is NativeProcessMemory => {
    if (!row || typeof row !== 'object' || !allowed.has(row.pid) || seen.has(row.pid) ||
      !Number.isSafeInteger(row.workingSetBytes) || row.workingSetBytes < 0 ||
      !Number.isSafeInteger(row.privateBytes) || row.privateBytes < 0) return false;
    seen.add(row.pid); return true;
  }).map(({ pid, workingSetBytes, privateBytes }) => ({ pid, workingSetBytes, privateBytes }));
}

/** Sample only the recorder's native children; never enumerate other applications. */
export async function nativeProcessMemory(exe: string, pids: readonly number[]): Promise<NativeProcessMemory[]> {
  const ids = [...new Set(pids.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return [];
  return new Promise((resolve, reject) => execFile(exe, [`--process-memory=${ids.join(',')}`],
    { windowsHide: true, timeout: 2000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(parseProcessMemory(JSON.parse(stdout), ids)); } catch (error) { reject(error); }
    }));
}

/** Non-overlapping asynchronous polling keeps process launch/inspection off the frame callback. */
export class NativeMemorySampler {
  rows: NativeProcessMemory[] = [];
  samples = 0;
  errors = 0;
  peakBytes = 0;
  maxProcesses = 0;
  private busy = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly read: () => Promise<NativeProcessMemory[]>) {}
  async poll(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try { const rows = await this.read(); if (!this.stopped) {
      this.rows = rows; this.samples++;
      this.peakBytes = Math.max(this.peakBytes, rows.reduce((sum, row) => sum + row.workingSetBytes, 0));
      this.maxProcesses = Math.max(this.maxProcesses, rows.length);
    } }
    catch { this.errors++; }
    finally { this.busy = false; }
  }
  start(): void { if (!this.timer && !this.stopped) { void this.poll(); this.timer = setInterval(() => void this.poll(), 500); } }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.rows = []; }
  total(pids: readonly number[]): number { const active = new Set(pids); return this.rows.reduce((sum, row) => sum + (active.has(row.pid) ? row.workingSetBytes : 0), 0); }
}
