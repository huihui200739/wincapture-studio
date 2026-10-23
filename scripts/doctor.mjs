#!/usr/bin/env node
/**
 * 环境自检（doctor）：一条命令确认「这台机器能不能构建 / 运行 / 录制」。
 *
 * 为什么需要：本项目在本机踩过一批环境坑（%TEMP% 拒绝清理、必须有 csc.exe、
 * Electron 必须 --no-sandbox、ELECTRON_RUN_AS_NODE 必须清空、视频目录不可写要回退）。
 * 新机器上先跑 `npm run doctor`，能把「环境问题」和「代码问题」分开，省掉大量排查。
 *
 * 用法：
 *   npm run doctor
 * 退出码：0 = 没有致命问题；1 = 有致命问题（不能构建/启动）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, useLocalTempDir } from './lib/local-temp.mjs';

const problems = [];
const warnings = [];
const okList = [];

function ok(message) {
  okList.push(message);
}
function warn(message) {
  warnings.push(message);
}
function fail(message) {
  problems.push(message);
}

// ---- 1. Node 版本（package.json 要求 22+） ----
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 22) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node} 过低：需要 22+（当前主进程 bundle 目标 node22）`);

// ---- 2. 平台 ----
if (process.platform === 'win32') ok(`平台 ${process.platform} ${process.arch}`);
else warn(`平台 ${process.platform}：原生采集工作进程只支持 Windows，录制功能不可用`);

// ---- 3. C# 编译器（构建 grabber/audio 必需） ----
if (process.platform === 'win32') {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) ok(`C# 编译器 ${found}`);
  else fail('找不到 .NET Framework 4.x 的 csc.exe（原生采集进程必需；请安装 .NET Framework 4.x）');
}

// ---- 4. 临时目录可写性（esbuild 清理失败的根因） ----
{
  const probe = path.join(useLocalTempDir('doctor'), `probe-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok('工作区临时目录 .tmp/ 可写');
  } catch (error) {
    fail(`工作区临时目录 .tmp/ 不可写：${String(error)}`);
  }
  // 系统 TEMP：只提示，不致命——构建脚本已统一把 TMP/TEMP 指到 .tmp/。
  const sysTemp = process.env.TEMP || process.env.TMP || '';
  if (sysTemp) {
    const sysProbe = path.join(sysTemp, `wcs-doctor-${process.pid}.tmp`);
    try {
      fs.writeFileSync(sysProbe, 'ok');
      fs.unlinkSync(sysProbe);
      ok('系统 %TEMP% 可写可清理');
    } catch {
      warn(`系统 %TEMP% 存在写入/清理限制（${sysTemp}）：构建已自动改用 .tmp/，无需处理`);
    }
  }
}

// ---- 5. 依赖是否安装 ----
{
  const electronPkg = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  if (fs.existsSync(electronPkg)) {
    ok(`Electron ${JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version}`);
  } else {
    fail('未安装依赖：请先执行 npm install');
  }
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'mediabunny', 'package.json'))) ok('mediabunny 已安装');
  else fail('缺少 mediabunny：请先执行 npm install');
}

// ---- 6. 构建产物（运行/录制必需） ----
{
  const required = [
    'dist/main/main.cjs',
    'dist/main/preload.cjs',
    'dist/renderer/index.html',
    'dist/native/grabber.exe',
    'dist/native/audio.exe',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length === 0) {
    ok('构建产物齐全（主进程 / 界面 / 原生工作进程）');
  } else if (missing.every((rel) => rel.startsWith('dist/native/'))) {
    warn(`原生工作进程缺失（${missing.join(', ')}）：执行 npm run build:native`);
  } else {
    warn(`构建产物缺失（${missing.join(', ')}）：执行 npm run build`);
  }
}

// ---- 7. Electron 启动约束 ----
if (process.env.ELECTRON_RUN_AS_NODE) {
  warn('ELECTRON_RUN_AS_NODE 已设置：启动 Electron 前需要清空（Remove-Item env:ELECTRON_RUN_AS_NODE）');
} else {
  ok('ELECTRON_RUN_AS_NODE 未设置');
}

// ---- 8. 数据目录可写性 ----
{
  const dataDir = process.env.WCS_USER_DATA || path.join(process.env.LOCALAPPDATA || ROOT, 'WinCaptureStudio');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `probe-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok(`应用数据目录可写：${dataDir}`);
  } catch {
    warn(`应用数据目录不可写：${dataDir}（可设置 WCS_USER_DATA 指向可写目录）`);
  }
}

// ---- 输出 ----
console.log('\n== WinCapture Studio 环境自检 ==');
for (const item of okList) console.log(`  [OK]   ${item}`);
for (const item of warnings) console.log(`  [提示] ${item}`);
for (const item of problems) console.log(`  [失败] ${item}`);

if (problems.length > 0) {
  console.log(`\n结果：${problems.length} 项致命问题，请先修复。\n`);
  process.exit(1);
}
console.log(`\n结果：环境可用${warnings.length > 0 ? `（${warnings.length} 项提示）` : ''}。\n`);
