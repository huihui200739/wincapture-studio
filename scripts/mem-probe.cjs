/**
 * 录制期间逐进程内存画像
 *
 * 目的：§16.2 要求「1080p 录制总工作集 ≤1.2GB」。要定位超标的来源，
 * 必须按进程拆开看，而不是只看进程树总和。
 *
 * 用法：WCS_MEM_PROBE=1 electron --no-sandbox .
 */

const path = require('node:path');
const fs = require('node:fs');

// 这个脚本作为 Electron 主进程入口被启动，复用真实主进程启动流程。
require(path.join(__dirname, '..', 'dist', 'main', 'main.cjs'));

const { app } = require('electron');
const OUT = path.join(__dirname, '..', 'dist', 'verify', 'mem-probe.json');

const samples = [];
let timer = null;

app.whenReady().then(() => {
  // 每 500ms 记录一次逐进程内存
  timer = setInterval(() => {
    try {
      const metrics = app.getAppMetrics();
      const rows = metrics.map((m) => ({
        pid: m.pid,
        type: m.type,
        name: m.name || '',
        workingSetMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
        peakWorkingSetMB: Math.round((m.memory?.peakWorkingSetSize ?? 0) / 1024),
        privateMB: Math.round((m.memory?.privateBytes ?? 0) / 1024),
        cpuPercent: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
      }));
      const total = rows.reduce((s, r) => s + r.workingSetMB, 0);
      samples.push({ at: Date.now(), totalMB: total, rows });
    } catch {
      // 忽略
    }
  }, 500);

  // 40 秒后落盘退出
  setTimeout(() => {
    if (timer) clearInterval(timer);
    const peak = samples.reduce((m, s) => Math.max(m, s.totalMB), 0);
    const peakSample = samples.find((s) => s.totalMB === peak) ?? null;
    const byType = {};
    for (const s of samples) {
      for (const r of s.rows) {
        const key = `${r.type}`;
        if (!byType[key] || r.workingSetMB > byType[key].workingSetMB) {
          byType[key] = { ...r, totalMB: s.totalMB };
        }
      }
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          peakTotalMB: peak,
          peakSample,
          peakByProcessType: byType,
          sampleCount: samples.length,
          timeline: samples.map((s) => ({ at: s.at, totalMB: s.totalMB })),
        },
        null,
        2,
      ),
    );
    console.log(`[mem] peak=${peak}MB samples=${samples.length}`);
    app.exit(0);
  }, 40_000);
});
