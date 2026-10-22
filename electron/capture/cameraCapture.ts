/**
 * 摄像头采集协调器（R04）
 *
 * 职责：把「录制会话」和「渲染进程里的摄像头运行时」连起来。
 *
 * 设计要点：
 * - 摄像头跑在独立的隐藏窗口里（role=camera）。为什么不在 recorder 窗口里做：
 *   recorder 窗口在编码屏幕段时会长时间同步占用（解码 JPEG + 编码），
 *   摄像头需要按 30fps 稳定取帧，两者放一起会互相饿死。
 * - 摄像头失败绝不影响主录制（§9.5）：open 失败就标记为降级，录制照常进行。
 * - 分段与屏幕段对齐：同样的段序号、同样的段时长，导出时两轨时间映射一致。
 */

import type { BrowserWindow } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CameraSegmentResult } from '../../src/renderer/cameraRuntime';

export interface CameraCoordinatorDeps {
  /** 创建（或复用）role=camera 的隐藏窗口 */
  createCameraWindow: () => BrowserWindow;
  /** 等待窗口内运行时就绪 */
  waitForReady: (win: BrowserWindow) => Promise<void>;
  /** 日志 */
  log: (message: string) => void;
}

export interface CameraStatus {
  /** 是否成功打开摄像头 */
  active: boolean;
  deviceId: string | null;
  label: string | null;
  /** 失败原因（active=false 时给用户看的可执行文案） */
  reason: string | null;
  /** 已提交的摄像头段数 */
  segments: number;
}

export class CameraCoordinator {
  private win: BrowserWindow | null = null;
  private status: CameraStatus = {
    active: false,
    deviceId: null,
    label: null,
    reason: null,
    segments: 0,
  };
  private opened = false;

  constructor(private readonly deps: CameraCoordinatorDeps) {}

  getStatus(): CameraStatus {
    return { ...this.status };
  }

  /** 打开摄像头。失败时记录 reason 并返回 false，不抛异常。 */
  async open(deviceId?: string): Promise<boolean> {
    try {
      const win = this.deps.createCameraWindow();
      this.win = win;
      await this.deps.waitForReady(win);

      const result = (await win.webContents.executeJavaScript(
        `(async () => {
           try {
             if (!window.__wcsCamera) throw new Error('摄像头运行时未就绪');
             return await window.__wcsCamera.open(${JSON.stringify(deviceId ?? null)});
           } catch (e) {
             return { ok: false, error: String((e && e.stack) || e) };
           }
         })()`,
        true,
      )) as { ok: boolean; deviceId?: string; label?: string; error?: string };

      if (result.ok) {
        this.opened = true;
        this.status = {
          active: true,
          deviceId: result.deviceId ?? null,
          label: result.label ?? null,
          reason: null,
          segments: 0,
        };
        this.deps.log(`[camera] 已打开 ${result.label || result.deviceId || '默认设备'}`);
        return true;
      }

      this.opened = false;
      this.status = {
        active: false,
        deviceId: null,
        label: null,
        reason: result.error ?? '摄像头打开失败',
        segments: 0,
      };
      this.deps.log(`[camera] 打开失败：${result.error}`);
      return false;
    } catch (error) {
      this.opened = false;
      this.status = {
        active: false,
        deviceId: null,
        label: null,
        reason: String(error instanceof Error ? error.message : error),
        segments: 0,
      };
      this.deps.log(`[camera] 协调器异常：${String(error)}`);
      return false;
    }
  }

  /**
   * 采集并落盘一个摄像头分段。
   *
   * @param projectPath 工程根目录
   * @param index 段序号（与 screen 段一致）
   * @param durationTicks 段时长
   * @param fps 帧率
   * @returns 成功时返回文件信息；失败返回 null 并更新 reason
   */
  async commitSegment(
    projectPath: string,
    index: number,
    durationTicks: number,
    fps: number,
  ): Promise<{ path: string; bytes: number; frames: number } | null> {
    if (!this.opened || !this.win || this.win.isDestroyed()) return null;

    try {
      const request = {
        index,
        durationTicks,
        fps,
        // 摄像头固定 720p（R04）
        width: 1280,
        height: 720,
        sampleTimesMs: [] as number[],
      };

      const result = (await this.win.webContents.executeJavaScript(
        `(async () => {
           try {
             if (!window.__wcsCamera) throw new Error('摄像头运行时未就绪');
             return await window.__wcsCamera.encodeSegment(${JSON.stringify(request)});
           } catch (e) {
             return { ok: false, error: String((e && e.stack) || e) };
           }
         })()`,
        true,
      )) as CameraSegmentResult;

      if (!result.ok || !result.mp4) {
        // 单段失败不终止整场录制，只记录原因
        this.status.reason = result.error ?? '摄像头分段编码失败';
        this.deps.log(`[camera] 段 #${index} 失败：${result.error}`);
        return null;
      }

      const dir = path.join(projectPath, 'media', 'camera');
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, `seg-${String(index).padStart(6, '0')}.mp4`);
      const bytes = Buffer.from(result.mp4, 'base64');
      // 先写临时文件再改名，避免崩溃留下半个文件被当成已提交段（§15.1）
      const temp = `${target}.partial`;
      await fsp.writeFile(temp, bytes);
      await fsp.rename(temp, target);

      this.status.segments += 1;
      this.status.reason = null;
      this.deps.log(`[camera] 段 #${index} 完成 ${result.frames} 帧 / ${bytes.length} 字节`);
      return { path: target, bytes: bytes.length, frames: result.frames ?? 0 };
    } catch (error) {
      this.status.reason = String(error instanceof Error ? error.message : error);
      this.deps.log(`[camera] 段 #${index} 异常：${String(error)}`);
      return null;
    }
  }

  /** 关闭摄像头并销毁隐藏窗口。 */
  async close(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      try {
        await this.win.webContents.executeJavaScript(
          `(async () => { try { await window.__wcsCamera?.close(); return true; } catch (e) { return false; } })()`,
          true,
        );
      } catch {
        // 窗口可能已经没了，忽略
      }
      try {
        this.win.destroy();
      } catch {
        // 忽略
      }
    }
    this.win = null;
    this.opened = false;
    this.status = { ...this.status, active: false };
  }

  /** 取一帧快照（PNG base64），用于验证画面不是全黑。 */
  async snapshot(): Promise<{ ok: boolean; png?: string; error?: string }> {
    if (!this.win || this.win.isDestroyed()) return { ok: false, error: '摄像头窗口不存在' };
    try {
      return (await this.win.webContents.executeJavaScript(
        `(async () => {
           try { return await window.__wcsCamera.snapshot(); }
           catch (e) { return { ok: false, error: String(e) }; }
         })()`,
        true,
      )) as { ok: boolean; png?: string; error?: string };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}
