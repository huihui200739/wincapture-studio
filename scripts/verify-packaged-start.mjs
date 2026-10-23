import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const screenshot = path.join(root, 'dist', 'verify', 'screenshots', '15-packaged-home.png');
const env = { ...process.env, WCS_USER_DATA: path.join(root, '.tmp', 'packaged-smoke-data'),
  WCS_SELFTEST: 'screenshot', WCS_SELFTEST_OUT: screenshot };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(path.dirname(screenshot), { recursive: true });
if (fs.existsSync(screenshot)) fs.unlinkSync(screenshot);
const child = spawn(path.join(root, 'release', 'win-unpacked', 'WinCapture Studio.exe'), ['--no-sandbox'], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45_000);
child.once('error', (error) => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => {
  clearTimeout(watchdog);
  const ok = code === 0 && fs.existsSync(screenshot) && fs.statSync(screenshot).size > 10_000;
  const result = { ok, exitCode: code, screenshot };
  fs.writeFileSync(path.join(root, 'dist', 'verify', 'packaged-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); process.exitCode = ok ? 0 : 1;
});
