import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, useLocalTempDir } from './lib/local-temp.mjs';
import { electronExecutable } from './lib/electron-runtime.mjs';
useLocalTempDir('startup-camera');
const env = { ...process.env, WCS_STARTUP_PROBE: '1', WCS_USER_DATA: path.join(ROOT, '.tmp', `startup-camera-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
const started = Date.now();
const child = spawn(electronExecutable(), ['--no-sandbox', ROOT], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
const timeout = setTimeout(() => { child.kill(); console.error('[startup] 验收超时'); process.exitCode = 1; }, 120_000);
child.once('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.once('exit', code => {
  clearTimeout(timeout);
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'verify', 'startup-camera-result.json'), 'utf8'));
  console.log(`[startup] 主进程已退出 code=${code}，全流程 ${Date.now() - started}ms`);
  process.exitCode = code === 0 && report.ok ? 0 : 1;
});
