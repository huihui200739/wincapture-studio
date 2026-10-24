import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

/** 源码路径在本机被划入 Internet 区域：钩子安装成功却不送事件。 */
export function pointerExecutable(source: string): string {
  if (process.platform !== 'win32' || !fs.existsSync(source)) return source;
  const bytes = fs.readFileSync(source);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'WinCaptureStudio', 'runtime', `pointer-${hash.slice(0, 24)}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'pointer.exe');
  if (fs.existsSync(target) && createHash('sha256').update(fs.readFileSync(target)).digest('hex') === hash) return target;
  const staging = path.join(dir, `pointer-${process.pid}-${Date.now()}.partial`);
  fs.writeFileSync(staging, bytes);
  fs.renameSync(staging, target);
  return target;
}
