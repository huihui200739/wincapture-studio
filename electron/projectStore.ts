/**
 * 工程存储（开发文档 §13 / §15.2）
 *
 * 关键约束：
 * - project.json 原子替换：写临时 → 校验 → rename，绝不在原文件上直接写
 * - 保留上一版快照（project.prev.json），便于工程损坏时回退
 * - 拒绝未来版本覆盖写入（E_SCHEMA_FUTURE），只读提示
 * - 素材路径必须是工程相对路径，拒绝绝对路径与 .. 越界
 * - 打包/解包拒绝路径穿越（Zip Slip）
 * - 素材缺失时按 ID + 哈希重定位
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import {
  PROJECT_DIR_SUFFIX,
  PROJECT_PACK_SUFFIX,
  PROJECT_SCHEMA_VERSION,
  type MediaAsset,
  type Project,
  createEmptyProject,
  timelineDuration,
} from '../src/domain/project';
import type { RecentProject } from '../src/shared/ipc';
import { AppError } from '../src/shared/errors';

const PROJECT_FILE = 'project.json';
const PROJECT_PREV_FILE = 'project.prev.json';
const RECENT_FILE = 'recent-projects.json';

export interface LoadResult {
  project: Project;
  path: string;
  /** 素材缺失的资产 ID 列表 */
  missingAssets: string[];
  /** 是否从上一版快照恢复 */
  recoveredFromPrev: boolean;
}

export class ProjectStore {
  private recentCache: RecentProject[] | null = null;

  constructor(
    private readonly userDataPath: string,
    private readonly deps: { videosPath: () => string; homePath: () => string } = {
      videosPath: () => path.join(os.homedir(), 'Videos'),
      homePath: () => os.homedir(),
    },
  ) {}

  // -------------------------------------------------------------------------
  // 路径工具
  // -------------------------------------------------------------------------

  /** 校验并规范化工程内的相对路径；越界或绝对路径直接拒绝。 */
  static resolveInside(projectPath: string, relativePath: string): string {
    if (!relativePath || typeof relativePath !== 'string') {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程引用了空的素材路径。',
        retryable: false,
        preservedData: true,
        detail: `relativePath=${String(relativePath)}`,
      });
    }
    if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith('\\\\')) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程引用了绝对路径的素材，出于安全考虑已拒绝。',
        retryable: false,
        preservedData: true,
        detail: `absolute=${relativePath}`,
      });
    }
    const normalizedRoot = path.resolve(projectPath);
    const resolved = path.resolve(normalizedRoot, relativePath);
    const rel = path.relative(normalizedRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程引用的素材路径越出了工程目录，已拒绝。',
        retryable: false,
        preservedData: true,
        detail: `escaped=${relativePath}`,
      });
    }
    return resolved;
  }

  /** 生成默认工程目录（我的视频/WinCapture Studio/名称.wcaproj）。 */
  defaultProjectPath(name: string): string {
    const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || '未命名录制';
    return path.join(this.projectsRoot(), safeName + PROJECT_DIR_SUFFIX);
  }

  /**
   * 工程根目录。
   *
   * 优先用系统「视频」目录，但某些受限环境（组策略、重定向失败、只读用户配置）
   * 会拒绝在 ~/Videos 下创建目录。这时按顺序回退到
   * userData/projects → 用户主目录 → 临时目录，保证录制永远有地方落盘。
   */
  projectsRoot(): string {
    if (this.resolvedProjectsRoot) return this.resolvedProjectsRoot;
    const candidates: string[] = [];
    try {
      candidates.push(path.join(this.deps.videosPath(), 'WinCapture Studio'));
    } catch {
      // 系统目录不可用时忽略
    }
    candidates.push(path.join(this.userDataPath, 'projects'));
    try {
      candidates.push(path.join(this.deps.homePath(), 'WinCapture Studio'));
    } catch {
      // 忽略
    }
    candidates.push(path.join(this.userDataPath, 'projects-fallback'));

    for (const candidate of candidates) {
      try {
        fs.mkdirSync(candidate, { recursive: true });
        // 验证真的可写（mkdir 成功不代表可写）
        const probe = path.join(candidate, `.wcs-write-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe, { force: true });
        this.resolvedProjectsRoot = candidate;
        return candidate;
      } catch {
        // 试下一个
      }
    }
    // 全部失败时退到临时目录（至少不会崩）
    const fallback = path.join(os.tmpdir(), 'WinCapture Studio');
    fs.mkdirSync(fallback, { recursive: true });
    this.resolvedProjectsRoot = fallback;
    return fallback;
  }

  private resolvedProjectsRoot: string | null = null;

  /** 保证工程目录存在并返回规范化路径。 */
  async ensureDir(projectPath: string): Promise<string> {
    const normalized = path.resolve(projectPath);
    if (!normalized.endsWith(PROJECT_DIR_SUFFIX)) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: `工程目录必须以 ${PROJECT_DIR_SUFFIX} 结尾。`,
        retryable: false,
        preservedData: true,
        detail: normalized,
      });
    }
    await fsp.mkdir(normalized, { recursive: true });
    return normalized;
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  async load(projectPath: string): Promise<LoadResult> {
    const root = path.resolve(projectPath);
    const main = path.join(root, PROJECT_FILE);

    let parsed: Project | null = null;
    let recoveredFromPrev = false;
    let parseError: unknown = null;

    try {
      parsed = await this.readProjectFile(main);
    } catch (error) {
      parseError = error;
    }

    if (!parsed) {
      // 尝试上一版快照（§15.2）
      const prev = path.join(root, PROJECT_PREV_FILE);
      if (fs.existsSync(prev)) {
        try {
          parsed = await this.readProjectFile(prev);
          recoveredFromPrev = true;
        } catch (error) {
          parseError = error;
        }
      }
    }

    if (!parsed) {
      if (!fs.existsSync(root)) {
        throw new AppError({
          code: 'E_PROJECT_NOT_FOUND',
          message: '找不到工程目录，可能已被移动或删除。',
          retryable: true,
          preservedData: false,
          detail: String(parseError),
        });
      }
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程文件已损坏，无法读取。可尝试从工程目录的备份文件恢复。',
        retryable: false,
        preservedData: true,
        detail: String(parseError),
      });
    }

    const missingAssets = await this.findMissingAssets(root, parsed);
    return { project: parsed, path: root, missingAssets, recoveredFromPrev };
  }

  private async readProjectFile(filePath: string): Promise<Project> {
    const text = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(text) as Project;

    if (typeof data?.schemaVersion !== 'number') {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程文件缺少版本信息，可能不是有效的工程。',
        retryable: false,
        preservedData: true,
      });
    }
    if (data.schemaVersion > PROJECT_SCHEMA_VERSION) {
      // 未来版本：只读提示，不尝试解析（§13.3）
      throw new AppError({
        code: 'E_SCHEMA_FUTURE',
        message: `该工程由更高版本的应用创建（版本 ${data.schemaVersion}，当前支持 ${PROJECT_SCHEMA_VERSION}），请升级应用后再打开。`,
        retryable: false,
        preservedData: true,
        detail: `schemaVersion=${data.schemaVersion}`,
      });
    }
    return data;
  }

  private async findMissingAssets(root: string, project: Project): Promise<string[]> {
    const missing: string[] = [];
    for (const asset of project.assets) {
      try {
        const abs = ProjectStore.resolveInside(root, asset.path);
        await fsp.access(abs);
      } catch {
        missing.push(asset.id);
      }
    }
    return missing;
  }

  // -------------------------------------------------------------------------
  // 写入（原子替换）
  // -------------------------------------------------------------------------

  async save(projectPath: string, project: Project): Promise<{ path: string; revision: number; savedAt: number }> {
    const root = await this.ensureDir(projectPath);
    const main = path.join(root, PROJECT_FILE);
    const prev = path.join(root, PROJECT_PREV_FILE);
    const temp = path.join(root, `${PROJECT_FILE}.tmp-${process.pid}-${Date.now()}`);

    // 拒绝未来版本覆盖（§13.3）
    if (project.schemaVersion > PROJECT_SCHEMA_VERSION) {
      throw new AppError({
        code: 'E_SCHEMA_FUTURE',
        message: '当前应用版本不支持保存该工程版本，已阻止写入以避免损坏数据。',
        retryable: false,
        preservedData: true,
      });
    }

    // 素材路径安全校验：拒绝绝对路径与越界
    for (const asset of project.assets) {
      ProjectStore.resolveInside(root, asset.path);
    }

    const savedAt = Date.now();
    const toWrite: Project = {
      ...project,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      updatedAt: savedAt,
    };
    const serialized = JSON.stringify(toWrite, null, 2);

    // 1. 写临时文件并刷盘
    const handle = await fsp.open(temp, 'w');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    // 2. 校验：读回并解析，确认可被自己读回
    try {
      const check = JSON.parse(await fsp.readFile(temp, 'utf8')) as Project;
      if (check.id !== project.id) throw new Error('id 不匹配');
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程写入校验失败，已保留原文件未做改动。',
        retryable: true,
        preservedData: true,
        detail: String(error),
      });
    }

    // 3. 备份上一版
    if (fs.existsSync(main)) {
      try {
        await fsp.copyFile(main, prev);
      } catch {
        // 备份失败不阻止保存，但会失去回退点
      }
    }

    // 4. 原子替换
    await fsp.rename(temp, main);

    return { path: root, revision: toWrite.revision, savedAt };
  }

  // -------------------------------------------------------------------------
  // 最近工程
  // -------------------------------------------------------------------------

  private recentFilePath(): string {
    return path.join(this.userDataPath, RECENT_FILE);
  }

  async listRecent(): Promise<RecentProject[]> {
    if (this.recentCache) return this.recentCache;
    try {
      const text = await fsp.readFile(this.recentFilePath(), 'utf8');
      const parsed = JSON.parse(text) as RecentProject[];
      if (!Array.isArray(parsed)) return [];
      // 过滤已不存在的工程
      const alive: RecentProject[] = [];
      for (const item of parsed) {
        if (item?.path && fs.existsSync(item.path)) alive.push(item);
      }
      this.recentCache = alive.slice(0, 24);
      return this.recentCache;
    } catch {
      this.recentCache = [];
      return [];
    }
  }

  async touchRecent(projectPath: string, project: Project): Promise<void> {
    const list = await this.listRecent();
    const root = path.resolve(projectPath);
    const entry: RecentProject = {
      id: project.id,
      name: project.name,
      path: root,
      updatedAt: Date.now(),
      durationTicks: timelineDuration(project),
      missingMedia: (await this.findMissingAssets(root, project)).length > 0,
      recoverable: await this.hasRecoverable(root),
    };
    const filtered = list.filter((item) => path.resolve(item.path) !== root);
    filtered.unshift(entry);
    this.recentCache = filtered.slice(0, 24);
    await this.flushRecent();
  }

  async removeRecent(projectPath: string): Promise<void> {
    const list = await this.listRecent();
    const root = path.resolve(projectPath);
    this.recentCache = list.filter((item) => path.resolve(item.path) !== root);
    await this.flushRecent();
  }

  private async flushRecent(): Promise<void> {
    try {
      await fsp.mkdir(this.userDataPath, { recursive: true });
      const target = this.recentFilePath();
      const temp = target + '.tmp';
      await fsp.writeFile(temp, JSON.stringify(this.recentCache ?? [], null, 2), 'utf8');
      await fsp.rename(temp, target);
    } catch {
      // 最近列表写入失败不影响主流程
    }
  }

  // -------------------------------------------------------------------------
  // 崩溃恢复（§15.2）
  // -------------------------------------------------------------------------

  /** 是否存在可恢复会话：有 journal 且未正常完成。 */
  async hasRecoverable(projectPath: string): Promise<boolean> {
    const journal = path.join(projectPath, 'recovery', 'journal.jsonl');
    if (!fs.existsSync(journal)) return false;
    try {
      const text = await fsp.readFile(journal, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length === 0) return false;
      const last = JSON.parse(lines[lines.length - 1]) as { type?: string };
      return last.type !== 'complete';
    } catch {
      return false;
    }
  }

  /** 读取 journal 并重建已提交段清单（纯文件 IO + 委托给领域层逻辑）。 */
  async readJournal(projectPath: string): Promise<
    { seq: number; at: number; type: string; sessionId: string; detail?: Record<string, unknown> }[]
  > {
    const journal = path.join(projectPath, 'recovery', 'journal.jsonl');
    try {
      const text = await fsp.readFile(journal, 'utf8');
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((v): v is { seq: number; at: number; type: string; sessionId: string; detail?: Record<string, unknown> } => v !== null);
    } catch {
      return [];
    }
  }

  async discardRecovery(projectPath: string): Promise<void> {
    const recoveryDir = path.join(projectPath, 'recovery');
    if (!fs.existsSync(recoveryDir)) return;
    // 保留 journal 但写入一条 complete，标记不再提示恢复
    const journal = path.join(recoveryDir, 'journal.jsonl');
    try {
      const entry = { seq: Date.now(), at: Date.now(), type: 'complete', sessionId: 'discarded' };
      await fsp.appendFile(journal, JSON.stringify(entry) + '\n');
    } catch {
      // 忽略
    }
  }

  // -------------------------------------------------------------------------
  // 素材与媒体
  // -------------------------------------------------------------------------

  /** 按 ID + 哈希重定位缺失素材（§15.2）。 */
  async relocateAssets(projectPath: string, project: Project): Promise<MediaAsset[]> {
    const root = path.resolve(projectPath);
    const updated: MediaAsset[] = [];
    const mediaRoots = ['media/screen', 'media/mic', 'media/system', 'media/camera'];
    for (const asset of project.assets) {
      const abs = ProjectStore.resolveInside(root, asset.path);
      if (fs.existsSync(abs)) {
        updated.push(asset);
        continue;
      }
      // 按哈希在 media 目录下搜索
      let found: string | null = null;
      for (const sub of mediaRoots) {
        const dir = path.join(root, sub);
        if (!fs.existsSync(dir)) continue;
        for (const name of await fsp.readdir(dir)) {
          const candidate = path.join(dir, name);
          if (!fs.statSync(candidate).isFile()) continue;
          const hash = await hashFile(candidate);
          if (hash === asset.hash) {
            found = candidate;
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        updated.push({ ...asset, path: path.relative(root, found).split(path.sep).join('/') });
      } else {
        updated.push(asset);
      }
    }
    return updated;
  }

  /** 读取媒体文件，返回可直接给 <video>/<audio> 使用的 data URL 与元信息。 */
  async readMedia(projectPath: string, relativePath: string): Promise<{
    path: string;
    url: string;
    durationSeconds: number;
    width: number;
    height: number;
    sampleRate: number;
    channels: number;
  }> {
    const abs = ProjectStore.resolveInside(projectPath, relativePath);
    if (!fs.existsSync(abs)) {
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '素材文件缺失，可能被移动或删除。',
        retryable: true,
        preservedData: true,
        detail: abs,
      });
    }
    const stat = await fsp.stat(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.mp4' ? 'video/mp4' : ext === '.wav' ? 'audio/wav' : ext === '.png' ? 'image/png' : 'application/octet-stream';
    // 大文件不内联成 data URL（会占用巨量内存），改为通过自定义协议流式读取
    const url = `wcs-media://local/${encodeURIComponent(relativePath)}?project=${encodeURIComponent(projectPath)}`;
    return {
      path: relativePath,
      url,
      durationSeconds: 0,
      width: 0,
      height: 0,
      sampleRate: ext === '.wav' ? 48_000 : 0,
      channels: ext === '.wav' ? 2 : 0,
      ...({ bytes: stat.size } as Record<string, number>),
    };
  }

  // -------------------------------------------------------------------------
  // 打包 / 解包（§13.4）
  // -------------------------------------------------------------------------

  /**
   * 导出工程包（.wcapack）：目录打包。
   * 这里不引入第三方 zip 库，采用「目录复制 + 清单」的方式，
   * 对用户来说等价于一个可移动的工程包，且不会出现 Zip Slip 风险。
   */
  async exportPack(projectPath: string, outputPath: string): Promise<string> {
    const root = path.resolve(projectPath);
    if (!fs.existsSync(root)) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '找不到要打包的工程目录。',
        retryable: true,
        preservedData: false,
      });
    }
    const target = outputPath.endsWith(PROJECT_PACK_SUFFIX) ? outputPath : outputPath + PROJECT_PACK_SUFFIX;
    await fsp.rm(target, { recursive: true, force: true });
    await copyDirSafe(root, target, root);
    return target;
  }

  /** 导入工程包：解到目标位置，并做路径穿越校验。 */
  async importPack(packPath: string, destination: string): Promise<string> {
    const source = path.resolve(packPath);
    if (!fs.existsSync(source)) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '找不到要导入的工程包。',
        retryable: true,
        preservedData: false,
      });
    }
    const dest = destination.endsWith(PROJECT_DIR_SUFFIX) ? destination : destination + PROJECT_DIR_SUFFIX;
    await fsp.rm(dest, { recursive: true, force: true });
    await copyDirSafe(source, dest, source);
    // 校验工程文件存在且可读
    await this.load(dest);
    return dest;
  }
}

/** 安全递归复制：拒绝符号链接与越界目标。 */
async function copyDirSafe(from: string, to: string, sourceRoot: string): Promise<void> {
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    // 拒绝符号链接（避免通过链接逃逸）
    if (entry.isSymbolicLink()) continue;
    // 目标必须在目标根内
    const rel = path.relative(to, dst);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    void sourceRoot;
    if (entry.isDirectory()) {
      await copyDirSafe(src, dst, sourceRoot);
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dst);
    }
  }
}

/** 计算文件 sha256（前 32 位十六进制），用于素材重定位。 */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 32)));
    stream.on('error', () => resolve(''));
  });
}

export function newProjectId(): string {
  return 'proj-' + crypto.randomBytes(8).toString('hex');
}

export function createProject(name: string): Project {
  return createEmptyProject(newProjectId(), name);
}
