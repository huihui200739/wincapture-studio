import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './local-temp.mjs';

/**
 * Keep the Windows executable outside the source checkout. On this machine
 * Windows classifies the checkout's executable paths as Internet zone (3):
 * MFCreateDeviceSource then returns E_ACCESSDENIED despite camera consent.
 * The identical runtime in a normal local app directory opens the same camera.
 * This copies our installed Electron package; it changes no Windows policy.
 */
export function electronExecutable() {
  const source = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const name = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const original = path.join(source, name);
  if (!fs.existsSync(original)) throw new Error('找不到 Electron，请先执行 npm ci');
  if (process.platform !== 'win32') return original;

  const version = JSON.parse(fs.readFileSync(path.join(source, '..', 'package.json'), 'utf8')).version;
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WinCaptureStudio', 'runtime');
  const target = path.join(cache, `electron-${version}-${process.arch}`);
  const executable = path.join(target, name);
  const marker = path.join(target, '.wcs-runtime-ready.json');
  const sourceSize = fs.statSync(original).size;
  try {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (saved.version === version && saved.executableSize === sourceSize && fs.statSync(executable).size === sourceSize) return executable;
  } catch { /* First use, or an interrupted copy: stage a complete runtime. */ }

  fs.mkdirSync(cache, { recursive: true });
  const staging = path.join(cache, `electron-${version}-${process.arch}.staging-${process.pid}-${Date.now()}`);
  try {
    fs.cpSync(source, staging, { recursive: true, filter: file => path.basename(file) !== 'debug.log' });
    fs.writeFileSync(path.join(staging, '.wcs-runtime-ready.json'), JSON.stringify({ version, executableSize: sourceSize }));
    // A complete cache is immutable. A concurrent successful launcher wins.
    if (!fs.existsSync(target)) fs.renameSync(staging, target);
    else if (fs.existsSync(marker) && fs.statSync(executable).size === sourceSize) return executable;
    else throw new Error(`本地 Electron 缓存不完整，请移除后重试：${target}`);
    console.log(`[electron] 本地运行时已准备：${executable}`);
    return executable;
  } finally {
    // Only remove the exact staging directory this invocation created.
    if (path.dirname(path.resolve(staging)) === path.resolve(cache) && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}
