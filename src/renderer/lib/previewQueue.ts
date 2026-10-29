type FrameJob = (isCurrent: () => boolean) => Promise<void>;

/** One decode in flight and one replaceable pending frame. Slow decoders still get to present. */
export class PreviewQueue {
  private pending: FrameJob | null = null;
  private running = false;
  private generation = 0;

  submit(job: FrameJob): void {
    this.pending = job;
    if (!this.running) void this.drain();
  }

  cancel(): void { this.generation++; this.pending = null; }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        const generation = this.generation;
        await job(() => generation === this.generation);
      }
    } finally { this.running = false; }
  }
}
