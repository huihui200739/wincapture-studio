/**
 * 分段栅格（纯逻辑，便于单测）。
 *
 * 背景（captureEngine.ts 的历史注释）：
 *  - 用「相对上一段累加」会让边界逐段被推后最多一帧，实测 11 段合计 17.68s 而真实时长 20.05s。
 *  - 因此边界改为「原点 + n×目标时长」的绝对栅格，段时长严格等于栅格步长。
 *
 * 但旧实现只保存「下一边界」，切段起点是 `boundary - target`。这只在
 * 「上一段刚好占满一格」时成立；一旦中途 flush 了一个不足一格的段（暂停就是这种情况），
 * 下一段起点会被算回上一格的起点，导致同一段媒体时间被编码两次（段与段重叠 1 秒左右）。
 *
 * 这里把「下一段起点」显式建模：切段/补尾都返回并推进 startTick，
 * 保证任意时刻相邻段 [start, end) 首尾相接、互不重叠。
 */

export interface SegmentSlice {
  /** 该段在会话媒体时间轴上的起点（含） */
  startTick: number;
  /** 该段声明的时长 */
  durationTicks: number;
}

export class SegmentGrid {
  /** 下一段起点；null 表示还没有任何可用帧 */
  private start: number | null = null;
  /** 下一段结束边界（= start + target） */
  private boundary = 0;

  constructor(private readonly targetTicks: number) {
    if (!Number.isFinite(targetTicks) || targetTicks <= 0) {
      throw new Error(`分段目标时长非法：${targetTicks}`);
    }
  }

  reset(): void {
    this.start = null;
    this.boundary = 0;
  }

  get initialized(): boolean {
    return this.start !== null;
  }

  get nextStartTick(): number | null {
    return this.start;
  }

  get nextBoundaryTick(): number {
    return this.boundary;
  }

  /**
   * 观察一个已接受帧的媒体时间。若它越过当前段边界，返回要切出的段。
   * 第一次调用只建立栅格原点，不切段。
   */
  observe(mediaTick: number): SegmentSlice | null {
    if (this.start === null) {
      // 栅格原点取首个有效帧的媒体时间，保证第 0 段包含首帧。
      this.start = mediaTick;
      this.boundary = mediaTick + this.targetTicks;
      return null;
    }
    if (mediaTick < this.boundary) return null;

    const slice: SegmentSlice = { startTick: this.start, durationTicks: this.targetTicks };
    this.start = this.boundary;
    this.boundary = this.start + this.targetTicks;
    // 长时间无帧（采集端卡顿/系统休眠）时可能有多个栅格区间没有任何帧被采集：
    // 这些区间直接跳过，不能把它们的内容塞进下一段（否则段内帧时间会压缩）。
    while (this.boundary <= mediaTick) {
      this.start = this.boundary;
      this.boundary = this.start + this.targetTicks;
    }
    return slice;
  }

  /**
   * 把缓冲区里剩余的帧收尾成一个短段（暂停/停止时调用）。
   *
   * @param endTick 可选的「已知真实结束时刻」，用于把最后一段覆盖到暂停/停止边界：
   *   末帧之后通常还有最多一个帧间隔的音频样本属于本段，不延长会把它们丢掉。
   *
   * 之后从「该段真实结束时刻」重新开始栅格：暂停恢复后媒体时间虽然冻结，
   * 但旧实现若继续沿用暂停前的边界，就会把 flush 出去的 [0,1.03s) 再编码一次。
   */
  flush(lastFrameMediaTick: number, frameIntervalTick: number, endTick?: number): SegmentSlice {
    const start = this.start ?? lastFrameMediaTick;
    const end = Math.max(
      start + 1,
      lastFrameMediaTick + Math.max(1, frameIntervalTick),
      Number.isFinite(endTick) ? (endTick as number) : 0,
    );
    const slice: SegmentSlice = { startTick: start, durationTicks: end - start };
    this.start = end;
    this.boundary = end + this.targetTicks;
    return slice;
  }
}
