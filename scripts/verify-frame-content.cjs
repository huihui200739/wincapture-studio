// 检查录制分段解码出来的真实帧内容（避免"能解码但全是黑屏"的假成功）
// 用 CanvasSink.getCanvas(timestamp) 逐点取帧，统计颜色多样性。
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const mb = require(path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs'));

(async () => {
  const result = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'verify', 'record-result.json'), 'utf8'));
  const screenDir = path.join(result.projectPath, 'media', 'screen');
  const files = fs.readdirSync(screenDir).filter((f) => f.endsWith('.mp4')).sort();
  const report = { files: [], ok: true };

  for (const name of files.slice(0, 2)) {
    const abs = path.join(screenDir, name);
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.FilePathSource(abs) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      report.ok = false;
      report.files.push({ name, error: 'no video track' });
      await input.dispose?.();
      continue;
    }
    const sink = new mb.CanvasSink(track);
    const samples = [];
    for (const seconds of [0, 0.5, 1.0, 1.5]) {
      const wrapped = await sink.getCanvas(seconds);
      if (!wrapped) continue;
      const canvas = wrapped.canvas ?? wrapped;
      const width = canvas.width;
      const height = canvas.height;
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, width, height).data;
      const colors = new Set();
      let sum = 0;
      let count = 0;
      const step = 4 * 89;
      for (let i = 0; i + 3 < data.length; i += step) {
        colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
        sum += data[i] + data[i + 1] + data[i + 2];
        count++;
      }
      samples.push({
        atSeconds: seconds,
        width,
        height,
        distinctColors: colors.size,
        avgLuma: Math.round(sum / (count * 3)),
      });
    }
    const nonBlank = samples.length > 0 && samples.some((s) => s.distinctColors > 20);
    if (!nonBlank) report.ok = false;
    report.files.push({ name, samples, nonBlank });
    await input.dispose?.();
  }

  fs.writeFileSync(path.join(ROOT, 'dist', 'verify', 'frame-content.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})().catch((error) => {
  console.error('FAILED ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
