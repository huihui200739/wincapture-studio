#!/usr/bin/env node
/**
 * vite 启动包装：先把临时目录指到工作区内，再拉起 vite。
 *
 * 为什么需要包装：`vite build` 处理大 chunk 时走 esbuild 写临时文件，本机 `%TEMP%`
 * 上清理该文件被拒（Access is denied），构建失败。详见 ./lib/local-temp.mjs。
 *
 * 用法：
 *   node scripts/vite-run.mjs            # 等同 vite build
 *   node scripts/vite-run.mjs build      # 同上
 *   node scripts/vite-run.mjs dev        # 开发服务器（热更新）
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, useLocalTempDir } from './lib/local-temp.mjs';

const tempDir = useLocalTempDir('esbuild-temp');
const passthrough = process.argv.slice(2);
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const args = [viteBin, ...(passthrough.length > 0 ? passthrough : ['build'])];
const env = { ...process.env, TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir };

console.log(`[vite] 临时目录 = ${path.relative(ROOT, tempDir)}`);

const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });

child.on('error', (error) => {
  console.error('[vite] 启动失败：', error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[vite] 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
