/**
 * 长时间录制与内存稳定性探针（真机，结果写 dist/verify/longrun-result.json）
 *
 * 由主进程在 WCS_LONGRUN_PROBE=1 时调用。与 perfProbe 的区别：
 *   perfProbe 回答「20 秒内链路快不快、丢不丢帧」；
 *   本探针回答「1 小时里内存涨不涨、音画偏差是否逐段累计、反复暂停恢复后
 *   时间轴是否还连续、采集进程被杀后能否自动重启并继续」。
 *
 * 流程（默认 60 分钟）：
 *   1. 1080p30 全链路录制（系统声音 + 麦克风，与性能探针同配置）；
 *   2. 每 5 分钟暂停 5 秒再恢复（默认，可调）；
 *   3. 进行到 50% 时用 TerminateProcess 强杀 grabber.exe，验证会话内自动重启；
 *   4. 500ms 采样一次完整进程树工作集；
 *   5. 停止后回读全部分段 MP4/WAV 与 journal，统计漂移、丢帧、时间轴连续性。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readWavDurationSeconds } from './perfProbe';

export interface LongrunDeps {
  startCapture: (projectPath: string) => Promise<{ sessionId: string }>;
  stopCapture: () => Promise<{ state: string; segmentsCommitted: number }>;
  pauseCapture: () => Promise<void>;
  resumeCapture: () => Promise<void>;
  getStatus: () => { state: string; mediaTick: number; framesArrived: number; degradation: string | null } | null;
  /** 当前兼容采集进程 PID；现代采集返回 null */
  getGrabberPid: () => number | null;
  killProcess: (pid: number) => void;
  probeSegment: (absPath: string) => Promise<{ durationSeconds: number; frames: number } | null>;
  newProjectPath: (name: string) => string;
  treeWorkingSetBytes: () => number;
  log: (message: string) => void;
}

export interface LongrunOptions {
  /** 总录制时长（分钟） */
  minutes: number;
  /** 每隔多少分钟暂停一次 */
  pauseEveryMinutes: number;
  /** 每次暂停的秒数 */
  pauseSeconds: number;
}

export interface LongrunReport {
  startedAt: string;
  finishedAt: string;
  options: LongrunOptions;
  ok: boolean;
  error?: string;
  notes: string[];
  wallSeconds: number;
  metrics: {
    /** 成片视频总时长（分段 MP4 之和） */
    videoSeconds: number;
    /** 麦克风 WAV 总时长 */
    audioSeconds: number;
    /** 音画累计偏差（毫秒） */
    avDriftMs: number;
    /** 采集帧缺失率（%，含崩溃间隙的自然缺口） */
    captureLossPercent: number;
    /** 采集层到达的总帧数 */
    framesArrived: number;
    /** 分段数与每段帧数分布（1.6 秒段目标帧数 = 48） */
    segments: number;
    framesPerSegmentMin: number;
    framesPerSegmentMax: number;
    framesPerSegmentMean: number;
    /** 损坏/被背压丢弃的分段数（0 为佳） */
    corruptSegments: number;
    droppedSegments: number;
    /** 暂停/恢复次数（journal 记录数） */
    pauseCount: number;
    /** 时间轴覆盖缺口（毫秒）：崩溃重启间隙 + 分段栅格跳空，应只有崩溃间隙 */
    timelineGapMs: number;
    /** 时间轴重叠（毫秒），必须为 0 */
    timelineOverlapMs: number;
    /** 崩溃注入：是否检测到自动重启、重启后是否继续出帧出段 */
    crashInjected: boolean;
    restartDetected: boolean;
    framesContinuedAfterRestart: boolean;
    segmentsAfterRestart: number;
    /** 内存（完整进程树工作集） */
    memoryPeakMiB: number;
    memoryStartMiB: number;
    memoryEndMiB: number;
    /** 后半程均值 − 前半程均值（MiB，排除启动瞬态；持续上涨即泄漏信号） */
    memoryGrowthMiB: number;
  };
  /** 每分钟平均工作集（MiB），供人工看曲线 */
  memoryCurveMiB: { minute: number; mib: number }[];
}

interface JournalEntry {
  type: string;
  detail?: Record<string, unknown>;
}

/** 读取 journal.jsonl，解析失败按空处理（journal 缺失本身就是失败信号）。 */
function readJournal(projectPath: string): JournalEntry[] {
  try {
    const text = fs.readFileSync(path.join(projectPath, 'recovery', 'journal.jsonl'), 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0).map((line) => {
      try { return JSON.parse(line) as JournalEntry; } catch { return { type: 'unparseable' }; }
    });
  } catch {
    return [];
  }
}

/** 每分钟一个均值桶：index = floor(elapsedMs / 60000)。 */
function buildCurve(samples: { elapsedMs: number; bytes: number }[]): { minute: number; mib: number }[] {
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const s of samples) {
    const minute = Math.floor(s.elapsedMs / 60_000);
    const bucket = buckets.get(minute) ?? { sum: 0, count: 0 };
    bucket.sum += s.bytes; bucket.count += 1;
    buckets.set(minute, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minute, b]) => ({ minute, mib: Number(((b.sum / b.count) / 1024 / 1024).toFixed(1)) }));
}

export async function runLongrunProbe(deps: LongrunDeps, options: LongrunOptions): Promise<LongrunReport> {
  const notes: string[] = [];
  const startedAt = new Date().toISOString();
  const projectPath = deps.newProjectPath(`长录探针 ${Date.now()}`);
  const totalMs = options.minutes * 60_000;
  // 崩溃注入放在两个暂停窗口的正中间，避免暂停与重启在同一时刻纠缠
  const crashAtMs = Math.floor(totalMs / 2) + Math.floor(options.pauseEveryMinutes * 60_000 / 2);

  deps.log(`启动录制：${projectPath}`);
  await deps.startCapture(projectPath);
  if (!deps.getStatus()) throw new Error('录制会话启动后读不到状态');

  // 崩溃注入只杀一次；记录注入前后帧数用于验证「重启后继续出帧」
  let crashInjected = false;
  let restartDetected = false;
  let framesAtCrash = 0;
  let crashPid = 0;

  const samples: { elapsedMs: number; bytes: number }[] = [];
  const startedWall = Date.now();
  let maxFrames = 0;
  let samplingError: string | null = null;
  const pending: Promise<void>[] = [];
  let pauseSerial = 0;
  let nextPauseAtMs = options.pauseEveryMinutes * 60_000;
  let pauseInFlight = false;

  // 500ms 采样循环 + 到点触发的暂停/崩溃调度，全部在这一个循环里驱动
  const ticker = setInterval(() => {
    try {
      const elapsedMs = Date.now() - startedWall;
      samples.push({ elapsedMs, bytes: deps.treeWorkingSetBytes() });
      const status = deps.getStatus();
      if (status) maxFrames = Math.max(maxFrames, status.framesArrived);

      if (!crashInjected && elapsedMs >= crashAtMs) {
        crashInjected = true;
        crashPid = deps.getGrabberPid() ?? 0;
        framesAtCrash = status?.framesArrived ?? 0;
        if (crashPid) {
          deps.log(`注入 grabber 崩溃（TerminateProcess pid=${crashPid}，进行到 ${Math.round(elapsedMs / 1000)}s）`);
          deps.killProcess(crashPid);
        } else {
          notes.push('崩溃注入时找不到 grabber PID（可能在现代采集路径），未注入');
        }
      }
      // 重启确认：崩溃后每轮轮询降级说明，15 秒内出现「已自动重启」即通过
      if (crashInjected && crashPid && !restartDetected && elapsedMs - crashAtMs <= 15_000) {
        if (deps.getStatus()?.degradation?.includes('已自动重启')) {
          restartDetected = true;
          deps.log(`自动重启已确认（+${Math.round(elapsedMs - crashAtMs)}ms）`);
        }
      }

      if (!pauseInFlight && elapsedMs >= nextPauseAtMs && elapsedMs < totalMs) {
        pauseInFlight = true;
        nextPauseAtMs += options.pauseEveryMinutes * 60_000;
        const boundary = ++pauseSerial;
        pending.push(
          runPauseCycle(boundary).finally(() => { pauseInFlight = false; }),
        );
      }
    } catch (error) {
      samplingError = String(error);
    }
  }, 500);

  async function runPauseCycle(boundary: number): Promise<void> {
    deps.log(`第 ${boundary} 个暂停窗口：暂停 ${options.pauseSeconds}s 后恢复`);
    try {
      await deps.pauseCapture();
    } catch (error) {
      notes.push(`第 ${boundary} 次暂停失败：${String(error).slice(0, 120)}`);
      pauseInFlight = false;
      return;
    }
    await new Promise((r) => setTimeout(r, options.pauseSeconds * 1000));
    try {
      await deps.resumeCapture();
    } catch (error) {
      notes.push(`第 ${boundary} 次恢复失败：${String(error).slice(0, 120)}`);
    }
  }

  // ---- 主等待：到总时长后停表 ----
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (Date.now() - startedWall >= totalMs) { clearInterval(check); resolve(); }
      else if (samplingError) { clearInterval(check); resolve(); }
    }, 1000);
  });
  clearInterval(ticker);
  await Promise.allSettled(pending);
  const wallSeconds = Math.round((Date.now() - startedWall) / 1000);

  // 等最后一次暂停循环结束再停（若恰好在边界附近）
  const statusBeforeStop = deps.getStatus();
  if (statusBeforeStop?.state === 'Paused') {
    await deps.resumeCapture().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }

  let stopState = 'unknown';
  let stopError: string | null = null;
  try {
    const stopped = await deps.stopCapture();
    stopState = stopped.state;
    deps.log(`停止完成：state=${stopped.state} segments=${stopped.segmentsCommitted}`);
  } catch (error) {
    stopError = String(error);
    notes.push(`停止录制报错：${stopError}`);
  }
  const finalStatus = deps.getStatus();
  const framesArrived = Math.max(maxFrames, finalStatus?.framesArrived ?? 0);
  const finishedAt = new Date().toISOString();

  // ---- 回读分段与音频 ----
  const screenDir = path.join(projectPath, 'media', 'screen');
  const segFiles = fs.existsSync(screenDir)
    ? fs.readdirSync(screenDir).filter((n) => n.endsWith('.mp4')).sort()
    : [];
  let videoSeconds = 0;
  const segFrames: number[] = [];
  for (const name of segFiles) {
    const info = await deps.probeSegment(path.join(screenDir, name));
    if (info) { videoSeconds += info.durationSeconds; segFrames.push(info.frames); }
  }
  const micDir = path.join(projectPath, 'media', 'mic');
  let audioSeconds = 0;
  if (fs.existsSync(micDir)) {
    for (const name of fs.readdirSync(micDir).filter((n) => n.endsWith('.wav')).sort()) {
      const s = readWavDurationSeconds(path.join(micDir, name));
      if (s !== null) audioSeconds += s;
    }
  }

  // ---- journal 统计 ----
  const journal = readJournal(projectPath);
  const pauseCount = journal.filter((e) => e.type === 'pause').length;
  const resumeCount = journal.filter((e) => e.type === 'resume').length;
  const restartEntries = journal.filter((e) => typeof e.detail?.grabberRestart === 'number').length;
  const corruptSegments = journal.filter((e) => e.type === 'segment-corrupt').length;
  const droppedSegments = journal.filter((e) => e.type === 'segment-dropped').length;
  const commits = journal
    .filter((e) => e.type === 'segment-commit')
    .map((e) => ({ index: Number(e.detail?.index ?? 0), startTick: Number(e.detail?.startTick ?? 0), durationTicks: Number(e.detail?.durationTicks ?? 0) }))
    .sort((a, b) => a.startTick - b.startTick);

  // ---- 时间轴连续性：段必须首尾相接；缺口 = 崩溃重启间隙，重叠必须为 0 ----
  let timelineGapTicks = 0;
  let timelineOverlapTicks = 0;
  if (commits.length > 0) {
    let cursor = commits[0].startTick;
    for (const seg of commits) {
      if (seg.startTick > cursor) timelineGapTicks += seg.startTick - cursor;
      else if (seg.startTick < cursor) timelineOverlapTicks += cursor - seg.startTick;
      cursor = Math.max(cursor, seg.startTick + seg.durationTicks);
    }
  }
  const TICKS_PER_SECOND = 10_000_000;

  // ---- 崩溃重启后的分段数（journal 顺序在重启条目之后的 commit 数）----
  let segmentsAfterRestart = 0;
  const restartSeq = journal.find((e) => typeof e.detail?.grabberRestart === 'number');
  if (restartSeq) {
    const idx = journal.indexOf(restartSeq);
    segmentsAfterRestart = journal.slice(idx).filter((e) => e.type === 'segment-commit').length;
  }
  const framesContinuedAfterRestart = restartDetected
    ? (finalStatus?.framesArrived ?? 0) > framesAtCrash + 30
    : false;

  // ---- 内存指标（先换算 MiB，再供阈值判定使用）----
  const curve = buildCurve(samples);
  const mib = (b: number): number => b / 1024 / 1024;
  const memoryPeakMiB = samples.length ? Number(mib(samples.reduce((m, s) => Math.max(m, s.bytes), 0)).toFixed(1)) : 0;
  const firstHalf = samples.filter((s) => s.elapsedMs >= 2 * 60_000 && s.elapsedMs < totalMs / 2 - 60_000);
  const secondHalf = samples.filter((s) => s.elapsedMs >= totalMs / 2 + 60_000 && s.elapsedMs < totalMs - 60_000);
  const mean = (arr: { bytes: number }[]): number => (arr.length ? arr.reduce((a, s) => a + s.bytes, 0) / arr.length : 0);
  const memoryGrowthMiB = firstHalf.length && secondHalf.length ? mib(mean(secondHalf)) - mib(mean(firstHalf)) : 0;

  // ---- 判定 ----
  const fps = 30;
  const expectedFrames = Math.round(videoSeconds * fps);
  const captureLossPercent = expectedFrames > 0 ? Math.max(0, (expectedFrames - framesArrived) / expectedFrames) * 100 : 100;
  const avDriftMs = Math.abs(videoSeconds - audioSeconds) * 1000;
  const expectedMediaSeconds = wallSeconds - pauseCount * options.pauseSeconds;
  const mediaCoverageDriftSeconds = Math.abs(videoSeconds - expectedMediaSeconds);
  const timelineGapMs = Math.round(timelineGapTicks / (TICKS_PER_SECOND / 1000));
  const timelineOverlapMs = Math.round(timelineOverlapTicks / (TICKS_PER_SECOND / 1000));
  const memoryGrowthThresholdMiB = 150;

  if (samplingError) notes.push(`采样循环出错：${samplingError}`);
  if (stopError) notes.push('停止阶段出错，见上方日志');
  if (captureLossPercent > 0.5) notes.push(`采集缺失 ${captureLossPercent.toFixed(2)}% 超过 0.5% 目标（崩溃间隙约贡献 ${Math.round(timelineGapMs)}ms 对应帧数）`);
  if (avDriftMs > 80) notes.push(`音画累计偏差 ${Math.round(avDriftMs)}ms 超过 80ms 目标`);
  if (timelineOverlapMs > 0) notes.push(`时间轴出现重叠 ${timelineOverlapMs}ms（分段栅格被破坏）`);
  if (timelineGapMs > 5000) notes.push(`时间轴缺口 ${timelineGapMs}ms 超过崩溃间隙合理上限（5 秒）`);
  if (pauseCount === 0) notes.push('本次运行没有任何暂停窗口（时长过短？），暂停恢复未被验证');
  if (pauseCount > 0 && resumeCount < pauseCount) notes.push(`resume(${resumeCount}) 少于 pause(${pauseCount})，存在未闭合暂停`);
  if (corruptSegments > 1) notes.push(`损坏分段 ${corruptSegments} 个（容忍上限 1）`);
  if (droppedSegments > 0) notes.push(`被背压丢弃的分段 ${droppedSegments} 个：编码或磁盘在长跑中跟不上了`);
  if (crashInjected && !restartDetected) notes.push('崩溃注入后未确认自动重启');
  if (restartDetected && !framesContinuedAfterRestart) notes.push('重启后帧数没有继续增长');
  if (memoryPeakMiB > 1228) notes.push('工作集峰值超过 §16.2 的 1228MiB 预算');
  if (memoryGrowthMiB > memoryGrowthThresholdMiB) notes.push(`前后半程内存增长 ${memoryGrowthMiB.toFixed(1)}MiB，疑似泄漏（基线阈值 ${memoryGrowthThresholdMiB}MiB）`);
  if (mediaCoverageDriftSeconds > 5) notes.push(`成片时长 ${videoSeconds.toFixed(1)}s 与「墙钟 − 暂停」${expectedMediaSeconds.toFixed(1)}s 相差 ${mediaCoverageDriftSeconds.toFixed(1)}s`);
  if (segFrames.length > 0) {
    const min = Math.min(...segFrames);
    if (min === 0) notes.push('存在 0 帧分段（该 1.6 秒完全无画面，崩溃间隙除外不应出现）');
  }

  const ok = notes.length === 0;
  const report: LongrunReport = {
    startedAt,
    finishedAt,
    options,
    ok,
    notes,
    wallSeconds,
    metrics: {
      videoSeconds: Number(videoSeconds.toFixed(3)),
      audioSeconds: Number(audioSeconds.toFixed(3)),
      avDriftMs: Math.round(avDriftMs),
      captureLossPercent: Number(captureLossPercent.toFixed(3)),
      framesArrived,
      segments: segFiles.length,
      framesPerSegmentMin: segFrames.length ? Math.min(...segFrames) : 0,
      framesPerSegmentMax: segFrames.length ? Math.max(...segFrames) : 0,
      framesPerSegmentMean: segFrames.length ? Number((segFrames.reduce((a, b) => a + b, 0) / segFrames.length).toFixed(1)) : 0,
      corruptSegments,
      droppedSegments,
      pauseCount,
      timelineGapMs,
      timelineOverlapMs,
      crashInjected,
      restartDetected,
      framesContinuedAfterRestart,
      segmentsAfterRestart,
      memoryPeakMiB, // 已换算为 MiB，不要再除一次
      memoryStartMiB: samples.length ? Number(mib(samples[0].bytes).toFixed(1)) : 0,
      memoryEndMiB: samples.length ? Number(mib(samples[samples.length - 1].bytes).toFixed(1)) : 0,
      memoryGrowthMiB: Number(memoryGrowthMiB.toFixed(1)),
    },
    memoryCurveMiB: curve,
  };
  return report;
}
