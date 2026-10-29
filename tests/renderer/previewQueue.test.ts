import { describe, expect, it } from 'vitest';
import { PreviewQueue } from '../../src/renderer/lib/previewQueue';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
describe('preview playback under slow decoding', () => {
  it('presents completed frames despite newer ticks, then decodes only the latest pending tick', async () => {
    const queue = new PreviewQueue(), wait = deferred(), drawn: number[] = [];
    queue.submit(async current => { await wait.promise; if (current()) drawn.push(1); });
    for (let tick = 2; tick <= 60; tick++) queue.submit(async current => { if (current()) drawn.push(tick); });
    wait.resolve(); await new Promise(r => setTimeout(r, 0));
    expect(drawn).toEqual([1, 60]);
  });
  it('does not present an old frame after pause, seek or closing a project', async () => {
    const queue = new PreviewQueue(), wait = deferred(), drawn: number[] = [];
    queue.submit(async current => { await wait.promise; if (current()) drawn.push(1); });
    queue.submit(async current => { if (current()) drawn.push(2); });
    queue.cancel();
    queue.submit(async current => { if (current()) drawn.push(10); });
    wait.resolve(); await new Promise(r => setTimeout(r, 0));
    expect(drawn).toEqual([10]);
  });
});
