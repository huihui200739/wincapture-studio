import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
