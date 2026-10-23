/**
 * 音频时间对齐（纯逻辑，便于单测）。
 *
 * 问题：audio.exe 输出的 `startFrame` 是「该路流自身的累计采样序号」，两路设备
 * 各有各的起点：实测系统回环首包比麦克风晚约 0.9 秒，而两者 startFrame 都从 0 开始。
 * 若直接把 startFrame 当段内偏移使用，两路声音都会整体前移一个设备启动延迟，
 * 且暂停期间设备仍在计数，暂停恢复后偏移还会继续偏离。
 *
 * 正确做法：用每个音频包携带的 QPC（WASAPI qpcPosition）经 SessionClock 换算成
 * 会话媒体时间，再减去该段的 startTick，得到「段内 48kHz 帧偏移」。
 */

import { TICKS_PER_SECOND } from '../../src/domain/timebase';

export const AUDIO_SAMPLE_RATE = 48_000;

/** 把媒体时刻（100ns tick）换算为相对段起点的 48kHz 采样帧偏移（可为负）。 */
export function audioOffsetFrames(
  mediaTick: number,
  segmentStartTick: number,
  sampleRate: number = AUDIO_SAMPLE_RATE,
): number {
  if (!Number.isFinite(mediaTick) || !Number.isFinite(segmentStartTick)) return 0;
  return Math.round(((mediaTick - segmentStartTick) / TICKS_PER_SECOND) * sampleRate);
}

/** 一段声明时长对应多少个 48kHz 采样帧。 */
export function audioFrameCount(durationTicks: number, sampleRate: number = AUDIO_SAMPLE_RATE): number {
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) return 0;
  return Math.round((durationTicks / TICKS_PER_SECOND) * sampleRate);
}

export interface PlacedPcmPacket {
  /** 该块首采样在目标缓冲内的帧偏移（可 negative：说明块从上一段跨过来） */
  startFrame: number;
  left: Float32Array;
  right: Float32Array;
}

/**
 * 把按段内偏移排列的 PCM 块写入交错立体声缓冲（Buffer 内为 little-endian float32）。
 *
 * 规则与编码端一致：越界样本丢弃（块跨段时只保留落在本段内的部分）。
 * 不做混音——麦克风与系统声是两条独立轨道，各自写各自的 WAV。
 *
 * @returns 实际写入的样本帧数（用于测试与诊断）
 */
export function writePcmInto(data: Buffer, packets: readonly PlacedPcmPacket[], frameCount: number): number {
  let written = 0;
  for (const packet of packets) {
    const base = packet.startFrame;
    const count = Math.min(packet.left.length, packet.right.length);
    for (let i = 0; i < count; i++) {
      const target = base + i;
      if (target < 0 || target >= frameCount) continue;
      const offset = target * 8;
      data.writeFloatLE(packet.left[i], offset);
      data.writeFloatLE(packet.right[i], offset + 4);
      written++;
    }
  }
  return written;
}

/**
 * 为写盘兜底计算缓冲长度：通常用「段声明时长」换算的帧数；
 * 若声明时长为 0（例如录音刚开始就暂停），退化为所有包能覆盖到的最大范围。
 */
export function audioBufferFrames(
  packets: readonly PlacedPcmPacket[],
  durationTicks: number,
  sampleRate: number = AUDIO_SAMPLE_RATE,
): number {
  const declared = audioFrameCount(durationTicks, sampleRate);
  if (declared > 0) return declared;
  let max = 0;
  for (const packet of packets) {
    max = Math.max(max, packet.startFrame + Math.min(packet.left.length, packet.right.length));
  }
  return Math.max(0, max);
}
