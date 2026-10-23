/**
 * 录制/导出/悬浮窗纯逻辑测试。
 *
 * 覆盖：
 * - 悬浮窗状态合并节流（≤10 次/秒、最后一次不丢、dispose 后不再 emit）
 * - 导出结果归类（成功 / 取消 / 视频失败 / 无产物 / 教程失败但视频成功）
 * - 输出路径归一化与校验（补 .mp4、目录误填、非法字符、默认路径）
 * - 录制备忘录 → 标记备注（光标行优先、回退最后一行）
 * - 来源分栏切换时选中项的收敛
 */

import { describe, expect, it } from 'vitest';
import {
  classifyExportBundle,
  createStatusCoalescer,
  deriveDefaultOutputPath,
  isSourceInKind,
  looksLikeDirectoryPath,
  memoMarkNote,
  normalizeOutputPath,
  pickSourceForKind,
  planFramePicks,
  planFrameSlots,
  sanitizeFileStem,
  validateOutputPath,
} from '../../src/renderer/uiSync';

// ---------------------------------------------------------------------------
// 悬浮窗状态合并节流
// ---------------------------------------------------------------------------

/** 手工时钟 + 手工调度器，避免依赖真实 setTimeout。 */
function makeHarness<T>() {
  let clock = 0;
  const emitted: T[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const coalescer = createStatusCoalescer<T>({
    intervalMs: 100,
    now: () => clock,
    emit: (value) => emitted.push(value),
    schedule: (fn, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: clock + delayMs, fn });
      return id;
    },
    cancel: (id) => {
      timers.delete(id);
    },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { coalescer, emitted, advance, timers };
}

describe('createStatusCoalescer', () => {
  it('两次推送间隔足够时立即应用', () => {
    const { coalescer, emitted } = makeHarness<number>();
    coalescer.push(1);
    expect(emitted).toEqual([1]);
  });

  it('窗口内多次推送只应用最后一次（状态不丢）', () => {
    const { coalescer, emitted, advance } = makeHarness<string>();
    coalescer.push('a'); // 立即（首次 emit）
    coalescer.push('b'); // 合并且排一个 100ms 定时器
    coalescer.push('c'); // 覆盖 b
    expect(emitted).toEqual(['a']);
    advance(100);
    expect(emitted).toEqual(['a', 'c']);
  });

  it('高频推送最多每 100ms 应用一次（≤10 次/秒）', () => {
    const { coalescer, emitted, advance } = makeHarness<number>();
    for (let i = 0; i < 50; i++) {
      coalescer.push(i);
      advance(10);
    }
    // 500ms 内最多 6 次（含首次），远少于 50 次
    expect(emitted.length).toBeLessThanOrEqual(6);
    // 最后一次值一定被应用（可能还在 pending 里，flush 后必须在）
    coalescer.flush();
    expect(emitted[emitted.length - 1]).toBe(49);
  });

  it('flush 立即应用 pending 值', () => {
    const { coalescer, emitted } = makeHarness<string>();
    coalescer.push('first');
    coalescer.push('pending');
    expect(coalescer.pending()).toBe('pending');
    coalescer.flush();
    expect(emitted).toEqual(['first', 'pending']);
    expect(coalescer.pending()).toBeNull();
  });

  it('dispose 后丢弃 pending 且不再 emit', () => {
    const { coalescer, emitted, advance } = makeHarness<string>();
    coalescer.push('first');
    coalescer.push('pending');
    coalescer.dispose();
    expect(coalescer.disposed()).toBe(true);
    advance(500);
    coalescer.push('late');
    expect(emitted).toEqual(['first']);
    expect(coalescer.pending()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 导出结果归类
// ---------------------------------------------------------------------------

describe('classifyExportBundle', () => {
  it('视频与教程都成功 → done', () => {
    const outcome = classifyExportBundle({
      video: { ok: true, verified: true, outputPath: 'C:\\v\\a.mp4' },
      tutorial: { ok: true },
      snapshotHash: 'abc',
    });
    expect(outcome).toEqual({ kind: 'done', warnings: [] });
  });

  it('仅视频成功 → done', () => {
    expect(classifyExportBundle({ video: { ok: true, verified: true }, tutorial: null }).kind).toBe('done');
  });

  it('导出管线报告的降级会进入 warnings（不能只写日志）', () => {
    const outcome = classifyExportBundle({
      video: {
        ok: true,
        verified: true,
        warnings: ['素材 mic-1 缺失，相关轨道按静音处理。', '素材 mic-1 缺失，相关轨道按静音处理。'],
      },
      tutorial: null,
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.warnings).toEqual(['素材 mic-1 缺失，相关轨道按静音处理。']);
  });

  it('仅教程成功 → done', () => {
    expect(classifyExportBundle({ video: null, tutorial: { ok: true } }).kind).toBe('done');
  });

  it('video.ok=false 不会被误判成成功', () => {
    const outcome = classifyExportBundle({
      video: { ok: false, error: { code: 'E_ENCODER_UNAVAILABLE', message: '编码器不可用', preservedData: true, retryable: true } },
      tutorial: null,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.message).toBe('编码器不可用');
      expect(outcome.code).toBe('E_ENCODER_UNAVAILABLE');
      expect(outcome.preservedData).toBe(true);
    }
  });

  it('被取消 → cancelled（即使外层 ok）', () => {
    const outcome = classifyExportBundle({
      video: null,
      tutorial: null,
      cancelled: true,
      error: '导出已取消',
    });
    expect(outcome.kind).toBe('cancelled');
  });

  it('取消错误码 → cancelled', () => {
    const outcome = classifyExportBundle({
      video: { ok: false, error: { code: 'E_EXPORT_CANCELLED', message: '用户取消' } },
      tutorial: null,
    });
    expect(outcome.kind).toBe('cancelled');
  });

  it('空载荷 → failed', () => {
    expect(classifyExportBundle(null).kind).toBe('failed');
    expect(classifyExportBundle({ video: null, tutorial: null }).kind).toBe('failed');
  });

  it('视频成功但完整性校验失败 → done 且带告警', () => {
    const outcome = classifyExportBundle({ video: { ok: true, verified: false }, tutorial: null });
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done') {
      expect(outcome.warnings.length).toBeGreaterThan(0);
      expect(outcome.warnings[0]).toContain('完整性校验');
    }
  });

  it('视频成功但教程失败 → done 且带教程告警', () => {
    const outcome = classifyExportBundle({
      video: { ok: true, verified: true },
      tutorial: { ok: false, error: '截图失败' },
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done') expect(outcome.warnings.join('|')).toContain('教程包生成失败');
  });
});

// ---------------------------------------------------------------------------
// 输出路径
// ---------------------------------------------------------------------------

describe('sanitizeFileStem', () => {
  it('去除 Windows 非法字符', () => {
    expect(sanitizeFileStem('录制: 2026/01/02 <测试>')).toBe('录制- 2026-01-02 -测试-');
  });

  it('空名回退默认值', () => {
    expect(sanitizeFileStem('   ')).toBe('WinCapture 录制');
  });
});

describe('deriveDefaultOutputPath', () => {
  it('拼出 视频目录\\工程名.mp4', () => {
    expect(deriveDefaultOutputPath('C:\\Users\\me\\Videos', '演示 工程')).toBe('C:\\Users\\me\\Videos\\演示 工程.mp4');
  });

  it('去掉目录末尾分隔符，避免双斜杠', () => {
    expect(deriveDefaultOutputPath('C:\\Videos\\', 'a')).toBe('C:\\Videos\\a.mp4');
  });

  it('系统信息未加载时返回空串（不猜路径）', () => {
    expect(deriveDefaultOutputPath('', 'a')).toBe('');
    expect(deriveDefaultOutputPath(null, 'a')).toBe('');
  });
});

describe('normalizeOutputPath', () => {
  it('M4A 补扩展名并拒绝错误的格式后缀', () => {
    expect(normalizeOutputPath('C:\\out\\audio', 'm4a')).toBe('C:\\out\\audio.m4a');
    expect(validateOutputPath('C:\\out\\audio.m4a', 'm4a').ok).toBe(true);
    expect(validateOutputPath('C:\\out\\video.mp4', 'm4a').ok).toBe(false);
  });
  it('缺少扩展名时补 .mp4', () => {
    expect(normalizeOutputPath('C:\\out\\demo')).toBe('C:\\out\\demo.mp4');
  });

  it('已有扩展名保持不变', () => {
    expect(normalizeOutputPath('C:\\out\\demo.MP4')).toBe('C:\\out\\demo.MP4');
    expect(normalizeOutputPath('C:\\out\\demo.mkv')).toBe('C:\\out\\demo.mkv');
  });

  it('目录路径补上默认文件名', () => {
    expect(normalizeOutputPath('C:\\out\\')).toBe('C:\\out\\WinCapture 录制.mp4');
  });

  it('空串保持空串', () => {
    expect(normalizeOutputPath('   ')).toBe('');
  });
});

describe('validateOutputPath', () => {
  it('空路径不通过并给出原因', () => {
    const result = validateOutputPath('  ');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('输出路径');
  });

  it('目录路径不通过', () => {
    expect(looksLikeDirectoryPath('C:\\out\\')).toBe(true);
    expect(validateOutputPath('C:\\out\\').ok).toBe(false);
  });

  it('自动补 .mp4 后通过', () => {
    const result = validateOutputPath('C:\\out\\demo');
    expect(result.ok).toBe(true);
    expect(result.normalized).toBe('C:\\out\\demo.mp4');
  });

  it('非 mp4 扩展名不通过', () => {
    const result = validateOutputPath('C:\\out\\demo.mkv');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('.mp4');
  });

  it('普通 .mp4 路径通过', () => {
    const result = validateOutputPath('D:\\videos\\a.mp4');
    expect(result).toEqual({ ok: true, normalized: 'D:\\videos\\a.mp4' });
  });
});

// ---------------------------------------------------------------------------
// 录制备忘录 → 标记备注
// ---------------------------------------------------------------------------

describe('memoMarkNote', () => {
  it('取光标所在行', () => {
    const text = '第一行\n第二行内容\n第三行';
    expect(memoMarkNote(text, text.indexOf('第二行') + 2)).toBe('第二行内容');
  });

  it('光标行是空白时回退最后一行非空内容', () => {
    const text = '第一行\n\n';
    expect(memoMarkNote(text, text.length)).toBe('第一行');
  });

  it('空文本返回空串', () => {
    expect(memoMarkNote('', 0)).toBe('');
    expect(memoMarkNote('  \n  ', 3)).toBe('');
  });

  it('越界光标按文本长度处理（不抛异常）', () => {
    expect(memoMarkNote('abc', 999)).toBe('abc');
    expect(memoMarkNote('abc', -5)).toBe('abc');
    expect(memoMarkNote('abc', Number.NaN)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// 来源分栏切换
// ---------------------------------------------------------------------------

const SOURCES = [
  { id: 'display:0', kind: 'screen' as const, available: true },
  { id: 'display:1', kind: 'screen' as const, available: false },
  { id: 'window:1', kind: 'window' as const, available: false },
];

describe('pickSourceForKind', () => {
  it('当前选中项仍在新分栏且可用时保持', () => {
    expect(pickSourceForKind(SOURCES, 'screen', 'display:0')).toEqual({ sourceId: 'display:0', sourceKind: 'screen' });
  });

  it('切到另一个分栏时选中该分栏第一个可用来源', () => {
    expect(pickSourceForKind(SOURCES, 'window', 'display:0')).toEqual({ sourceId: 'window:1', sourceKind: 'window' });
  });

  it('新分栏没有可用来源时清空 sourceId（不再偷偷用旧来源）', () => {
    const unavailable = SOURCES.map((source) => ({ ...source, available: false }));
    expect(pickSourceForKind(unavailable, 'window', 'display:0')).toEqual({ sourceId: 'window:1', sourceKind: 'window' });
  });

  it('完全没有该分栏来源时 sourceId 为空', () => {
    expect(pickSourceForKind([SOURCES[0]], 'window', 'display:0')).toEqual({ sourceId: '', sourceKind: 'window' });
  });
});

describe('isSourceInKind', () => {
  it('来源与分栏一致返回 true', () => {
    expect(isSourceInKind(SOURCES, 'screen', 'display:0')).toBe(true);
  });

  it('来源不在当前分栏返回 false（界面必须提示而不是照旧开录）', () => {
    expect(isSourceInKind(SOURCES, 'window', 'display:0')).toBe(false);
  });

  it('空 sourceId 返回 false', () => {
    expect(isSourceInKind(SOURCES, 'screen', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 录制分段选帧
// ---------------------------------------------------------------------------

describe('planFrameSlots: 按真实时间戳落帧', () => {
  const S = 10_000_000;
  const STEP = S / 30; // 30fps

  const stamped = (ticks: number[]) => ticks.map((mediaTick) => ({ mediaTick }));

  it('帧率稳定时逐槽落位', () => {
    const frames = stamped(Array.from({ length: 60 }, (_, i) => i * STEP));
    expect(planFrameSlots(frames, 0, 60, STEP)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('后半段掉帧时保持时间轴不压缩（空槽沿用上一帧）', () => {
    // 只收到前 1 秒的 30 帧，段长 2 秒
    const frames = stamped(Array.from({ length: 30 }, (_, i) => i * STEP));
    const slots = planFrameSlots(frames, 0, 60, STEP);
    expect(slots).toHaveLength(60);
    // 前 30 槽是原始帧，后 30 槽沿用第 29 帧（而不是把 30 帧压进前 1 秒）
    expect(slots.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(slots.slice(30).every((index) => index === 29)).toBe(true);
  });

  it('中间丢一段帧时该段画面静止，后续帧仍回到正确槽位', () => {
    const frames = stamped([0, 1 * STEP, 2 * STEP, 40 * STEP, 41 * STEP, 42 * STEP]);
    const slots = planFrameSlots(frames, 0, 60, STEP);
    expect(slots[0]).toBe(0);
    expect(slots[2]).toBe(2);
    expect(slots[39]).toBe(2); // 2s..40step 之间沿用第 2 帧
    expect(slots[40]).toBe(3); // 掉帧恢复后回到真实位置
    expect(slots[42]).toBe(5);
  });

  it('首帧晚于段起点时前导槽位用第一帧补齐', () => {
    const frames = stamped([5 * STEP, 6 * STEP]);
    const slots = planFrameSlots(frames, 0, 10, STEP);
    expect(slots.slice(0, 5).every((index) => index === 0)).toBe(true);
    expect(slots[5]).toBe(0);
    expect(slots[6]).toBe(1);
  });

  it('时间戳不可用（全相同/缺失）时退回均匀抽样', () => {
    const same = stamped(Array.from({ length: 60 }, () => 7));
    expect(planFrameSlots(same, 0, 60, STEP)).toEqual(planFramePicks(60, 60));
  });

  it('空输入返回空数组，长度恒等于目标帧数', () => {
    expect(planFrameSlots([], 0, 60, STEP)).toEqual([]);
    const frames = stamped([0, STEP, 2 * STEP]);
    expect(planFrameSlots(frames, 0, 120, STEP)).toHaveLength(120);
  });

  it('结果单调不减且始终落在源帧范围内', () => {
    for (const count of [1, 2, 7, 30, 200]) {
      const frames = stamped(Array.from({ length: count }, (_, i) => i * STEP * 1.7));
      const slots = planFrameSlots(frames, 0, 60, STEP);
      expect(slots).toHaveLength(60);
      for (let i = 0; i < slots.length; i++) {
        expect(slots[i]).toBeGreaterThanOrEqual(0);
        expect(slots[i]).toBeLessThan(count);
        if (i > 0) expect(slots[i]).toBeGreaterThanOrEqual(slots[i - 1]);
      }
    }
  });
});

describe('planFramePicks', () => {
  const RANGE = (count: number) => Array.from({ length: count }, (_, i) => i);

  it('源帧与目标帧相等时逐帧使用', () => {
    expect(planFramePicks(60, 60)).toEqual(RANGE(60));
  });

  it('源帧多于目标帧时抽稀，长度严格等于目标帧数', () => {
    const picks = planFramePicks(656, 600);
    expect(picks).toHaveLength(600);
    expect(picks[0]).toBe(0);
    // 最后一个采样点不应越过源帧末尾
    expect(picks[picks.length - 1]).toBeLessThan(656);
  });

  it('源帧少于目标帧时重复末帧补齐', () => {
    const picks = planFramePicks(30, 60);
    expect(picks).toHaveLength(60);
    expect(picks.slice(0, 30)).toEqual(RANGE(30));
    expect(picks.slice(30).every((index) => index === 29)).toBe(true);
  });

  it('结果单调不减且始终落在源帧范围内（含边界输入）', () => {
    for (const [source, target] of [
      [1, 1],
      [1, 60],
      [0, 10],
      [1000, 7],
      [59, 60],
      [60, 59],
    ] as const) {
      const picks = planFramePicks(source, target);
      expect(picks).toHaveLength(Math.max(1, Math.floor(target)));
      for (let i = 0; i < picks.length; i++) {
        expect(picks[i]).toBeGreaterThanOrEqual(0);
        expect(picks[i]).toBeLessThan(Math.max(1, Math.floor(source)));
        if (i > 0) expect(picks[i]).toBeGreaterThanOrEqual(picks[i - 1]);
      }
    }
  });
});
