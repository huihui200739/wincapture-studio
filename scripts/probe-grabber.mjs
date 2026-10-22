#!/usr/bin/env node
/**
 * 采集工作进程联调脚本
 *   node scripts/probe-grabber.mjs [width] [height] [seconds]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'dist', 'native', 'grabber.exe');
if (!fs.existsSync(exe)) {
  console.error('缺少 dist/native/grabber.exe，先运行 npm run build:native');
  process.exit(1);
}

const W = Number(process.argv[2] ?? 1280);
const H = Number(process.argv[3] ?? 720);
const SECONDS = Number(process.argv[4] ?? 3);
const FPS = 30;

const child = spawn(exe, [String(W), String(H), '0', '0', '88', String(FPS)], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let acc = Buffer.alloc(0);
let frames = 0;
let bytes = 0;
let firstQpc = null;
let lastQpc = null;
const intervals = [];
let stderrText = '';

child.stderr.on('data', (chunk) => {
  stderrText += chunk.toString();
  process.stdout.write('[stderr] ' + chunk.toString().trimEnd() + '\n');
});

child.stdout.on('data', (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  while (acc.length >= 12) {
    const len = acc.readUInt32LE(0);
    if (acc.length < 12 + len) break;
    const qpc = Number(acc.readBigInt64LE(4));
    const jpeg = acc.subarray(12, 12 + len);
    acc = acc.subarray(12 + len);
    if (firstQpc === null) firstQpc = qpc;
    if (lastQpc !== null) intervals.push(qpc - lastQpc);
    lastQpc = qpc;
    frames += 1;
    bytes += jpeg.length;
    if (frames === 1) {
      const isJpeg = jpeg[0] === 0xff && jpeg[1] === 0xd8;
      console.log(`first frame: bytes=${jpeg.length} isJpeg=${isJpeg}`);
      fs.writeFileSync(path.join(root, 'dist', 'probe-frame.jpg'), jpeg);
    }
  }
});

const start = Date.now();
setTimeout(() => {
  child.stdin.write('q\n');
  setTimeout(() => {
    const elapsed = (Date.now() - start) / 1000;
    const freqMatch = /QPCFREQ (\d+)/.exec(stderrText);
    const freq = freqMatch ? Number(freqMatch[1]) : null;
    const qpcSpan = firstQpc !== null && lastQpc !== null ? (lastQpc - firstQpc) / (freq ?? 1) : 0;
    const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const jitter = intervals.length
      ? Math.sqrt(intervals.reduce((a, b) => a + (b - avgInterval) ** 2, 0) / intervals.length) / (freq ?? 1) * 1000
      : 0;
    console.log('---');
    console.log(`requested=${W}x${H}@${FPS} duration=${SECONDS}s`);
    console.log(`frames=${frames} elapsed=${elapsed.toFixed(2)}s effectiveFps=${(frames / elapsed).toFixed(1)}`);
    console.log(`avgBytes=${Math.round(bytes / Math.max(1, frames))} totalKB=${Math.round(bytes / 1024)}`);
    console.log(`qpcSpan=${qpcSpan.toFixed(3)}s qpcFreq=${freq}`);
    console.log(`frameIntervalAvg=${(avgInterval / (freq ?? 1) * 1000).toFixed(2)}ms jitterStd=${jitter.toFixed(2)}ms`);
    const target = 1000 / FPS;
    console.log(`pacingOk=${Math.abs(avgInterval / (freq ?? 1) * 1000 - target) < target * 0.15}`);
    child.kill();
    process.exit(0);
  }, 400);
}, SECONDS * 1000);
