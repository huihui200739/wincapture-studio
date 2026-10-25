/**
 * 录制完成卡片（右下角小窗，window.wcs.role === 'review' 时渲染）。
 *
 * 停止录制后主进程弹出本卡片（electron/main.ts createReviewWindow），
 * 不再把编辑器直接甩给用户：先给缩略图、时长与分辨率，由用户决定下一步。
 *   - 进入编辑：windowOpenEditor → 主进程布局编辑器窗口并通知主窗口打开工程；
 *   - 打开文件夹：定位工程目录（工程在录制过程中已原子落盘，无需再「保存」）；
 *   - ×：关闭卡片并回到启动胶囊。
 *
 * 数据全部来自窗口 URL hash（#review?p=&n=&d=&w=&h=&t=），本窗口不需要任何 IPC
 * 初始化；缩略图用 readMedia 返回的 wcs-media:// 流式 URL，由 <video> 直接解码。
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/ui';

interface ReviewInfo {
  projectPath: string;
  name: string;
  seconds: number;
  width: number;
  height: number;
  thumb: string | null;
}

function parseReviewHash(): ReviewInfo {
  const raw = typeof window !== 'undefined' ? window.location.hash : '';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  return {
    projectPath: params.get('p') ?? '',
    name: params.get('n') || '本次录制',
    seconds: Number(params.get('d') ?? 0) || 0,
    width: Number(params.get('w') ?? 0) || 0,
    height: Number(params.get('h') ?? 0) || 0,
    thumb: params.get('t') || null,
  };
}

function formatCardClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function ReviewCard() {
  const info = useMemo(parseReviewHash, []);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    if (!info.thumb) {
      setThumbFailed(true);
      return;
    }
    let cancelled = false;
    void window.wcs
      .readMedia(info.projectPath, info.thumb)
      .then((response) => {
        if (cancelled) return;
        if (response.ok && response.data?.url) setThumbUrl(response.data.url);
        else setThumbFailed(true);
      })
      .catch(() => {
        if (!cancelled) setThumbFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [info.projectPath, info.thumb]);

  const meta = [
    formatCardClock(info.seconds),
    info.width > 0 && info.height > 0 ? `${info.width} × ${info.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="review-root">
      <div className="review-card" role="dialog" aria-label="录制完成">
        <button type="button" className="review-close" aria-label="关闭卡片" title="关闭（回到启动胶囊）" onClick={() => void window.wcs.closeReviewCard()}>
          ×
        </button>
        <div className="review-thumb">
          {thumbUrl && !thumbFailed ? (
            // 静音 + 定位到 0.1s：让 <video> 呈现首帧作为缩略图，不自动播放
            <video
              src={thumbUrl}
              muted
              playsInline
              preload="metadata"
              onLoadedData={(event) => {
                try {
                  event.currentTarget.currentTime = 0.1;
                } catch {
                  // 个别编码首帧定位失败：保留当前帧
                }
              }}
            />
          ) : (
            <div className="review-placeholder">
              <Icon name="screen" size={34} />
            </div>
          )}
          {meta && <span className="review-badge">{meta}</span>}
        </div>
        <div className="review-title">
          <span className="review-dot" aria-hidden="true">
            <Icon name="check" size={9} />
          </span>
          <span title={info.name}>{info.name}</span>
        </div>
        <div className="review-actions">
          <button type="button" aria-label="打开文件夹" title="在资源管理器中显示工程" onClick={() => void window.wcs.showInFolder(info.projectPath)}>
            打开文件夹
          </button>
          <button type="button" className="review-edit" aria-label="进入编辑" title="打开剪辑台" onClick={() => void window.wcs.openEditor(info.projectPath)}>
            进入编辑 →
          </button>
        </div>
      </div>
    </div>
  );
}
