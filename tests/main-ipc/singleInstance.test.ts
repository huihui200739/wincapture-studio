import { afterEach, describe, expect, it, vi } from 'vitest';
import { SingleInstance } from '../../electron/singleInstance';
const instances: SingleInstance[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.close())); });
describe('录屏实例互斥', () => {
  it('重复启动唤醒已有实例，退出后允许重新打开', async () => {
    const activate = vi.fn(); const profile = `wcs-test-${process.pid}-${Date.now()}`;
    const first = new SingleInstance(profile, activate); instances.push(first);
    const second = new SingleInstance(profile, () => {}); instances.push(second);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false); expect(activate).toHaveBeenCalledOnce();
    await first.close(); expect(await second.acquire()).toBe(true);
  });
  it('独立测试数据目录不影响正式实例', async () => {
    const profile = `wcs-test-${process.pid}-${Date.now()}`;
    const first = new SingleInstance(profile, () => {}); const isolated = new SingleInstance(profile + '-isolated', () => {});
    instances.push(first, isolated);
    expect(await first.acquire()).toBe(true); expect(await isolated.acquire()).toBe(true);
  });
});
