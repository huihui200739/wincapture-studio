import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, useLocalTempDir } from './lib/local-temp.mjs';
import { electronExecutable } from './lib/electron-runtime.mjs';

useLocalTempDir('studio-flow');
const env = { ...process.env, WCS_STUDIO_PROBE: '1', WCS_USER_DATA: path.join(ROOT, '.tmp', `studio-flow-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExecutable(), ['--no-sandbox', ROOT], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
const timeout = setTimeout(() => { child.kill(); console.error('[studio] 超时，已停止本次验收'); process.exitCode = 1; }, 210_000);
child.once('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
