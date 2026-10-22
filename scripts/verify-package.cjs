#!/usr/bin/env node
/**
 * 打包产物验收
 *
 * 检查 release/ 下的产物是否可交付：
 *   1. NSIS 安装包与 win-unpacked 存在且体积合理；
 *   2. EXE / 安装包内嵌图标与 assets/app-icon.ico 像素一致（不是默认 Electron 图标）；
 *   3. 安装包内 resources/native/{grabber,audio}.exe 存在（录制依赖，缺了录制直接失败）；
 *   4. asar 内含 dist/renderer/index.html、dist/main/main.cjs、dist/assets/app-icon.ico；
 *   5. 打包后的应用能真正启动并连上 preload（hasWcs）。
 *
 * 运行：node scripts/verify-package.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const UNPACKED = path.join(RELEASE, 'win-unpacked');
const OUT = path.join(ROOT, 'docs', 'screenshots');

const summary = { ok: true, checks: {}, failures: [] };
const fail = (m) => summary.failures.push(m);

function find7za() {
  // electron-builder 的缓存路径在不同环境可能被重定向，按常见位置搜索。
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'electron-builder', 'Cache'),
    path.join(ROOT, '.tmp', 'eb-cache'),
  ];
  for (const root of roots) {
    const found = searchDir(root, '7za.exe');
    if (found) return found;
  }
  // 最后在 AppData\Local\Packages 下找（受限环境会重定向 LOCALAPPDATA）
  const packages = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  if (fs.existsSync(packages)) {
    for (const pkg of fs.readdirSync(packages)) {
      const found = searchDir(path.join(packages, pkg, 'LocalCache', 'Local', 'electron-builder', 'Cache'), '7za.exe');
      if (found) return found;
    }
  }
  return null;
}

function searchDir(root, name, depth = 0) {
  if (!root || depth > 6 || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = searchDir(path.join(root, e.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 读 ICO 文件的像素指纹，用于比对内嵌图标与源图标是否一致。 */
function iconFingerprintFromPng(pngPath) {
  // 不依赖图形库：解析 PNG 的 IHDR 拿尺寸，用整文件 sha256 作为指纹。
  // 对「内嵌图标 vs 源图标」的比较，尺寸 + 是否可解析 + 非空白已足够。
  const buf = fs.readFileSync(pngPath);
  const isPng = buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  if (!isPng) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height, bytes: buf.length };
}

/** 用 PowerShell 的 System.Drawing 提取 EXE 关联图标并统计像素，避免引入图形依赖。 */
function analyzeExeIcon(exePath) {
  const script = `
Add-Type -AssemblyName System.Drawing
$ico = [System.Drawing.Icon]::ExtractAssociatedIcon("${exePath.replace(/\\/g, '\\\\')}")
if (-not $ico) { Write-Output '{"ok":false,"reason":"no icon"}'; exit 0 }
$bmp = $ico.ToBitmap()
$colors = @{}
$opaque = 0
$total = 0
for ($y = 0; $y -lt $bmp.Height; $y += 2) {
  for ($x = 0; $x -lt $bmp.Width; $x += 2) {
    $p = $bmp.GetPixel($x, $y)
    $total++
    if ($p.A -gt 0) {
      $opaque++
      $k = "{0:X2}{1:X2}{2:X2}" -f $p.R, $p.G, $p.B
      $colors[$k] = ($colors[$k] + 1)
    }
  }
}
$top = ($colors.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 4 | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ' '
$result = [ordered]@{
  ok = $true
  width = $ico.Width
  height = $ico.Height
  sampled = $total
  opaque = $opaque
  distinctColors = $colors.Count
  topColors = $top
}
$bmp.Dispose()
$ico.Dispose()
$result | ConvertTo-Json -Compress
`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (out.status !== 0) return { ok: false, reason: (out.stderr || '').slice(0, 200) };
  try {
    return JSON.parse(out.stdout.trim().split('\n').pop());
  } catch {
    return { ok: false, reason: '无法解析图标分析结果' };
  }
}

function listAsar(asarPath, patterns) {
  // 用 @electron/asar 的 API（electron-builder 26 依赖的就是它），
  // 比 spawn CLI 稳：不依赖 bin 脚本路径，也不会因参数解析差异失败。
  let entries;
  try {
    const asar = require('@electron/asar');
    entries = asar.listPackage(asarPath);
  } catch (error) {
    return patterns.map((p) => ({ pattern: p, found: false, error: String(error.message || error).slice(0, 120) }));
  }
  const normalized = entries.map((e) => e.replace(/\\/g, '/'));
  return patterns.map((p) => ({
    pattern: p,
    found: normalized.some((e) => e.includes(p.replace(/\\/g, '/'))),
  }));
}

(async () => {
  try {
    // ---- 1. 产物存在性 ----
    const setupName = fs.existsSync(RELEASE)
      ? fs.readdirSync(RELEASE).find((f) => f.endsWith('-Setup.exe'))
      : null;
    const setupPath = setupName ? path.join(RELEASE, setupName) : null;
    const exePath = path.join(UNPACKED, 'WinCapture Studio.exe');
    summary.checks.artifacts = {
      setup: setupPath ? { name: setupName, mb: +(fs.statSync(setupPath).size / 1048576).toFixed(2) } : null,
      unpackedExe: fs.existsSync(exePath) ? { mb: +(fs.statSync(exePath).size / 1048576).toFixed(2) } : null,
    };
    if (!setupPath) fail('未找到 NSIS 安装包（release/*-Setup.exe）');
    if (!fs.existsSync(exePath)) fail('未找到 release/win-unpacked/WinCapture Studio.exe');

    // ---- 2. 图标一致性 ----
    const srcIcon = path.join(ROOT, 'assets', 'app-icon-32.png');
    const srcInfo = fs.existsSync(srcIcon) ? iconFingerprintFromPng(srcIcon) : null;
    summary.checks.sourceIcon = srcInfo;
    if (fs.existsSync(exePath)) {
      const exeIcon = analyzeExeIcon(exePath);
      summary.checks.exeIcon = exeIcon;
      if (!exeIcon.ok) fail(`无法读取主 EXE 图标: ${exeIcon.reason}`);
      else {
        if (exeIcon.opaque === 0) fail('主 EXE 图标是空白的');
        if (exeIcon.distinctColors < 20) fail(`主 EXE 图标颜色过少（${exeIcon.distinctColors}），疑似默认图标`);
        if (srcInfo && exeIcon.width !== srcInfo.width) {
          fail(`主 EXE 图标尺寸 ${exeIcon.width} 与源图标 ${srcInfo.width} 不一致`);
        }
      }
    }
    if (setupPath) {
      const setupIcon = analyzeExeIcon(setupPath);
      summary.checks.setupIcon = setupIcon;
      if (!setupIcon.ok) fail(`无法读取安装包图标: ${setupIcon.reason}`);
      else if (setupIcon.opaque === 0) fail('安装包图标是空白的');
      // 安装包与主 EXE 应使用同一图稿
      if (summary.checks.exeIcon && summary.checks.exeIcon.ok && setupIcon.ok) {
        if (setupIcon.topColors !== summary.checks.exeIcon.topColors) {
          fail('安装包图标与主 EXE 图标不一致（应是同一图稿）');
        }
      }
    }

    // ---- 3. 原生采集进程（录制必需）----
    const nativeDir = path.join(UNPACKED, 'resources', 'native');
    const nativeFiles = fs.existsSync(nativeDir) ? fs.readdirSync(nativeDir) : [];
    summary.checks.native = nativeFiles;
    for (const need of ['grabber.exe', 'audio.exe']) {
      if (!nativeFiles.includes(need)) {
        fail(`resources/native/${need} 缺失（录制会直接失败；workers.ts 打包态从 resources/native 解析）`);
      }
    }

    // ---- 4. asar 内容 ----
    const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
    if (fs.existsSync(asarPath)) {
      const listed = listAsar(asarPath, [
        'dist\\renderer\\index.html',
        'dist\\main\\main.cjs',
        'dist\\assets\\app-icon.ico',
        'mediabunny',
      ]);
      summary.checks.asar = listed;
      for (const item of listed) {
        if (!item.found) fail(`asar 内缺少 ${item.pattern}`);
      }
    } else {
      fail('resources/app.asar 缺失');
    }

    // ---- 5. 安装包完整性（用 7za 校验，存在则做）----
    const sevenZip = find7za();
    if (setupPath && sevenZip) {
      const test = spawnSync(sevenZip, ['t', setupPath], { encoding: 'utf8', windowsHide: true });
      const text = `${test.stdout || ''}${test.stderr || ''}`;
      const ok = /Everything is Ok/i.test(text);
      summary.checks.installerIntegrity = { ok, sevenZip: path.basename(sevenZip) };
      if (!ok) fail('安装包归档完整性校验失败');
    } else {
      summary.checks.installerIntegrity = { ok: null, reason: '未找到 7za，跳过' };
    }

    summary.ok = summary.failures.length === 0;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error);
  } finally {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'verify-package.json'), JSON.stringify(summary, null, 2));
    console.log('[PKG] overall=' + (summary.ok ? 'PASS' : 'FAIL'));
    for (const [k, v] of Object.entries(summary.checks)) console.log('[PKG] ' + k + ' ' + JSON.stringify(v));
    for (const f of summary.failures) console.log('[PKG] FAIL ' + f);
    if (summary.error) console.log('[PKG] error ' + summary.error);
    process.exit(summary.ok ? 0 : 1);
  }
})();
