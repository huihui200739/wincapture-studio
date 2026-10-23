import { describe, it, expect } from 'vitest';
import {
  validateProject,
  assertProjectValid,
  checkProjectRelativePath,
  checkSymlinkEscape,
  checkRange,
  rangesOverlap,
  projectDuration,
  removedLength,
} from '../../src/domain/validate';
import { createEmptyProject, PROJECT_SCHEMA_VERSION } from '../../src/domain/project';
import type { Project } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';

const S = TICKS_PER_SECOND;

function goodProject(): Project {
  const project = createEmptyProject('proj-1', 'valid');
  project.assets.push({
    id: 'screen-1',
    kind: 'screen',
    path: 'media/screen/seg-000001.mp4',
    hash: 'h1',
    durationTicks: 10 * S,
    width: 1920,
    height: 1080,
    sampleRate: 0,
    channels: 0,
    createdAt: 0,
  });
  project.tracks.find((t) => t.kind === 'primaryVideo')!.clips = [
    {
      id: 'clip-1',
      assetId: 'screen-1',
      sourceInTicks: 0,
      sourceDurationTicks: 10 * S,
      timelineInTicks: 0,
      rate: { num: 1, den: 1 },
      linkGroupId: 'rec-1',
    },
  ];
  return project;
}

describe('checkProjectRelativePath: 拒绝越界路径（§13.1 / T11）', () => {
  it('接受合法工程相对路径', () => {
    expect(checkProjectRelativePath('media/screen/seg-000001.mp4').ok).toBe(true);
    expect(checkProjectRelativePath('media\\mic\\seg-000001.wav').ok).toBe(true);
    expect(checkProjectRelativePath('events/pointer.jsonl').ok).toBe(true);
    expect(checkProjectRelativePath('./media/a.mp4').ok).toBe(true);
  });

  it('拒绝盘符绝对路径', () => {
    for (const path of ['C:\\Windows\\a.mp4', 'D:/media/a.mp4', 'c:relative.mp4']) {
      const result = checkProjectRelativePath(path);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('asset-path-absolute');
    }
  });

  it('拒绝 UNC 网络路径', () => {
    for (const path of ['\\\\server\\share\\a.mp4', '//server/share/a.mp4']) {
      const result = checkProjectRelativePath(path);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('asset-path-absolute');
    }
  });

  it('拒绝 Unix 绝对路径', () => {
    expect(checkProjectRelativePath('/etc/passwd').ok).toBe(false);
    expect(checkProjectRelativePath('\\media\\a.mp4').ok).toBe(false);
  });

  it('拒绝 ~ 展开路径', () => {
    expect(checkProjectRelativePath('~/media/a.mp4').ok).toBe(false);
  });

  it('拒绝 .. 越界（含「看起来在内部」的 a/../../b）', () => {
    for (const path of ['../a.mp4', 'media/../../a.mp4', 'media/../..', 'a/../../b.mp4', '..\\a.mp4']) {
      const result = checkProjectRelativePath(path);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('asset-path-traversal');
    }
  });

  it('拒绝空路径与控制字符', () => {
    expect(checkProjectRelativePath('').ok).toBe(false);
    expect(checkProjectRelativePath('   ').ok).toBe(false);
    expect(checkProjectRelativePath('media/a\u0000.mp4').ok).toBe(false);
    expect(checkProjectRelativePath('media/a\n.mp4').ok).toBe(false);
  });

  it('拒绝 Windows 保留设备名', () => {
    for (const path of ['media/CON', 'media/nul.mp4', 'COM1/a.mp4', 'lpt1']) {
      expect(checkProjectRelativePath(path).ok).toBe(false);
    }
  });

  it('拒绝超长路径', () => {
    expect(checkProjectRelativePath('a/'.repeat(600) + 'b.mp4').ok).toBe(false);
  });
});

describe('checkSymlinkEscape: 符号链接越界', () => {
  const root = 'C:\\projects\\demo.wcaproj';

  it('解析到工程内路径通过', () => {
    const result = checkSymlinkEscape('media/a.mp4', () => 'C:\\projects\\demo.wcaproj\\media\\a.mp4', root);
    expect(result.ok).toBe(true);
  });

  it('解析到工程外路径被拒绝', () => {
    const result = checkSymlinkEscape('media/a.mp4', () => 'C:\\Windows\\System32\\a.mp4', root);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('asset-path-symlink-escape');
  });

  it('解析失败时视为无法判定（不阻塞，交给素材重定位）', () => {
    expect(checkSymlinkEscape('media/a.mp4', () => null, root).ok).toBe(true);
  });

  it('前缀相似但不相同的目录不算在工程内', () => {
    const result = checkSymlinkEscape('media/a.mp4', () => 'C:\\projects\\demo.wcaproj-evil\\a.mp4', root);
    expect(result.ok).toBe(false);
  });
});

describe('checkRange / rangesOverlap', () => {
  it('严格 [start, end)：start < end 且非负整数', () => {
    expect(checkRange({ start: 0, end: 1 })).toBe(true);
    expect(checkRange({ start: 0, end: 0 })).toBe(false);
    expect(checkRange({ start: 5, end: 3 })).toBe(false);
    expect(checkRange({ start: -1, end: 5 })).toBe(false);
    expect(checkRange({ start: 0.5, end: 5 })).toBe(false);
    expect(checkRange({ start: 0, end: NaN })).toBe(false);
    expect(checkRange(null)).toBe(false);
  });

  it('allowEmpty 允许 start === end', () => {
    expect(checkRange({ start: 5, end: 5 }, true)).toBe(true);
  });

  it('相邻区间不重叠', () => {
    expect(rangesOverlap({ start: 0, end: 5 }, { start: 5, end: 10 })).toBe(false);
    expect(rangesOverlap({ start: 0, end: 6 }, { start: 5, end: 10 })).toBe(true);
  });
});

describe('validateProject: 合法工程', () => {
  it('合法工程无 error', () => {
    const result = validateProject(goodProject());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('返回结构化结果（issues/errors/warnings 都在）', () => {
    const result = validateProject(goodProject());
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('validateProject: schemaVersion 未来版本拒写（§13.4）', () => {
  it('schemaVersion 高于当前时返回 schema-future error', () => {
    const project = goodProject();
    project.schemaVersion = PROJECT_SCHEMA_VERSION + 1;
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    const issue = result.errors.find((e) => e.code === 'schema-future');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('只读');
  });

  it('allowFutureSchema 时只读检查通过', () => {
    const project = goodProject();
    project.schemaVersion = PROJECT_SCHEMA_VERSION + 1;
    const result = validateProject(project, { allowFutureSchema: true });
    expect(result.errors.find((e) => e.code === 'schema-future')).toBeUndefined();
  });

  it('schemaVersion 为 0 或缺失时报错', () => {
    const project = goodProject();
    project.schemaVersion = 0;
    expect(validateProject(project).errors.some((e) => e.code === 'schema-unsupported')).toBe(true);
  });
});

describe('validateProject: revision 单调与时间基准', () => {
  it('revision 为 0 或负数报错', () => {
    const project = goodProject();
    project.revision = 0;
    expect(validateProject(project).errors.some((e) => e.code === 'revision-invalid')).toBe(true);
    project.revision = -5;
    expect(validateProject(project).errors.some((e) => e.code === 'revision-invalid')).toBe(true);
  });

  it('revision 非整数报错', () => {
    const project = goodProject();
    project.revision = 1.5;
    expect(validateProject(project).errors.some((e) => e.code === 'revision-invalid')).toBe(true);
  });

  it('时间基准不是每秒 10^7 tick 报错', () => {
    const project = goodProject();
    project.timebase.ticksPerSecond = 1000;
    expect(validateProject(project).errors.some((e) => e.code === 'timebase-invalid')).toBe(true);
  });

  it('帧率非法报错', () => {
    const project = goodProject();
    project.settings.fps = { num: 0, den: 1 };
    expect(validateProject(project).errors.some((e) => e.code === 'fps-invalid')).toBe(true);
  });
});

describe('validateProject: 素材与路径', () => {
  it('素材绝对路径报错', () => {
    const project = goodProject();
    project.assets[0].path = 'C:\\Windows\\a.mp4';
    const result = validateProject(project);
    expect(result.errors.some((e) => e.code === 'asset-path-absolute')).toBe(true);
  });

  it('素材 .. 越界报错', () => {
    const project = goodProject();
    project.assets[0].path = '../../secret.mp4';
    const result = validateProject(project);
    expect(result.errors.some((e) => e.code === 'asset-path-traversal')).toBe(true);
  });

  it('符号链接越界报错（注入 resolvePath）', () => {
    const project = goodProject();
    const result = validateProject(project, {
      resolvePath: () => 'C:\\Windows\\a.mp4',
      projectRoot: 'C:\\projects\\demo.wcaproj',
    });
    expect(result.errors.some((e) => e.code === 'asset-path-symlink-escape')).toBe(true);
  });

  it('素材时长为 0 报错', () => {
    const project = goodProject();
    project.assets[0].durationTicks = 0;
    expect(validateProject(project).errors.some((e) => e.code === 'asset-duration-invalid')).toBe(true);
  });

  it('视频素材宽高为 0 报错', () => {
    const project = goodProject();
    project.assets[0].width = 0;
    expect(validateProject(project).errors.some((e) => e.code === 'asset-dimension-invalid')).toBe(true);
  });

  it('重复素材 ID 报错', () => {
    const project = goodProject();
    project.assets.push({ ...project.assets[0] });
    expect(validateProject(project).errors.some((e) => e.code === 'id-duplicate')).toBe(true);
  });
});

describe('validateProject: 片段引用与时间区间', () => {
  it('clip 引用不存在的 assetId 报错', () => {
    const project = goodProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].assetId = 'missing';
    expect(validateProject(project).errors.some((e) => e.code === 'clip-asset-missing')).toBe(true);
  });

  it('sourceIn + sourceDuration 超素材时长报错', () => {
    const project = goodProject();
    const clip = project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0];
    clip.sourceInTicks = 5 * S;
    clip.sourceDurationTicks = 10 * S; // 5+10 > 10
    expect(validateProject(project).errors.some((e) => e.code === 'clip-source-out-of-range')).toBe(true);
  });

  it('sourceIn + sourceDuration 恰好等于素材时长时通过', () => {
    const project = goodProject();
    const clip = project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0];
    clip.sourceInTicks = 0;
    clip.sourceDurationTicks = 10 * S;
    expect(validateProject(project).errors.some((e) => e.code === 'clip-source-out-of-range')).toBe(false);
  });

  it('sourceIn 为负报错', () => {
    const project = goodProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].sourceInTicks = -1;
    expect(validateProject(project).errors.some((e) => e.code === 'clip-range-invalid')).toBe(true);
  });

  it('sourceDuration 为 0 报错', () => {
    const project = goodProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].sourceDurationTicks = 0;
    expect(validateProject(project).errors.some((e) => e.code === 'clip-range-invalid')).toBe(true);
  });

  it('timelineIn 为负报错', () => {
    const project = goodProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].timelineInTicks = -S;
    expect(validateProject(project).errors.some((e) => e.code === 'clip-range-invalid')).toBe(true);
  });

  it('同轨片段时间线重叠报错', () => {
    const project = goodProject();
    project.assets[0].durationTicks = 30 * S;
    const track = project.tracks.find((t) => t.kind === 'primaryVideo')!;
    track.clips = [
      { ...track.clips[0], id: 'c1', timelineInTicks: 0, sourceInTicks: 0, sourceDurationTicks: 10 * S },
      { ...track.clips[0], id: 'c2', timelineInTicks: 5 * S, sourceInTicks: 10 * S, sourceDurationTicks: 10 * S },
    ];
    expect(validateProject(project).errors.some((e) => e.code === 'clip-timeline-overlap')).toBe(true);
  });

  it('相邻片段（不重叠）通过', () => {
    const project = goodProject();
    project.assets[0].durationTicks = 30 * S;
    const track = project.tracks.find((t) => t.kind === 'primaryVideo')!;
    track.clips = [
      { ...track.clips[0], id: 'c1', timelineInTicks: 0, sourceInTicks: 0, sourceDurationTicks: 10 * S },
      { ...track.clips[0], id: 'c2', timelineInTicks: 10 * S, sourceInTicks: 10 * S, sourceDurationTicks: 10 * S },
    ];
    expect(validateProject(project).errors.some((e) => e.code === 'clip-timeline-overlap')).toBe(false);
  });

  it('嵌套重叠（中间夹一个短片段）同样报错', () => {
    const project = goodProject();
    project.assets[0].durationTicks = 30 * S;
    const track = project.tracks.find((t) => t.kind === 'primaryVideo')!;
    track.clips = [
      { ...track.clips[0], id: 'long', timelineInTicks: 0, sourceInTicks: 0, sourceDurationTicks: 20 * S },
      { ...track.clips[0], id: 'short', timelineInTicks: 2 * S, sourceInTicks: 20 * S, sourceDurationTicks: S },
      { ...track.clips[0], id: 'tail', timelineInTicks: 4 * S, sourceInTicks: 21 * S, sourceDurationTicks: S },
    ];
    const overlaps = validateProject(project).errors.filter((e) => e.code === 'clip-timeline-overlap');
    // 旧实现只和「紧邻的前一个」比：tail 的前一个是 short（结束 3s < 4s），漏检
    expect(overlaps.some((e) => e.entityId === 'short')).toBe(true);
    expect(overlaps.some((e) => e.entityId === 'tail')).toBe(true);
  });

  it('checkOverlap=false 时跳过重叠检查', () => {
    const project = goodProject();
    project.assets[0].durationTicks = 30 * S;
    const track = project.tracks.find((t) => t.kind === 'primaryVideo')!;
    track.clips = [
      { ...track.clips[0], id: 'c1', timelineInTicks: 0, sourceInTicks: 0, sourceDurationTicks: 10 * S },
      { ...track.clips[0], id: 'c2', timelineInTicks: 5 * S, sourceInTicks: 10 * S, sourceDurationTicks: 10 * S },
    ];
    const result = validateProject(project, { checkOverlap: false });
    expect(result.errors.some((e) => e.code === 'clip-timeline-overlap')).toBe(false);
  });

  it('播放速率非法报错', () => {
    const project = goodProject();
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].rate = { num: 0, den: 1 };
    expect(validateProject(project).errors.some((e) => e.code === 'clip-rate-invalid')).toBe(true);
  });

  it('重复轨道类型报错', () => {
    const project = goodProject();
    project.tracks.push({ ...project.tracks[0], id: 'main2', clips: [] });
    expect(validateProject(project).errors.some((e) => e.code === 'track-kind-duplicate')).toBe(true);
  });
});

describe('validateProject: 效果与步骤区间', () => {
  it('效果区间非法（start >= end）报错', () => {
    const project = goodProject();
    project.effects.push({
      id: 'e1',
      kind: 'zoom',
      range: { start: 5 * S, end: 5 * S },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'effect-range-invalid')).toBe(true);
  });

  it('效果区间超出工程时长给 warning', () => {
    const project = goodProject();
    project.effects.push({
      id: 'e1',
      kind: 'zoom',
      range: { start: 20 * S, end: 25 * S },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    const result = validateProject(project);
    expect(result.warnings.some((e) => e.code === 'effect-range-out-of-project')).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('运镜缩放倍数 < 1 报错', () => {
    const project = goodProject();
    project.effects.push({
      id: 'e1',
      kind: 'zoom',
      range: { start: 0, end: S },
      parameters: { scale: 0.5, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'effect-parameters-invalid')).toBe(true);
  });

  it('运镜焦点超出 [0,1] 报错', () => {
    const project = goodProject();
    project.effects.push({
      id: 'e1',
      kind: 'zoom',
      range: { start: 0, end: S },
      parameters: { scale: 2, focusX: 1.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'effect-parameters-invalid')).toBe(true);
  });

  it('运镜焦点为 NaN 同样报错（NaN 通过范围比较会被漏掉）', () => {
    const project = goodProject();
    project.effects.push({
      id: 'e-nan',
      kind: 'zoom',
      range: { start: 0, end: S },
      parameters: { scale: 2, focusX: Number.NaN, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'effect-parameters-invalid')).toBe(true);
  });

  it('未确认的遮挡给 warning（未确认不等于已遮挡）', () => {
    const project = goodProject();
    project.effects.push({
      id: 'pv-1',
      kind: 'privacy',
      range: { start: 0, end: S },
      anchor: 'screen',
      parameters: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, anchor: 'screen', style: 'solid', confirmed: false },
      origin: 'manual',
      locked: true,
    });
    const result = validateProject(project);
    expect(result.warnings.some((e) => e.code === 'privacy-unconfirmed')).toBe(true);
  });

  it('遮挡宽高为 0 报错', () => {
    const project = goodProject();
    project.effects.push({
      id: 'pv-1',
      kind: 'privacy',
      range: { start: 0, end: S },
      anchor: 'screen',
      parameters: { x: 0.1, y: 0.1, width: 0, height: 0.2, anchor: 'screen', style: 'solid', confirmed: true },
      origin: 'manual',
      locked: true,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'effect-parameters-invalid')).toBe(true);
  });

  it('步骤区间非法报错', () => {
    const project = goodProject();
    project.steps.push({
      id: 's1',
      sourceRange: { start: 5 * S, end: 5 * S },
      title: 't',
      description: '',
      imageTick: 5 * S,
      actionRect: null,
      source: 'manual',
      privacyVersion: 0,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'step-range-invalid')).toBe(true);
  });

  it('步骤 imageTick 为负报错', () => {
    const project = goodProject();
    project.steps.push({
      id: 's1',
      sourceRange: { start: 0, end: S },
      title: 't',
      description: '',
      imageTick: -1,
      actionRect: null,
      source: 'manual',
      privacyVersion: 0,
    });
    expect(validateProject(project).errors.some((e) => e.code === 'step-image-out-of-range')).toBe(true);
  });

  it('步骤截图时间超出工程时长给 warning', () => {
    const project = goodProject();
    project.steps.push({
      id: 's1',
      sourceRange: { start: 0, end: S },
      title: 't',
      description: '',
      imageTick: 100 * S,
      actionRect: null,
      source: 'manual',
      privacyVersion: 0,
    });
    expect(validateProject(project).warnings.some((e) => e.code === 'step-image-out-of-range')).toBe(true);
  });
});

describe('validateProject: 画幅与标记', () => {
  it('画幅宽高比非法报错', () => {
    const project = goodProject();
    project.variants[0].aspect = [0, 9];
    expect(validateProject(project).errors.some((e) => e.code === 'variant-invalid')).toBe(true);
  });

  it('激活画幅不存在报错', () => {
    const project = goodProject();
    project.settings.activeVariantId = 'nope';
    expect(validateProject(project).errors.some((e) => e.code === 'variant-invalid')).toBe(true);
  });

  it('标记时间为负报错', () => {
    const project = goodProject();
    project.markers.push({ id: 'm1', mediaTick: -1, note: '', createdAt: 0 });
    expect(validateProject(project).errors.some((e) => e.code === 'marker-out-of-range')).toBe(true);
  });
});

describe('validateProject: 收集全部错误而不短路（关键要求）', () => {
  it('同时报告多个问题', () => {
    const project = goodProject();
    project.revision = 0; // 问题 1
    project.assets[0].path = 'C:\\abs\\a.mp4'; // 问题 2
    project.assets[0].durationTicks = 0; // 问题 3
    project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0].assetId = 'missing'; // 问题 4
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    const codes = new Set(result.errors.map((e) => e.code));
    expect(codes.has('revision-invalid')).toBe(true);
    expect(codes.has('asset-path-absolute')).toBe(true);
    expect(codes.has('asset-duration-invalid')).toBe(true);
    expect(codes.has('clip-asset-missing')).toBe(true);
  });

  it('每个错误都带 entity / entityId / 中文 message', () => {
    const project = goodProject();
    project.assets[0].path = 'C:\\abs\\a.mp4';
    const result = validateProject(project);
    for (const issue of result.errors) {
      expect(issue.entity).toBeTruthy();
      expect(typeof issue.entityId).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.severity).toBe('error');
    }
  });

  it('空/非法工程对象返回结构化错误而不抛异常', () => {
    const result = validateProject(null as unknown as Project);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('assertProjectValid', () => {
  it('合法工程不抛错', () => {
    expect(() => assertProjectValid(goodProject())).not.toThrow();
  });

  it('非法工程抛错并汇总问题', () => {
    const project = goodProject();
    project.revision = 0;
    expect(() => assertProjectValid(project)).toThrowError(/工程校验未通过/);
  });
});

describe('projectDuration / removedLength', () => {
  it('工程时长取自主轨', () => {
    expect(projectDuration(goodProject())).toBe(10 * S);
  });

  it('removedLength 汇总区间长度', () => {
    expect(removedLength([{ start: 0, end: S }, { start: 2 * S, end: 3 * S }])).toBe(2 * S);
    expect(removedLength([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 回归测试：损坏结构不抛异常、路径归一化绕过、重复 ID、空区间
// ---------------------------------------------------------------------------

describe('回归：损坏的工程结构返回结构化错误而不是抛 TypeError', () => {
  it('tracks / assets / effects / markers 缺失或类型错误时不抛异常', () => {
    const base = goodProject();
    const malformed = [
      { ...base, tracks: undefined },
      { ...base, tracks: {} },
      { ...base, assets: {} },
      { ...base, effects: 'broken' },
      { ...base, steps: 42 },
      { ...base, variants: null },
      { ...base, markers: {} },
    ];
    for (const project of malformed) {
      const result = validateProject(project as unknown as Project);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => typeof e.message === 'string' && e.message.length > 0)).toBe(true);
    }
  });

  it('轨道 clips 不是数组时不抛异常', () => {
    const project = goodProject();
    (project.tracks.find((t) => t.kind === 'primaryVideo') as unknown as { clips: unknown }).clips = 'broken';
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'schema-unsupported')).toBe(true);
  });
});

describe('回归：路径校验的 Windows 归一化绕过', () => {
  it('拒绝尾随点/空格的 .. 与保留名（Windows 会忽略尾随字符）', () => {
    for (const path of ['a/.. /b', 'media/.. /secret.mp4', 'media/con. /x', 'media/CON.', 'media/nul ', 'media/...']) {
      const result = checkProjectRelativePath(path);
      expect(result.ok, path).toBe(false);
      expect(result.code).toBe('asset-path-traversal');
    }
  });

  it('拒绝 NTFS 备用数据流（ADS）冒号', () => {
    const result = checkProjectRelativePath('media/a.mp4:evil');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('asset-path-traversal');
  });

  it('合法路径仍通过（含 . 段与普通点号文件名）', () => {
    for (const path of ['media/a.b.mp4', './media/a.mp4', 'media/.hidden/a.mp4', 'events/pointer.jsonl']) {
      expect(checkProjectRelativePath(path).ok, path).toBe(true);
    }
  });
});

describe('回归：重复 ID 检测覆盖效果/步骤/画幅/标记', () => {
  it('重复效果 ID 报 id-duplicate（SetEffect 只会更新第一条）', () => {
    const project = goodProject();
    const effect = {
      kind: 'zoom' as const,
      range: { start: 0, end: S },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual' as const,
      locked: true,
    };
    project.effects.push({ ...effect, id: 'dup' }, { ...effect, id: 'dup', range: { start: S, end: 2 * S } });
    const result = validateProject(project);
    expect(result.errors.some((e) => e.code === 'id-duplicate' && e.entity === 'effect')).toBe(true);
  });

  it('重复步骤/标记/画幅 ID 报 id-duplicate', () => {
    const project = goodProject();
    project.steps.push(
      { id: 's-dup', sourceRange: { start: 0, end: S }, title: 'a', description: '', imageTick: 0, actionRect: null, source: 'manual', privacyVersion: 0 },
      { id: 's-dup', sourceRange: { start: S, end: 2 * S }, title: 'b', description: '', imageTick: S, actionRect: null, source: 'manual', privacyVersion: 0 },
    );
    project.markers.push({ id: 'm-dup', mediaTick: 0, note: '', createdAt: 0 }, { id: 'm-dup', mediaTick: S, note: '', createdAt: 0 });
    project.variants.push({ id: 'landscape', aspect: [16, 9], layoutOverrides: {} });
    const codes = validateProject(project).errors.filter((e) => e.code === 'id-duplicate').map((e) => e.entity);
    expect(codes).toContain('step');
    expect(codes).toContain('marker');
    expect(codes).toContain('variant');
  });
});

describe('回归：rangesOverlap 空区间不与任何区间重叠', () => {
  it('空区间被大区间包含时仍不算重叠', () => {
    expect(rangesOverlap({ start: 5, end: 5 }, { start: 0, end: 10 })).toBe(false);
    expect(rangesOverlap({ start: 0, end: 10 }, { start: 3, end: 3 })).toBe(false);
    expect(rangesOverlap({ start: 3, end: 5 }, { start: 0, end: 10 })).toBe(true);
  });
});
