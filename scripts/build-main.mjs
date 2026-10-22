import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 应用图标随包复制到 dist/assets/：主进程在打包环境下从 dist/assets/app-icon.ico
// 解析窗口/任务栏图标（见 electron/main.ts 的 appIconPath）。
// 只复制运行时真正用到的档位：ICO 给窗口，32/64/128 给可能的托盘与高 DPI 场景。
// 1.6MB 的 app-icon.png 是设计源图，界面品牌图走 public/app-icon.png，不重复打包。
const iconDist = path.join(root, 'dist', 'assets');
fs.mkdirSync(iconDist, { recursive: true });
for (const name of ['app-icon.ico', 'app-icon-32.png', 'app-icon-64.png', 'app-icon-128.png']) {
  const src = path.join(root, 'assets', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(iconDist, name));
}

// 主进程与 preload 使用 CommonJS 打包，避免 Electron ESM 加载差异。
// mediabunny 保留为外部依赖（主进程侧用动态 import 加载它的 ESM 入口）。
await build({
  entryPoints: {
    main: path.join(root, 'electron/main.ts'),
    preload: path.join(root, 'electron/preload.ts'),
  },
  outdir: path.join(root, 'dist/main'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'mediabunny'],
  sourcemap: true,
  logLevel: 'info',
});
