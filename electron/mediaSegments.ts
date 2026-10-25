import path from 'node:path';

/** 音频录制保存为 WAV，必须与 MP4 使用各自的分段序列。 */
export function recordedSegmentNames(assetPath: string, names: readonly string[]): string[] {
  const extension = path.extname(assetPath).toLowerCase();
  if (!['.wav', '.mp4', '.m4a'].includes(extension)) return [];
  const base = path.basename(assetPath);
  if (!/^seg-\d+\./i.test(base)) return names.includes(base) ? [base] : [];
  return names.filter(name => /^seg-\d+\./i.test(name) && path.extname(name).toLowerCase() === extension).sort();
}
