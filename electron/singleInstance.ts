import { createHash } from 'node:crypto';
import { createConnection, createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Chromium 的锁失败时也不能启动第二个采集实例；本地管道负责互斥和唤醒。 */
export class SingleInstance {
  private server: Server | null = null;
  private readonly address: string;
  constructor(profile: string, private readonly activate: () => void) {
    const normalized = path.resolve(profile);
    const key = createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex').slice(0, 24);
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\wcs-${key}` : path.join(os.tmpdir(), `wcs-${key}.sock`);
  }
  async acquire(): Promise<boolean> {
    const server = createServer(socket => {
      socket.setTimeout(1000, () => socket.destroy());
      socket.once('data', data => {
        if (data.toString() === 'activate') this.activate();
        socket.end('ok');
      });
      socket.on('error', () => {});
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.address, () => { server.removeListener('error', reject); resolve(); });
      });
      this.server = server;
      return true;
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await new Promise<void>((resolve, reject) => {
        const client = createConnection(this.address);
        client.setTimeout(2000, () => client.destroy(new Error('已有实例未响应，请关闭旧录屏进程后重试')));
        client.once('connect', () => client.write('activate'));
        client.once('data', () => { client.end(); resolve(); });
        client.once('error', reject);
      });
      return false;
    }
  }
  async close(): Promise<void> {
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
