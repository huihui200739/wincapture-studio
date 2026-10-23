import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, useLocalTempDir } from './lib/local-temp.mjs';

useLocalTempDir('record-probe');
const env = { ...process.env, WCS_RECORDER_PROBE: '1',
  WCS_USER_DATA: path.join(ROOT, '.tmp', 'record-probe', `data-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: environment, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('录制验收超过 120 秒，已停止本次探针')); }, 120_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`验收进程退出码 ${code}`)); });
  });
}
try {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'main.cjs'))) throw new Error('请先运行 npm run build');
  await run(electron, ['--no-sandbox', ROOT], env);
  await run(process.execPath, [path.join(ROOT, 'scripts', 'verify-record.cjs')], process.env);
} catch (error) {
  console.error('[record-verify]', error.message);
  process.exitCode = 1;
}
