import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 渲染进程（界面层）构建配置。领域层与协议层是纯 TS，被主进程与渲染进程共用。
export default defineConfig({
  root: path.resolve(__dirname, '.'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
  },
  server: { port: 5273, strictPort: true },
});
