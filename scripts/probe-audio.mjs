#!/usr/bin/env node
/**
 * 音频工作进程联调脚本：验证系统回环 + 麦克风双路采集、重采样、电平与 QPC 时间基准。
 *   node scripts/probe-audio.mjs [seconds]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'dist', 'native', 'audio.exe');
if (!fs.existsSync(exe)) {
  console.error('缺少 dist/native/audio.exe');
  process.exit(1);
}

const SECONDS = Number(process.argv[2] ?? 3);

/** 生成并播放一段 440Hz 音调，制造系统声音以验证回环确实有数据。 */
function playTone() {
  const wav = path.join(root, 'dist', 'tone.wav');
  const rate = 48000;
  const samples = rate * (SECONDS + 1);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wav, Buffer.concat([header, data]));
  return spawn('powershell', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${wav}').PlaySync()`], {
    stdio: 'ignore',
  });
}

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const stats = {
  0: { packets: 0, frames: 0, peak: 0, rmsSum: 0, firstQpc: null, lastQpc: null, samples: [] },
  1: { packets: 0, frames: 0, peak: 0, rmsSum: 0, firstQpc: null, lastQpc: null, samples: [] },
};
const errors = [];
let stderrText = '';
let qpcFrequency = 10_000_000;
let acc = Buffer.alloc(0);

child.stderr.on('data', (c) => {
  stderrText += c.toString();
  process.stdout.write('[stderr] ' + c.toString().trimEnd() + '\n');
  const m = /QPCFREQ (\d+)/.exec(stderrText);
  if (m) qpcFrequency = Number(m[1]);
});

child.stdout.on('data', (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  while (acc.length >= 4) {
    const total = acc.readUInt32LE(0);
    if (total < 24 || acc.length < total) break;
    const packet = acc.subarray(0, total);
    acc = acc.subarray(total);
    const streamId = packet.readUInt32LE(4);
    if (streamId === 0xffffffff) {
      const codeLen = packet.readUInt32LE(12);
      const msgLen = packet.readUInt32LE(16);
      const code = packet.subarray(20, 20 + codeLen).toString('utf8');
      const message = packet.subarray(20 + codeLen, 20 + codeLen + msgLen).toString('utf8');
      errors.push({ streamId: packet.readUInt32LE(8), code, message });
      continue;
    }
    const startFrame = packet.readInt32LE(8);
    const rms = packet.readFloatLE(12);
    const qpc = Number(packet.readBigInt64LE(16));
    const frames = (total - 24) / 8;
    const st = stats[streamId];
    if (!st) continue;
    st.packets += 1;
    st.frames += frames;
    st.rmsSum += rms;
    if (rms > st.peak) st.peak = rms;
    if (st.firstQpc === null) st.firstQpc = qpc;
    st.lastQpc = qpc;
    if (st.packets <= 3) {
      let nonZero = 0;
      for (let i = 0; i < frames; i += 37) {
        const v = packet.readFloatLE(24 + i * 4);
        if (Math.abs(v) > 1e-6) nonZero += 1;
      }
      st.samples.push({
        startFrame,
        frames,
        rms: Number(rms.toFixed(4)),
        nonZeroSamples: nonZero,
        qpcSeconds: Number((qpc / qpcFrequency).toFixed(4)),
      });
    }
  }
});

const tone = playTone();

setTimeout(() => {
  child.stdin.write('q\n');
  setTimeout(() => {
    try {
      tone.kill();
    } catch {
      /* 忽略 */
    }
    console.log('---');
    console.log(`qpcFrequency=${qpcFrequency}`);
    for (const id of [0, 1]) {
      const st = stats[id];
      const label = id === 0 ? 'system(loopback)' : 'mic';
      const span = st.firstQpc !== null ? (st.lastQpc - st.firstQpc) / qpcFrequency : 0;
      console.log(
        `${label}: packets=${st.packets} frames=${st.frames} audioSeconds=${(st.frames / 48000).toFixed(2)} qpcSpan=${span.toFixed(2)}s peakRms=${st.peak.toFixed(4)} avgRms=${(st.rmsSum / Math.max(1, st.packets)).toFixed(4)}`,
      );
      if (st.samples.length) console.log(`  samples=${JSON.stringify(st.samples)}`);
    }
    if (stats[0].firstQpc !== null && stats[1].firstQpc !== null) {
      const skew = (stats[0].firstQpc - stats[1].firstQpc) / qpcFrequency;
      console.log(`firstPacketSkew=${skew.toFixed(3)}s (两路启动时刻差，用 QPC 可对齐)`);
    }
    console.log(`errors=${JSON.stringify(errors)}`);
    const sysOk = stats[0].frames > 48000 * 0.5 && stats[0].peak > 0.001;
    const micOk = stats[1].frames > 48000 * 0.5;
    console.log(`systemAudioCaptured=${sysOk}`);
    console.log(`micCaptured=${micOk}`);
    child.kill();
    process.exit(sysOk && micOk ? 0 : 1);
  }, 400);
}, SECONDS * 1000);
