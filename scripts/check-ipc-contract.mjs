#!/usr/bin/env node
/**
 * IPC 契约静态检查。
 *
 * 这个项目的进程间协议有三处需要手工保持一致：
 *   1. src/shared/ipc.ts 的 IPC 常量表（契约真源）
 *   2. electron/preload.ts 暴露给界面的方法（谁在调用）
 *   3. electron/main.ts 的 ipcMain.handle / ipcMain.on 注册（谁在处理）
 *
 * 三者任一处漏改都不会报类型错误：invoke 一个没人 handle 的通道只会在运行时
 * reject（错误还会被统一错误结构吞成 E_UNKNOWN），问题非常难查。
 *
 * 本脚本做如下检查（错误=退出码 1，警告=只提示）：
 *   E1. preload 引用了 IPC 表中不存在的常量名；
 *   E2. preload/main 使用了字面量通道但 IPC 表里没有（契约未收录）；
 *   E3. preload 的 invoke 通道在 main 没有对应 handle；
 *   E4. preload 的 send 通道在 main 没有对应 ipcMain.on；
 *   W1. IPC 表里有条目但 preload/main 都没用到（疑似死契约）；
 *   W2. preload 订阅了某通道但 main 从不发送（疑似死订阅）。
 *
 * 用法：npm run verify:ipc
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/local-temp.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const errors = [];
const warnings = [];

// ---------------------------------------------------------------------------
// 1. 契约真源：src/shared/ipc.ts 的 IPC 常量表
// ---------------------------------------------------------------------------
const ipcSource = read('src/shared/ipc.ts');
const mapBlock = ipcSource.match(/export const IPC = \{([\s\S]*?)\} as const;/);
if (!mapBlock) {
  console.error('无法解析 src/shared/ipc.ts 的 IPC 常量表');
  process.exit(1);
}
/** @type {Map<string, string>} 常量名 -> 通道字符串 */
const ipcMap = new Map();
for (const m of mapBlock[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*'([^']+)'/g)) ipcMap.set(m[1], m[2]);
const channels = new Set(ipcMap.values());
const reverseMap = new Map([...ipcMap].map(([name, channel]) => [channel, name]));

// ---------------------------------------------------------------------------
// 2. preload.ts：谁在调用
// ---------------------------------------------------------------------------
const preloadSource = read('electron/preload.ts');
/** @type {Array<{kind:'invoke'|'send'|'subscribe', channel:string, where:string}>} */
const preloadCalls = [];

function scanPreloadCalls(kind) {
  const seen = new Set();
  const collect = (channel, line, label) => {
    const key = `${kind}:${line}:${channel ?? label}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!channel) {
      errors.push(`[E1] preload.ts:${line} 引用了 IPC 表中不存在的常量名 ${label}`);
      return;
    }
    if (!channels.has(channel)) errors.push(`[E2] preload.ts:${line} 使用未收录进 IPC 表的通道 '${channel}'`);
    preloadCalls.push({ kind, channel, where: `preload.ts:${line}` });
  };
  // 调用形式：invoke(IPC.foo, ...) / ipcRenderer.send(IPC.foo, ...) / invoke('literal', ...)
  for (const m of preloadSource.matchAll(new RegExp(`\\b${kind}\\(\\s*IPC\\.([A-Za-z0-9_]+)`, 'g'))) {
    const line = preloadSource.slice(0, m.index).split('\n').length;
    collect(ipcMap.get(m[1]) ?? null, line, `IPC.${m[1]}`);
  }
  for (const m of preloadSource.matchAll(new RegExp(`\\b${kind}\\(\\s*'([^']+)'`, 'g'))) {
    const line = preloadSource.slice(0, m.index).split('\n').length;
    collect(m[1], line, `'${m[1]}'`);
  }
}
scanPreloadCalls('invoke');
scanPreloadCalls('send');
// subscribe(channel, cb) 是本地 helper 名
for (const m of preloadSource.matchAll(/subscribe\(\s*(?:IPC\.([A-Za-z0-9_]+)|'([^']+)')/g)) {
  const channel = m[1] ? ipcMap.get(m[1]) : m[2];
  const line = preloadSource.slice(0, m.index).split('\n').length;
  if (!channel) {
    errors.push(`[E1] preload.ts:${line} 订阅了不存在的通道`);
    continue;
  }
  if (!channels.has(channel)) errors.push(`[E2] preload.ts:${line} 订阅未收录的通道 '${channel}'`);
  preloadCalls.push({ kind: 'subscribe', channel, where: `preload.ts:${line}` });
}

// ---------------------------------------------------------------------------
// 3. main.ts：谁在处理 / 谁在发
// ---------------------------------------------------------------------------
const mainSource = read('electron/main.ts');
const handled = new Set(); // ipcMain.handle（含本地 handle() 包装）
const listened = new Set(); // ipcMain.on
const sentByMain = new Set(); // main -> renderer 的 webContents.send

function addChannel(target, nameOrLiteral, line, label) {
  const channel = nameOrLiteral.startsWith('IPC.') ? ipcMap.get(nameOrLiteral.slice(4)) : nameOrLiteral;
  if (!channel) {
    errors.push(`[E1] main.ts:${line} ${label} 引用了不存在的常量 ${nameOrLiteral}`);
    return;
  }
  if (!channels.has(channel)) errors.push(`[E2] main.ts:${line} ${label} 使用未收录进 IPC 表的通道 '${channel}'`);
  target.add(channel);
}

// 本项目的注册包装：handle(channel, fn) / handleFor(channel, roles, fn) / 原生 ipcMain.handle。
// 用 `[^\w.]` 作分隔符，避免把 protocol.handle('wcs-media') 之类非 IPC 的注册误算进来。
for (const m of mainSource.matchAll(/(?:^|[^\w.])(handleFor|handle|ipcMain\.handle)\(\s*(IPC\.[A-Za-z0-9_]+|'[^']+')/g)) {
  addChannel(handled, m[2].startsWith("'") ? m[2].slice(1, -1) : m[2], mainSource.slice(0, m.index).split('\n').length, 'handle');
}
for (const m of mainSource.matchAll(/ipcMain\.on\(\s*(IPC\.[A-Za-z0-9_]+|'[^']+')/g)) {
  addChannel(listened, m[1].startsWith("'") ? m[1].slice(1, -1) : m[1], mainSource.slice(0, m.index).split('\n').length, 'ipcMain.on');
}
for (const m of mainSource.matchAll(/(?:webContents\.send|send)\(\s*(IPC\.[A-Za-z0-9_]+|'[^']+')/g)) {
  addChannel(sentByMain, m[1].startsWith("'") ? m[1].slice(1, -1) : m[1], mainSource.slice(0, m.index).split('\n').length, 'send');
}

// ---------------------------------------------------------------------------
// 4. 交叉校验
// ---------------------------------------------------------------------------
for (const call of preloadCalls) {
  if (call.kind === 'invoke' && !handled.has(call.channel)) {
    errors.push(`[E3] ${call.where} invoke('${call.channel}') 在 main.ts 没有 ipcMain.handle`);
  }
  if (call.kind === 'send' && !listened.has(call.channel)) {
    errors.push(`[E4] ${call.where} ipcRenderer.send('${call.channel}') 在 main.ts 没有 ipcMain.on`);
  }
  if (call.kind === 'subscribe' && !sentByMain.has(call.channel)) {
    warnings.push(`[W2] ${call.where} 订阅了 '${call.channel}'，但 main.ts 从不发送该通道`);
  }
}

// 只被 main 自身当作事件名传来传去、不进契约表的通道（例如窗口内部私有事件）：
// 用前缀白名单避免误报，但新增时请优先收进 IPC 表。
const privateChannelPrefixes = ['overlay:', 'exporter:'];
for (const set of [handled, listened, sentByMain]) {
  for (const channel of set) {
    if (channels.has(channel)) continue;
    if (privateChannelPrefixes.some((prefix) => channel.startsWith(prefix))) {
      warnings.push(`[W3] '${channel}' 未收录进 IPC 表（私有通道，建议收编）`);
    }
  }
}

const usedChannels = new Set(preloadCalls.map((c) => c.channel));
for (const channel of channels) {
  const inUse = usedChannels.has(channel) || handled.has(channel) || listened.has(channel) || sentByMain.has(channel);
  if (!inUse) warnings.push(`[W1] IPC 表条目 '${channel}'（${reverseMap.get(channel)}）没有任何调用方/处理方`);
}

// ---------------------------------------------------------------------------
// 5. 输出
// ---------------------------------------------------------------------------
const uniqueErrors = [...new Set(errors)];
const uniqueWarnings = [...new Set(warnings)];
console.log(`IPC 契约：${ipcMap.size} 条通道，preload 调用 ${preloadCalls.length} 处，` +
  `main handle ${handled.size} 个 / on ${listened.size} 个`);
for (const w of uniqueWarnings) console.log(`  [警告] ${w}`);
for (const e of uniqueErrors) console.log(`  [错误] ${e}`);

if (uniqueErrors.length > 0) {
  console.log(`\nIPC 契约检查失败：${uniqueErrors.length} 个错误。\n`);
  process.exit(1);
}
console.log(`\nIPC 契约一致${uniqueWarnings.length > 0 ? `（${uniqueWarnings.length} 条警告）` : ''}。\n`);
