import { afterEach, expect, it, vi } from 'vitest';
import { NativeMemorySampler, parseProcessMemory } from '../../electron/capture/processMemory';
afterEach(() => vi.useRealTimers());
it('excludes unrelated, duplicated and malformed process memory rows', () => {
  expect(parseProcessMemory([
    { pid: 1, workingSetBytes: 100, privateBytes: 50 }, { pid: 1, workingSetBytes: 200, privateBytes: 50 },
    { pid: 2, workingSetBytes: 900, privateBytes: 200 }, { pid: 3, workingSetBytes: -5, privateBytes: 0 },
    { pid: 4, workingSetBytes: Infinity, privateBytes: 0 }, null,
  ], [1, 3, 4])).toEqual([{ pid: 1, workingSetBytes: 100, privateBytes: 50 }]);
});
it('serializes polling and excludes exited workers without double counting', async () => {
  let finish!: (value: { pid: number; workingSetBytes: number; privateBytes: number }[]) => void;
  const read = vi.fn(() => new Promise<{ pid: number; workingSetBytes: number; privateBytes: number }[]>(resolve => { finish = resolve; }));
  const sampler = new NativeMemorySampler(read), poll = sampler.poll();
  await sampler.poll(); expect(read).toHaveBeenCalledTimes(1);
  finish([{ pid: 10, workingSetBytes: 100, privateBytes: 50 }, { pid: 11, workingSetBytes: 200, privateBytes: 60 }]);
  await poll; expect(sampler.total([10])).toBe(100); expect(sampler.total([10, 11])).toBe(300);
  expect(sampler.peakBytes).toBe(300); expect(sampler.maxProcesses).toBe(2);
  sampler.stop(); expect(sampler.total([10, 11])).toBe(0);
});
it('does not retain late samples after stopping and reports inspection failures', async () => {
  const sampler = new NativeMemorySampler(async () => { throw new Error('query failed'); });
  await sampler.poll(); expect(sampler.errors).toBe(1); expect(sampler.samples).toBe(0);
  sampler.stop(); await sampler.poll(); expect(sampler.errors).toBe(1);
});
