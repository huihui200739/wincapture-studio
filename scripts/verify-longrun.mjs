import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, useLocalTempDir } from './lib/local-temp.mjs';
import { electronExecutable } from './lib/electron-runtime.mjs';

// 长时间录制探针启动器：参数经环境变量传给主进程（见 scripts/longrunProbe.ts）。
//   WCS_LONGRUN_MINUTES     总时长（分钟），默认 60
//   WCS_LONGRUN_PAUSE_MIN   暂停间隔（分钟），默认 5
//   WCS_LONGRUN_PAUSE_SEC   每次暂停秒数，默认 5
useLocalTempDir('longrun');
const minutes = Number(process.env.WCS_LONGRUN_MINUTES || '60');
if (!Number.isFinite(minutes) || minutes < 2 || minutes > 180) throw new Error('WCS_LONGRUN_MINUTES 必须为 2–180 的整数分钟');
const env = { ...process.env, WCS_LONGRUN_PROBE: '1', WCS_USER_DATA: path.join(ROOT, '.tmp', 'longrun', 'user-data') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExecutable(), ['--no-sandbox', ROOT], { env, cwd: ROOT, windowsHide: true, stdio: 'inherit' });
// 总时长 + 10 分钟回读余量；超时视为失败并杀掉应用
const timer = setTimeout(() => { child.kill(); console.error('[longrun] 启动器超时，已终止应用'); process.exitCode = 1; }, minutes * 60_000 + 600_000);
child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
