import { describe, it, expect } from 'vitest';
import {
  readProject,
  writeProject,
  parseProjectJson,
  serializeProject,
  readOnlyNotice,
  SchemaFutureError,
} from '../../src/domain/migration';
import { createEmptyProject, PROJECT_SCHEMA_VERSION } from '../../src/domain/project';
import type { Project } from '../../src/domain/project';
import { TICKS_PER_SECOND, secondsToTicks } from '../../src/domain/timebase';
import { AppError } from '../../src/shared/errors';

const S = TICKS_PER_SECOND;

function sampleProject(): Project {
  const project = createEmptyProject('proj-1', 'migration', 1_700_000_000_000);
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
    createdAt: 1_700_000_000_000,
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

describe('readProject: 当前版本', () => {
  it('当前版本无需迁移', () => {
    const result = readProject(sampleProject());
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(result.toVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(result.steps).toHaveLength(0);
    expect(result.backup).toBeNull();
    expect(result.readOnlyNotice).toBeNull();
  });

  it('读取后结构完整（轨道/画幅/设置都在）', () => {
    const result = readProject(sampleProject());
    expect(result.project.tracks).toHaveLength(4);
    expect(result.project.variants.length).toBeGreaterThan(0);
    expect(result.project.settings.fps.num).toBeGreaterThan(0);
  });
});

describe('readProject: 未来版本拒写（E_SCHEMA_FUTURE）', () => {
  it('未来版本默认只读，返回只读提示', () => {
    const raw = { ...sampleProject(), schemaVersion: PROJECT_SCHEMA_VERSION + 1 };
    const result = readProject(raw);
    expect(result.readOnlyNotice).not.toBeNull();
    expect(result.readOnlyNotice).toContain('只读');
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(PROJECT_SCHEMA_VERSION + 1);
  });

  it('allowReadOnlyFuture=false 时抛 E_SCHEMA_FUTURE', () => {
    const raw = { ...sampleProject(), schemaVersion: PROJECT_SCHEMA_VERSION + 1 };
    try {
      readProject(raw, { allowReadOnlyFuture: false });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('E_SCHEMA_FUTURE');
      expect((error as AppError).retryable).toBe(false);
      expect((error as AppError).preservedData).toBe(true);
    }
  });

  it('writeProject 遇到未来版本抛 E_SCHEMA_FUTURE（拒绝覆盖写入）', () => {
    const project = sampleProject();
    project.schemaVersion = PROJECT_SCHEMA_VERSION + 5;
    try {
      writeProject(project);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('E_SCHEMA_FUTURE');
    }
  });

  it('SchemaFutureError 带版本信息', () => {
    const error = new SchemaFutureError(9, 1);
    expect(error.code).toBe('E_SCHEMA_FUTURE');
    expect(error.foundVersion).toBe(9);
    expect(error.supportedVersion).toBe(1);
    expect(error.message).toContain('9');
    expect(error.toShape().code).toBe('E_SCHEMA_FUTURE');
  });

  it('readOnlyNotice 文案包含版本号', () => {
    const notice = readOnlyNotice(7, 1);
    expect(notice).toContain('v7');
    expect(notice).toContain('v1');
    expect(notice).toContain('只读');
  });
});

describe('readProject: 旧版本迁移前备份', () => {
  it('v0 迁移到 v1 时保留备份', () => {
    const legacy = { ...sampleProject(), schemaVersion: 0 };
    const result = readProject(legacy);
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(result.backup).not.toBeNull();
    expect(result.backup!.schemaVersion).toBe(0); // 备份保留原版本
    expect(result.backupFileName).toBe('project.v0.backup.json');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('迁移后工程版本为目标版本', () => {
    const legacy = { ...sampleProject(), schemaVersion: 0 };
    const result = readProject(legacy);
    expect(result.project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('迁移补齐缺失字段（tracks/variants/settings）', () => {
    const legacy = { schemaVersion: 0, id: 'x', name: '旧工程', revision: 3 } as unknown as Project;
    const result = readProject(legacy);
    expect(result.project.tracks).toHaveLength(4);
    expect(result.project.variants.length).toBeGreaterThan(0);
    expect(result.project.settings.fps.num).toBeGreaterThan(0);
    expect(result.project.revision).toBe(3);
    expect(result.project.name).toBe('旧工程');
  });

  it('迁移记录含 from/to/description', () => {
    const legacy = { ...sampleProject(), schemaVersion: 0 };
    const result = readProject(legacy);
    for (const step of result.steps) {
      expect(step.to).toBe(step.from + 1);
      expect(step.description.length).toBeGreaterThan(0);
    }
  });

  it('备份是深拷贝，后续修改不影响备份', () => {
    const legacy = { ...sampleProject(), schemaVersion: 0 };
    const result = readProject(legacy);
    result.project.name = '改名了';
    expect(result.backup!.name).not.toBe('改名了');
  });
});

describe('readProject: 损坏与非法输入', () => {
  it('null / 非对象抛 E_PROJECT_CORRUPT', () => {
    for (const raw of [null, undefined, 42, 'text']) {
      try {
        readProject(raw);
        throw new Error('应当抛错');
      } catch (error) {
        expect((error as AppError).code).toBe('E_PROJECT_CORRUPT');
      }
    }
  });

  it('缺少 schemaVersion 抛 E_PROJECT_CORRUPT', () => {
    try {
      readProject({ id: 'x' });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('E_PROJECT_CORRUPT');
    }
  });

  it('schemaVersion 非法（NaN/负数）抛错', () => {
    for (const version of [NaN, -1, 0.5]) {
      try {
        readProject({ schemaVersion: version, id: 'x' });
        throw new Error('应当抛错');
      } catch (error) {
        expect((error as AppError).code).toBe('E_PROJECT_CORRUPT');
      }
    }
  });
});

describe('serializeProject / parseProjectJson', () => {
  it('往返保持结构', () => {
    const project = sampleProject();
    const json = serializeProject(project);
    const result = parseProjectJson(json);
    expect(result.project.id).toBe(project.id);
    expect(result.project.tracks[0].clips[0].sourceDurationTicks).toBe(10 * S);
    expect(result.project.assets[0].path).toBe(project.assets[0].path);
  });

  it('序列化为可读 JSON（2 空格缩进）', () => {
    const json = serializeProject(sampleProject());
    expect(json).toContain('\n  ');
    expect(json.startsWith('{')).toBe(true);
  });

  it('非法 JSON 抛 E_PROJECT_CORRUPT', () => {
    try {
      parseProjectJson('{ not json');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('E_PROJECT_CORRUPT');
    }
  });

  it('十进制字符串形式的 tick 被解析（§13.3）', () => {
    const raw = {
      ...sampleProject(),
      tracks: [
        {
          id: 'main',
          kind: 'primaryVideo',
          muted: false,
          gain: 1,
          clips: [
            {
              id: 'c1',
              assetId: 'screen-1',
              sourceInTicks: '0',
              sourceDurationTicks: '40000000',
              timelineInTicks: '0',
              rate: { num: 1, den: 1 },
              linkGroupId: 'g',
            },
          ],
        },
      ],
    };
    const result = readProject(raw);
    const clip = result.project.tracks.find((t) => t.kind === 'primaryVideo')!.clips[0];
    expect(clip.sourceDurationTicks).toBe(4 * S);
  });

  it('未来版本的 JSON 只读读取不抛错', () => {
    const raw = JSON.stringify({ ...sampleProject(), schemaVersion: PROJECT_SCHEMA_VERSION + 2 });
    const result = parseProjectJson(raw);
    expect(result.readOnlyNotice).not.toBeNull();
  });
});

describe('writeProject', () => {
  it('当前版本可写', () => {
    const project = sampleProject();
    const written = writeProject(project);
    expect(written.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(written.tracks).toHaveLength(4);
  });

  it('写入时补齐缺失轨道', () => {
    const project = sampleProject();
    project.tracks = project.tracks.filter((t) => t.kind === 'primaryVideo');
    const written = writeProject(project);
    expect(written.tracks).toHaveLength(4);
  });

  it('写入时把非法 revision 规整为 1', () => {
    const project = sampleProject();
    project.revision = 0;
    expect(writeProject(project).revision).toBe(1);
  });

  it('写入时把激活画幅不存在的情况回退到第一个画幅', () => {
    const project = sampleProject();
    project.settings.activeVariantId = 'nope';
    const written = writeProject(project);
    expect(written.variants.some((v) => v.id === written.settings.activeVariantId)).toBe(true);
  });

  it('写入时夹紧非法的效果/步骤区间（start < end）', () => {
    const project = sampleProject();
    project.effects.push({
      id: 'e1',
      kind: 'zoom',
      range: { start: 5 * S, end: 5 * S },
      parameters: { scale: 2, focusX: 0.5, focusY: 0.5, easeInTicks: 0, easeOutTicks: 0 },
      origin: 'manual',
      locked: true,
    });
    const written = writeProject(project);
    const effect = written.effects[0];
    expect(effect.range.end).toBeGreaterThan(effect.range.start);
  });

  it('写入的工程可再次被 readProject 读取', () => {
    const written = writeProject(sampleProject());
    const result = readProject(written);
    expect(result.migrated).toBe(false);
    expect(result.project.id).toBe(written.id);
  });
});

// ---------------------------------------------------------------------------
// 回归：未来版本只读读取也必须给出完整结构
// ---------------------------------------------------------------------------

describe('回归：未来版本只读读取的结构规整', () => {
  it('缺少集合字段时补全为空结构，同时保留未来新增字段', () => {
    const result = readProject({
      schemaVersion: PROJECT_SCHEMA_VERSION + 1,
      id: 'future',
      name: '未来工程',
      futureFeature: { a: 1 },
    });
    expect(result.readOnlyNotice).not.toBeNull();
    expect(result.project.tracks).toHaveLength(4);
    expect(result.project.assets).toEqual([]);
    expect(result.project.effects).toEqual([]);
    expect(result.project.steps).toEqual([]);
    expect(result.project.markers).toEqual([]);
    expect(result.project.variants.length).toBeGreaterThan(0);
    expect(result.project.settings.fps.num).toBeGreaterThan(0);
    // 只读模式不能把版本号降到当前版本（否则后续写入会以为可覆盖）
    expect(result.project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION + 1);
    // 未来版本新增的字段不能被丢弃
    expect((result.project as unknown as { futureFeature?: unknown }).futureFeature).toEqual({ a: 1 });
  });

  it('对同一输入读取两次结果一致（幂等）', () => {
    const raw = { schemaVersion: PROJECT_SCHEMA_VERSION + 1, id: 'future', name: 'x' };
    expect(readProject(raw).project).toEqual(readProject(raw).project);
  });
});
