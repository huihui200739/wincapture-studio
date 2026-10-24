import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn, ChildProcess } from 'node:child_process';
import { PointerWorker } from '../../electron/capture/pointerWorker';

it('reads split native click packets, ignores malformed lines, and cleans up on stop', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: () => true });
  child.stdin.on('data', () => { child.exitCode = 0; child.emit('exit', 0); });
  const worker = new PointerWorker('pointer.exe', (() => child as unknown as ChildProcess) as typeof spawn);
  const events: unknown[] = []; let unexpectedExits = 0;
  worker.onEvent(event => events.push(event)); worker.onExit(() => unexpectedExits++);
  const start = worker.start();
  child.stdout.write('{"ready":true,"frequency":"100'); child.stdout.write('00000"}\ninvalid\n{"qpc":"12000000","kind":"down","x":-10,"y":200,"button":2}\n');
  await start; expect(worker.frequency).toBe(10_000_000n);
  expect(events).toEqual([{ qpc: 12_000_000n, kind: 'down', x: -10, y: 200, button: 2 }]);
  child.stdout.write('{"qpc":"12100000","kind":"move","x":40,"y":220,"button":0}\n');
  expect(events.at(-1)).toEqual({ qpc: 12_100_000n, kind: 'move', x: 40, y: 220, button: 0 });
  await worker.stop(); expect(unexpectedExits).toBe(0);
});

it('reports a click worker crash after startup', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true });
  const worker = new PointerWorker('pointer.exe', (() => child as unknown as ChildProcess) as typeof spawn);
  let exits = 0; worker.onExit(() => exits++);
  const start = worker.start(); child.stdout.write('{"ready":true,"frequency":"10000000"}\n'); await start;
  child.emit('exit', 1); expect(exits).toBe(1);
});
