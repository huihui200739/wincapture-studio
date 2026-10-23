import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * 单元测试配置。
 *
 * 与 vite.config.ts 分开：构建配置只服务渲染进程产物，测试配置只服务 Node 侧
 * 领域/媒体纯逻辑，两者互不影响（vitest 优先读取本文件）。
 *
 * 现有测试覆盖 src/domain 与少量 src/renderer/lib 的纯函数；覆盖率阈值按当前
 * 实际水平设置（domain 语句 90.8% / 分支 85.5%），用于防止后续改动悄悄掉覆盖。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src/domain/**/*.ts', 'src/renderer/lib/waveform.ts'],
      exclude: ['src/domain/types.ts'],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
