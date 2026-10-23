/**
 * 工程存储（开发文档 §13 / §15.2）
 *
 * 关键约束：
 * - project.json 原子替换：写临时 → 校验 → rename，绝不在原文件上直接写
 * - 保留上一版快照（project.prev.json），便于工程损坏时回退
 * - 拒绝未来版本覆盖写入（E_SCHEMA_FUTURE），只读提示
 * - 迁移统一走 src/domain/migration（旧版本升级、字段规整、tick 字符串化）
 * - 素材路径必须是工程相对路径，拒绝绝对路径与 .. 越界
 * - 打包/解包拒绝路径穿越与「自己包含自己」
 * - 素材缺失时按 ID + 内容哈希重定位
 * - 同一工程的并发保存串行化，临时文件名唯一（不再用 pid+Date.now 相撞）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
import { parseProjectJson, serializeProject, writeProject, type MigrationResult } from '../src/domain/migration';
import type { RecentProject } from '../src/shared/ipc';
import { AppError } from '../src/shared/errors';

const PROJECT_FILE = 'project.json';
const PROJECT_PREV_FILE = 'project.prev.json';
const RECENT_FILE = 'recent-projects.json';
/** 最近工程列表上限。 */
const MAX_RECENT = 24;

export interface LoadResult {
  project: Project;
  path: string;
  /** 素材缺失的资产 ID 列表 */
  missingAssets: string[];
  /** 是否从上一版快照恢复 */
  recoveredFromPrev: boolean;
  /** 从旧 schemaVersion 迁移时的来源版本；未迁移为 null */
  migratedFrom: number | null;
  /** 未来版本工程：只读提示（非 null 表示本次打开为只读） */
  readOnlyNotice: string | null;
}

/**
 * 词法判断 target 是否位于 root 之内（大小写不敏感，Windows 语义）。
 *
 * 注意：这里只做**词法**判断，不解析符号链接/目录联接（junction）。
 * 主进程在真正读写前还会用 fs.realpath 再校验一次（见 main.ts 的 assertAllowedPath）。
 */
export function isPathInside(root: string, target: string): boolean {
  if (typeof root !== 'string' || typeof target !== 'string' || !root || !target) return false;
  const lowerRoot = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '');
  const lowerTarget = path.resolve(target).toLowerCase().replace(/[\\/]+$/, '');
  if (!lowerRoot) return false;
  if (lowerTarget === lowerRoot) return true;
  return lowerTarget.startsWith(lowerRoot + path.sep);
}

/** Windows 文件名里不能作为工程名/目录名的保留字。 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class ProjectStore {
  private recentCache: RecentProject[] | null = null;
  private resolvedProjectsRoot: string | null = null;
  /** 同一工程目录的保存串行化：避免并发 rename/临时文件互相踩踏。 */
  private readonly saveChains = new Map<string, Promise<unknown>>();
  /** 最近列表「读-改-写」串行化：避免并发 touchRecent 丢条目。 */
  private recentChain: Promise<unknown> = Promise.resolve();

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
    if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程引用了空的素材路径。',
        retryable: false,
        preservedData: true,
        detail: `relativePath=${String(relativePath)}`,
      });
    }
    // NUL 字节会被部分底层 API 截断，必须显式拒绝
    if (relativePath.includes('\0')) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程引用的素材路径包含非法字符。',
        retryable: false,
        preservedData: true,
        detail: 'path contains NUL',
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
    if (!rel) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程引用的素材路径指向工程目录本身，已拒绝。',
        retryable: false,
        preservedData: true,
        detail: `relativePath=${relativePath}`,
      });
    }
    return resolved;
  }

  /** 生成默认工程目录（我的视频/WinCapture Studio/名称.wcaproj）。 */
  defaultProjectPath(name: string): string {
    const cleaned = String(name ?? '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 80)
      .trim();
    // Windows 保留名（CON/NUL/COM1…）不能直接作为目录名，加前缀规避
    const safeName = !cleaned ? '未命名录制' : WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
    return path.join(this.projectsRoot(), safeName + PROJECT_DIR_SUFFIX);
  }

  /**
   * 生成一个当前不存在的工程目录。
   *
   * 为什么需要：同名工程（尤其是默认的「未命名工程」/同一时刻的「录制 …」）
   * 直接复用 defaultProjectPath 会把已有工程的 project.json 覆盖掉。
   * 新建录制/新建工程/导入工程包都必须走这里。
   */
  uniqueProjectPath(name: string): string {
    return this.uniqueProjectDir(this.defaultProjectPath(name));
  }

  /** 对一个目标目录做「不存在就用、存在就追加 (n)」的唯一化。 */
  private uniqueProjectDir(candidate: string): string {
    const normalized = path.resolve(candidate);
    if (!fs.existsSync(normalized)) return normalized;
    const stem = normalized.toLowerCase().endsWith(PROJECT_DIR_SUFFIX)
      ? normalized.slice(0, -PROJECT_DIR_SUFFIX.length)
      : normalized;
    for (let index = 2; index < 1000; index++) {
      const next = `${stem} (${index})${PROJECT_DIR_SUFFIX}`;
      if (!fs.existsSync(next)) return next;
    }
    return `${stem} (${Date.now().toString(36)})${PROJECT_DIR_SUFFIX}`;
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

  /** 保证工程目录存在并返回规范化路径。 */
  async ensureDir(projectPath: string): Promise<string> {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '工程路径为空。',
        retryable: false,
        preservedData: true,
        detail: String(projectPath),
      });
    }
    const normalized = path.resolve(projectPath);
    if (!normalized.toLowerCase().endsWith(PROJECT_DIR_SUFFIX)) {
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
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '工程路径为空。',
        retryable: false,
        preservedData: false,
        detail: String(projectPath),
      });
    }
    const root = path.resolve(projectPath);
    const main = path.join(root, PROJECT_FILE);

    let parsed: Project | null = null;
    let recoveredFromPrev = false;
    let migratedFrom: number | null = null;
    let readOnlyNotice: string | null = null;
    let parseError: unknown = null;

    try {
      const result = await this.readProjectFile(main);
      parsed = result.project;
      readOnlyNotice = result.readOnlyNotice;
      if (result.migrated) {
        migratedFrom = result.fromVersion;
        await this.persistMigration(root, result);
      }
    } catch (error) {
      // 未来版本不是「损坏」：必须原样上报，绝不能回退到旧快照——
      // 否则用户会在只读项目上看到旧数据，保存时又把未来版本工程降级覆盖。
      if (error instanceof AppError && error.code === 'E_SCHEMA_FUTURE') throw error;
      parseError = error;
    }

    if (!parsed) {
      // 尝试上一版快照（§15.2）
      const prev = path.join(root, PROJECT_PREV_FILE);
      if (fs.existsSync(prev)) {
        try {
          const result = await this.readProjectFile(prev);
          parsed = result.project;
          readOnlyNotice = result.readOnlyNotice;
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
    return { project: parsed, path: root, missingAssets, recoveredFromPrev, migratedFrom, readOnlyNotice };
  }

  private async readProjectFile(filePath: string): Promise<MigrationResult> {
    const text = await fsp.readFile(filePath, 'utf8');
    if (!text.trim()) {
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程文件为空，可能写入过程中断电或磁盘已满。',
        retryable: false,
        preservedData: true,
        detail: filePath,
      });
    }
    // parseProjectJson 内部做：JSON 解析、schemaVersion 校验、旧版本迁移、字段规整
    return parseProjectJson(text);
  }

  /** 旧版本迁移后：落盘迁移备份，并把规整后的工程原子写回（保留旧版为 prev）。 */
  private async persistMigration(root: string, result: MigrationResult): Promise<void> {
    if (result.backup && result.backupFileName) {
      try {
        const backupPath = path.join(root, path.basename(result.backupFileName));
        if (!fs.existsSync(backupPath)) {
          await fsp.writeFile(backupPath, JSON.stringify(result.backup, null, 2), 'utf8');
        }
      } catch (error) {
        console.warn('[projectStore] 迁移备份写入失败（不影响打开）', error);
      }
    }
    try {
      await this.save(root, result.project);
    } catch (error) {
      // 只读目录 / 磁盘满：以内存中的规范结构继续，用户下次保存时会再尝试
      console.warn('[projectStore] 迁移后的工程写回失败', error);
    }
  }

  private async findMissingAssets(root: string, project: Project): Promise<string[]> {
    const missing: string[] = [];
    if (!Array.isArray(project.assets)) return missing;
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
  // 写入（原子替换 + 并发串行化）
  // -------------------------------------------------------------------------

  async save(projectPath: string, project: Project): Promise<{ path: string; revision: number; savedAt: number }> {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '工程路径为空。',
        retryable: false,
        preservedData: true,
        detail: String(projectPath),
      });
    }
    if (!project || typeof project !== 'object') {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '要保存的工程数据无效。',
        retryable: false,
        preservedData: true,
      });
    }
    // 先按调用顺序入队，再在队列里做 ensureDir：
    // 若先 await ensureDir 再入队，并发保存的落盘顺序会取决于 mkdir 完成顺序。
    const root = path.resolve(projectPath);
    return this.queueSave(root, async () => {
      const ensured = await this.ensureDir(projectPath);
      return this.writeProjectFile(ensured, project);
    });
  }

  /** 按工程目录串行化保存；前一个保存失败不会阻断后续保存。 */
  private queueSave<T>(root: string, task: () => Promise<T>): Promise<T> {
    const key = root.toLowerCase();
    const previous = this.saveChains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.saveChains.set(key, settled);
    return next.finally(() => {
      if (this.saveChains.get(key) === settled) this.saveChains.delete(key);
    });
  }

  private async writeProjectFile(
    root: string,
    project: Project,
  ): Promise<{ path: string; revision: number; savedAt: number }> {
    const main = path.join(root, PROJECT_FILE);
    const prev = path.join(root, PROJECT_PREV_FILE);

    // 迁移/规整 + 未来版本拒绝（writeProject 内部抛 E_SCHEMA_FUTURE）
    const normalized = writeProject(project);

    // 素材路径安全校验：拒绝绝对路径与越界
    for (const asset of normalized.assets) {
      ProjectStore.resolveInside(root, asset.path);
    }

    const savedAt = Date.now();
    const toWrite: Project = {
      ...normalized,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      updatedAt: savedAt,
    };
    const serialized = serializeProject(toWrite);
    // 临时文件名必须唯一：并发保存（自动保存 + 手动保存）在同一毫秒内也不会撞名
    const temp = path.join(
      root,
      `${PROJECT_FILE}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    );

    // 1. 写临时文件并刷盘
    let handle: FileHandle | null = null;
    try {
      handle = await fsp.open(temp, 'w');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    // 2. 校验：读回并解析，确认可被自己读回
    try {
      const check = JSON.parse(await fsp.readFile(temp, 'utf8')) as Project;
      if (!check || check.id !== toWrite.id) throw new Error('id 不匹配');
      if (check.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new Error('schemaVersion 不一致');
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw new AppError({
        code: 'E_PROJECT_CORRUPT',
        message: '工程写入校验失败，已保留原文件未做改动。',
        retryable: true,
        preservedData: true,
        detail: String(error),
      });
    }

    // 3. 备份上一版：只有当前文件能解析时才覆盖快照，
    //    否则会把仅存的良好回退点（prev）用损坏内容覆盖掉。
    if (fs.existsSync(main)) {
      try {
        JSON.parse(await fsp.readFile(main, 'utf8'));
        await fsp.copyFile(main, prev);
      } catch (error) {
        console.warn('[projectStore] 当前 project.json 无法解析，保留既有快照作为回退点', error);
      }
    }

    // 4. 原子替换
    try {
      await fsp.rename(temp, main);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }

    return { path: root, revision: toWrite.revision, savedAt };
  }

  // -------------------------------------------------------------------------
  // 最近工程
  // -------------------------------------------------------------------------

  private recentFilePath(): string {
    return path.join(this.userDataPath, RECENT_FILE);
  }

  async listRecent(): Promise<RecentProject[]> {
    // 每次读取都回查磁盘：工程目录可能被用户在资源管理器里删除/移动，
    // 只用进程内缓存会长期显示已经不存在的工程（「最近列表与磁盘不一致」）。
    await this.reloadRecent();
    return (this.recentCache ?? []).slice();
  }

  private async reloadRecent(): Promise<void> {
    try {
      const text = await fsp.readFile(this.recentFilePath(), 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) {
        this.recentCache = [];
        return;
      }
      const alive: RecentProject[] = [];
      const seen = new Set<string>();
      for (const item of parsed as RecentProject[]) {
        if (!item || typeof item.path !== 'string' || !item.path) continue;
        const abs = path.resolve(item.path);
        const key = abs.toLowerCase();
        if (seen.has(key)) continue;
        if (!fs.existsSync(abs)) continue;
        seen.add(key);
        alive.push({ ...item, path: abs });
        if (alive.length >= MAX_RECENT) break;
      }
      this.recentCache = alive;
    } catch {
      this.recentCache = [];
    }
  }

  async touchRecent(projectPath: string, project: Project): Promise<void> {
    await this.queueRecent(async () => {
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
      // Windows 路径大小写不敏感：同一工程不能因为大小写不同出现两条
      const filtered = list.filter((item) => path.resolve(item.path).toLowerCase() !== root.toLowerCase());
      filtered.unshift(entry);
      this.recentCache = filtered.slice(0, MAX_RECENT);
      await this.flushRecentUnlocked();
    });
  }

  async removeRecent(projectPath: string): Promise<void> {
    await this.queueRecent(async () => {
      const list = await this.listRecent();
      const root = path.resolve(projectPath).toLowerCase();
      this.recentCache = list.filter((item) => path.resolve(item.path).toLowerCase() !== root);
      await this.flushRecentUnlocked();
    });
  }

  private queueRecent<T>(task: () => Promise<T>): Promise<T> {
    const next = this.recentChain.then(task, task);
    this.recentChain = next.catch(() => undefined);
    return next;
  }

  private async flushRecentUnlocked(): Promise<void> {
    try {
      await fsp.mkdir(this.userDataPath, { recursive: true });
      const target = this.recentFilePath();
      // 唯一临时名：并发写同一个 .tmp 会随机失败并静默丢列表
      const temp = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      await fsp.writeFile(temp, JSON.stringify(this.recentCache ?? [], null, 2), 'utf8');
      await fsp.rename(temp, target);
    } catch (error) {
      // 最近列表写入失败不影响主流程，但要留下诊断线索（原来完全静默）
      console.warn('[projectStore] 最近工程列表写入失败', error);
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
        .filter(
          (v): v is { seq: number; at: number; type: string; sessionId: string; detail?: Record<string, unknown> } =>
            v !== null,
        );
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
      // 没有哈希就无法可靠重定位：空哈希会把任意不可读文件误判为命中
      if (typeof asset.hash !== 'string' || asset.hash.length === 0) {
        updated.push(asset);
        continue;
      }
      // 按内容哈希在 media 目录下搜索
      let found: string | null = null;
      for (const sub of mediaRoots) {
        const dir = path.join(root, sub);
        if (!fs.existsSync(dir)) continue;
        for (const name of await fsp.readdir(dir)) {
          const candidate = path.join(dir, name);
          if (!fs.statSync(candidate).isFile()) continue;
          const hash = await hashFile(candidate);
          if (hash && hash === asset.hash) {
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

  /** 读取媒体文件，返回可直接给 <video>/<audio> 使用的 URL 与元信息。 */
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
    if (!stat.isFile()) {
      throw new AppError({
        code: 'E_MEDIA_MISSING',
        message: '素材路径不是文件。',
        retryable: false,
        preservedData: true,
        detail: abs,
      });
    }
    const ext = path.extname(abs).toLowerCase();
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
    };
  }

  // -------------------------------------------------------------------------
  // 打包 / 解包（§13.4）
  // -------------------------------------------------------------------------

  /**
   * 导出工程包（.wcapack）：目录打包。
   * 这里不引入第三方 zip 库，采用「目录复制」的方式，
   * 对用户来说等价于一个可移动的工程包，且不会出现 Zip Slip 风险。
   */
  async exportPack(projectPath: string, outputPath: string): Promise<string> {
    const root = path.resolve(projectPath);
    if (!fs.existsSync(path.join(root, PROJECT_FILE))) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '找不到有效的工程目录（缺少 project.json）。',
        retryable: true,
        preservedData: false,
        detail: root,
      });
    }
    const suffixSatisfied = outputPath.toLowerCase().endsWith(PROJECT_PACK_SUFFIX);
    const target = path.resolve(suffixSatisfied ? outputPath : outputPath + PROJECT_PACK_SUFFIX);
    // 目标在工程目录内部会导致「复制进自己」的无限递归/磁盘爆炸
    if (isPathInside(root, target)) {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '工程包不能导出到工程目录内部。',
        retryable: false,
        preservedData: true,
        detail: `project=${root} target=${target}`,
      });
    }
    await fsp.rm(target, { recursive: true, force: true });
    await copyDirSafe(root, target);
    return target;
  }

  /** 导入工程包：解到目标位置，并做路径穿越校验；绝不覆盖已有工程。 */
  async importPack(packPath: string, destination: string): Promise<string> {
    const source = path.resolve(packPath);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new AppError({
        code: 'E_PROJECT_NOT_FOUND',
        message: '找不到要导入的工程包目录。',
        retryable: true,
        preservedData: false,
        detail: source,
      });
    }
    const wanted = path.resolve(
      destination.toLowerCase().endsWith(PROJECT_DIR_SUFFIX) ? destination : destination + PROJECT_DIR_SUFFIX,
    );
    if (isPathInside(source, wanted) || isPathInside(wanted, source)) {
      throw new AppError({
        code: 'E_INVALID_COMMAND',
        message: '导入目标不能与工程包位于同一目录或互为父子目录。',
        retryable: false,
        preservedData: true,
        detail: `source=${source} dest=${wanted}`,
      });
    }
    // 关键：导入不能 rm 已有同名工程（原来的实现会直接递归删除，属于数据丢失）
    const dest = this.uniqueProjectDir(wanted);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      // 复制与校验放在同一个 try 里：复制阶段失败（磁盘满/权限拒绝）时
      // dest 目录与部分文件已经存在，旧实现只在 load 失败时清理，
      // 会留下一个打不开的半成品工程（还可能被最近列表/恢复逻辑误认为工程）。
      await copyDirSafe(source, dest);
      await this.load(dest);
    } catch (error) {
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return dest;
  }
}

/** 复制工程包时跳过的中间文件：临时工程文件与未提交分段。 */
function shouldSkipCopy(name: string): boolean {
  return name.includes('.tmp-') || name.toLowerCase().endsWith('.partial');
}

/** 安全递归复制：拒绝符号链接与越界目标，跳过临时文件。 */
async function copyDirSafe(from: string, to: string): Promise<void> {
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    // 拒绝符号链接/目录联接（避免通过链接逃逸或成环）
    if (entry.isSymbolicLink()) continue;
    if (shouldSkipCopy(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    // 目标必须在目标根内（readdir 不会返回 ..，这里是纵深防御）
    if (!isPathInside(to, dst)) continue;
    if (entry.isDirectory()) {
      await copyDirSafe(src, dst);
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
