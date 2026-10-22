#!/usr/bin/env node
/**
 * 导出器真机验证（WP-C2）
 *
 * 目的：不依赖任何真实录制，用 OffscreenCanvas 合成源画面，走完整 exportProject 流程，
 * 产出真实 MP4 到 dist/verify/，再用 Node + mediabunny 读回校验时长 / 帧率 / 帧数 / 音轨。
 *
 * 覆盖：
 *   1. 合成工程 10 秒 → 真实 MP4（含 AAC 音轨）
 *   2. decoder.ts 的 SegmentSet：先把合成画面编码成 2 个自包含 MP4 分段，
 *      再用 VideoFrameSource 跨段取帧 / 跨段取 PCM，然后用它作为素材导出第二个 MP4
 *   3. 取消：渲染中取消（无残留）+ 写完 .partial 后取消（.partial 必须被删除）
 *   4. 磁盘不足：注入极小的 freeBytes，必须抛 E_DISK_FULL
 *   5. 进度：节流 ≤10 次/秒、单调不回退、不长时间停在 99%
 *
 * 运行：
 *   Remove-Item env:ELECTRON_RUN_AS_NODE
 *   node_modules\electron\dist\electron.exe --no-sandbox scripts/verify-exporter.cjs
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'verify');
const TICKS = 10_000_000;

app.setPath('userData', path.join(ROOT, '.verify-exporter-data'));
app.commandLine.appendSwitch('disable-gpu-sandbox');

const results = { steps: [], ok: true, page: null };
function record(name, value, ok = true) {
  results.steps.push({ name, value, ok });
  if (!ok) results.ok = false;
  console.log('[VERIFY] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + ': ' + JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 1. 把 TS 导出器打成渲染进程可用的 IIFE（stdin 入口，不新增源文件）
// ---------------------------------------------------------------------------

async function bundleExporter() {
  const esbuild = require('esbuild');
  const entry = [
    "import * as mediabunny from 'mediabunny';",
    "import { configureMediabunny, VideoFrameSource, SegmentSet } from './src/media/decoder';",
    "import { exportProject, snapshotProject, sha256Hex, estimateOutputBytes } from './src/media/exporter';",
    'configureMediabunny(mediabunny);',
    'export { exportProject, snapshotProject, sha256Hex, estimateOutputBytes, VideoFrameSource, SegmentSet, mediabunny };',
  ].join('\n');

  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'verify-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'iife',
    globalName: 'WCSExport',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const code = built.outputFiles[0].text;
  const file = path.join(OUT, 'exporter-bundle.js');
  fs.writeFileSync(file, code, 'utf8');
  return { file, bytes: Buffer.byteLength(code) };
}

// ---------------------------------------------------------------------------
// 2. 合成工程（严格遵循 src/domain/project.ts 的结构）
// ---------------------------------------------------------------------------

function makeSyntheticProject(seconds) {
  const dur = Math.round(seconds * TICKS);
  const S = TICKS;
  return {
    schemaVersion: 1,
    id: 'verify-synthetic-project',
    revision: 7,
    timebase: { ticksPerSecond: S },
    name: '导出验证 · 合成工程',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    assets: [
      {
        id: 'asset-screen',
        kind: 'screen',
        path: 'media/screen/seg-000001.mp4',
        hash: 'a3f19c2b7d4e5061',
        durationTicks: dur,
        width: 1600,
        height: 900,
        sampleRate: 0,
        channels: 0,
        createdAt: 1_700_000_000_000,
      },
      {
        id: 'asset-mic',
        kind: 'mic',
        path: 'media/mic/seg-000001.wav',
        hash: 'c2d8f0a15b6e7349',
        durationTicks: dur,
        width: 0,
        height: 0,
        sampleRate: 48000,
        channels: 2,
        createdAt: 1_700_000_000_000,
      },
      {
        id: 'asset-system',
        kind: 'system',
        path: 'media/system/seg-000001.wav',
        hash: 'd9e0b1c47a2f8856',
        durationTicks: dur,
        width: 0,
        height: 0,
        sampleRate: 48000,
        channels: 2,
        createdAt: 1_700_000_000_000,
      },
    ],
    tracks: [
      {
        id: 'main',
        kind: 'primaryVideo',
        muted: false,
        gain: 1,
        clips: [
          {
            id: 'clip-main-1',
            assetId: 'asset-screen',
            sourceInTicks: 0,
            sourceDurationTicks: 4 * S,
            timelineInTicks: 0,
            rate: { num: 1, den: 1 },
            linkGroupId: 'g1',
          },
          {
            id: 'clip-main-2',
            assetId: 'asset-screen',
            sourceInTicks: 4 * S,
            sourceDurationTicks: 6 * S,
            timelineInTicks: 4 * S,
            rate: { num: 1, den: 1 },
            linkGroupId: 'g1',
          },
        ],
      },
      { id: 'camera', kind: 'camera', muted: false, gain: 1, clips: [] },
      {
        id: 'mic',
        kind: 'mic',
        muted: false,
        gain: 0.86,
        clips: [
          {
            id: 'clip-mic',
            assetId: 'asset-mic',
            sourceInTicks: 0,
            sourceDurationTicks: dur,
            timelineInTicks: 0,
            rate: { num: 1, den: 1 },
            linkGroupId: 'ga',
          },
        ],
      },
      {
        id: 'system',
        kind: 'system',
        muted: false,
        gain: 0.42,
        clips: [
          {
            id: 'clip-sys',
            assetId: 'asset-system',
            sourceInTicks: 0,
            sourceDurationTicks: dur,
            timelineInTicks: 0,
            rate: { num: 1, den: 1 },
            linkGroupId: 'ga',
          },
        ],
      },
    ],
    effects: [
      {
        id: 'zoom-1',
        kind: 'zoom',
        range: { start: 2 * S, end: 6 * S },
        parameters: { scale: 1.6, focusX: 0.42, focusY: 0.4, easeInTicks: Math.round(0.4 * S), easeOutTicks: Math.round(0.5 * S), focusSource: 'manual' },
        origin: 'manual',
        locked: true,
      },
      {
        id: 'privacy-1',
        kind: 'privacy',
        range: { start: 1 * S, end: 9 * S },
        anchor: 'screen',
        parameters: { x: 0.3, y: 0.42, width: 0.22, height: 0.08, anchor: 'screen', style: 'solid', confirmed: true },
        origin: 'manual',
        locked: true,
      },
      {
        id: 'note-1',
        kind: 'annotation',
        range: { start: 0, end: dur },
        parameters: { text: '合成验证 · 非真实录制', x: 0.08, y: 0.08, fontSize: 34, color: '#ffffff' },
        origin: 'manual',
        locked: false,
      },
    ],
    steps: [],
    variants: [
      { id: 'landscape', aspect: [16, 9], layoutOverrides: {} },
      { id: 'square', aspect: [1, 1], layoutOverrides: {} },
      { id: 'portrait', aspect: [9, 16], layoutOverrides: {} },
    ],
    markers: [],
    settings: {
      fps: { num: 30, den: 1 },
      activeVariantId: 'landscape',
      canvas: {
        background: '#101418',
        cornerRadius: 14,
        shadowBlur: 28,
        shadowOpacity: 0.45,
        padding: 0.06,
        camera: { x: 0.72, y: 0.68, width: 0.24, height: 0.24, visible: true, cornerRadius: 12 },
      },
      pointerSampleHz: 120,
      stepEnhancement: false,
    },
    privacyVersion: 2,
  };
}

function makeProfile(width, height, fps) {
  return {
    variantId: 'landscape',
    width,
    height,
    fps: { num: fps, den: 1 },
    videoBitrate: width >= 1920 ? 12_000_000 : 6_000_000,
    audioBitrate: 192_000,
    audioOnly: false,
    includeTutorial: false,
  };
}

// ---------------------------------------------------------------------------
// 3. 页面脚本（渲染进程：WebCodecs 可用）
// ---------------------------------------------------------------------------

const PAGE_SCRIPT = String.raw`
window.runVerify = async function (cfg) {
  var fs = require('node:fs');
  var pathMod = require('node:path');
  var W = window.WCSExport;
  var mb = W.mediabunny;
  var out = { steps: [], logs: [], ok: true };

  function rec(name, value, ok) {
    out.steps.push({ name: name, value: value, ok: ok !== false });
    if (ok === false) out.ok = false;
    console.log('[PAGE] ' + (ok === false ? 'FAIL' : 'PASS') + ' ' + name + ': ' + JSON.stringify(value));
  }
  function log(m) { out.logs.push(m); console.log('[PAGE] ' + m); }

  var io = {
    writeFile: async function (p, data) {
      await fs.promises.writeFile(p, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    rename: async function (a, b) { await fs.promises.rename(a, b); },
    removeFile: async function (p) {
      try { await fs.promises.unlink(p); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    },
    freeBytes: async function (p) {
      try {
        var st = await fs.promises.statfs(pathMod.dirname(p));
        return Number(st.bavail) * Number(st.bsize);
      } catch (e) { return 0; }
    },
    readFile: async function (p) { return new Uint8Array(await fs.promises.readFile(p)); }
  };

  // ---- 合成源画面：渐变 + 文字 + 运动方块（每帧都不同，便于校验不是纯色） ----
  function drawSynthetic(ctx, W_, H_, t, label) {
    var hue = (t * 37) % 360;
    var g = ctx.createLinearGradient(0, 0, W_, H_);
    g.addColorStop(0, 'hsl(' + hue + ',62%,20%)');
    g.addColorStop(0.55, 'hsl(' + ((hue + 60) % 360) + ',58%,34%)');
    g.addColorStop(1, 'hsl(' + ((hue + 130) % 360) + ',64%,42%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W_, H_);

    for (var i = 0; i < 6; i++) {
      var x = ((t * 90 + i * 150) % (W_ + 240)) - 120;
      ctx.fillStyle = 'hsla(' + ((hue + i * 45) % 360) + ',72%,62%,0.34)';
      ctx.fillRect(x, 60 + i * (H_ / 8), Math.round(W_ * 0.07), Math.round(H_ * 0.055));
    }

    // 模拟一个"应用窗口"
    ctx.fillStyle = 'rgba(255,255,255,0.93)';
    ctx.fillRect(Math.round(W_ * 0.18), Math.round(H_ * 0.16), Math.round(W_ * 0.62), Math.round(H_ * 0.5));
    ctx.fillStyle = '#0f1720';
    ctx.font = '600 ' + Math.round(H_ * 0.042) + 'px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    ctx.fillText('合成源画面 · ' + label, Math.round(W_ * 0.21), Math.round(H_ * 0.27));
    ctx.fillStyle = '#33465c';
    ctx.font = '400 ' + Math.round(H_ * 0.028) + 'px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    ctx.fillText('OffscreenCanvas 渐变 + 文字（不依赖真实录制）', Math.round(W_ * 0.21), Math.round(H_ * 0.35));
    ctx.fillStyle = 'hsl(' + ((hue + 200) % 360) + ',70%,45%)';
    ctx.fillRect(Math.round(W_ * 0.21), Math.round(H_ * 0.42), Math.round(W_ * 0.34), Math.round(H_ * 0.12));

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 ' + Math.round(H_ * 0.048) + 'px "Consolas", monospace';
    ctx.fillText('t = ' + t.toFixed(3) + 's', Math.round(W_ * 0.06), H_ - Math.round(H_ * 0.09));
    ctx.font = '400 ' + Math.round(H_ * 0.028) + 'px "Consolas", monospace';
    ctx.fillText('WinCapture Studio / verify-exporter', Math.round(W_ * 0.06), H_ - Math.round(H_ * 0.035));
  }

  // ---- 合成 FrameProvider（同时提供画面与 PCM） ----
  function makeSyntheticProvider(width, height, label) {
    var canvas = new OffscreenCanvas(width, height);
    var ctx = canvas.getContext('2d', { alpha: false });
    return {
      getFrameAt: async function (tick) {
        drawSynthetic(ctx, width, height, tick / 1e7, label);
        return canvas;
      },
      getAudioAt: async function (range, opts) {
        var channels = Math.max(1, (opts && opts.channels) || 2);
        var sr = 48000;
        var startSample = Math.max(0, Math.round((range.start * sr) / 1e7));
        var endSample = Math.max(startSample, Math.round((range.end * sr) / 1e7));
        var n = endSample - startSample;
        var chs = [];
        for (var ch = 0; ch < channels; ch++) {
          var d = new Float32Array(n);
          var f = ch === 0 ? 440 : 660;
          for (var i = 0; i < n; i++) d[i] = 0.22 * Math.sin((2 * Math.PI * f * (startSample + i)) / sr);
          chs.push(d);
        }
        return {
          channels: chs,
          sampleRate: sr,
          startTick: Math.round((startSample * 1e7) / sr),
          frameCount: n,
          hasData: n > 0
        };
      },
      close: function () {}
    };
  }

  function makeProgressCollector() {
    var events = [];
    return {
      events: events,
      sink: function (p) {
        events.push({ t: performance.now(), percent: p.percent, phase: p.phase, framesDone: p.framesDone });
      }
    };
  }

  function analyzeProgress(events) {
    var percents = events.map(function (e) { return e.percent; });
    var monotonic = true;
    for (var i = 1; i < percents.length; i++) if (percents[i] < percents[i - 1]) monotonic = false;
    // 任意 1000ms 窗口内的最大事件数
    var maxPerSecond = 0;
    for (var j = 0; j < events.length; j++) {
      var count = 0;
      for (var k = j; k < events.length && events[k].t - events[j].t <= 1000; k++) count++;
      if (count > maxPerSecond) maxPerSecond = count;
    }
    var saw99 = percents.indexOf(99) >= 0;
    var phases = events
      .map(function (e) { return e.phase; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    var required = ['preparing', 'rendering', 'muxing', 'finalizing', 'done'];
    var missingPhases = required.filter(function (p) { return phases.indexOf(p) < 0; });
    return {
      total: events.length,
      monotonic: monotonic,
      maxPerSecond: maxPerSecond,
      firstPercent: percents.length ? percents[0] : null,
      lastPercent: percents.length ? percents[percents.length - 1] : null,
      saw99: saw99,
      phases: phases,
      missingPhases: missingPhases
    };
  }

  // ---- 读回文件：结构性 + 内容性校验（渲染进程有 canvas / AudioBuffer） ----
  async function inspectInPage(file) {
    var bytes = new Uint8Array(await fs.promises.readFile(file));
    var input = new mb.Input({ source: new mb.BlobSource(new Blob([bytes])), formats: mb.ALL_FORMATS });
    try {
      var v = await input.getPrimaryVideoTrack();
      var a = await input.getPrimaryAudioTrack();
      var res = { bytes: bytes.byteLength, duration: await input.computeDuration() };
      if (v) {
        var stats = await v.computePacketStats();
        res.video = {
          codec: await v.getCodec(),
          width: await v.getCodedWidth(),
          height: await v.getCodedHeight(),
          frameRate: stats.averagePacketRate,
          packetCount: stats.packetCount
        };
        var sinkV = new mb.VideoSampleSink(v);
        var decoded = 0;
        var colors = new Set();
        for await (var s of sinkV.samples(0, 0.4)) {
          var c = new OffscreenCanvas(s.codedWidth, s.codedHeight);
          var cx = c.getContext('2d');
          s.draw(cx, 0, 0);
          var d = cx.getImageData(0, 0, c.width, c.height).data;
          for (var i = 0; i < d.length; i += 4 * 2003) {
            colors.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
          }
          decoded++;
          s.close();
        }
        res.decodedFrames = decoded;
        res.distinctColors = colors.size;
      } else {
        res.video = null;
      }
      if (a) {
        res.audio = {
          codec: await a.getCodec(),
          channels: await a.getNumberOfChannels(),
          sampleRate: await a.getSampleRate()
        };
        var asink = new mb.AudioBufferSink(a);
        var samples = 0;
        var peak = 0;
        for await (var buf of asink.buffers(0, 1.5)) {
          samples += buf.buffer.length;
          for (var ch = 0; ch < buf.buffer.numberOfChannels; ch++) {
            var dd = buf.buffer.getChannelData(ch);
            for (var n = 0; n < dd.length; n += 37) {
              var abs = Math.abs(dd[n]);
              if (abs > peak) peak = abs;
            }
          }
        }
        res.decodedAudioSamples = samples;
        res.audioPeak = Number(peak.toFixed(4));
      } else {
        res.audio = null;
      }
      return res;
    } finally {
      try { input.dispose(); } catch (e) {}
    }
  }

  // ---- 音频链路定量校验：gain 乘积、限幅、无响度美化 ----
  // 用「直流」源（恒定 0.5）把混音结果变成可解析的数字：
  //   期望峰值 = clamp(0.5 * trackGain * intervalGain)
  //   若导出器偷偷做了响度归一化/压限，峰值就会偏离这个理论值。
  async function measureAudioGain(cfgPath) {
    var DC = 0.5;
    var mkProvider = function () {
      return {
        getFrameAt: async function (tick) {
          var c = new OffscreenCanvas(64, 36);
          var cx = c.getContext('2d', { alpha: false });
          cx.fillStyle = '#202830';
          cx.fillRect(0, 0, 64, 36);
          return c;
        },
        getAudioAt: async function (range, opts) {
          var channels = Math.max(1, (opts && opts.channels) || 2);
          var sr = 48000;
          var a = Math.max(0, Math.round((range.start * sr) / 1e7));
          var b = Math.max(a, Math.round((range.end * sr) / 1e7));
          var n = b - a;
          var chs = [];
          for (var ch = 0; ch < channels; ch++) {
            var d = new Float32Array(n);
            for (var i = 0; i < n; i++) d[i] = DC;
            chs.push(d);
          }
          return {
            channels: chs,
            sampleRate: sr,
            startTick: Math.round((a * 1e7) / sr),
            frameCount: n,
            hasData: n > 0
          };
        },
        close: function () {}
      };
    };

    // 单轨、gain=1：期望峰值 = DC（不做任何美化）
    // 注意：主视频轨必须保留至少 1 个片段，否则 timelineDuration=0，导出会被直接拒绝。
    var p1 = JSON.parse(JSON.stringify(cfgPath.project));
    p1.effects = [];
    p1.tracks.forEach(function (t) {
      if (t.kind === 'primaryVideo') {
        // 只留 1 个 1 秒片段，缩短验证时间
        t.clips = [{
          id: 'clip-gain-main',
          assetId: 'asset-screen',
          sourceInTicks: 0,
          sourceDurationTicks: 1e7,
          timelineInTicks: 0,
          rate: { num: 1, den: 1 },
          linkGroupId: 'gg'
        }];
      } else if (t.kind === 'mic') {
        t.gain = 1;
        t.clips = [{
          id: 'clip-gain-mic',
          assetId: 'asset-mic',
          sourceInTicks: 0,
          sourceDurationTicks: 1e7,
          timelineInTicks: 0,
          rate: { num: 1, den: 1 },
          linkGroupId: 'gg'
        }];
      } else {
        t.clips = [];
      }
    });

    var out1 = pathMod.join(outDir, 'gain-unity.mp4');
    await W.exportProject({
      jobId: 'verify-gain-unity',
      project: p1,
      profile: cfgPath.profile,
      outputPath: out1,
      io: io,
      media: { providerFor: async function () { return mkProvider(); }, segmentsFor: async function () { return []; } },
      onProgress: function () {}
    });
    var unity = await inspectAudioPeak(out1);

    // 单轨、gain=0.5：期望峰值 = 0.25（严格线性，无自动增益补偿）
    var p2 = JSON.parse(JSON.stringify(p1));
    p2.tracks.forEach(function (t) {
      if (t.kind === 'mic') t.gain = 0.5;
    });
    var out2 = pathMod.join(outDir, 'gain-half.mp4');
    await W.exportProject({
      jobId: 'verify-gain-half',
      project: p2,
      profile: cfgPath.profile,
      outputPath: out2,
      io: io,
      media: { providerFor: async function () { return mkProvider(); }, segmentsFor: async function () { return []; } },
      onProgress: function () {}
    });
    var half = await inspectAudioPeak(out2);

    // 限幅：DC=0.5 × gain=4 → 2.0，必须被限到 1.0（不能削成更大的数字，也不能爆音）
    var p3 = JSON.parse(JSON.stringify(p1));
    p3.tracks.forEach(function (t) {
      if (t.kind === 'mic') t.gain = 4;
    });
    var out3 = pathMod.join(outDir, 'gain-clamp.mp4');
    await W.exportProject({
      jobId: 'verify-gain-clamp',
      project: p3,
      profile: cfgPath.profile,
      outputPath: out3,
      io: io,
      media: { providerFor: async function () { return mkProvider(); }, segmentsFor: async function () { return []; } },
      onProgress: function () {}
    });
    var clamped = await inspectAudioPeak(out3);

    return {
      dc: DC,
      unityPeak: unity,
      halfPeak: half,
      clampPeak: clamped,
      expected: { unity: DC, half: DC * 0.5, clamp: 1 }
    };
  }

  async function inspectAudioPeak(file) {
    var bytes = new Uint8Array(await fs.promises.readFile(file));
    var input = new mb.Input({ source: new mb.BlobSource(new Blob([bytes])), formats: mb.ALL_FORMATS });
    try {
      var a = await input.getPrimaryAudioTrack();
      if (!a) return null;
      var sink = new mb.AudioBufferSink(a);
      var peak = 0;
      var sum = 0;
      var count = 0;
      // 跳过首尾各 0.1s 的边界淡入淡出，只看稳态
      for await (var buf of sink.buffers(0.15, 0.85)) {
        var d = buf.buffer.getChannelData(0);
        for (var i = 0; i < d.length; i++) {
          var v = d[i];
          if (v > peak) peak = v;
          sum += v;
          count++;
        }
      }
      return { peak: Number(peak.toFixed(4)), mean: Number((sum / Math.max(1, count)).toFixed(4)), samples: count };
    } finally {
      try { input.dispose(); } catch (e) {}
    }
  }

  // ---- 生成一个自包含 MP4 分段（模拟 WP-A 的分段录制） ----
  async function encodeSegment(t0Sec, seconds, file) {
    var SW = 1280;
    var SH = 720;
    var FPS = 30;
    var SR = 48000;
    var output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new mb.BufferTarget()
    });
    var canvas = new OffscreenCanvas(SW, SH);
    var ctx = canvas.getContext('2d', { alpha: false });
    var vs = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: 6000000 });
    output.addVideoTrack(vs, { frameRate: FPS });
    var as = new mb.AudioBufferSource({ codec: 'aac', bitrate: 128000, numberOfChannels: 2, sampleRate: SR });
    output.addAudioTrack(as);
    await output.start();

    var total = Math.round(FPS * seconds);
    for (var i = 0; i < total; i++) {
      drawSynthetic(ctx, SW, SH, t0Sec + i / FPS, 'segment');
      await vs.add(i / FPS, 1 / FPS);
    }
    var ac = new OfflineAudioContext(2, SR * seconds, SR);
    var ab = ac.createBuffer(2, SR * seconds, SR);
    for (var ch = 0; ch < 2; ch++) {
      var d = ab.getChannelData(ch);
      var f = ch === 0 ? 440 : 660;
      for (var n = 0; n < d.length; n++) {
        d[n] = 0.2 * Math.sin((2 * Math.PI * f * (t0Sec * SR + n)) / SR);
      }
    }
    await as.add(ab);
    await output.finalize();
    var bytes = new Uint8Array(output.target.buffer);
    await fs.promises.writeFile(file, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { file: file, bytes: bytes.byteLength, frames: total };
  }

  try {
    var profile = cfg.profile;
    var project = cfg.project;
    var outDir = cfg.outDir;
    var encInfo = null;

    // =====================================================================
    // A. 合成工程 10 秒 → 真实 MP4
    // =====================================================================
    var synth = makeSyntheticProvider(1600, 900, 'screen');
    var mediaSynthetic = {
      providerFor: async function (assetId) {
        if (assetId === 'asset-screen' || assetId === 'asset-mic' || assetId === 'asset-system') return synth;
        return null;
      },
      segmentsFor: async function () { return []; }
    };
    var synthPath = pathMod.join(outDir, 'synthetic-10s.mp4');
    var prog1 = makeProgressCollector();
    var t0 = performance.now();
    var r1 = await W.exportProject({
      jobId: 'verify-synthetic',
      project: project,
      profile: profile,
      outputPath: synthPath,
      io: io,
      media: mediaSynthetic,
      pointerAt: function (tick) {
        var s = tick / 1e7;
        return {
          x: 0.5 + 0.28 * Math.sin(s * 1.1),
          y: 0.5 + 0.18 * Math.cos(s * 1.7),
          visible: true,
          clickProgress: s % 2.5 < 0.2 ? (s % 2.5) / 0.2 : 0,
          clickX: 0.5,
          clickY: 0.5
        };
      },
      onProgress: prog1.sink
    });
    var synthMs = Math.round(performance.now() - t0);
    encInfo = r1.encoder;
    var prog1Info = analyzeProgress(prog1.events);
    rec('export-synthetic', {
      ok: r1.ok,
      outputPath: r1.outputPath,
      frames: r1.frames,
      bytes: r1.bytes,
      durationTicks: r1.durationTicks,
      encoder: r1.encoder,
      verified: r1.verified,
      snapshotHash: r1.snapshotHash,
      verifySource: r1.verifiedDetail ? r1.verifiedDetail.source : null,
      verifyChecks: r1.verifiedDetail ? r1.verifiedDetail.checks : null,
      warnings: r1.warnings,
      ms: synthMs
    });
    rec('export-synthetic-verified', r1.verified === true && r1.ok === true);
    rec('progress-throttle', prog1Info,
      prog1Info.monotonic &&
      prog1Info.maxPerSecond <= 10 &&
      prog1Info.firstPercent === 0 &&
      prog1Info.lastPercent === 100 &&
      !prog1Info.saw99 &&
      prog1Info.missingPhases.length === 0);
    rec('snapshot-hash', { hash: r1.snapshotHash, length: r1.snapshotHash.length },
      typeof r1.snapshotHash === 'string' && r1.snapshotHash.length === 64);

    var inspect1 = await inspectInPage(synthPath);
    rec('readback-synthetic', inspect1,
      Math.abs(inspect1.duration - 10) <= 0.1 &&
      Math.abs(inspect1.video.frameRate - 30) <= 0.5 &&
      inspect1.video.packetCount === 300 &&
      !!inspect1.audio &&
      inspect1.decodedFrames > 0 &&
      inspect1.distinctColors > 20 &&
      inspect1.audioPeak > 0.01);

    // =====================================================================
    // B. decoder.ts：2 个自包含 MP4 分段 → SegmentSet 跨段取帧 / 取 PCM
    // =====================================================================
    var seg1 = pathMod.join(outDir, 'source-seg-000001.mp4');
    var seg2 = pathMod.join(outDir, 'source-seg-000002.mp4');
    var s1 = await encodeSegment(0, 5, seg1);
    var s2 = await encodeSegment(5, 5, seg2);
    rec('segments-encoded', { seg1: s1.bytes, seg2: s2.bytes, framesEach: s1.frames });

    var segments = [
      { path: seg1, startTick: 0 },
      { path: seg2, startTick: Math.round(5 * 1e7) }
    ];
    var vfs = new W.VideoFrameSource(
      {
        mediabunny: mb,
        readFile: io.readFile,
        sampleRate: 48000,
        seekWindowSeconds: 1.5
      },
      segments
    );
    await vfs.open();

    var probeSecs = [0, 0.5, 1.5, 4.5, 4.9, 4.999, 5.0, 5.001, 5.5, 7.5, 9.0, 9.9];
    var probes = [];
    var allProbesOk = true;
    for (var pi = 0; pi < probeSecs.length; pi++) {
      var sec = probeSecs[pi];
      var frame = await vfs.getFrameAt(Math.round(sec * 1e7));
      var ok = !!frame && frame.width === 1280 && frame.height === 720;
      if (!ok) allProbesOk = false;
      probes.push({ sec: sec, ok: ok, w: frame ? frame.width : 0, h: frame ? frame.height : 0 });
    }
    // 回跳（seek 回退）也必须正确
    var back = await vfs.getFrameAt(Math.round(2.0 * 1e7));
    rec('decoder-frame-probes', { probes: probes, seekBack: !!back }, allProbesOk && !!back);

    // 跨段边界取 PCM
    var crossAudio = await vfs.getAudioAt(
      { start: Math.round(4.5 * 1e7), end: Math.round(5.5 * 1e7) },
      { channels: 2 }
    );
    var peak = 0;
    if (crossAudio) {
      for (var ch2 = 0; ch2 < crossAudio.channels.length; ch2++) {
        var data2 = crossAudio.channels[ch2];
        for (var n2 = 0; n2 < data2.length; n2 += 11) {
          var abs2 = Math.abs(data2[n2]);
          if (abs2 > peak) peak = abs2;
        }
      }
    }
    rec('decoder-cross-segment-audio', {
      frameCount: crossAudio ? crossAudio.frameCount : 0,
      expected: 48000,
      channels: crossAudio ? crossAudio.channels.length : 0,
      peak: Number(peak.toFixed(4)),
      startTick: crossAudio ? crossAudio.startTick : null
    }, !!crossAudio && Math.abs(crossAudio.frameCount - 48000) <= 2 && peak > 0.05);

    // 缓存/游标有效性：段内顺序读必须比"每次都从头 seek"快得多
    // 做法：先整段顺序读一遍计时，再随机跳读同样次数计时，顺序读应显著更快
    var seqStart = performance.now();
    for (var sf = 0; sf < 60; sf++) {
      await vfs.getFrameAt(Math.round((5.2 + sf / 30) * 1e7));
    }
    var seqMs = performance.now() - seqStart;
    var rndStart = performance.now();
    for (var rf = 0; rf < 60; rf++) {
      var t2 = 0.3 + ((rf * 137) % 90) / 10; // 反复跨段乱跳
      await vfs.getFrameAt(Math.round(t2 * 1e7));
    }
    var rndMs = performance.now() - rndStart;
    rec('decoder-sequential-vs-random', {
      sequentialMs: Number(seqMs.toFixed(2)),
      randomMs: Number(rndMs.toFixed(2)),
      ratio: Number((rndMs / Math.max(0.001, seqMs)).toFixed(2))
    }, seqMs < rndMs);

    // =====================================================================
    // C. 用真实解码的分段素材再导出一次（验证 decoder → compositor → 编码 全链路）
    // =====================================================================
    var mediaDecoded = {
      providerFor: async function (assetId) {
        if (assetId === 'asset-screen' || assetId === 'asset-mic' || assetId === 'asset-system') return vfs;
        return null;
      },
      segmentsFor: async function () { return []; }
    };
    var segOut = pathMod.join(outDir, 'segmented-10s.mp4');
    var prog2 = makeProgressCollector();
    var t1 = performance.now();
    var r2 = await W.exportProject({
      jobId: 'verify-segmented',
      project: project,
      profile: profile,
      outputPath: segOut,
      io: io,
      media: mediaDecoded,
      onProgress: prog2.sink
    });
    var segMs = Math.round(performance.now() - t1);
    rec('export-from-segments', {
      ok: r2.ok,
      frames: r2.frames,
      bytes: r2.bytes,
      encoder: r2.encoder,
      verified: r2.verified,
      verifySource: r2.verifiedDetail ? r2.verifiedDetail.source : null,
      warnings: r2.warnings,
      ms: segMs
    });
    var inspect2 = await inspectInPage(segOut);
    rec('readback-segmented', inspect2,
      Math.abs(inspect2.duration - 10) <= 0.1 &&
      inspect2.video.packetCount === 300 &&
      !!inspect2.audio &&
      inspect2.distinctColors > 20 &&
      inspect2.audioPeak > 0.01);

    // =====================================================================
    // D. 取消（渲染中取消）
    // =====================================================================
    var cancelPath1 = pathMod.join(outDir, 'cancel-early.mp4');
    var ac1 = new AbortController();
    var timer1 = setTimeout(function () { ac1.abort(); }, 350);
    var err1 = null;
    try {
      await W.exportProject({
        jobId: 'verify-cancel-early',
        project: project,
        profile: profile,
        outputPath: cancelPath1,
        io: io,
        media: mediaSynthetic,
        signal: ac1.signal,
        onProgress: function () {}
      });
    } catch (e) {
      err1 = { code: e && e.code, message: e && e.message };
    } finally {
      clearTimeout(timer1);
    }
    var partial1 = fs.existsSync(cancelPath1 + '.partial');
    var final1 = fs.existsSync(cancelPath1);
    rec('cancel-early', { error: err1, partialLeft: partial1, finalLeft: final1 },
      !!err1 && err1.code === 'E_EXPORT_CANCELLED' && !partial1 && !final1);

    // =====================================================================
    // E. 取消（.partial 已写入之后取消 —— 必须删除 .partial）
    //    用 io 钩子确定性触发：.partial 落盘成功之后立刻 abort，
    //    覆盖「临时文件已存在但尚未 rename」这个最危险的窗口。
    // =====================================================================
    var cancelPath2 = pathMod.join(outDir, 'cancel-late.mp4');
    var ac2 = new AbortController();
    var lateAborted = false;
    var partialWrittenSeen = false;
    var ioLate = {
      writeFile: async function (p, data) {
        await io.writeFile(p, data);
        if (p.indexOf('.partial') >= 0) {
          partialWrittenSeen = fs.existsSync(p);
          lateAborted = true;
          ac2.abort();
        }
      },
      rename: io.rename,
      removeFile: io.removeFile,
      freeBytes: io.freeBytes,
      readFile: io.readFile
    };
    var err2 = null;
    try {
      await W.exportProject({
        jobId: 'verify-cancel-late',
        project: project,
        profile: profile,
        outputPath: cancelPath2,
        io: ioLate,
        media: mediaSynthetic,
        signal: ac2.signal,
        onProgress: function () {}
      });
    } catch (e) {
      err2 = { code: e && e.code, message: e && e.message };
    }
    var partial2 = fs.existsSync(cancelPath2 + '.partial');
    var final2 = fs.existsSync(cancelPath2);
    rec('cancel-late-after-partial', {
      partialWrittenSeen: partialWrittenSeen,
      abortedAfterPartialWrite: lateAborted,
      error: err2,
      partialLeft: partial2,
      finalLeft: final2
    }, partialWrittenSeen && lateAborted && !!err2 && err2.code === 'E_EXPORT_CANCELLED' && !partial2 && !final2);

    // =====================================================================
    // F. 磁盘不足：注入极小的 freeBytes → 必须抛 E_DISK_FULL
    // =====================================================================
    var ioSmall = {
      writeFile: io.writeFile,
      rename: io.rename,
      removeFile: io.removeFile,
      readFile: io.readFile,
      freeBytes: async function () { return 1024; }
    };
    var diskPath = pathMod.join(outDir, 'disk-full.mp4');
    var err3 = null;
    try {
      await W.exportProject({
        jobId: 'verify-disk-full',
        project: project,
        profile: profile,
        outputPath: diskPath,
        io: ioSmall,
        media: mediaSynthetic,
        onProgress: function () {}
      });
    } catch (e) {
      err3 = { code: e && e.code, message: e && e.message };
    }
    var diskPartial = fs.existsSync(diskPath + '.partial');
    var diskFinal = fs.existsSync(diskPath);
    rec('disk-full', { error: err3, partialLeft: diskPartial, finalLeft: diskFinal },
      !!err3 && err3.code === 'E_DISK_FULL' && !diskPartial && !diskFinal);

    // =====================================================================
    // G. 空工程：必须报错而不是产出伪完成文件
    // =====================================================================
    var emptyProject = JSON.parse(JSON.stringify(project));
    for (var ti = 0; ti < emptyProject.tracks.length; ti++) emptyProject.tracks[ti].clips = [];
    var emptyPath = pathMod.join(outDir, 'empty.mp4');
    var err4 = null;
    try {
      await W.exportProject({
        jobId: 'verify-empty',
        project: emptyProject,
        profile: profile,
        outputPath: emptyPath,
        io: io,
        media: mediaSynthetic,
        onProgress: function () {}
      });
    } catch (e) {
      err4 = { code: e && e.code, message: e && e.message };
    }
    rec('empty-project-rejected', { error: err4, finalLeft: fs.existsSync(emptyPath) },
      !!err4 && !fs.existsSync(emptyPath));

    // =====================================================================
    // H. 音频增益链路：严格线性 gain、限幅到 [-1,1]、不做响度美化
    // =====================================================================
    var gainInfo = await measureAudioGain(cfg);
    var g = gainInfo;
    var gainOk =
      !!g.unityPeak && !!g.halfPeak && !!g.clampPeak &&
      // 严格线性：0.5 → 0.5，×0.5 → 0.25（AAC 量化误差容差 2%）
      Math.abs(g.unityPeak.peak - 0.5) <= 0.012 &&
      Math.abs(g.halfPeak.peak - 0.25) <= 0.008 &&
      Math.abs(g.unityPeak.peak / Math.max(1e-6, g.halfPeak.peak) - 2) <= 0.05 &&
      // 限幅：0.5×4=2.0 必须被夹到 1.0（AAC 解码可能略微超过 1.0，不算爆音）
      g.clampPeak.peak >= 0.97 && g.clampPeak.peak <= 1.02;
    rec('audio-gain-and-clamp', g, gainOk);

    // =====================================================================
    // I. 快照不可变：哈希确定 + 导出中篡改原工程不影响结果
    // =====================================================================
    var snapA = W.snapshotProject(project);
    var snapB = W.snapshotProject(project);
    var hashA = await W.sha256Hex(JSON.stringify(snapA));
    var hashB = await W.sha256Hex(JSON.stringify(snapB));
    // 深拷贝：改快照不能反向污染原工程
    var before = project.tracks[0].clips[0].sourceDurationTicks;
    snapA.tracks[0].clips[0].sourceDurationTicks = 123;
    snapA.name = 'MUTATED';
    var isolated = project.tracks[0].clips[0].sourceDurationTicks === before && project.name !== 'MUTATED';
    rec('snapshot-deterministic-and-isolated', {
      hashEqual: hashA === hashB,
      isolated: isolated,
      originalDuration: before,
      snapshotDurationAfterMutate: snapA.tracks[0].clips[0].sourceDurationTicks
    }, hashA === hashB && isolated);

    // 导出过程中篡改原工程：结果哈希/帧数必须与未被篡改时一致
    var tamperProject = JSON.parse(JSON.stringify(project));
    var tamperPath = pathMod.join(outDir, 'tamper.mp4');
    var tamperTimer = setTimeout(function () {
      // 导出已开始后，把工程改成 3 秒、删掉一半片段
      tamperProject.tracks[0].clips = [
        { id: 'x', assetId: 'asset-screen', sourceInTicks: 0, sourceDurationTicks: 3e7, timelineInTicks: 0, rate: { num: 1, den: 1 }, linkGroupId: 'g1' }
      ];
      tamperProject.name = 'TAMPERED-MID-EXPORT';
    }, 60);
    var rTamper = await W.exportProject({
      jobId: 'verify-tamper',
      project: tamperProject,
      profile: profile,
      outputPath: tamperPath,
      io: io,
      media: mediaSynthetic,
      onProgress: function () {}
    });
    clearTimeout(tamperTimer);
    rec('snapshot-immune-to-mid-export-mutation', {
      frames: rTamper.frames,
      durationTicks: rTamper.durationTicks,
      hashMatchesBaseline: rTamper.snapshotHash === r1.snapshotHash,
      bytes: rTamper.bytes
    }, rTamper.frames === 300 &&
       rTamper.durationTicks === 100000000 &&
       rTamper.snapshotHash === r1.snapshotHash);

    try { vfs.close(); } catch (e) {}
    out.files = {
      synthetic: synthPath,
      segmented: segOut,
      seg1: seg1,
      seg2: seg2
    };
  } catch (e) {
    out.ok = false;
    out.error = String(e) + ' | ' + (e && e.stack ? e.stack : '');
    console.log('[PAGE] FATAL ' + out.error);
  }
  return out;
};
`;

// ---------------------------------------------------------------------------
// 4. Node 侧（主进程）用 mediabunny 解封装校验
// ---------------------------------------------------------------------------

function loadNodeMediabunny() {
  const p = path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.node.cjs');
  // eslint-disable-next-line import/no-dynamic-require
  return require(p);
}

async function inspectWithNode(file) {
  const mb = loadNodeMediabunny();
  const input = new mb.Input({ source: new mb.FilePathSource(file), formats: mb.ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const result = {
      file: path.relative(ROOT, file),
      bytes: fs.statSync(file).size,
      durationSeconds: Number((await input.computeDuration()).toFixed(4)),
      trackCount: (await input.getTracks()).length,
      video: null,
      audio: null,
    };
    if (video) {
      const stats = await video.computePacketStats();
      result.video = {
        codec: await video.getCodec(),
        width: await video.getCodedWidth(),
        height: await video.getCodedHeight(),
        frameRate: Number(stats.averagePacketRate.toFixed(4)),
        packetCount: stats.packetCount,
        averageBitrate: Math.round(stats.averageBitrate),
      };
    }
    if (audio) {
      result.audio = {
        codec: await audio.getCodec(),
        channels: await audio.getNumberOfChannels(),
        sampleRate: await audio.getSampleRate(),
      };
    }
    return result;
  } finally {
    try {
      input.dispose();
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  const win = { current: null };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    // 清掉上一轮产物，避免残留文件污染本轮判定
    for (const name of fs.readdirSync(OUT)) {
      if (/^(synthetic-|segmented-|source-seg-|cancel-|disk-full|empty|gain-|tamper)/.test(name)) {
        fs.rmSync(path.join(OUT, name), { force: true });
      }
    }

    const bundle = await bundleExporter();
    record('bundle-exporter', { file: path.relative(ROOT, bundle.file), bytes: bundle.bytes });

    const html = [
      '<!doctype html><html><head><meta charset="utf-8"><title>verify-exporter</title></head><body>',
      '<script src="./exporter-bundle.js"></script>',
      '<script>' + PAGE_SCRIPT + '</script>',
      '</body></html>',
    ].join('\n');
    const htmlPath = path.join(OUT, 'verify-exporter.html');
    fs.writeFileSync(htmlPath, html, 'utf8');

    const WIDTH = 1920;
    const HEIGHT = 1080;
    const FPS = 30;
    const SECONDS = 10;

    win.current = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        backgroundThrottling: false,
        nodeIntegration: true,
        contextIsolation: false,
        offscreen: false,
      },
    });
    win.current.webContents.on('console-message', (event) => {
      const text = typeof event === 'object' && event.message !== undefined ? event.message : String(event);
      if (text && (text.startsWith('[PAGE]') || text.includes('Error') || text.includes('error'))) {
        console.log(text);
      }
    });
    await win.current.loadFile(htmlPath);

    const cfg = {
      project: makeSyntheticProject(SECONDS),
      profile: makeProfile(WIDTH, HEIGHT, FPS),
      outDir: OUT,
    };

    console.log('[VERIFY] rendering ' + SECONDS + 's @ ' + WIDTH + 'x' + HEIGHT + ' ' + FPS + 'fps ...');
    const page = await win.current.webContents.executeJavaScript(
      'window.runVerify(' + JSON.stringify(cfg) + ')',
    );
    results.page = page;
    if (page && page.steps) {
      for (const step of page.steps) record('page/' + step.name, step.value, step.ok);
    }
    if (page && page.error) record('page/fatal', page.error, false);

    // Node 侧解封装（独立于渲染进程的读回）
    for (const key of ['synthetic', 'segmented', 'seg1', 'seg2']) {
      const file = page && page.files ? page.files[key] : null;
      if (!file || !fs.existsSync(file)) {
        record('node-inspect/' + key, { missing: true }, false);
        continue;
      }
      const info = await inspectWithNode(file);
      if (key === 'synthetic' || key === 'segmented') {
        const okDuration = Math.abs(info.durationSeconds - SECONDS) <= 0.1;
        const okFps = info.video && Math.abs(info.video.frameRate - FPS) <= 0.5;
        const okFrames = info.video && info.video.packetCount === FPS * SECONDS;
        const okAudio = !!info.audio;
        const okSize = info.video && info.video.width === WIDTH && info.video.height === HEIGHT;
        record('node-inspect/' + key, info, okDuration && okFps && okFrames && okAudio && okSize);
      } else {
        record('node-inspect/' + key, info, !!info.video && !!info.audio);
      }
    }

    // 残留检查
    const leftovers = fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith('.partial') || f.startsWith('cancel-') || f.startsWith('disk-full') || f === 'empty.mp4');
    record('no-leftover-artifacts', { leftovers }, leftovers.length === 0);
  } catch (error) {
    record('fatal', String(error) + ' | ' + (error && error.stack ? error.stack : ''), false);
  } finally {
    try {
      if (win.current && !win.current.isDestroyed()) win.current.destroy();
    } catch {
      /* 忽略 */
    }
    fs.writeFileSync(
      path.join(OUT, 'verify-exporter-result.json'),
      JSON.stringify(results, null, 2),
      'utf8',
    );
    console.log('[VERIFY] === SUMMARY ===');
    console.log('[VERIFY] overall=' + (results.ok ? 'PASS' : 'FAIL'));
    for (const step of results.steps) {
      console.log('[VERIFY] ' + (step.ok ? 'PASS' : 'FAIL') + ' ' + step.name);
    }
    setTimeout(() => app.exit(results.ok ? 0 : 1), 200);
  }
});
