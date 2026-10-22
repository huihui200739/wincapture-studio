import { describe, it, expect } from 'vitest';
import {
  applyCommand,
  makeCommand,
  CommandHistory,
  IdempotentCommandRunner,
  rebaseCommand,
  describeCommand,
  MAX_HISTORY,
} from '../../src/domain/commands';
import type { ProjectCommand } from '../../src/domain/commands';
import { createEmptyProject, timelineDuration } from '../../src/domain/project';
import type { Project, Effect, TutorialStep } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';
import { AppError } from '../../src/shared/errors';

const S = TICKS_PER_SECOND;

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 建立三轨联动工程：主轨 0..10s，摄像头/麦克风同 linkGroup，均在 0..10s。 */
function linkedProject(): Project {
  const project = createEmptyProject('p1', 'linked');
  project.assets.push(
    {
      id: 'screen-1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: 'h1',
      durationTicks: 20 * S,
      width: 1920,
      height: 1080,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    },
    {
      id: 'cam-1',
      kind: 'camera',
      path: 'media/camera/seg-000001.mp4',
      hash: 'h2',
      durationTicks: 20 * S,
      width: 1280,
      height: 720,
      sampleRate: 0,
      channels: 0,
      createdAt: 0,
    },
    {
      id: 'mic-1',
      kind: 'mic',
      path: 'media/mic/seg-000001.wav',
      hash: 'h3',
      durationTicks: 20 * S,
      width: 0,
      height: 0,
      sampleRate: 48_000,
      channels: 1,
      createdAt: 0,
    },
  );
  project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
    {
      id: 'main-clip',
      assetId: 'screen-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'camera')!.clips = [
    {
      id: 'cam-clip',
      assetId: 'cam-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  project.tracks.find((t) => t.kind === 'mic')!.clips = [
    {
      id: 'mic-clip',
      assetId: 'mic-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  return project;
}

function privacyEffect(id: string, start: number, end: number): Effect {
  return {
    id,
    kind: 'privacy',
    range: { start, end },
    anchor: 'screen',
    parameters: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, anchor: 'screen', style: 'solid', confirmed: true },
    origin: 'manual',
    locked: true,
  };
}

function zoomEffect(id: string, start: number, end: number): Effect {
  return {
    id,
    kind: 'zoom',
    range: { start, end },
    parameters: { scale: 1.8, focusX: 0.5, focusY: 0.5, easeInTicks: S / 2, easeOutTicks: S / 2 },
    origin: 'automatic',
    locked: false,
  };
}

function step(id: string, start: number, end: number, imageTick: number): TutorialStep {
  return {
    id,
    sourceRange: { start, end },
    title: id,
    description: '',
    imageTick,
    actionRect: null,
    source: 'marker',
    privacyVersion: 0,
  };
}

function cmd(project: Project, partial: Omit<ProjectCommand, 'id' | 'expectedRevision'>): ProjectCommand {
  return makeCommand(project, partial as Omit<ProjectCommand, 'id' | 'expectedRevision'>);
}

// ---------------------------------------------------------------------------
// 版本冲突
// ---------------------------------------------------------------------------

describe('applyCommand: 版本与不可变性', () => {
  it('expectedRevision 不匹配时抛 E_REVISION_CONFLICT', () => {
    const project = linkedProject();
    const command: ProjectCommand = {
      id: 'c1',
      kind: 'DeleteRange',
      expectedRevision: project.revision + 5,
      range: { start: 0, end: S },
      ripple: true,
    };
    expect(() => applyCommand(project, command)).toThrowError(AppError);
    try {
      applyCommand(project, command);
    } catch (error) {
      expect((error as AppError).code).toBe('E_REVISION_CONFLICT');
      expect((error as AppError).retryable).toBe(true);
    }
  });

  it('成功执行后 revision 递增 1', () => {
    const project = linkedProject();
    const result = applyCommand(project, cmd(project, { kind: 'SetActiveVariant', variantId: 'square' }));
    expect(result.project.revision).toBe(project.revision + 1);
  });

  it('不修改传入工程（纯函数）', () => {
    const project = linkedProject();
    const snapshot = JSON.stringify(project);
    applyCommand(project, cmd(project, { kind: 'DeleteRange', range: { start: S, end: 2 * S }, ripple: true }));
    expect(JSON.stringify(project)).toBe(snapshot);
  });

  it('未知命令抛 E_INVALID_COMMAND', () => {
    const project = linkedProject();
    const bad = { id: 'x', kind: 'Nope', expectedRevision: project.revision } as unknown as ProjectCommand;
    expect(() => applyCommand(project, bad)).toThrowError(AppError);
  });

  it('rebaseCommand 重新绑定 revision 后可执行', () => {
    const project = linkedProject();
    const stale = cmd(project, { kind: 'SetActiveVariant', variantId: 'portrait' });
    const moved = applyCommand(project, cmd(project, { kind: 'SetActiveVariant', variantId: 'square' })).project;
    expect(() => applyCommand(moved, stale)).toThrowError(AppError);
    const rebased = rebaseCommand(moved, stale);
    const result = applyCommand(moved, rebased);
    expect(result.project.settings.activeVariantId).toBe('portrait');
  });
});

// ---------------------------------------------------------------------------
// DeleteRange：ripple 事务
// ---------------------------------------------------------------------------

describe('DeleteRange: ripple 同步所有关联轨', () => {
  it('ripple 删除后主轨前移', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: true }),
    );
    const main = result.project.tracks.find((t) => t.kind === 'primaryVideo')!;
    expect(main.clips).toHaveLength(2);
    // 左段 0..2s，右段前移 2s → 2..8s
    expect(main.clips[0].timelineInTicks).toBe(0);
    expect(main.clips[0].sourceDurationTicks).toBe(2 * S);
    expect(main.clips[1].timelineInTicks).toBe(2 * S);
    expect(main.clips[1].sourceInTicks).toBe(4 * S);
    expect(main.clips[1].sourceDurationTicks).toBe(6 * S);
    expect(timelineDuration(result.project)).toBe(8 * S);
  });

  it('ripple 让摄像头与麦克风（同 linkGroupId）同步前移相同长度', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: true }),
    );
    for (const kind of ['camera', 'mic'] as const) {
      const track = result.project.tracks.find((t) => t.kind === kind)!;
      expect(track.clips).toHaveLength(2);
      expect(track.clips[0].timelineInTicks).toBe(0);
      expect(track.clips[1].timelineInTicks).toBe(2 * S);
      expect(track.clips[1].sourceInTicks).toBe(4 * S);
      expect(track.clips[1].sourceDurationTicks).toBe(6 * S);
    }
    // 三轨时长完全一致（音画对齐）
    const ends = ['primaryVideo', 'camera', 'mic'].map((kind) => {
      const track = result.project.tracks.find((t) => t.kind === kind)!;
      return Math.max(...track.clips.map((c) => c.timelineInTicks + c.sourceDurationTicks));
    });
    expect(new Set(ends).size).toBe(1);
  });

  it('非 ripple 删除保留空隙，后续片段不前移', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: false }),
    );
    const main = result.project.tracks.find((t) => t.kind === 'primaryVideo')!;
    expect(main.clips).toHaveLength(2);
    expect(main.clips[0].timelineInTicks).toBe(0);
    expect(main.clips[1].timelineInTicks).toBe(4 * S); // 空隙保留
    expect(timelineDuration(result.project)).toBe(10 * S);
  });

  it('ripple 删除区间覆盖整个工程时所有片段被删', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 0, end: 10 * S }, ripple: true }),
    );
    expect(result.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips).toHaveLength(0);
    expect(result.project.tracks.find((t) => t.kind === 'camera')!.clips).toHaveLength(0);
    expect(timelineDuration(result.project)).toBe(0);
  });

  it('空区间删除不改变任何片段', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 5 * S, end: 5 * S }, ripple: true }),
    );
    expect(result.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips).toHaveLength(1);
    expect(timelineDuration(result.project)).toBe(10 * S);
  });

  it('删除区间边界与片段边界重合时不多切片段（左闭右开）', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 10 * S, end: 12 * S }, ripple: true }),
    );
    // 片段 [0,10) 完全在删除区间之前，不应被切
    const main = result.project.tracks.find((t) => t.kind === 'primaryVideo')!;
    expect(main.clips).toHaveLength(1);
    expect(main.clips[0].sourceDurationTicks).toBe(10 * S);
  });

  it('diff 记录受影响轨道与被删实体', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: true }),
    );
    expect(result.diff.kind).toBe('DeleteRange');
    expect(result.diff.tracks).toContain('primaryVideo');
    expect(result.diff.tracks).toContain('camera');
    expect(result.diff.tracks).toContain('mic');
    expect(result.diff.removed).toEqual([{ start: 2 * S, end: 4 * S }]);
  });
});

describe('DeleteRange: linkGroupId 关联语义', () => {
  it('同 linkGroupId 的伴随轨必须与主轨同步前移相同长度', () => {
    const project = linkedProject();
    // 三轨 linkGroupId 都是 rec-1
    for (const track of project.tracks) {
      if (track.clips.length > 0) expect(track.clips[0].linkGroupId).toBe('rec-1');
    }
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 3 * S, end: 5 * S }, ripple: true }),
    );
    // 删除长度 2s，所有关联轨的右段都应前移 2s
    for (const kind of ['primaryVideo', 'camera', 'mic'] as const) {
      const track = result.project.tracks.find((t) => t.kind === kind)!;
      const right = track.clips.find((c) => c.sourceInTicks >= 5 * S)!;
      expect(right).toBeDefined();
      expect(right.timelineInTicks).toBe(3 * S); // 原本 5s，前移 2s
      expect(right.sourceInTicks).toBe(5 * S); // 源起点不变（非破坏编辑）
    }
  });

  it('关联轨在删除区间之前的片段不前移', () => {
    const project = linkedProject();
    // 主轨拆成两段：0..2s 与 6..10s
    const track = project.tracks.find((t) => t.kind === 'primaryVideo')!;
    track.clips = [
      { ...track.clips[0], id: 'c-left', sourceInTicks: 0, sourceDurationTicks: 2 * S, timelineInTicks: 0 },
      { ...track.clips[0], id: 'c-right', sourceInTicks: 6 * S, sourceDurationTicks: 4 * S, timelineInTicks: 6 * S },
    ];
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 3 * S, end: 5 * S }, ripple: true }),
    );
    const clips = result.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips;
    const left = clips.find((c) => c.id === 'c-left')!;
    const right = clips.find((c) => c.id === 'c-right')!;
    expect(left.timelineInTicks).toBe(0); // 未动
    expect(right.timelineInTicks).toBe(4 * S); // 6s − 2s
  });

  it('不同 linkGroupId 但位于删除区间之后的片段也前移（ripple 是时间线操作）', () => {
    const project = linkedProject();
    // 追加一条独立录制产生的片段（linkGroupId=rec-2），位于 12s
    const cameraTrack = project.tracks.find((t) => t.kind === 'camera')!;
    cameraTrack.clips.push({
      id: 'cam-other',
      assetId: 'cam-1',
      sourceInTicks: 0,
      sourceDurationTicks: 2 * S,
      timelineInTicks: 12 * S,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-2',
    });
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: true }),
    );
    const other = result.project.tracks
      .find((t) => t.kind === 'camera')!
      .clips.find((c) => c.id === 'cam-other')!;
    expect(other.timelineInTicks).toBe(10 * S); // 12s − 2s
    expect(other.linkGroupId).toBe('rec-2'); // 关联组不被改写
  });

  it('ripple 后各关联轨的时间线位置仍逐一对应（音画不漂移）', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 1 * S, end: 2.5 * S }, ripple: true }),
    );
    const layout = (kind: 'primaryVideo' | 'camera' | 'mic') =>
      result.project.tracks
        .find((t) => t.kind === kind)!
        .clips.map((c) => [c.timelineInTicks, c.sourceInTicks, c.sourceDurationTicks]);
    expect(layout('primaryVideo')).toEqual(layout('camera'));
    expect(layout('primaryVideo')).toEqual(layout('mic'));
  });
});

// ---------------------------------------------------------------------------
// DeleteRange：效果与步骤裁断
// ---------------------------------------------------------------------------

describe('DeleteRange: 隐私效果被切分时拆成多个独立 effect', () => {
  it('privacy 被中间挖空 → 拆成两个 effect，各自新 id', () => {
    const project = linkedProject();
    project.effects.push(privacyEffect('pv-1', 2 * S, 8 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 4 * S, end: 6 * S }, ripple: true }),
    );
    const privacies = result.project.effects.filter((e) => e.kind === 'privacy');
    expect(privacies).toHaveLength(2);
    const ids = privacies.map((e) => e.id);
    expect(new Set(ids).size).toBe(2); // id 不重复
    // 前段 [2,4)，后段 ripple 前移到 [4,6)
    expect(privacies[0].range).toEqual({ start: 2 * S, end: 4 * S });
    expect(privacies[1].range).toEqual({ start: 4 * S, end: 6 * S });
    // 参数必须完全一致（同一遮挡区域不能丢）
    expect(privacies[1].parameters).toEqual(privacies[0].parameters);
  });

  it('非 ripple 切分时第二段留在原位置', () => {
    const project = linkedProject();
    project.effects.push(privacyEffect('pv-1', 2 * S, 8 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 4 * S, end: 6 * S }, ripple: false }),
    );
    const privacies = result.project.effects.filter((e) => e.kind === 'privacy');
    expect(privacies).toHaveLength(2);
    expect(privacies[0].range).toEqual({ start: 2 * S, end: 4 * S });
    expect(privacies[1].range).toEqual({ start: 6 * S, end: 8 * S });
  });

  it('privacy 只被切掉头部 → 保留一段', () => {
    const project = linkedProject();
    project.effects.push(privacyEffect('pv-1', 2 * S, 8 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 0, end: 4 * S }, ripple: false }),
    );
    const privacies = result.project.effects.filter((e) => e.kind === 'privacy');
    expect(privacies).toHaveLength(1);
    expect(privacies[0].range).toEqual({ start: 4 * S, end: 8 * S });
  });

  it('privacy 被完全覆盖 → 删除并递增 privacyVersion', () => {
    const project = linkedProject();
    project.effects.push(privacyEffect('pv-1', 3 * S, 5 * S));
    const before = project.privacyVersion;
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 6 * S }, ripple: false }),
    );
    expect(result.project.effects.filter((e) => e.kind === 'privacy')).toHaveLength(0);
    expect(result.project.privacyVersion).toBe(before + 1);
  });

  it('三次切分产生三段独立 effect（不丢段）', () => {
    const project = linkedProject();
    project.effects.push(privacyEffect('pv-1', 0, 10 * S));
    let current = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 3 * S }, ripple: false }),
    ).project;
    current = applyCommand(
      current,
      cmd(current, { kind: 'DeleteRange', range: { start: 6 * S, end: 7 * S }, ripple: false }),
    ).project;
    const privacies = current.effects.filter((e) => e.kind === 'privacy');
    expect(privacies).toHaveLength(3);
    expect(new Set(privacies.map((e) => e.id)).size).toBe(3);
    const total = privacies.reduce((acc, e) => acc + (e.range.end - e.range.start), 0);
    expect(total).toBe(10 * S - S - S);
  });
});

describe('DeleteRange: zoom 只保留主段', () => {
  it('zoom 被中间挖空 → 只保留最长的一段', () => {
    const project = linkedProject();
    // [1,9) 被 [3,4) 切开 → 左段 2s，右段 5s，保留右段
    project.effects.push(zoomEffect('zoom-1', S, 9 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 3 * S, end: 4 * S }, ripple: false }),
    );
    const zooms = result.project.effects.filter((e) => e.kind === 'zoom');
    expect(zooms).toHaveLength(1);
    expect(zooms[0].range).toEqual({ start: 4 * S, end: 9 * S });
    expect(zooms[0].id).toBe('zoom-1');
  });

  it('zoom 主段选择与切分顺序无关（取最长）', () => {
    const project = linkedProject();
    // [0,10) 切掉 [6,7) → 左 6s、右 3s，保留左
    project.effects.push(zoomEffect('zoom-1', 0, 10 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 6 * S, end: 7 * S }, ripple: false }),
    );
    const zooms = result.project.effects.filter((e) => e.kind === 'zoom');
    expect(zooms).toHaveLength(1);
    expect(zooms[0].range).toEqual({ start: 0, end: 6 * S });
  });
});

describe('DeleteRange: 步骤保留最大段并更新 imageTick', () => {
  it('step 被切分时保留最大段，imageTick 夹到新区间内', () => {
    const project = linkedProject();
    // 源 [1,9)，imageTick = 8.5s，删除源 [3,4)
    project.steps.push(step('st-1', S, 9 * S, 8.5 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 3 * S, end: 4 * S }, ripple: false }),
    );
    expect(result.project.steps).toHaveLength(1);
    const s = result.project.steps[0];
    // 左段 1..3（2s）、右段 4..9（5s）→ 保留右段
    expect(s.sourceRange).toEqual({ start: 4 * S, end: 9 * S });
    expect(s.imageTick).toBeGreaterThanOrEqual(s.sourceRange.start);
    expect(s.imageTick).toBeLessThan(s.sourceRange.end);
  });

  it('imageTick 落在被删区间内时移到保留段起点', () => {
    const project = linkedProject();
    project.steps.push(step('st-1', 0, 10 * S, 5 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 4 * S, end: 6 * S }, ripple: false }),
    );
    const s = result.project.steps[0];
    // 左段 0..4（4s）比右段 6..10（4s）相等 → 取第一个（左段）
    expect(s.sourceRange).toEqual({ start: 0, end: 4 * S });
    expect(s.imageTick).toBeGreaterThanOrEqual(0);
    expect(s.imageTick).toBeLessThan(4 * S);
  });

  it('step 完全被删时移除', () => {
    const project = linkedProject();
    project.steps.push(step('st-1', 3 * S, 5 * S, 4 * S));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 6 * S }, ripple: false }),
    );
    expect(result.project.steps).toHaveLength(0);
  });

  it('step 未被删除区间碰到时保持原样', () => {
    const project = linkedProject();
    project.steps.push(step('st-1', 0, S, S / 2));
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 5 * S, end: 6 * S }, ripple: false }),
    );
    expect(result.project.steps[0].sourceRange).toEqual({ start: 0, end: S });
    expect(result.project.steps[0].imageTick).toBe(S / 2);
  });
});

describe('DeleteRange: 标记处理', () => {
  it('落在删除区间内的标记被删除', () => {
    const project = linkedProject();
    project.markers.push(
      { id: 'm1', mediaTick: 2 * S, note: 'a', createdAt: 0 },
      { id: 'm2', mediaTick: 5 * S, note: 'b', createdAt: 0 },
    );
    const result = applyCommand(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 4 * S, end: 6 * S }, ripple: false }),
    );
    expect(result.project.markers.map((m) => m.id)).toEqual(['m1']);
  });
});

// ---------------------------------------------------------------------------
// SplitClip / TrimClip / MoveClip
// ---------------------------------------------------------------------------

describe('SplitClip: 关联轨同步分割', () => {
  it('在 5s 处分割主轨，产生两段且源区间连续', () => {
    const project = linkedProject();
    const result = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 5 * S }));
    const main = result.project.tracks.find((t) => t.kind === 'primaryVideo')!;
    expect(main.clips).toHaveLength(2);
    expect(main.clips[0].sourceDurationTicks).toBe(5 * S);
    expect(main.clips[1].sourceInTicks).toBe(5 * S);
    expect(main.clips[1].timelineInTicks).toBe(5 * S);
    expect(main.clips[0].sourceDurationTicks + main.clips[1].sourceDurationTicks).toBe(10 * S);
  });

  it('分割同样作用于摄像头与麦克风轨（关联事务）', () => {
    const project = linkedProject();
    const result = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 5 * S }));
    for (const kind of ['camera', 'mic'] as const) {
      expect(result.project.tracks.find((t) => t.kind === kind)!.clips).toHaveLength(2);
    }
  });

  it('分割点恰在片段起点或终点时不分割（左闭右开）', () => {
    const project = linkedProject();
    const atStart = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 0 })).project;
    expect(atStart.tracks.find((t) => t.kind === 'primaryVideo')!.clips).toHaveLength(1);
    const atEnd = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 10 * S })).project;
    expect(atEnd.tracks.find((t) => t.kind === 'primaryVideo')!.clips).toHaveLength(1);
  });

  it('分割产生的新片段 ID 唯一且确定（同输入同输出）', () => {
    const project = linkedProject();
    const a = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 5 * S })).project;
    const b = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 5 * S })).project;
    const idsA = a.tracks.find((t) => t.kind === 'primaryVideo')!.clips.map((c) => c.id);
    const idsB = b.tracks.find((t) => t.kind === 'primaryVideo')!.clips.map((c) => c.id);
    expect(idsA).toEqual(idsB); // 确定性，便于幂等重放
    expect(new Set(idsA).size).toBe(idsA.length);
  });

  it('距边界小于 1ms 的分割被拒绝（不产生碎片）', () => {
    const project = linkedProject();
    const result = applyCommand(project, cmd(project, { kind: 'SplitClip', timelineTick: 5000 }));
    expect(result.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips).toHaveLength(1);
  });
});

describe('TrimClip / MoveClip', () => {
  it('TrimClip 修改源起点与时长', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'TrimClip', clipId: 'main-clip', sourceInTicks: S, sourceDurationTicks: 3 * S }),
    );
    const clip = result.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0];
    expect(clip.sourceInTicks).toBe(S);
    expect(clip.sourceDurationTicks).toBe(3 * S);
  });

  it('TrimClip 不存在片段抛 E_INVALID_COMMAND', () => {
    const project = linkedProject();
    expect(() =>
      applyCommand(project, cmd(project, { kind: 'TrimClip', clipId: 'nope', sourceInTicks: 0 })),
    ).toThrowError(AppError);
  });

  it('MoveClip 移动并重新排序', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'MoveClip', clipId: 'main-clip', timelineInTicks: 3 * S }),
    );
    const main = result.project.tracks.find((t) => t.kind === 'primaryVideo')!;
    expect(main.clips[0].timelineInTicks).toBe(3 * S);
    expect(timelineDuration(result.project)).toBe(13 * S);
  });
});

// ---------------------------------------------------------------------------
// 其他命令
// ---------------------------------------------------------------------------

describe('SetEffect / DeleteEffect', () => {
  it('新增 privacy 效果递增 privacyVersion', () => {
    const project = linkedProject();
    const before = project.privacyVersion;
    const result = applyCommand(
      project,
      cmd(project, { kind: 'SetEffect', effect: privacyEffect('pv-1', 0, S) }),
    );
    expect(result.project.effects).toHaveLength(1);
    expect(result.project.privacyVersion).toBe(before + 1);
  });

  it('SetEffect 默认锁定（人工修改不被自动重生成覆盖）', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'SetEffect', effect: { ...zoomEffect('z1', 0, S), locked: false } }),
    );
    expect(result.project.effects[0].locked).toBe(true);
  });

  it('DeleteEffect 不存在时抛错', () => {
    const project = linkedProject();
    expect(() => applyCommand(project, cmd(project, { kind: 'DeleteEffect', effectId: 'nope' }))).toThrowError(AppError);
  });

  it('DeleteEffect 删除 privacy 时递增 privacyVersion', () => {
    const project = linkedProject();
    project.effects.push(privacyEffect('pv-1', 0, S));
    const before = project.privacyVersion;
    const result = applyCommand(project, cmd(project, { kind: 'DeleteEffect', effectId: 'pv-1' }));
    expect(result.project.privacyVersion).toBe(before + 1);
  });
});

describe('SetTrackAudio / SetCanvasStyle / SetVariantOverride / SetActiveVariant / SetFrameRate', () => {
  it('SetTrackAudio 夹紧增益到 0..4', () => {
    const project = linkedProject();
    const loud = applyCommand(project, cmd(project, { kind: 'SetTrackAudio', track: 'mic', gain: 99 })).project;
    expect(loud.tracks.find((t) => t.kind === 'mic')!.gain).toBe(4);
    const quiet = applyCommand(project, cmd(project, { kind: 'SetTrackAudio', track: 'mic', gain: -3 })).project;
    expect(quiet.tracks.find((t) => t.kind === 'mic')!.gain).toBe(0);
  });

  it('SetTrackAudio 静音', () => {
    const project = linkedProject();
    const result = applyCommand(project, cmd(project, { kind: 'SetTrackAudio', track: 'system', muted: true }));
    expect(result.project.tracks.find((t) => t.kind === 'system')!.muted).toBe(true);
  });

  it('SetCanvasStyle 局部覆盖', () => {
    const project = linkedProject();
    const result = applyCommand(
      project,
      cmd(project, { kind: 'SetCanvasStyle', canvas: { cornerRadius: 0, background: '#000' } }),
    );
    expect(result.project.settings.canvas.cornerRadius).toBe(0);
    expect(result.project.settings.canvas.background).toBe('#000');
    expect(result.project.settings.canvas.padding).toBe(project.settings.canvas.padding);
  });

  it('SetVariantOverride 不存在的画幅抛错', () => {
    const project = linkedProject();
    expect(() =>
      applyCommand(project, cmd(project, { kind: 'SetVariantOverride', variantId: 'nope', layoutOverrides: {} })),
    ).toThrowError(AppError);
  });

  it('SetActiveVariant 切换成功 / 不存在抛错', () => {
    const project = linkedProject();
    const ok = applyCommand(project, cmd(project, { kind: 'SetActiveVariant', variantId: 'portrait' }));
    expect(ok.project.settings.activeVariantId).toBe('portrait');
    expect(() => applyCommand(project, cmd(project, { kind: 'SetActiveVariant', variantId: 'x' }))).toThrowError(AppError);
  });

  it('SetFrameRate 切换帧率', () => {
    const project = linkedProject();
    const result = applyCommand(project, cmd(project, { kind: 'SetFrameRate', fps: { num: 60, den: 1 } }));
    expect(result.project.settings.fps).toEqual({ num: 60, den: 1 });
  });
});

describe('步骤命令', () => {
  it('SetStep 新增并按时间排序', () => {
    const project = linkedProject();
    let current = applyCommand(project, cmd(project, { kind: 'SetStep', step: step('s2', 5 * S, 6 * S, 5.5 * S) })).project;
    current = applyCommand(current, cmd(current, { kind: 'SetStep', step: step('s1', S, 2 * S, 1.5 * S) })).project;
    expect(current.steps.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('DeleteStep / ReorderSteps', () => {
    const project = linkedProject();
    project.steps.push(step('s1', 0, S, S / 2), step('s2', 2 * S, 3 * S, 2.5 * S));
    const removed = applyCommand(project, cmd(project, { kind: 'DeleteStep', stepId: 's1' })).project;
    expect(removed.steps.map((s) => s.id)).toEqual(['s2']);
    const reordered = applyCommand(project, cmd(project, { kind: 'ReorderSteps', orderedIds: ['s2', 's1'] })).project;
    expect(reordered.steps.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('SetMarker 添加/删除', () => {
    const project = linkedProject();
    const marker = { id: 'm1', mediaTick: 3 * S, note: 'x', createdAt: 0 };
    const added = applyCommand(project, cmd(project, { kind: 'SetMarker', marker })).project;
    expect(added.markers).toHaveLength(1);
    const removed = applyCommand(added, cmd(added, { kind: 'SetMarker', marker, remove: true })).project;
    expect(removed.markers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 撤销 / 重做：revision 单调
// ---------------------------------------------------------------------------

describe('CommandHistory: revision 单调递增，内容回到旧状态', () => {
  it('undo 后 revision 递增而不是回退', () => {
    const project = linkedProject();
    const history = new CommandHistory();
    const first = history.execute(project, cmd(project, { kind: 'SetActiveVariant', variantId: 'square' }));
    expect(first.project.revision).toBe(project.revision + 1);
    const undone = history.undo(first.project);
    expect(undone).not.toBeNull();
    // 内容回到旧状态
    expect(undone!.settings.activeVariantId).toBe(project.settings.activeVariantId);
    // 但 revision 继续递增
    expect(undone!.revision).toBe(first.project.revision + 1);
    expect(undone!.revision).toBeGreaterThan(first.project.revision);
  });

  it('连续 undo 的 revision 严格单调递增', () => {
    let current = linkedProject();
    const history = new CommandHistory();
    const revisions: number[] = [current.revision];
    for (const variantId of ['square', 'portrait', 'landscape']) {
      current = history.execute(current, cmd(current, { kind: 'SetActiveVariant', variantId })).project;
      revisions.push(current.revision);
    }
    for (let i = 0; i < 3; i++) {
      const undone = history.undo(current);
      expect(undone).not.toBeNull();
      current = undone!;
      revisions.push(current.revision);
    }
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }
  });

  it('redo 后内容与首次执行一致，revision 继续递增', () => {
    const project = linkedProject();
    const history = new CommandHistory();
    const executed = history.execute(project, cmd(project, { kind: 'SetCanvasStyle', canvas: { cornerRadius: 0 } }));
    const undone = history.undo(executed.project)!;
    const redone = history.redo(undone)!;
    expect(redone.settings.canvas.cornerRadius).toBe(0);
    expect(redone.revision).toBe(undone.revision + 1);
    expect(redone.revision).toBeGreaterThan(executed.project.revision);
  });

  it('undo 内容确实回到旧状态（多字段比对）', () => {
    const project = linkedProject();
    const history = new CommandHistory();
    const executed = history.execute(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: true }),
    );
    const undone = history.undo(executed.project)!;
    expect(undone.tracks).toEqual(project.tracks);
    expect(undone.effects).toEqual(project.effects);
    expect(undone.steps).toEqual(project.steps);
    expect(timelineDuration(undone)).toBe(10 * S);
  });

  it('undo 后新命令清空 redo 栈', () => {
    const project = linkedProject();
    const history = new CommandHistory();
    const executed = history.execute(project, cmd(project, { kind: 'SetActiveVariant', variantId: 'square' }));
    const undone = history.undo(executed.project)!;
    expect(history.canRedo).toBe(true);
    history.execute(undone, cmd(undone, { kind: 'SetActiveVariant', variantId: 'portrait' }));
    expect(history.canRedo).toBe(false);
  });

  it('空历史 undo/redo 返回 null', () => {
    const project = linkedProject();
    const history = new CommandHistory();
    expect(history.undo(project)).toBeNull();
    expect(history.redo(project)).toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('undo/redo 标签与深度', () => {
    const project = linkedProject();
    const history = new CommandHistory();
    const executed = history.execute(
      project,
      cmd(project, { kind: 'DeleteRange', range: { start: 0, end: S }, ripple: true }),
    );
    expect(history.undoLabel).toBe('删除区间（波纹）');
    expect(history.depth).toBe(1);
    history.undo(executed.project);
    expect(history.redoLabel).toBe('删除区间（波纹）');
    expect(history.redoDepth).toBe(1);
    history.clear();
    expect(history.depth).toBe(0);
    expect(history.redoDepth).toBe(0);
  });

  it('历史长度受 MAX_HISTORY 限制', () => {
    const history = new CommandHistory();
    let current = linkedProject();
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      current = history.execute(current, cmd(current, { kind: 'SetTrackAudio', track: 'mic', gain: i % 4 })).project;
    }
    expect(history.depth).toBe(MAX_HISTORY);
  });
});

// ---------------------------------------------------------------------------
// 幂等命令与取消竞争
// ---------------------------------------------------------------------------

describe('IdempotentCommandRunner: 同一 requestId 重复执行结果一致', () => {
  it('重复执行返回同一结果且不重复应用', () => {
    const project = linkedProject();
    const runner = new IdempotentCommandRunner();
    const command = cmd(project, { kind: 'DeleteRange', range: { start: 2 * S, end: 4 * S }, ripple: true });
    const first = runner.execute(project, command);
    const second = runner.execute(project, command);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.project).toEqual(first.project);
    expect(second.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips).toHaveLength(2);
  });

  it('不同 requestId 依次应用', () => {
    const project = linkedProject();
    const runner = new IdempotentCommandRunner();
    const first = runner.execute(project, cmd(project, { kind: 'SetTrackAudio', track: 'mic', muted: true }));
    const second = runner.execute(
      first.project,
      cmd(first.project, { kind: 'SetTrackAudio', track: 'system', muted: true }),
    );
    expect(second.deduped).toBe(false);
    expect(second.project.tracks.find((t) => t.kind === 'mic')!.muted).toBe(true);
    expect(second.project.tracks.find((t) => t.kind === 'system')!.muted).toBe(true);
    expect(runner.size).toBe(2);
  });

  it('取消竞争：命令先执行后取消，重试同一 requestId 不再改工程', () => {
    const project = linkedProject();
    const runner = new IdempotentCommandRunner();
    const command = cmd(project, { kind: 'SetActiveVariant', variantId: 'square' });
    const executed = runner.execute(project, command);
    // 模拟取消后用户重试：同一 requestId 重放
    const retried = runner.execute(executed.project, command);
    expect(retried.deduped).toBe(true);
    expect(retried.project).toEqual(executed.project);
    expect(retried.project.settings.activeVariantId).toBe('square');
    // 只应用了一次：revision 只 +1
    expect(retried.project.revision).toBe(project.revision + 1);
  });

  it('has/get/clear', () => {
    const project = linkedProject();
    const runner = new IdempotentCommandRunner();
    const command = cmd(project, { kind: 'SetActiveVariant', variantId: 'square' });
    expect(runner.has(command.id)).toBe(false);
    const result = runner.execute(project, command);
    expect(runner.has(command.id)).toBe(true);
    expect(runner.get(command.id)!.project).toEqual(result.project);
    runner.clear();
    expect(runner.has(command.id)).toBe(false);
    expect(runner.size).toBe(0);
  });

  it('同一命令 ID 应用到不同工程快照时仍返回首次结果（幂等优先）', () => {
    const projectA = linkedProject();
    const projectB = linkedProject();
    projectB.name = 'other';
    const runner = new IdempotentCommandRunner();
    const command = cmd(projectA, { kind: 'SetActiveVariant', variantId: 'square' });
    const first = runner.execute(projectA, command);
    const second = runner.execute(projectB, command);
    expect(second.deduped).toBe(true);
    expect(second.project).toEqual(first.project);
  });
});

describe('describeCommand 中文标签', () => {
  it('覆盖所有命令类型', () => {
    const project = linkedProject();
    const kinds: ProjectCommand['kind'][] = [
      'SplitClip',
      'TrimClip',
      'DeleteRange',
      'MoveClip',
      'SetEffect',
      'DeleteEffect',
      'SetVariantOverride',
      'SetCanvasStyle',
      'SetTrackAudio',
      'SetStep',
      'DeleteStep',
      'ReorderSteps',
      'SetMarker',
      'SetActiveVariant',
      'SetFrameRate',
    ];
    for (const kind of kinds) {
      const label = describeCommand({ id: 'x', kind, expectedRevision: project.revision } as ProjectCommand);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
  it('固定种子可复现：同一 seed 生成的区间序列完全一致', () => {
    const lcgLocal = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
      };
    };
    function sequence(seed: number): string[] {
      const rand = lcgLocal(seed);
      const out: string[] = [];
      for (let i = 0; i < 200; i++) {
        const start = secondsToTicks(Math.floor(rand() * 8));
        const len = secondsToTicks(1 + Math.floor(rand() * 3));
        out.push(`${start}-${len}`);
      }
      return out;
    }
    expect(sequence(424242)).toEqual(sequence(424242));
    expect(sequence(424242)).not.toEqual(sequence(424243));
  });
});

describe('DeleteRange 属性测试：随机区间序列 200 组（固定种子）', () => {
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('ripple 删除后：各轨总时长 = 各片段时长之和，且三轨长度一致', () => {
    const rand = lcg(424242);
    for (let round = 0; round < 200; round++) {
      const project = linkedProject();
      const cutStart = secondsToTicks(Math.floor(rand() * 8));
      const cutLen = secondsToTicks(1 + Math.floor(rand() * 3));
      const range = { start: cutStart, end: Math.min(10 * S, cutStart + cutLen) };
      if (range.end <= range.start) continue;

      const result = applyCommand(project, cmd(project, { kind: 'DeleteRange', range, ripple: true }));

      for (const track of result.project.tracks) {
        if (track.clips.length === 0) continue;
        // 各片段时长之和 = 轨道覆盖时长（1 倍速下无重叠）
        const sum = track.clips.reduce((acc, c) => acc + c.sourceDurationTicks, 0);
        const span = Math.max(...track.clips.map((c) => c.timelineInTicks + c.sourceDurationTicks));
        const minStart = Math.min(...track.clips.map((c) => c.timelineInTicks));
        expect(sum).toBe(span - minStart);
        // 片段之间不重叠
        const sorted = [...track.clips].sort((a, b) => a.timelineInTicks - b.timelineInTicks);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].timelineInTicks).toBeGreaterThanOrEqual(
            sorted[i - 1].timelineInTicks + sorted[i - 1].sourceDurationTicks,
          );
        }
        // 时间线位置非负
        for (const c of track.clips) expect(c.timelineInTicks).toBeGreaterThanOrEqual(0);
      }

      // 三轨删除后总长一致（音画同步）
      const durations = ['primaryVideo', 'camera', 'mic'].map((kind) => {
        const track = result.project.tracks.find((t) => t.kind === kind)!;
        if (track.clips.length === 0) return 0;
        return Math.max(...track.clips.map((c) => c.timelineInTicks + c.sourceDurationTicks));
      });
      expect(new Set(durations).size).toBe(1);
      // 删除后的总长 = 原长 − 删除区间长度
      expect(durations[0]).toBe(10 * S - (range.end - range.start));
    }
  });

  it('事件映射不越界：随机效果/步骤在删除后仍落在工程时长内', () => {
    const rand = lcg(998877);
    for (let round = 0; round < 200; round++) {
      const project = linkedProject();
      // 随机效果
      const effectStart = secondsToTicks(Math.floor(rand() * 8));
      const effectEnd = Math.min(10 * S, effectStart + secondsToTicks(1 + Math.floor(rand() * 4)));
      if (effectEnd > effectStart) {
        project.effects.push(privacyEffect(`pv-${round}`, effectStart, effectEnd));
        project.effects.push(zoomEffect(`z-${round}`, effectStart, effectEnd));
      }
      // 随机步骤
      project.steps.push(step(`st-${round}`, effectStart, Math.max(effectStart + 1, effectEnd), effectStart));
      // 随机标记
      project.markers.push({ id: `m-${round}`, mediaTick: effectStart, note: '', createdAt: 0 });

      const cutStart = secondsToTicks(Math.floor(rand() * 8));
      const cutLen = secondsToTicks(1 + Math.floor(rand() * 3));
      const range = { start: cutStart, end: Math.min(10 * S, cutStart + cutLen) };
      if (range.end <= range.start) continue;

      const result = applyCommand(project, cmd(project, { kind: 'DeleteRange', range, ripple: true }));
      const duration = timelineDuration(result.project);

      for (const effect of result.project.effects) {
        expect(effect.range.start).toBeGreaterThanOrEqual(0);
        expect(effect.range.end).toBeGreaterThan(effect.range.start);
        // ripple 后事件必须仍在工程时长内（否则永远不会被求值到）
        expect(effect.range.start).toBeLessThanOrEqual(duration);
      }
      for (const s of result.project.steps) {
        expect(s.sourceRange.start).toBeGreaterThanOrEqual(0);
        expect(s.sourceRange.end).toBeGreaterThan(s.sourceRange.start);
        expect(s.imageTick).toBeGreaterThanOrEqual(s.sourceRange.start);
        expect(s.imageTick).toBeLessThan(s.sourceRange.end);
      }
      for (const m of result.project.markers) {
        expect(m.mediaTick).toBeGreaterThanOrEqual(0);
        expect(m.mediaTick).toBeLessThanOrEqual(duration);
      }
      // privacy 效果 id 唯一（拆段后不能撞 id）
      const privacyIds = result.project.effects.filter((e) => e.kind === 'privacy').map((e) => e.id);
      expect(new Set(privacyIds).size).toBe(privacyIds.length);
    }
  });

  it('随机 200 组：undo 后内容完全等于删除前，revision 递增', () => {
    const rand = lcg(13579);
    for (let round = 0; round < 200; round++) {
      const project = linkedProject();
      project.effects.push(privacyEffect('pv-1', 2 * S, 8 * S));
      project.steps.push(step('st-1', S, 9 * S, 5 * S));
      const history = new CommandHistory();
      const cutStart = secondsToTicks(Math.floor(rand() * 8));
      const cutLen = secondsToTicks(1 + Math.floor(rand() * 2));
      const range = { start: cutStart, end: Math.min(10 * S, cutStart + cutLen) };
      if (range.end <= range.start) continue;

      const executed = history.execute(
        project,
        cmd(project, { kind: 'DeleteRange', range, ripple: rand() > 0.5 }),
      );
      const undone = history.undo(executed.project)!;
      expect(undone.tracks).toEqual(project.tracks);
      expect(undone.effects).toEqual(project.effects);
      expect(undone.steps).toEqual(project.steps);
      expect(undone.markers).toEqual(project.markers);
      expect(undone.revision).toBeGreaterThan(executed.project.revision);
    }
  });
});
