#!/usr/bin/env node
/**
 * 构建原生采集工作进程（grabber.exe / audio.exe / pointer.exe）
 *
 * 为什么在构建期编译：
 *   Electron 子进程内调用 csc 会因权限被拒绝写入（实测 CS0016 拒绝访问），
 *   且每次启动都编译会拖慢启动。
 *
 * 本机只有 C# 5 编译器（csc.exe v4.0.30319），源码必须兼容 C# 5 语法。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const SRC = path.join(root, 'electron', 'native');
const OUT = path.join(root, 'dist', 'native');

const targets = [
  { name: 'grabber', source: 'grabber.cs', refs: ['/r:System.Drawing.dll'] },
  { name: 'audio', source: 'audio.cs', refs: [] },
  { name: 'pointer', source: 'pointer.cs', refs: [] },
];

if (process.platform !== 'win32') {
  console.log('[native] 跳过：非 Windows 平台');
  process.exit(0);
}

if (!fs.existsSync(CSC)) {
  console.error(`[native] 找不到 C# 编译器：${CSC}`);
  console.error('[native] 原生采集工作进程是必需组件，请安装 .NET Framework 4.x');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

let failed = false;
for (const target of targets) {
  const sourcePath = path.join(SRC, target.source);
  if (!fs.existsSync(sourcePath)) {
    console.error(`[native] 缺少源码：${sourcePath}`);
    failed = true;
    continue;
  }
  const outPath = path.join(OUT, `${target.name}.exe`);
  const args = ['/nologo', '/optimize+', `/out:${outPath}`, sourcePath, ...target.refs];
  const result = spawnSync(CSC, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`[native] 编译 ${target.name} 失败：`);
    console.error(result.stdout || '');
    console.error(result.stderr || '');
    failed = true;
    continue;
  }
  const warnings = (result.stdout || '').split('\n').filter((l) => l.trim());
  const size = fs.statSync(outPath).size;
  console.log(`[native] ${target.name}.exe  ${Math.round(size / 1024)} KB${warnings.length ? `  (${warnings.length} 条警告)` : ''}`);
}

if (failed) process.exit(1);
console.log('[native] 完成');
