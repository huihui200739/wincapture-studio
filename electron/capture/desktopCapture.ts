import type { BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import type { VideoFramePacket } from './wireProtocol';
import type { VideoCaptureSource } from './captureEngine';

export class DesktopVideoSource implements VideoCaptureSource {
  readonly backend = 'Chromium/WGC';
  frequency = 10_000_000n;
  cursorEmbedded = true;
  private win: BrowserWindow | null = null;
  private frames = new Set<(frame: VideoFramePacket) => void>();
  private exits = new Set<(reason: { code: number | null; signal: string | null; stderr: string }) => void>();
  private resolveFrame: (() => void) | null = null;
  private rejectFrame: ((error: Error) => void) | null = null;
  private stopping = false;
  private failed = false;
  private qpc = 0;
  private epochMs = 0;
  constructor(private readonly deps: { createWindow: () => BrowserWindow; ready(win: BrowserWindow): Promise<void>; clockExe: string },
    readonly captureBounds: { x: number; y: number; width: number; height: number },
    private readonly options: { width: number; height: number; fps: number; sourceWidth: number; sourceHeight: number; region?: { x: number; y: number; width: number; height: number } }) {}
  onFrame(listener: (frame: VideoFramePacket) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  onExit(listener: (reason: { code: number | null; signal: string | null; stderr: string }) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  async start(): Promise<void> {
    const clock = await new Promise<{ qpc: string; frequency: string }>((resolve, reject) => execFile(this.deps.clockExe, ['--clock'], { windowsHide: true, timeout: 3000 }, (e, data) => {
      if (e) { reject(e); return; } try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    }));
    this.frequency = BigInt(clock.frequency); this.qpc = Number(clock.qpc); this.epochMs = performance.timeOrigin + performance.now();
    const win = this.deps.createWindow(); this.win = win; await this.deps.ready(win);
    win.on('closed', () => this.fail('现代采集窗口已关闭'));
    const first = new Promise<void>((resolve, reject) => { this.resolveFrame = resolve; this.rejectFrame = reject; });
    const timeout = setTimeout(() => this.fail('现代采集未在 8 秒内返回画面；系统可能拒绝 WGC'), 8000);
    try {
      const started = win.webContents.executeJavaScript(`window.__wcsDesktop.start(${JSON.stringify(this.options)})`, true);
      void started.catch(error => this.fail(String(error)));
      await first;
    } finally { clearTimeout(timeout); }
  }
  accept(packet: unknown): void {
    if (this.stopping || this.failed || !packet || typeof packet !== 'object') return;
    const data = packet as { jpeg?: Uint8Array; wallTimeMs?: number; ended?: boolean; error?: string; cursorEmbedded?: boolean };
    if (data.ended || data.error) { this.fail(data.error ?? '来源窗口已关闭或屏幕采集已结束'); return; }
    if (!(data.jpeg instanceof Uint8Array) || data.jpeg.byteLength < 4 || data.jpeg.byteLength > 16 * 1024 * 1024 ||
      data.jpeg[0] !== 0xff || data.jpeg[1] !== 0xd8 || !Number.isFinite(data.wallTimeMs)) return;
    const qpc = BigInt(Math.round(this.qpc + (data.wallTimeMs! - this.epochMs) * Number(this.frequency) / 1000));
    this.cursorEmbedded = data.cursorEmbedded !== false;
    this.resolveFrame?.(); this.resolveFrame = null;
    for (const listener of this.frames) listener({ qpc, jpeg: Buffer.from(data.jpeg), receivedAt: Date.now() });
  }
  private fail(message: string): void {
    if (this.stopping || this.failed) return;
    this.failed = true;
    this.rejectFrame?.(new Error(message)); this.rejectFrame = null;
    for (const listener of this.exits) listener({ code: null, signal: null, stderr: message });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.win && !this.win.isDestroyed()) {
      try { await this.win.webContents.executeJavaScript('window.__wcsDesktop?.stop()'); } catch { }
      this.win.destroy();
    }
    this.win = null;
  }
}
