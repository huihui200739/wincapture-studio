import { describe, expect, it } from 'vitest';
import { contextMenuPosition } from '../../src/renderer/lib/contextMenu';

describe('Windows timeline context menu placement', () => {
  it('有空间时保留鼠标位置', () => {
    expect(contextMenuPosition(300, 200, 240, 250, 1366, 900)).toEqual({ left: 300, top: 200 });
  });
  it('靠近右下角时完整留在窗口里', () => {
    expect(contextMenuPosition(790, 590, 240, 250, 800, 600)).toEqual({ left: 552, top: 342 });
  });
  it('键盘定位与异常窗口尺寸也保留最小边距', () => {
    expect(contextMenuPosition(-1, -1, 240, 250, 800, 600)).toEqual({ left: 8, top: 8 });
    expect(contextMenuPosition(0, 0, 240, 250, 100, 100)).toEqual({ left: 8, top: 8 });
  });
});
