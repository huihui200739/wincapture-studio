/**
 * 领域层公共类型（避免循环依赖的轻量定义）
 */

import type { TickRange, Ticks } from './timebase';

export type PointerEventKind = 'move' | 'down' | 'up' | 'shape';

export interface PointerEventLike {
  /** 会话媒体时间 */
  tick: Ticks;
  kind: PointerEventKind;
  button?: number;
  /** 归一化到源画面 [0,1] */
  x: number;
  y: number;
  /** 源画面像素坐标（原始物理像素），用于调试与像素级对齐 */
  px?: number;
  py?: number;
  /** 几何版本：窗口/DPI 拓扑变化时递增（§7.3） */
  geometryVersion?: number;
  /** 可选控件边界（归一化），P1 语义焦点 */
  controlRect?: { x: number; y: number; width: number; height: number };
  controlName?: string;
  /** 采集状态：ok 表示完整；degraded 表示仅坐标 */
  captureState?: 'ok' | 'degraded';
  confidence?: number;
}

export interface RecordingMarker {
  id: string;
  mediaTick: Ticks;
  note: string;
  createdAt: number;
}

export interface PointerLog {
  version: number;
  /** 录制时的源画面尺寸与桌面拓扑 */
  sourceWidth: number;
  sourceHeight: number;
  displayScale: number;
  geometryVersion: number;
  events: PointerEventLike[];
  /** 点击可视标记，用于对齐验证（§16.2 指针点击对齐 ≤50ms） */
  clicks: { tick: Ticks; x: number; y: number }[];
}

export interface SegmentRecord {
  index: number;
  /** 工程相对路径 */
  path: string;
  kind: 'video' | 'audio';
  startTick: Ticks;
  durationTicks: Ticks;
  /** 提交状态：committed 才可被工程引用（§15.1） */
  state: 'writing' | 'committed' | 'corrupt';
  hash?: string;
  bytes?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  range?: TickRange;
}

export interface RecoveryJournalEntry {
  seq: number;
  at: number;
  type:
    | 'session-start'
    | 'segment-begin'
    | 'segment-commit'
    | 'segment-corrupt'
    | 'segment-dropped'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'complete'
    | 'heartbeat';
  sessionId: string;
  detail?: Record<string, unknown>;
}
