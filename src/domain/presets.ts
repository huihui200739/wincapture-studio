import type { CanvasStyle } from './project';

export interface CanvasPreset {
  id: string;
  name: string;
  description: string;
  style: Pick<CanvasStyle, 'background' | 'padding' | 'cornerRadius' | 'shadowBlur' | 'shadowOpacity'>;
}

/** Only decoration changes; camera placement and privacy effects stay independent. */
export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { id: 'studio', name: '工作室', description: '深灰背景 · 柔和阴影',
    style: { background: 'linear-gradient(150deg, #24303f, #101418)', padding: 0.06, cornerRadius: 18, shadowBlur: 36, shadowOpacity: 0.4 } },
  { id: 'light', name: '简洁白', description: '浅色背景 · 清晰留白',
    style: { background: '#edf1f7', padding: 0.055, cornerRadius: 12, shadowBlur: 28, shadowOpacity: 0.2 } },
  { id: 'sunset', name: '落日', description: '暖色渐变 · 展示分享',
    style: { background: 'linear-gradient(135deg, #f4b078, #ae527c, #483b78)', padding: 0.08, cornerRadius: 22, shadowBlur: 42, shadowOpacity: 0.38 } },
  { id: 'ocean', name: '海蓝', description: '蓝色渐变 · 产品演示',
    style: { background: 'linear-gradient(145deg, #467ed5, #203967)', padding: 0.07, cornerRadius: 18, shadowBlur: 36, shadowOpacity: 0.35 } },
  { id: 'edge', name: '铺满', description: '无留白 · 无圆角',
    style: { background: '#000000', padding: 0, cornerRadius: 0, shadowBlur: 0, shadowOpacity: 0 } },
];
