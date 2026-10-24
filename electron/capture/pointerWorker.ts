import { spawn, type ChildProcess } from 'node:child_process';
export interface NativePointerEvent { qpc: bigint; kind: 'down' | 'up'; x: number; y: number; button: number; hwnd?: string; bounds?: { x: number; y: number; width: number; height: number } }
export class PointerWorker {
  get pid(): number | null { return this.child?.exitCode === null ? this.child.pid ?? null : null; }
  private child: ChildProcess | null = null;
  private pending = '';
  private listeners = new Set<(event: NativePointerEvent) => void>();
  private exits = new Set<() => void>();
  private stopping = false;
  frequency = 10_000_000n;
  constructor(private readonly exe: string, private readonly spawnImpl: typeof spawn = spawn) {}
  onEvent(listener: (event: NativePointerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onExit(listener: () => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  async start(): Promise<void> {
    this.stopping = false; this.pending = '';
    const child = this.spawnImpl(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill(); reject(error); } else resolve(); };
      const timer = setTimeout(() => finish(new Error('鼠标点击采集启动超时')), 3000);
      child.once('error', error => finish(error)); child.once('exit', () => { if (!this.stopping) for (const listener of this.exits) listener(); finish(new Error('鼠标点击采集进程退出')); });
      child.stdout?.on('data', (chunk: Buffer) => {
        this.pending += chunk.toString('utf8');
        if (this.pending.length > 262144) { finish(new Error('鼠标事件协议失步')); child.kill(); return; }
        let newline: number;
        while ((newline = this.pending.indexOf('\n')) >= 0) {
          const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.ready && /^\d+$/.test(event.frequency) && BigInt(event.frequency) > 0n) { this.frequency = BigInt(event.frequency); finish(); }
            else if ((event.kind === 'down' || event.kind === 'up') && /^\d+$/.test(event.qpc) && Number.isFinite(event.x) && Number.isFinite(event.y)) {
              for (const listener of this.listeners) listener({ ...event, qpc: BigInt(event.qpc) });
            }
          } catch { /* A malformed line must not affect subsequent events. */ }
        }
      });
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child; this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin?.write('q\n');
    });
  }
}
