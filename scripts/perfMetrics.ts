/**
 * 性能基准探针（§16.2）
 *
 * 目标是把文档里「待验证指标」变成可复现的实测数字，而不是拍脑袋。
 * 所有指标都在真机跑，结果写 dist/verify/perf-result.json。
 *
 * 覆盖：
 *  - 首次有效画面延迟（从 start 到第一个已提交帧）
 *  - 处理超时丢帧率（期望帧数 vs 实际编码帧数）
 *  - 音画偏差（音频总采样时长 vs 视频总时长）
 *  - 1080p 导出速度（是否快于实时）
 *  - 工作集内存峰值与增长
 *  - 故障尾部损失（分段时长 = 崩溃时最多丢的时长）
 *
 * 用法：WCS_PERF_PROBE=1 由主进程自动执行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface PerfSample {
  name: string;
  value: number;
  unit: string;
  target: number | null;
  /** null 表示没有判定标准（纯记录） */
  pass: boolean | null;
  note?: string;
}

export interface PerfReport {
  startedAt: string;
  seconds: number;
  samples: PerfSample[];
  ok: boolean;
  error?: string;
}

/** 判定：越小越好的指标。 */
function lowerIsBetter(name: string, value: number, unit: string, target: number, note?: string): PerfSample {
  return { name, value, unit, target, pass: value <= target, note };
}

/** 判定：越大越好的指标。 */
function higherIsBetter(name: string, value: number, unit: string, target: number, note?: string): PerfSample {
  return { name, value, unit, target, pass: value >= target, note };
}

function record(name: string, value: number, unit: string, note?: string): PerfSample {
  return { name, value, unit, target: null, pass: null, note };
}

/**
 * 从录制产出的分段与 WAV 计算音画偏差。
 *
 * 视频侧用 mediabunny 统计每段包数 / 时长；音频侧用 WAV 头算采样数。
 * 两者都换算成秒后比较。文档 §16.2 要求绝对偏差 ≤ 80ms。
 */
export async function measureAvDrift(
  projectPath: string,
  loadMedia: (absPath: string) => Promise<{
    durationSeconds: number;
    frames: number;
    codec: string;
    width: number;
    height: number;
  } | null>,
  readWavDuration: (absPath: string) => number | null,
): Promise<{ videoSeconds: number; audioSeconds: number; driftMs: number } | null> {
  const screenDir = path.join(projectPath, 'media', 'screen');
  const micDir = path.join(projectPath, 'media', 'mic');
  if (!fs.existsSync(screenDir)) return null;

  const videoFiles = fs.readdirSync(screenDir).filter((n) => n.endsWith('.mp4')).sort();
  if (videoFiles.length === 0) return null;

  let videoSeconds = 0;
  for (const name of videoFiles) {
    const info = await loadMedia(path.join(screenDir, name));
    if (info) videoSeconds += info.durationSeconds;
  }

  let audioSeconds = 0;
  if (fs.existsSync(micDir)) {
    for (const name of fs.readdirSync(micDir).filter((n) => n.endsWith('.wav')).sort()) {
      const seconds = readWavDuration(path.join(micDir, name));
      if (seconds !== null) audioSeconds += seconds;
    }
  }

  return {
    videoSeconds,
    audioSeconds,
    driftMs: Math.abs(videoSeconds - audioSeconds) * 1000,
  };
}

/** 读 WAV 时长（只解析头，不读全部数据）。 */
export function readWavDurationSeconds(absPath: string): number | null {
  try {
    const stat = fs.statSync(absPath);
    const fd = fs.openSync(absPath, 'r');
    const header = Buffer.alloc(Math.min(44, stat.size));
    fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    if (header.length < 44) return null;
    if (header.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (header.toString('ascii', 8, 12) !== 'WAVE') return null;

    const format = header.readUInt16LE(20);
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const dataBytes = header.readUInt32LE(40);
    if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) return null;
    // WAVE_FORMAT_IEEE_FLOAT = 3, PCM = 1；两者都按位宽算帧数
    if (format !== 1 && format !== 3) return null;
    const bytesPerFrame = (bitsPerSample / 8) * channels;
    if (bytesPerFrame <= 0) return null;
    return dataBytes / bytesPerFrame / sampleRate;
  } catch {
    return null;
  }
}

export function writePerfReport(outPath: string, report: PerfReport): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

export { lowerIsBetter, higherIsBetter, record, performance };
