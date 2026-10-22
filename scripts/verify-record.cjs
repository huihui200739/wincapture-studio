// 校验录制产物：用 Node 侧 mediabunny 独立解封装每个分段，确认真的可解码
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const mediabunny = require(path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs'));

async function inspect(file) {
  const input = new mediabunny.Input({
    formats: mediabunny.ALL_FORMATS,
    source: new mediabunny.FilePathSource(file),
  });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();
  let packetCount = 0;
  let codec = null;
  let width = 0;
  let height = 0;
  if (video) {
    codec = await video.getCodec();
    width = await video.getCodedWidth();
    height = await video.getCodedHeight();
    const stats = await video.computePacketStats();
    packetCount = stats.packetCount;
  }
  const audioCodec = audio ? await audio.getCodec() : null;
  const channels = audio ? await audio.numberOfChannels : 0;
  const sampleRate = audio ? await audio.sampleRate : 0;
  await input.dispose?.();
  return { duration, codec, width, height, packetCount, audioCodec, channels, sampleRate };
}

(async () => {
  const resultPath = path.join(ROOT, 'dist', 'verify', 'record-result.json');
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const projectPath = result.projectPath;
  const screenDir = path.join(projectPath, 'media', 'screen');
  const files = fs.readdirSync(screenDir).filter((f) => f.endsWith('.mp4')).sort();

  const report = { projectPath, segments: [], ok: true };
  let totalDuration = 0;
  let totalPackets = 0;
  for (const name of files) {
    const abs = path.join(screenDir, name);
    const stat = fs.statSync(abs);
    try {
      const info = await inspect(abs);
      totalDuration += info.duration;
      totalPackets += info.packetCount;
      const good = info.duration > 0 && info.packetCount > 0 && info.codec === 'avc' && info.width === 1280;
      if (!good) report.ok = false;
      report.segments.push({
        name,
        bytes: stat.size,
        durationSeconds: Number(info.duration.toFixed(4)),
        codec: info.codec,
        size: `${info.width}x${info.height}`,
        packets: info.packetCount,
        audio: info.audioCodec ? `${info.audioCodec} ${info.channels}ch@${info.sampleRate}` : null,
        ok: good,
      });
    } catch (error) {
      report.ok = false;
      report.segments.push({ name, bytes: stat.size, error: String(error) });
    }
  }
  report.totalDurationSeconds = Number(totalDuration.toFixed(4));
  report.totalPackets = totalPackets;
  report.expectedFrames = Math.round(totalDuration * 30);

  // 检查音频 WAV
  const micDir = path.join(projectPath, 'media', 'mic');
  if (fs.existsSync(micDir)) {
    report.micFiles = fs.readdirSync(micDir).map((n) => ({ name: n, bytes: fs.statSync(path.join(micDir, n)).size }));
  }

  fs.writeFileSync(path.join(ROOT, 'dist', 'verify', 'record-verify.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})();
