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
    // 单文件产物约 1.2MB（主要是 mediabunny + React），拆成可独立缓存的 vendor
    // chunk：改界面代码时用户不必重下整包，构建期也不再刷 >500kB 警告。
    // mediabunny 单独 722KB 是体积下限（WebCodecs 封装/解封装全在这里），
    // 因此阈值设为 800kB：只对新增的失控大 chunk 报警。
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;
          if (normalized.includes('/mediabunny/')) return 'vendor-mediabunny';
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(normalized)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  server: { port: 5273, strictPort: true },
});
