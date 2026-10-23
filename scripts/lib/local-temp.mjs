/**
 * 受限环境的临时目录处理。
 *
 * 背景：本机 `%TEMP%`（C:\Users\<user>\AppData\Local\Temp）上，esbuild 创建的临时文件
 * 在清理时会返回 `Access is denied`（安全软件/ACL 限制），构建直接失败：
 *
 *   [vite:esbuild-transpile] remove C:\Users\...\Temp\esbuild-xxxx: Access is denied.
 *
 * 现象：小文件（<2MB）正常，只有大 chunk（如 1.2MB 渲染产物 + sourcemap）会触发，
 * 因为 esbuild 的 JS API 只有在大输入时才把内容落到临时文件再交给二进制进程。
 *
 * 处理：调用方在 spawn 子进程或调用 esbuild JS API 之前调用 `useLocalTempDir()`，
 * 把 TMP/TEMP 指到工作区内的 `.tmp/`（已被 .gitignore 忽略）。这是构建脚本层面的
 * 兼容处理，不改变产物内容。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（scripts/lib -> .. -> ..）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 把当前进程（以及其后 spawn 的子进程）的临时目录指到工作区内。
 *
 * @param {string} [sub] `.tmp/` 下的子目录名，避免不同工具互相清理。
 * @returns {string} 生效的临时目录绝对路径。
 */
export function useLocalTempDir(sub = 'temp') {
  const dir = path.join(ROOT, '.tmp', sub);
  fs.mkdirSync(dir, { recursive: true });
  // Windows 的 os.tmpdir() 读 TMP/TEMP；POSIX 读 TMPDIR。三个都设，跨平台一致。
  process.env.TMP = dir;
  process.env.TEMP = dir;
  process.env.TMPDIR = dir;
  return dir;
}
