/**
 * 合成示例素材（mock 模式使用）
 *
 * wp-a-capture 的 window.wcs 尚未就绪时，界面需要独立跑起来看效果。
 * 这里用 canvas 画一帧“像桌面应用”的假源画面，交给 compositor 的 drawScene 合成，
 * 保证预览路径与真实导出完全一致（同一 drawScene）。
 */

const SCREEN_W = 1600;
const SCREEN_H = 900;
const CAM_W = 640;
const CAM_H = 480;

let screenCanvas: HTMLCanvasElement | null = null;
let cameraCanvas: HTMLCanvasElement | null = null;

function ensureCanvas(width: number, height: number, existing: HTMLCanvasElement | null): HTMLCanvasElement {
  if (existing) return existing;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawFakeDesktop(ctx: CanvasRenderingContext2D, seconds: number): void {
  const W = SCREEN_W;
  const H = SCREEN_H;

  // 桌面底色（带轻微渐晕）
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#dfe7f2');
  bg.addColorStop(1, '#c7d4e6');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 主应用窗口
  const winX = 150;
  const winY = 84;
  const winW = 1300;
  const winH = 760;
  ctx.save();
  ctx.shadowColor = 'rgba(22,32,48,0.28)';
  ctx.shadowBlur = 42;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, winX, winY, winW, winH, 14);
  ctx.fill();
  ctx.restore();

  // 标题栏
  ctx.save();
  roundRect(ctx, winX, winY, winW, 46, 14);
  ctx.clip();
  ctx.fillStyle = '#f2f5fa';
  ctx.fillRect(winX, winY, winW, 46);
  ctx.restore();
  ctx.strokeStyle = '#e3e9f2';
  ctx.beginPath();
  ctx.moveTo(winX, winY + 46);
  ctx.lineTo(winX + winW, winY + 46);
  ctx.stroke();

  // 应用图标 + 标题
  ctx.fillStyle = '#2f6df6';
  roundRect(ctx, winX + 18, winY + 14, 18, 18, 5);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('C', winX + 22, winY + 27);
  ctx.fillStyle = '#1f2733';
  ctx.font = '600 14px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('Contoso 客户管理 — 新建客户', winX + 46, winY + 29);

  // 窗口按钮
  ctx.fillStyle = '#8b97a7';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(winX + winW - 30 - i * 24, winY + 23, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 左侧导航
  ctx.fillStyle = '#f7f9fc';
  ctx.fillRect(winX, winY + 46, 220, winH - 46);
  ctx.strokeStyle = '#e6ecf4';
  ctx.beginPath();
  ctx.moveTo(winX + 220, winY + 46);
  ctx.lineTo(winX + 220, winY + winH);
  ctx.stroke();

  const nav = ['概览', '客户', '新建客户', '订单', '报表', '设置'];
  nav.forEach((label, i) => {
    const y = winY + 74 + i * 44;
    const active = i === 2;
    if (active) {
      ctx.fillStyle = '#e8efff';
      roundRect(ctx, winX + 12, y - 10, 196, 34, 8);
      ctx.fill();
    }
    ctx.fillStyle = active ? '#2f6df6' : '#5b6879';
    ctx.beginPath();
    ctx.arc(winX + 32, y + 6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = active ? '#1c4fd0' : '#44505f';
    ctx.font = `${active ? 600 : 400} 14px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(label, winX + 50, y + 11);
  });

  // 主体：标题 + 表单
  const cx = winX + 260;
  let cy = winY + 96;
  ctx.fillStyle = '#101828';
  ctx.font = '600 24px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('新建客户档案', cx, cy);

  ctx.fillStyle = '#6b7788';
  ctx.font = '400 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('带 * 的字段为必填项，保存后可在客户列表中检索。', cx, cy + 24);

  cy += 60;
  const fields: { label: string; value: string; sensitive?: boolean }[] = [
    { label: '客户名称 *', value: '星海科技有限公司' },
    { label: '联系人 *', value: '王晓明' },
    { label: '邮箱', value: 'wang.xiaoming@xinghai-tech.cn', sensitive: true },
    { label: '手机号', value: '138 0013 8000', sensitive: true },
  ];

  fields.forEach((field, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const fx = cx + col * 420;
    const fy = cy + row * 92;

    ctx.fillStyle = '#3b4657';
    ctx.font = '600 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(field.label, fx, fy);

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#d5dde8';
    ctx.lineWidth = 1;
    roundRect(ctx, fx, fy + 10, 380, 42, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#1b2432';
    ctx.font = '400 14px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(field.value, fx + 14, fy + 37);

    // 邮箱/手机号附近加一个“已复核”的提示点，方便演示遮挡效果
    if (field.sensitive) {
      ctx.fillStyle = '#c9d6ea';
      ctx.beginPath();
      ctx.arc(fx + 400, fy + 31, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 分段控件
  const segY = cy + 200;
  ctx.fillStyle = '#3b4657';
  ctx.font = '600 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('客户等级', cx, segY);
  const levels = ['普通', '重要', '战略'];
  levels.forEach((label, i) => {
    const bx = cx + i * 110;
    const active = i === 1;
    ctx.fillStyle = active ? '#2f6df6' : '#f2f5fa';
    ctx.strokeStyle = active ? '#2f6df6' : '#d5dde8';
    roundRect(ctx, bx, segY + 12, 100, 36, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? '#ffffff' : '#44505f';
    ctx.font = '500 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(label, bx + 34, segY + 36);
  });

  // 复选框
  ctx.strokeStyle = '#2f6df6';
  ctx.fillStyle = '#2f6df6';
  roundRect(ctx, cx + 360, segY + 18, 18, 18, 4);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + 364, segY + 27);
  ctx.lineTo(cx + 368, segY + 31);
  ctx.lineTo(cx + 375, segY + 22);
  ctx.stroke();
  ctx.fillStyle = '#3b4657';
  ctx.font = '400 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('同步到通讯录', cx + 388, segY + 32);

  // 表格
  const tableY = segY + 92;
  ctx.fillStyle = '#f7f9fc';
  roundRect(ctx, cx, tableY, 900, 250, 10);
  ctx.fill();
  ctx.strokeStyle = '#e6ecf4';
  ctx.stroke();

  const headers = ['客户编号', '名称', '等级', '最近联系', '负责人'];
  const colX = [0, 130, 470, 560, 720];
  ctx.fillStyle = '#6b7788';
  ctx.font = '600 12px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  headers.forEach((h, i) => ctx.fillText(h, cx + 20 + colX[i], tableY + 30));

  const rows = [
    ['C-1042', '星海科技有限公司', '重要', '今天 09:24', '王晓明'],
    ['C-1039', '蓝湾设计工作室', '普通', '昨天 16:40', '李静'],
    ['C-1031', '远航物流集团', '战略', '10-18 11:02', '陈立'],
    ['C-1028', '晨光传媒', '普通', '10-17 15:18', '赵敏'],
  ];
  rows.forEach((row, r) => {
    const ry = tableY + 62 + r * 44;
    if (r % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(cx + 12, ry - 18, 876, 40);
    }
    ctx.fillStyle = '#26303d';
    ctx.font = '400 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
    row.forEach((cell, c) => ctx.fillText(cell, cx + 20 + colX[c], ry + 6));
  });

  // 底部按钮
  const btnY = winY + winH - 66;
  ctx.fillStyle = '#2f6df6';
  roundRect(ctx, winX + winW - 300, btnY, 120, 40, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 14px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('保存并关闭', winX + winW - 282, btnY + 25);

  ctx.fillStyle = '#f2f5fa';
  ctx.strokeStyle = '#d5dde8';
  roundRect(ctx, winX + winW - 168, btnY, 100, 40, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#44505f';
  ctx.font = '500 14px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText('取消', winX + winW - 138, btnY + 25);

  // 随时间变化的“正在操作”高亮，让预览看起来在动
  const phase = Math.floor(seconds * 0.9) % 4;
  const pulse = 0.5 + 0.5 * Math.sin(seconds * 3.2);
  const targets = [
    { x: cx - 6, y: cy + 4, w: 392, h: 56 },
    { x: cx + 414, y: cy + 4, w: 392, h: 56 },
    { x: cx - 6, y: cy + 96, w: 392, h: 56 },
    { x: cx + 414, y: cy + 96, w: 392, h: 56 },
  ];
  const t = targets[phase];
  ctx.save();
  ctx.strokeStyle = `rgba(47,109,246,${0.28 + pulse * 0.4})`;
  ctx.lineWidth = 2;
  roundRect(ctx, t.x, t.y, t.w, t.h, 10);
  ctx.stroke();
  ctx.restore();

  // 右下角系统时间，给录屏一点真实感
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRect(ctx, W - 220, H - 54, 196, 36, 18);
  ctx.fill();
  ctx.fillStyle = '#37414f';
  ctx.font = '500 13px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
  ctx.fillText(`示例桌面 · ${seconds.toFixed(1)}s`, W - 200, H - 30);
}

function drawFakeCamera(ctx: CanvasRenderingContext2D, seconds: number): void {
  const W = CAM_W;
  const H = CAM_H;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1b2a3c');
  bg.addColorStop(1, '#2c4258');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 虚拟人像
  const cx = W / 2 + Math.sin(seconds * 0.7) * 12;
  const cy = H * 0.46;
  ctx.fillStyle = '#7f9ec0';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 96, 132, 96, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#e6c7a8';
  ctx.beginPath();
  ctx.arc(cx, cy - 10, 74, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#3c2f26';
  ctx.beginPath();
  ctx.arc(cx, cy - 34, 76, Math.PI * 1.04, Math.PI * 1.96);
  ctx.fill();

  ctx.fillStyle = '#2c241c';
  ctx.beginPath();
  ctx.arc(cx - 26, cy - 6, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 26, cy - 6, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#a8755a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy + 14, 22, 0.25 * Math.PI, 0.75 * Math.PI);
  ctx.stroke();

  // 头像边框光
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
}

/** 屏幕源画面（1600×900）。 */
export function syntheticScreen(seconds: number): HTMLCanvasElement {
  screenCanvas = ensureCanvas(SCREEN_W, SCREEN_H, screenCanvas);
  const ctx = screenCanvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    drawFakeDesktop(ctx, seconds);
  }
  return screenCanvas;
}

/** 摄像头源画面（640×480）。 */
export function syntheticCamera(seconds: number): HTMLCanvasElement {
  cameraCanvas = ensureCanvas(CAM_W, CAM_H, cameraCanvas);
  const ctx = cameraCanvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CAM_W, CAM_H);
    drawFakeCamera(ctx, seconds);
  }
  return cameraCanvas;
}

export const SYNTHETIC_SCREEN_SIZE = { width: SCREEN_W, height: SCREEN_H };
export const SYNTHETIC_CAMERA_SIZE = { width: CAM_W, height: CAM_H };

/** 生成来源选择器用的缩略图 dataURL。 */
export function syntheticThumbnail(kind: 'screen' | 'window' | 'camera', variant = 0): string {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  if (kind === 'camera') {
    ctx.drawImage(syntheticCamera(0), 0, 0, 320, 180);
    return canvas.toDataURL('image/png');
  }
  const screen = syntheticScreen(variant * 0.7);
  ctx.drawImage(screen, 0, 0, 320, 180);
  if (kind === 'window') {
    // 窗口缩略图：把桌面压暗，只突出窗口区域
    ctx.fillStyle = 'rgba(10,16,24,0.55)';
    ctx.fillRect(0, 0, 320, 180);
    ctx.drawImage(screen, 150, 84, 1300, 760, 18, 12, 284, 156);
  }
  return canvas.toDataURL('image/png');
}
