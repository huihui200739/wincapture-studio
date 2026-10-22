#!/usr/bin/env node
/**
 * 打包入口：用 Node spawn 调用 electron-builder，显式注入镜像与缓存环境变量。
 *
 * 为什么不让 npm script 直接调 electron-builder：
 *   1. 本机 npm 会把 `NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR` 当成自己的未知配置
 *      并警告/丢弃，导致 electron-builder 回落到 GitHub，在慢链路下超时；
 *   2. `cmd /c` 启动的子进程在这套环境里无法稳定继承 PowerShell 的 $env: 设置。
 * 在同一个进程里 spawn 并传 env，是唯一稳定的方式。
 *
 * 用法：
 *   node scripts/package.mjs            # 出 NSIS 安装包
 *   node scripts/package.mjs --dir      # 只出 win-unpacked（调试用，快）
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.tmp', 'eb-cache');

// 缓存目录必须在工作区内：系统 TEMP 对部分工具拒绝访问，
// 且 electron-builder 在受限环境下会被重定向到 Packages\...\LocalCache。
fs.mkdirSync(cacheDir, { recursive: true });

const env = {
  ...process.env,
  TEMP: path.join(root, '.tmp'),
  TMP: path.join(root, '.tmp'),
  ELECTRON_BUILDER_CACHE: cacheDir,
  // 国内镜像：GitHub releases 在本机常超时（connect ETIMEDOUT）。
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/',
  ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.npm_config_electron_builder_binaries_mirror;

const passthrough = process.argv.slice(2);
const args = [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--config', 'electron-builder.yml'];
if (passthrough.includes('--dir')) args.push('--dir');

console.log('[pack] outputs  =', path.join(root, 'release'));
console.log('[pack] cache    =', cacheDir);
console.log('[pack] mirror   =', env.ELECTRON_BUILDER_BINARIES_MIRROR);
console.log('[pack] args     =', args.slice(1).join(' '));

const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });

child.on('error', (error) => {
  console.error('[pack] 启动 electron-builder 失败:', error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (code === 0) {
    console.log('[pack] 完成。产物在 release/，用 `npm run verify:package` 验收。');
  } else {
    console.error(`[pack] 失败 code=${code} signal=${signal}`);
  }
  process.exit(code ?? 1);
});
