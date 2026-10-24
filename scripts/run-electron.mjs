#!/usr/bin/env node
/**
 * 以正确姿势启动 Electron 运行验收脚本。
 *
 * 本机/受限环境有两个硬约束（docs/testing.md §7）：
 *   1. 必须带 `--no-sandbox`，否则进程以 -2147483645 退出；
 *   2. 环境里若存在 `ELECTRON_RUN_AS_NODE`，`require('electron')` 会返回路径字符串，
 *      脚本表现为"不是 Electron 环境"而失败——必须在子进程环境里删掉它。
 *
 * 直接写 `electron --no-sandbox scripts/xxx.cjs` 在约束 2 下会失败，所以统一走本包装：
 *   node scripts/run-electron.mjs scripts/verify-ui.cjs [脚本参数...]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/local-temp.mjs';
import { electronExecutable } from './lib/electron-runtime.mjs';

const scriptArg = process.argv[2];
if (!scriptArg) {
  console.error('用法：node scripts/run-electron.mjs <脚本路径> [脚本参数...]');
  process.exit(1);
}

const scriptPath = path.resolve(ROOT, scriptArg);
if (!fs.existsSync(scriptPath)) {
  console.error(`[electron] 脚本不存在：${scriptPath}`);
  process.exit(1);
}

const electronExe = electronExecutable();
if (!fs.existsSync(electronExe)) {
  console.error('[electron] 找不到 Electron 可执行文件，请先 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['--no-sandbox', scriptPath, ...process.argv.slice(3)];
const child = spawn(electronExe, args, { cwd: ROOT, env, stdio: 'inherit' });

child.on('error', (error) => {
  console.error('[electron] 启动失败：', error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[electron] 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
