import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/local-temp.mjs';
const out = path.join(ROOT, 'dist', 'verify'); fs.mkdirSync(out, { recursive: true });
execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  ['/nologo', '/out:' + path.join(out, 'inject-click.exe'), path.join(ROOT, 'tests', 'native', 'inject-click.cs')], { windowsHide: true, stdio: 'inherit' });
process.argv[2] = 'scripts/verify-input-camera.cjs';
await import('./run-electron.mjs');
