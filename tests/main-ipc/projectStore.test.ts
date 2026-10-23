/**
 * 工程存储（electron/projectStore.ts）单元测试。
 *
 * 该模块只依赖 node:fs/path/crypto 与 src/domain，不 import electron，
 * 因此可以直接在 vitest（node 环境）里跑真实文件 IO。
 *
 * 覆盖的是本次审计修复的行为：
 * - 路径穿越 / 绝对路径 / NUL 拒绝，isPathInside 边界
 * - 原子写入、并发保存串行化、临时文件清理
 * - 损坏 project.json 回退 prev，且不会用损坏内容覆盖好快照
 * - 未来版本禁止覆盖保存；旧版本经迁移模块升级并留下备份
 * - 最近列表去重/上限/持久化
 * - 导入不覆盖已有工程、导出不能写进工程目录内部
 * - 素材按内容哈希重定位（空哈希不得命中）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ProjectStore,
  createProject,
  hashFile,
  isPathInside,
} from '../../electron/projectStore';
import { PROJECT_SCHEMA_VERSION, type Project } from '../../src/domain/project';

const tempDirs: string[] = [];
const silentStore = (userDataPath: string): ProjectStore =>
  new ProjectStore(userDataPath, { videosPath: () => path.join(userDataPath, 'Videos'), homePath: () => userDataPath });

function makeStore(): { store: ProjectStore; root: string; userData: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wcs-store-'));
  tempDirs.push(root);
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return { store: silentStore(userData), root, userData };
}

function makeProjectDir(root: string, name = 'proj'): string {
  const dir = path.join(root, `${name}.wcaproj`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleProject(name = '测试工程'): Project {
  return createProject(name);
}

function tempLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-') || name.endsWith('.partial'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProjectStore.resolveInside / isPathInside', () => {
  it('允许工程内相对路径', () => {
    const resolved = ProjectStore.resolveInside('C:\\projects\\a.wcaproj', 'media/screen/seg-000001.mp4');
    expect(resolved.toLowerCase()).toBe('c:\\projects\\a.wcaproj\\media\\screen\\seg-000001.mp4');
  });

  it.each(['../secret.txt', 'media/../../secret.txt', 'C:\\Windows\\win.ini', '\\\\server\\share\\x', 'media/\0evil'])(
    '拒绝越界/绝对/非法路径：%s',
    (bad) => {
      expect(() => ProjectStore.resolveInside('C:\\projects\\a.wcaproj', bad)).toThrow();
    },
  );

  it('拒绝空路径与指向工程根本身', () => {
    expect(() => ProjectStore.resolveInside('C:\\p\\a.wcaproj', '')).toThrow();
    expect(() => ProjectStore.resolveInside('C:\\p\\a.wcaproj', '.')).toThrow();
  });

  it('isPathInside 处理前缀同名目录与大小写', () => {
    expect(isPathInside('C:\\a\\b', 'C:\\a\\b\\c.txt')).toBe(true);
    expect(isPathInside('C:\\a\\b', 'C:\\A\\B\\C.TXT')).toBe(true);
    expect(isPathInside('C:\\a\\b', 'C:\\a\\bc\\c.txt')).toBe(false);
    expect(isPathInside('C:\\a\\b', 'C:\\a\\b')).toBe(true);
    expect(isPathInside('C:\\', 'D:\\x')).toBe(false);
  });
});

describe('ProjectStore 原子保存', () => {
  it('保存后可读回，revision/updatedAt 正确且无临时文件残留', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    const project = sampleProject('第一个工程');
    project.assets.push({
      id: 'a1',
      kind: 'screen',
      path: 'media/screen/seg-000001.mp4',
      hash: '',
      durationTicks: 1_000,
      width: 1920,
      height: 1080,
      sampleRate: 0,
      channels: 0,
      createdAt: Date.now(),
    });

    const result = await store.save(dir, project);
    expect(result.revision).toBe(project.revision);

    const loaded = await store.load(dir);
    expect(loaded.project.name).toBe('第一个工程');
    expect(loaded.project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(loaded.missingAssets).toEqual(['a1']);
    expect(loaded.recoveredFromPrev).toBe(false);
    expect(tempLeftovers(dir)).toEqual([]);
  });

  it('第二次保存保留上一版快照 project.prev.json', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    await store.save(dir, sampleProject('v1'));
    await store.save(dir, { ...sampleProject('v2'), id: 'same-id' });
    const prev = JSON.parse(fs.readFileSync(path.join(dir, 'project.prev.json'), 'utf8')) as Project;
    expect(prev.name).toBe('v1');
  });

  it('同一工程并发保存不互相踩踏（唯一临时名 + 串行化）', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    const base = sampleProject('并发');
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.save(dir, { ...base, id: `id-${index}`, name: `n${index}`, revision: index + 1 }),
      ),
    );
    const loaded = await store.load(dir);
    // 队列按调用顺序执行，最后一次落盘的是 n7
    expect(loaded.project.name).toBe('n7');
    expect(loaded.project.id).toBe('id-7');
    expect(tempLeftovers(dir)).toEqual([]);
  });

  it('拒绝未来版本保存（E_SCHEMA_FUTURE）', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    const future = { ...sampleProject('future'), schemaVersion: PROJECT_SCHEMA_VERSION + 1 };
    await expect(store.save(dir, future)).rejects.toMatchObject({ code: 'E_SCHEMA_FUTURE' });
    expect(fs.existsSync(path.join(dir, 'project.json'))).toBe(false);
  });

  it('拒绝包含绝对路径素材的工程', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    const project = sampleProject('bad');
    project.assets.push({
      id: 'a1',
      kind: 'screen',
      path: 'C:\\Windows\\win.ini',
      hash: '',
      durationTicks: 0,
      width: 0,
      height: 0,
      sampleRate: 0,
      channels: 0,
      createdAt: Date.now(),
    });
    await expect(store.save(dir, project)).rejects.toMatchObject({ code: 'E_PROJECT_CORRUPT' });
    expect(tempLeftovers(dir)).toEqual([]);
  });
});

describe('ProjectStore 损坏容错', () => {
  it('主文件损坏时回退 project.prev.json，且后续保存不会覆盖好快照', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    await store.save(dir, sampleProject('v1'));
    await store.save(dir, { ...sampleProject('v2'), id: 'same-id' });
    // 破坏主文件
    fs.writeFileSync(path.join(dir, 'project.json'), '{ not-json', 'utf8');

    const recovered = await store.load(dir);
    expect(recovered.recoveredFromPrev).toBe(true);
    expect(recovered.project.name).toBe('v1');

    // 再保存一次：不能把损坏内容备份覆盖掉 good prev
    await store.save(dir, { ...sampleProject('v3'), id: 'same-id' });
    const prev = JSON.parse(fs.readFileSync(path.join(dir, 'project.prev.json'), 'utf8')) as Project;
    expect(prev.name).toBe('v1');
    const main = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as Project;
    expect(main.name).toBe('v3');
  });

  it('主文件 JSON 损坏且无快照时报 E_PROJECT_CORRUPT', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    fs.writeFileSync(path.join(dir, 'project.json'), 'not json at all', 'utf8');
    await expect(store.load(dir)).rejects.toMatchObject({ code: 'E_PROJECT_CORRUPT' });
  });

  it('未来版本只读打开，不回退旧快照、不允许保存覆盖', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    await store.save(dir, sampleProject('old'));
    const future = { ...createProject('future'), schemaVersion: PROJECT_SCHEMA_VERSION + 5 };
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(future, null, 2), 'utf8');

    const loaded = await store.load(dir);
    expect(loaded.recoveredFromPrev).toBe(false);
    expect(loaded.project.name).toBe('future');
    expect(loaded.readOnlyNotice).not.toBeNull();
    await expect(store.save(dir, loaded.project)).rejects.toMatchObject({ code: 'E_SCHEMA_FUTURE' });
  });

  it('旧版本工程经迁移升级并写迁移备份', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    fs.writeFileSync(
      path.join(dir, 'project.json'),
      JSON.stringify({ schemaVersion: 0, id: 'legacy', name: '旧工程', createdAt: 1 }),
      'utf8',
    );

    const loaded = await store.load(dir);
    expect(loaded.migratedFrom).toBe(0);
    expect(loaded.project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(loaded.project.id).toBe('legacy');
    expect(loaded.project.tracks.map((track) => track.kind)).toEqual(['primaryVideo', 'camera', 'mic', 'system']);
    expect(fs.existsSync(path.join(dir, 'project.v0.backup.json'))).toBe(true);
    // 迁移结果已原子写回
    const main = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as Project;
    expect(main.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });
});

describe('ProjectStore 最近工程', () => {
  it('去重、按更新时间排序，并过滤已删除目录', async () => {
    const { store, root } = makeStore();
    const dirA = makeProjectDir(root, 'a');
    const dirB = makeProjectDir(root, 'b');
    const project = sampleProject('a');
    project.assets = [];
    await store.touchRecent(dirA, project);
    await store.touchRecent(dirB, { ...project, id: 'b-id', name: 'b' });
    await store.touchRecent(dirA, { ...project, name: 'a2' });

    let recent = await store.listRecent();
    expect(recent.map((item) => item.name)).toEqual(['a2', 'b']);

    fs.rmSync(dirB, { recursive: true, force: true });
    recent = await store.listRecent();
    expect(recent.map((item) => item.name)).toEqual(['a2']);

    // 返回的是副本，外部修改不影响缓存
    recent.push({} as never);
    expect((await store.listRecent()).length).toBe(1);
  });

  it('最多保留 24 条', async () => {
    const { store, root } = makeStore();
    for (let index = 0; index < 30; index++) {
      const dir = makeProjectDir(root, `p${index}`);
      await store.touchRecent(dir, sampleProject(`p${index}`));
    }
    expect((await store.listRecent()).length).toBe(24);
  });
});

describe('ProjectStore 打包/导入', () => {
  it('导入不覆盖已存在的同名工程（数据丢失防护）', async () => {
    const { store, root } = makeStore();
    const pack = path.join(root, 'pack-dir');
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, 'project.json'), JSON.stringify(sampleProject('incoming'), null, 2), 'utf8');

    const existing = makeProjectDir(root, 'incoming');
    const existingProject = { ...sampleProject('existing'), id: 'existing-id' };
    fs.writeFileSync(path.join(existing, 'project.json'), JSON.stringify(existingProject, null, 2), 'utf8');

    const imported = await store.importPack(pack, existing);
    expect(imported.toLowerCase()).not.toBe(existing.toLowerCase());
    expect(fs.existsSync(imported)).toBe(true);
    // 原工程保持原样
    const untouched = JSON.parse(fs.readFileSync(path.join(existing, 'project.json'), 'utf8')) as Project;
    expect(untouched.name).toBe('existing');
  });

  it('导出工程包不能写进工程目录内部（防递归复制）', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    await store.save(dir, sampleProject('pack-me'));
    await expect(store.exportPack(dir, path.join(dir, 'inside'))).rejects.toMatchObject({ code: 'E_INVALID_COMMAND' });

    const target = await store.exportPack(dir, path.join(root, 'out.wcapack'));
    expect(fs.existsSync(path.join(target, 'project.json'))).toBe(true);
  });

  it('导入损坏工程包会清理半成品目录', async () => {
    const { store, root } = makeStore();
    const pack = path.join(root, 'bad-pack');
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, 'project.json'), '{ broken', 'utf8');
    const dest = path.join(root, 'bad-dest.wcaproj');
    await expect(store.importPack(pack, dest)).rejects.toBeTruthy();
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('ProjectStore 素材定位与媒体读取', () => {
  it('按内容哈希重定位缺失素材', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    const mediaDir = path.join(dir, 'media', 'mic');
    fs.mkdirSync(mediaDir, { recursive: true });
    const realFile = path.join(mediaDir, 'real.wav');
    fs.writeFileSync(realFile, 'RIFF-fake-wave-bytes');
    const contentHash = await hashFile(realFile);

    const project = sampleProject('relocate');
    project.assets = [
      {
        id: 'missing',
        kind: 'mic',
        path: 'media/screen/seg-000001.mp4',
        hash: contentHash,
        durationTicks: 0,
        width: 0,
        height: 0,
        sampleRate: 48_000,
        channels: 2,
        createdAt: Date.now(),
      },
      {
        id: 'no-hash',
        kind: 'mic',
        path: 'media/screen/seg-000002.mp4',
        hash: '',
        durationTicks: 0,
        width: 0,
        height: 0,
        sampleRate: 48_000,
        channels: 2,
        createdAt: Date.now(),
      },
    ];
    const relocated = await store.relocateAssets(dir, project);
    expect(relocated[0].path).toBe('media/mic/real.wav');
    // 空哈希不得命中任意文件
    expect(relocated[1].path).toBe('media/screen/seg-000002.mp4');
  });

  it('readMedia 返回自定义协议 URL 并拒绝越界路径', async () => {
    const { store, root } = makeStore();
    const dir = makeProjectDir(root);
    const mediaDir = path.join(dir, 'media', 'screen');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'seg-000001.mp4'), 'x');

    const info = await store.readMedia(dir, 'media/screen/seg-000001.mp4');
    expect(info.url.startsWith('wcs-media://local/')).toBe(true);
    expect(info.path).toBe('media/screen/seg-000001.mp4');

    await expect(store.readMedia(dir, '../outside.mp4')).rejects.toMatchObject({ code: 'E_PROJECT_CORRUPT' });
    await expect(store.readMedia(dir, 'media/screen/none.mp4')).rejects.toMatchObject({ code: 'E_MEDIA_MISSING' });
  });
});

describe('ProjectStore 目录命名', () => {
  it('defaultProjectPath 清理非法字符、保留名与结尾点号', () => {
    const { store } = makeStore();
    const illegal = store.defaultProjectPath('a<b>c:d"e/f\\g|h?i*j');
    expect(path.basename(illegal)).not.toMatch(/[<>:"/\\|?*]/);
    expect(store.defaultProjectPath('CON').endsWith('_CON.wcaproj')).toBe(true);
    expect(store.defaultProjectPath('name...  ').endsWith('name.wcaproj')).toBe(true);
    expect(store.defaultProjectPath('').endsWith('未命名录制.wcaproj')).toBe(true);
  });

  it('uniqueProjectPath 不覆盖已存在的同名工程', async () => {
    const { store } = makeStore();
    const first = store.uniqueProjectPath('同名');
    await store.ensureDir(first);
    const second = store.uniqueProjectPath('同名');
    expect(second).not.toBe(first);
    expect(second.endsWith('同名 (2).wcaproj')).toBe(true);
  });
});
