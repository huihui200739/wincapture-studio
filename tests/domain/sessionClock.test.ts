import { describe, it, expect } from 'vitest';
import { SessionClock, RECOVERY_LOSS_TARGET_TICKS } from '../../src/domain/sessionClock';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

describe('SessionClock: 会话零点', () => {
  it('未设置零点前媒体时间为 0', () => {
    const clock = new SessionClock();
    expect(clock.hasZero).toBe(false);
    expect(clock.mediaTickAt(1000)).toBe(0);
    expect(clock.durationTicks()).toBe(0);
  });

  it('首次有效屏幕帧确定零点，重复设置保持第一次（幂等）', () => {
    const clock = new SessionClock();
    const zero = clock.setZero(5 * S);
    expect(zero).toBe(5 * S);
    expect(clock.setZero(99 * S)).toBe(5 * S);
    expect(clock.zero).toBe(5 * S);
  });

  it('媒体时间 = QPC − 零点（无暂停）', () => {
    const clock = new SessionClock();
    clock.setZero(S);
    expect(clock.mediaTickAt(S)).toBe(0);
    expect(clock.mediaTickAt(S + 3 * S)).toBe(3 * S);
  });

  it('零点之前的 QPC 返回负媒体时间（供调用方裁掉较早样本）', () => {
    const clock = new SessionClock();
    clock.setZero(5 * S);
    expect(clock.mediaTickAt(3 * S)).toBe(-2 * S);
    expect(clock.mediaTickAt(5 * S)).toBe(0);
  });
});

describe('SessionClock: 暂停映射', () => {
  it('暂停期间媒体时间冻结', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    expect(clock.mediaTickAt(2 * S)).toBe(2 * S);
    clock.pause(2 * S);
    // 暂停中：累计暂停时间随 now 增长，媒体时间保持 2s
    expect(clock.mediaTickAt(3 * S)).toBe(2 * S);
    expect(clock.mediaTickAt(5 * S)).toBe(2 * S);
    clock.resume(5 * S);
    // 恢复后：媒体时间继续，暂停 3s 被扣除
    expect(clock.mediaTickAt(5 * S)).toBe(2 * S);
    expect(clock.mediaTickAt(6 * S)).toBe(3 * S);
    expect(clock.mediaTickAt(10 * S)).toBe(7 * S);
  });

  it('暂停映射公式：媒体时间 = QPC − 零点 − 累计暂停', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.pause(2 * S);
    clock.resume(4 * S); // 暂停 2s
    clock.pause(6 * S);
    clock.resume(6.5 * S); // 暂停 0.5s
    const at = 10 * S;
    const accumulated = 2 * S + 0.5 * S;
    expect(clock.pausedTicksAt(at)).toBe(accumulated);
    expect(clock.mediaTickAt(at)).toBe(at - accumulated);
  });

  it('重复暂停幂等（不产生新的暂停区间）', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    expect(clock.pause(S)).toBe(true);
    expect(clock.pause(2 * S)).toBe(false);
    expect(clock.pause(3 * S)).toBe(false);
    clock.resume(4 * S);
    expect(clock.pauseCount).toBe(1);
    expect(clock.accumulatedPauseTicks).toBe(3 * S);
  });

  it('未暂停时 resume 无副作用（幂等）', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    expect(clock.resume(S)).toBe(false);
    expect(clock.pauseCount).toBe(0);
    expect(clock.accumulatedPauseTicks).toBe(0);
  });

  it('20 次暂停恢复无累计偏移（§18.3 T02）', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    let qpc = 0;
    let expectedMedia = 0;
    for (let i = 0; i < 20; i++) {
      qpc += S; // 录 1s
      expectedMedia += S;
      expect(clock.mediaTickAt(qpc)).toBe(expectedMedia);
      clock.pause(qpc);
      qpc += secondsToTicks(0.37); // 暂停 370ms
      clock.resume(qpc);
      expect(clock.mediaTickAt(qpc)).toBe(expectedMedia); // 暂停不推进
    }
    expect(clock.pauseCount).toBe(20);
    expect(clock.accumulatedPauseTicks).toBe(secondsToTicks(0.37) * 20);
  });

  it('暂停区间表按 QPC 记录且有序', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.pause(S);
    clock.resume(2 * S);
    clock.pause(3 * S);
    clock.resume(5 * S);
    expect(clock.pauseTable()).toEqual([
      { start: S, end: 2 * S },
      { start: 3 * S, end: 5 * S },
    ]);
  });

  it('isDuringPause 判定', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.pause(S);
    clock.resume(3 * S);
    expect(clock.isDuringPause(0)).toBe(false);
    expect(clock.isDuringPause(S)).toBe(true); // 左闭
    expect(clock.isDuringPause(2 * S)).toBe(true);
    expect(clock.isDuringPause(3 * S)).toBe(false); // 右开
  });

  it('暂停中 stop 会先闭合暂停区间', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.pause(2 * S);
    const stopped = clock.stop(5 * S);
    expect(stopped).toBe(5 * S);
    expect(clock.pauseCount).toBe(1);
    expect(clock.durationTicks()).toBe(2 * S); // 5s − 3s 暂停
  });
});

describe('SessionClock: 重复停止幂等（§9.1）', () => {
  it('重复 Stop 返回同一结果', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    const first = clock.stop(10 * S);
    const second = clock.stop(20 * S);
    const third = clock.stop(30 * S);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(clock.stopQpc).toBe(first);
  });

  it('停止后时长不再变化', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.stop(8 * S);
    expect(clock.durationTicks()).toBe(8 * S);
    expect(clock.durationTicks(100 * S)).toBe(8 * S);
  });

  it('停止后 pause/resume 被拒绝', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.stop(5 * S);
    expect(clock.pause(6 * S)).toBe(false);
    expect(clock.resume(7 * S)).toBe(false);
    expect(clock.stopped).toBe(true);
  });
});

describe('SessionClock: 轨道时钟映射', () => {
  it('轨道偏移映射到会话媒体时间', () => {
    const clock = new SessionClock();
    clock.setZero(10 * S);
    // 音频设备时钟比 QPC 慢 1s
    clock.setTrackOffset('mic', S);
    expect(clock.trackMediaTickAt('mic', 10 * S)).toBe(S);
    expect(clock.trackMediaTickAt('mic', 15 * S)).toBe(6 * S);
  });

  it('早于会话零点的轨道样本返回 null（裁掉）', () => {
    const clock = new SessionClock();
    clock.setZero(10 * S);
    expect(clock.trackMediaTickAt('mic', 5 * S)).toBeNull();
  });

  it('晚起轨道补空白并记录原因', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.setTrackOffset('camera', 0, 2 * S); // 摄像头晚起 2s
    const placement = clock.placeSample('camera', 3 * S, 0);
    expect(placement.mediaTick).toBe(5 * S);
    expect(placement.padTicks).toBe(5 * S);
    expect(placement.padReason).toBe('late-start');
  });

  it('准时样本不补空白', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.setTrackOffset('mic', 0);
    const placement = clock.placeSample('mic', 2 * S, 2 * S);
    expect(placement.padTicks).toBe(0);
    expect(placement.padReason).toBeNull();
  });

  it('暂停期间的样本标记 duringPause', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.pause(2 * S);
    clock.resume(4 * S);
    const placement = clock.placeSample('mic', 3 * S);
    expect(placement.duringPause).toBe(true);
  });

  it('未注册偏移的轨道按 0 偏移处理', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    expect(clock.trackOffset('unknown')).toBeUndefined();
    expect(clock.trackMediaTickAt('unknown', 3 * S)).toBe(3 * S);
  });
});

describe('SessionClock: reset 与常量', () => {
  it('reset 清空全部状态', () => {
    const clock = new SessionClock();
    clock.setZero(S);
    clock.pause(2 * S);
    clock.setTrackOffset('mic', S);
    clock.reset();
    expect(clock.hasZero).toBe(false);
    expect(clock.paused).toBe(false);
    expect(clock.stopped).toBe(false);
    expect(clock.pauseCount).toBe(0);
    expect(clock.trackOffset('mic')).toBeUndefined();
  });

  it('恢复损失目标为 4 秒', () => {
    expect(RECOVERY_LOSS_TARGET_TICKS).toBe(4 * S);
  });
});

// ---------------------------------------------------------------------------
// 回归：非法时刻不得污染会话状态；倒序 resume 不得丢失暂停
// ---------------------------------------------------------------------------

describe('回归：非法 QPC 时刻与倒序恢复', () => {
  it('setZero(NaN/Infinity) 不写入零点，之后的有效零点仍可用', () => {
    const clock = new SessionClock();
    expect(clock.setZero(NaN)).toBe(0);
    expect(clock.hasZero).toBe(false);
    expect(clock.setZero(Infinity)).toBe(0);
    expect(clock.hasZero).toBe(false);
    expect(clock.setZero(5 * S)).toBe(5 * S);
    expect(clock.mediaTickAt(6 * S)).toBe(S);
    expect(clock.durationTicks(6 * S)).toBe(S);
  });

  it('pause(NaN) 不进入暂停，查询接口不返回 NaN', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    expect(clock.pause(NaN)).toBe(false);
    expect(clock.paused).toBe(false);
    expect(clock.mediaTickAt(NaN)).toBe(0);
    expect(clock.isDuringPause(NaN)).toBe(false);
    expect(clock.pausedTicksAt(NaN)).toBe(0);
    expect(clock.durationTicks(NaN)).toBe(0);
    expect(clock.mediaTickAt(3 * S)).toBe(3 * S);
  });

  it('stop(NaN) 不改变状态', () => {
    const clock = new SessionClock();
    clock.setZero(S);
    clock.stop(NaN);
    expect(clock.stopped).toBe(false);
    expect(clock.durationTicks(3 * S)).toBe(2 * S);
  });

  it('倒序 resume 被忽略，暂停区间不会静默丢失', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.pause(5 * S);
    expect(clock.resume(3 * S)).toBe(false); // QPC 回跳
    expect(clock.paused).toBe(true);
    expect(clock.resume(6 * S)).toBe(true);
    expect(clock.pauseTable()).toEqual([{ start: 5 * S, end: 6 * S }]);
    expect(clock.mediaTickAt(7 * S)).toBe(6 * S); // 7s − 1s 暂停
  });

  it('setTrackOffset 忽略非有限参数', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    clock.setTrackOffset('mic', NaN);
    expect(clock.trackOffset('mic')).toBeUndefined();
    clock.setTrackOffset('mic', 0, Infinity);
    expect(clock.trackOffset('mic')).toBeUndefined();
    clock.setTrackOffset('mic', S);
    expect(clock.trackMediaTickAt('mic', 2 * S)).toBe(3 * S);
  });

  it('placeSample / trackMediaTickAt 对非法时刻返回 null', () => {
    const clock = new SessionClock();
    clock.setZero(0);
    expect(clock.placeSample('mic', NaN)).toEqual({ mediaTick: null, padTicks: 0, padReason: null, duringPause: false });
    expect(clock.trackMediaTickAt('mic', Infinity)).toBeNull();
  });
});
