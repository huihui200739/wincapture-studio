/**
 * IPC 超时包装测试
 *
 * 对应缺陷：主进程无响应时渲染层永远停在「保存中…」、按钮一直禁用。
 * withTimeout 只影响本次等待，不撤销底层请求；调用方负责丢弃迟到结果。
 */

import { describe, expect, it } from 'vitest';
import { withTimeout } from '../../src/renderer/lib/wcs';

describe('withTimeout', () => {
  it('按时返回时透传结果', async () => {
    await expect(withTimeout(Promise.resolve(42), 200, '读取')).resolves.toBe(42);
  });

  it('超时后抛出可重试的中文错误', async () => {
    const never = new Promise<void>(() => {
      /* 永不 settle，模拟主进程卡死 */
    });
    await expect(withTimeout(never, 5, '保存工程')).rejects.toThrow(/保存工程.*超时/);
  });

  it('底层异常原样透传，不伪装成超时', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 200, '读取')).rejects.toThrow('boom');
  });

  it('ms<=0 时跳过包装，直接返回原 Promise', async () => {
    const promise = Promise.resolve('ok');
    await expect(withTimeout(promise, 0, '读取')).resolves.toBe('ok');
  });
});
