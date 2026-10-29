import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { electronExecutable } from './lib/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, WCS_E2E_PROBE: '1', WCS_E2E_CAMERA: '1', WCS_E2E_SECONDS: '10',
  WCS_USER_DATA: path.join(root, '.tmp', 'camera-recording-check') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExecutable(), ['--no-sandbox', root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const diagnostics = [];
let pending = '';
child.stdout.on('data', bytes => {
  process.stdout.write(bytes); pending += bytes;
  let newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    const match = line.match(/采样诊断 (\{.*\})/);
    if (match) diagnostics.push(JSON.parse(match[1]));
  }
});
child.stderr.on('data', bytes => process.stderr.write(bytes));
const timer = setTimeout(() => child.kill(), 90000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  const interior = diagnostics.slice(1, -1);
  const ok = code === 0 && interior.length >= 3 && interior.every(s => s.uniqueFrames >= 40 && s.longestHoldMs <= 100);
  fs.writeFileSync(path.join(root, 'dist/verify/camera-recording-cadence.json'), JSON.stringify({ ok, diagnostics }, null, 2));
  console.log('[camera-recording] cadence ' + (ok ? 'PASS' : 'FAIL'));
  process.exitCode = ok ? 0 : 1;
});
