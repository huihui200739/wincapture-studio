import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraCandidates, cameraStreamWithTimeout } from '../../src/media/cameraDevices';

afterEach(() => vi.useRealTimers());
describe('摄像头实际设备选择与超时释放', () => {
  const devices = [{ deviceId: 'phone', label: 'Smart Connect' }, { deviceId: 'usb', label: 'USB Camera' }, { deviceId: 'built-in', label: 'Integrated Camera' }];
  it('默认优先内置摄像头，避免系统默认虚拟设备不可用', () => {
    expect(cameraCandidates(devices)).toEqual(['built-in', 'usb', 'phone']);
    expect(cameraCandidates(devices, 'unplugged')).toEqual(['built-in', 'usb', 'phone']);
  });
  it('明确选择可见设备时不悄悄改录其他摄像头', () => {
    expect(cameraCandidates(devices, 'usb')).toEqual(['usb']);
  });
  it('超时后迟到的摄像头流释放，避免后台占用', async () => {
    vi.useFakeTimers();
    let resolve!: (stream: MediaStream) => void;
    const request = new Promise<MediaStream>(r => { resolve = r; });
    const stop = vi.fn();
    const timed = cameraStreamWithTimeout(request, 100);
    const rejected = expect(timed).rejects.toThrow('摄像头响应超时');
    await vi.advanceTimersByTimeAsync(101); await rejected;
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve(); expect(stop).toHaveBeenCalledOnce();
  });
  it('正常打开后不会误停使用中的摄像头', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    expect(await cameraStreamWithTimeout(Promise.resolve(stream), 100)).toBe(stream);
    await vi.advanceTimersByTimeAsync(101); expect(stop).not.toHaveBeenCalled();
  });
});
