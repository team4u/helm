/**
 * 外部插件包管理器：install / update / remove 事务。
 *
 * 仿 Pi package manager 的 source 模型（npm / git / local 一步到位），但 helm
 * 的安装语义是「staging 拷贝 + 现有 doctor 全链 + 原子进入受管目录 + 持久化
 * 记录 + 注册进 PluginHost」，不做市场数据库、不做版本目录池、不做向后迁移。
 *
 * 安全与诚实性纪律：
 * - npm 安装永不运行 lifecycle scripts（--ignore-scripts --no-audit --no-fund，
 *   --foreground-scripts 使任何绕过显式可见）；git 使用非交互环境变量
 *   （GIT_TERMINAL_PROMPT=0/GIT_ASKPASS=echo）与 --depth 1 浅克隆；
 * - staging 一律在 <dataDir>/plugins/.staging/<uuid>/ 内；成功后原子 rename
 *   进入 <dataDir>/plugins/<safeName>/；失败（含 doctor 失败、注册失败）清理
 *   staging，绝不留半产物；rename 失败显式报错并清理；
 * - local 来源与 npm/git 同样拷贝进受管目录（不 symlink）：PluginHost.register
 *   会把 <dataDir>/plugins/<pluginId> 同时作为插件源目录与 ctx.dataDir，符号
 *   链接会把插件数据写入用户源码树、remove 会破坏用户文件。代价（编辑源码
 *   需 update 重同步）在 install 结果与错误信息中如实说明；
 * - 拷贝排除 node_modules / .git / 点开头文件/目录（受管安装不含构建产物与
 *   VCS 元数据；npm 来源的运行时依赖声明于 package.json.dependencies，由
 *   受管 install 步骤以 --omit=dev 补齐且同样不运行 lifecycle scripts）；
 * - 受信插件的进程内执行边界如实声明：doctor/注册/启用的插件代码在本 Hub
 *   进程内运行、拥有宿主权限；本管理器的路径校验只是受管目录边界约定，
 *   不是沙箱。本文件头与错误信息按此口径表述，绝不声称沙箱。
 *
 * 安装目录名 safeName：优先包内定义 id（plugin.json/package.json helm 字段
 * 解析后的插件 id），回退目录探测名；最终以 doctor 真实导入得到的插件 id
 * 为准（目录名与 id 不一致时以 id 为准，安装记录同样按 id 键控）。
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HelmError, type PluginInstallResult, type PluginPackageRecord, type PluginRemoveResult, type PluginPackageSource, type PluginSummary, type PluginUpdateResult } from '@helm/protocol';
import { parsePluginSource } from './package-source.js';
import { doctorPluginDir } from './plugin-doctor.js';
import type { PluginPackageManagerStore } from './package-store.js';

// ---------------------------------------------------------------------------
// 进程执行底座（可注入 fake：测试不依赖真实网络）
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 进程运行器：真实实现 spawn npm/git；测试注入 fake。 */
export type PackageRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

/** 默认 runner：非交互环境、合并 stdout/stderr、超时 SIGKILL。 */
export const defaultPackageRunner: PackageRunner = (cmd, args, opts) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_CONFIG_NOSYSTEM: '1',
        npm_config_ignore_scripts: 'true',
        npm_config_foreground_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });

/** 末 40 行快照（诚实性纪律：外部交接失败必须附终端输出）。 */
export function tailLines(text: string, lines = 40): string {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim();
}

function commandError(kind: string, cmd: string, args: string[], result: RunResult): HelmError {
  return new HelmError(
    `plugin_package_${kind}_failed`,
    `插件包${kind === 'install' ? '安装' : kind === 'update' ? '更新' : '移除'}命令失败：${cmd} ${args.join(' ')}（exit ${result.code}）\n${tailLines(result.stderr || result.stdout)}`,
    500,
    { cmd, args, code: result.code, stdoutTail: tailLines(result.stdout), stderrTail: tailLines(result.stderr) },
  );
}

// ---------------------------------------------------------------------------
// 管理器
// ---------------------------------------------------------------------------

/** PluginHost 集成端口（真实 PluginHost 结构兼容，便于测试注入 fake host）。 */
export interface PackageManagerHost {
  registerManagedPlugin(dir: string, options: { enabled: boolean }): Promise<{ summary: PluginSummary; pluginId: string }>;
  /** 安装后启用（install enable: true 路径；失败诊断向上透传，不回滚安装）。 */
  enableManagedPlugin(pluginId: string): Promise<PluginSummary>;
  /** 更新切换前安全预检：在途任务 409 / provider 忙则拒绝（旧实例与旧目录不动）。 */
  assertManagedPluginUpdateSafe(pluginId: string): Promise<void> | void;
  updateManagedPlugin(pluginId: string, dir: string, options: { keepEnabled: boolean }): Promise<{ summary: PluginSummary }>;
  removeManagedPlugin(pluginId: string): Promise<{ wasEnabled: boolean }>;
  /**
   * 卸载关联清理：删除该插件持久化文档数据（全局 doc + 会话文档）并等待
   * DELETE 真实落盘；失败显式 reject，remove 据此保留目录与安装记录以便重试。
   */
  purgePluginPersistentData(pluginId: string): Promise<void>;
  listSummaries(): PluginSummary[];
}

export interface PluginPackageManagerOptions {
  dataDir: string
  /** Hub cwd（相对 local 路径解析基准）。 */
  cwd: string
  store: PluginPackageManagerStore
  host: PackageManagerHost
  runner?: PackageRunner
  /** 单命令超时（默认 120s）。 */
  commandTimeoutMs?: number
}

const COPY_IGNORE = new Set(['node_modules', '.git', '.staging']);
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeDirName(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.startsWith('builtin:')) {
    throw new HelmError('invalid_plugin_definition', `插件 id 不允许作为受管安装目录名：${pluginId}`, 400, { pluginId });
  }
  return pluginId;
}

function assertInsideDataDir(dataDir: string, target: string): void {
  const rel = relative(resolve(dataDir), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError('validation_error', `安装目标越出受管插件目录：${target}`, 400, { target });
  }
}

/** 纯数据目录拷贝（不含符号链接目标；忽略 node_modules/.git/点前缀）。 */
async function copyTreeFiltered(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || COPY_IGNORE.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTreeFiltered(from, to);
    } else if (entry.isFile()) {
      await cp(from, to, { force: true });
    }
    // symlink / fifo 等特殊文件跳过（受管安装不携带链接与设备文件）
  }
}

/**
 * 插件包管理器。所有操作经 manager 级互斥队列串行（install/update/remove
 * 互不并发；PluginHost 内部的 per-plugin 生命周期队列由 host 端口保证）。
 */
export class PluginPackageManager {
  private readonly dataDir: string;
  private readonly cwd: string;
  private readonly store: PluginPackageManagerStore;
  private readonly host: PackageManagerHost;
  private readonly runner: PackageRunner;
  private readonly timeoutMs: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: PluginPackageManagerOptions) {
    this.dataDir = options.dataDir;
    this.cwd = options.cwd;
    this.store = options.store;
    this.host = options.host;
    this.runner = options.runner ?? defaultPackageRunner;
    this.timeoutMs = options.commandTimeoutMs ?? 120_000;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn, fn);
    this.chain = task.catch(() => undefined);
    return task;
  }

  private pluginsDir(): string {
    return join(this.dataDir, 'plugins');
  }

  private stagingRoot(): string {
    return join(this.pluginsDir(), '.staging');
  }

  /** staging 目录创建（幂等；首次安装前保证存在）。 */
  private async ensureStagingRoot(): Promise<string> {
    const root = this.stagingRoot();
    await mkdir(root, { recursive: true });
    return root;
  }

  // --- 安装 -------------------------------------------------------------

  /**
   * 安装插件包：解析 source -> staging 获取 -> 运行时依赖 -> doctor 全链 ->
   * 原子进入受管目录 -> 持久化记录 -> 注册（默认 disabled）。
   *
   * 事务语义（不留半产物、不破坏运行中实例）：
   * - 重复安装防护：同 pluginId 已有受管记录或已注册实例时显式 409
   *   plugin_package_already_installed（不静默覆盖；需更新请走 update）；
   * - 目标目录占用防护：target 已存在（残留目录或同名其它插件目录）时
   *   显式 409，不先删后装；
   * - rename 进位后任何失败（注册 / 持久化）：删除新 target 回滚，staging
   *   一并清理，绝不留未注册目录与已注册实例的撕裂状态；
   * - enable: true 启用失败不回滚安装（设计允许，失败诊断经 enableError
   *   透传），但安装/记录链本身失败时必须完全回滚；启用失败时插件保持
   *   disabled，记录已持久化，重启后可正常加载与重试 enable。
   */
  async install(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    const parsed = parsePluginSource(source, this.cwd);
    return this.enqueue(async () => {
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      let inPlace = false; // payload 已 rename 进受管 target
      try {
        const payloadDir = await this.fetchIntoStaging(parsed, staging);
        // 运行时依赖先于 doctor：带 package.json 的包（npm/git/local 同权）在
        // staging 副本内补装 --omit=dev（不触碰用户 local 源：local 已是过滤拷贝），
        // 否则依赖 npm 包的入口在 doctor 代际导入时即失败（误报为插件缺陷）。
        await this.installRuntimeDeps(payloadDir);
        const { pluginId, dirName } = await this.identifyPlugin(payloadDir, parsed);
        // doctor 全链（manifest/backend/register/client）在依赖就绪后执行
        const report = await doctorPluginDir(payloadDir);
        if (!report.ok) {
          const first = report.checks.find((c) => c.error !== undefined);
          throw new HelmError(
            'plugin_package_doctor_failed',
            `插件包安装预检失败（${first ? `${first.label}：${first.error!.message}` : '未知检查失败'}），已放弃安装`,
            422,
            { source: parsed, staging: payloadDir, report },
          );
        }
        // 重复安装防护（先于任何目录操作）：已有受管记录或已注册实例均拒绝
        if (this.store.getRecord(pluginId) !== undefined) {
          throw new HelmError(
            'plugin_package_already_installed',
            `插件 ${pluginId} 已受管安装（请用 update 更新，或先 remove 后重装）`,
            409,
            { pluginId },
          );
        }
        if (this.host.listSummaries().some((s) => s.id === pluginId)) {
          throw new HelmError(
            'plugin_package_already_installed',
            `插件 ${pluginId} 已注册（可能是手放置入目录的外部插件），拒绝重复安装`,
            409,
            { pluginId },
          );
        }
        const target = join(this.pluginsDir(), safeDirName(dirName));
        assertInsideDataDir(this.pluginsDir(), target);
        if (await pathExists(target)) {
          throw new HelmError(
            'plugin_package_target_occupied',
            `安装目标目录已存在（未知来源残留，请人工检查后处理）：${target}`,
            409,
            { pluginId, target },
          );
        }
        await mkdir(dirname(target), { recursive: true });
        await rename(payloadDir, target);
        inPlace = true;
        // 注册 -> 持久化：任一失败删除新 target 完全回滚（未注册目录不残留）
        let registered: Awaited<ReturnType<PackageManagerHost['registerManagedPlugin']>>;
        try {
          registered = await this.host.registerManagedPlugin(target, { enabled: false });
        } catch (err) {
          await rm(target, { recursive: true, force: true }).catch(() => {});
          inPlace = false;
          throw new HelmError(
            'plugin_package_install_failed',
            `插件 ${pluginId} 安装后注册失败，已回滚（新目录已删除）：${err instanceof Error ? err.message : String(err)}`,
            500,
            {
              pluginId,
              target,
              rolledBack: true,
              cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
            },
          );
        }
        let summary = registered.summary;
        let enableError: { message: string; code: string } | undefined;
        if (options.enable === true) {
          try {
            summary = await this.host.enableManagedPlugin(registered.pluginId);
          } catch (err) {
            // 启用失败不回滚安装（设计允许）：插件保持 disabled，诊断透传；
            // 注册与目录均已在位，记录持久化后重启可加载重试。
            enableError = {
              message: err instanceof Error ? err.message : String(err),
              code: err instanceof HelmError ? err.code : 'plugin_enable_failed',
            };
            const fallback = this.host.listSummaries().find((s) => s.id === registered.pluginId);
            summary = { ...registered.summary, ...(fallback !== undefined ? { enabled: fallback.enabled } : {}) };
          }
        }
        try {
          const record = await this.store.save({
            pluginId: registered.pluginId,
            source: parsed,
            installPath: target,
            version: summary.version ?? '',
            installedAt: Date.now(),
            updatedAt: Date.now(),
          });
          return {
            record,
            summary: this.attachManaged(summary, record),
            ...(enableError !== undefined ? { enableError } : {}),
          };
        } catch (err) {
          // 持久化失败：目录与注册实例均已存在但无记录——不可靠状态，整体回滚
          await this.host.removeManagedPlugin(registered.pluginId).catch(() => {});
          await rm(target, { recursive: true, force: true }).catch(() => {});
          inPlace = false;
          throw new HelmError(
            'plugin_package_install_failed',
            `插件 ${pluginId} 安装记录持久化失败，已回滚（实例注销、新目录删除）：${err instanceof Error ? err.message : String(err)}`,
            500,
            {
              pluginId,
              target,
              rolledBack: true,
              cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
            },
          );
        }
      } finally {
        // staging 全量清理；回滚路径下 target 已单独删除，不经过 staging
        void inPlace;
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** summary 附加受管包元数据（PluginSummary.managed 映射）。 */
  private attachManaged(summary: PluginSummary, record: PluginPackageRecord): PluginSummary {
    return {
      ...summary,
      managed: {
        source: record.source,
        installId: record.id,
        installedVersion: record.version,
        installedAt: record.updatedAt,
      },
    };
  }

  // --- 更新 -------------------------------------------------------------

  /**
   * 原子更新已安装插件包：
   * 1. 安全预检（在途任务 409 / provider 忙）——旧实例与旧目录保持不动；
   * 2. staging 重取 source -> 运行时依赖补装 -> doctor 全链（同样不动旧目录）；
   * 3. 切换：旧目录 rename 到 staging backup -> 新 payload rename 进受管目录
   *    -> reload 重注册（保持启用状态）；成功后删 backup；
   * 4. 切换失败（reload/register 抛错）：新目录移回 staging，backup rename
   *    回受管目录，再次 reload 恢复旧实例；回滚失败如实上报（需人工介入）。
   * 记录仅在切换成功后推进。local 源码编辑后 update 即重新拷贝同步。
   */
  async update(pluginId: string): Promise<PluginUpdateResult> {
    return this.enqueue(async () => {
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmError('unknown_plugin_package', `插件 ${pluginId} 没有受管安装记录（仅受管安装的插件可 update）`, 404, { pluginId });
      }
      // 1. 安全预检：在途任务 / provider 忙时拒绝，旧目录与旧实例不动
      await this.host.assertManagedPluginUpdateSafe(pluginId);
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      const backup = join(staging, 'backup');
      let switched = false;
      try {
        // 2. staging 重取 + 依赖 + doctor（全部在 staging 内，旧目录不动）
        const payloadDir = await this.fetchIntoStaging(record.source, staging);
        await this.installRuntimeDeps(payloadDir);
        const identified = await this.identifyPlugin(payloadDir, record.source);
        if (identified.pluginId !== pluginId) {
          throw new HelmError(
            'plugin_package_id_changed',
            `更新后插件 id 变更（期望 ${pluginId}，实际 ${identified.pluginId}），拒绝替换`,
            409,
            { pluginId, actualId: identified.pluginId },
          );
        }
        const report = await doctorPluginDir(payloadDir);
        if (!report.ok) {
          const first = report.checks.find((c) => c.error !== undefined);
          throw new HelmError(
            'plugin_package_doctor_failed',
            `插件包更新预检失败（${first ? `${first.label}：${first.error!.message}` : '未知检查失败'}），已保留现安装`,
            422,
            { source: record.source, staging: payloadDir, report },
          );
        }
        const target = record.installPath;
        assertInsideDataDir(this.pluginsDir(), target);
        const previousVersion = record.version;
        // 3. 原子切换：旧目录 -> staging backup，新 payload -> 受管目录
        if (await pathExists(target)) {
          await rename(target, backup);
        }
        try {
          await rename(payloadDir, target);
          switched = true;
        } catch (err) {
          // 新目录没进入：backup 立即回原位，旧实例未受任何影响
          if (await pathExists(backup)) await rename(backup, target).catch(() => {});
          throw err;
        }
        // reload 重注册（保持启用状态）；失败则回滚目录与实例
        let reloadError: unknown;
        try {
          const { summary } = await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true });
          const updated = await this.store.save({
            pluginId,
            source: record.source,
            installPath: target,
            version: summary.version ?? '',
            installedAt: record.installedAt,
            updatedAt: Date.now(),
          });
          return {
            record: updated,
            summary: this.attachManaged(summary, updated),
            // 版本串未变但内容重同步仍是事实变更（local 源编辑后 update）；如实 true
            changed: true,
            previousVersion,
          };
        } catch (err) {
          reloadError = err;
        }
        // 4. reload 失败回滚：新目录移回 staging，backup 回受管目录，旧实例重载
        let rollbackError: { message: string } | undefined;
        try {
          await rename(target, join(staging, 'failed-new'));
          if (await pathExists(backup)) await rename(backup, target);
          await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true }).catch(() => {});
        } catch (rollbackErr) {
          rollbackError = { message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) };
        }
        throw new HelmError(
          'plugin_package_update_failed',
          `插件 ${pluginId} 更新后重载失败${rollbackError === undefined ? '（已回滚到更新前目录与实例，旧版本继续可用）' : `（回滚也失败：${rollbackError.message}，需人工检查受管目录后重试）`}：${reloadError instanceof Error ? reloadError.message : String(reloadError)}`,
          500,
          {
            pluginId,
            installPath: target,
            rolledBack: rollbackError === undefined,
            ...(rollbackError !== undefined ? { rollbackError } : {}),
            cause: reloadError instanceof Error ? { message: reloadError.message, stack: reloadError.stack } : undefined,
          },
        );
      } finally {
        // staging 清理：switched 成功后 backup（旧版本）随 staging 一并删除
        void switched;
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // --- 移除 -------------------------------------------------------------

  /**
   * 移除受管安装：unregister（builtin/在途任务/providers 由 host 保护）->
   * 关联清理持久化文档数据（等待 DELETE 真实落盘，失败显式拒绝）-> 删除
   * 受管目录 -> 删除记录。local 来源只删受管副本与记录，绝不触碰用户源目录
   * （install 即拷贝，用户源从未进入受管树）。清理在删目录/记录之前且等待
   * 落盘：任一步失败可重试（记录未删即幂等可续）。
   */
  async remove(pluginId: string): Promise<PluginRemoveResult> {
    return this.enqueue(async () => {
      if (pluginId.startsWith('builtin:')) {
        throw new HelmError('plugin_locked', `内置插件 ${pluginId} 不可移除`, 403, { pluginId });
      }
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmError('unknown_plugin_package', `插件 ${pluginId} 没有受管安装记录（手放置入目录的插件请直接删除目录）`, 404, { pluginId });
      }
      const { wasEnabled } = await this.host.removeManagedPlugin(pluginId);
      // purge 等待 DELETE 真实落盘后才 resolve：失败在此显式拒绝，目录与
      // 安装记录保持原样（记录未删即幂等可重试）。
      await this.host.purgePluginPersistentData(pluginId);
      const target = record.installPath;
      assertInsideDataDir(this.pluginsDir(), target);
      await rm(target, { recursive: true, force: true });
      await this.store.delete(pluginId);
      return { pluginId, installPath: target, wasEnabled, installId: record.id };
    });
  }

  // --- staging 获取（按来源分派） ----------------------------------------

  private async fetchIntoStaging(source: PluginPackageSource, staging: string): Promise<string> {
    if (source.kind === 'npm') return this.fetchNpm(source, staging);
    if (source.kind === 'git') return this.fetchGit(source, staging);
    return this.fetchLocal(source, staging);
  }

  /** npm pack 拉取 tarball + 解包（不做全局 npm install，绝不运行 scripts）。 */
  private async fetchNpm(source: Extract<PluginPackageSource, { kind: 'npm' }>, staging: string): Promise<string> {
    const packDir = join(staging, 'pack');
    await mkdir(packDir, { recursive: true });
    const packArgs = ['pack', source.spec, '--pack-destination', packDir, '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts'];
    const pack = await this.run('npm', packArgs);
    if (pack.code !== 0) {
      throw commandError('install', 'npm', packArgs, pack);
    }
    // 找 tarball 并解包到 payload/
    const files = await readdir(packDir);
    const tarball = files.find((f) => f.endsWith('.tgz'));
    if (tarball === undefined) {
      throw new HelmError('plugin_package_install_failed', `npm pack 未产出 tarball（spec: ${source.spec}）`, 500, { spec: source.spec, stdoutTail: tailLines(pack.stdout) });
    }
    const payload = join(staging, 'payload');
    await mkdir(payload, { recursive: true });
    const extract = await this.run('tar', ['-xzf', join(packDir, tarball), '-C', payload]);
    if (extract.code !== 0) throw commandError('install', 'tar', ['-xzf'], extract);
    // npm tarball 内层为 package/ 目录
    const inner = join(payload, 'package');
    const innerStat = await stat(inner).catch(() => undefined);
    return innerStat?.isDirectory() === true ? inner : payload;
  }

  /** git clone --depth 1（带 ref 时加 --branch）+ 子目录定位。 */
  private async fetchGit(source: Extract<PluginPackageSource, { kind: 'git' }>, staging: string): Promise<string> {
    const repoDir = join(staging, 'repo');
    const args = ['clone', '--depth', '1', ...(source.ref !== undefined ? ['--branch', source.ref] : []), '--', source.repo, repoDir];
    const clone = await this.run('git', args);
    if (clone.code !== 0) throw commandError('install', 'git', args, clone);
    let root = repoDir;
    if (source.subdirectory !== undefined) {
      root = join(repoDir, source.subdirectory);
      const st = await stat(root).catch(() => undefined);
      if (st?.isDirectory() !== true) {
        throw new HelmError('plugin_package_install_failed', `git 仓库内子目录不存在：${source.subdirectory}`, 404, { repo: source.repo, subdirectory: source.subdirectory });
      }
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(root, payload);
    return payload;
  }

  /** local：校验目录存在且不在受管插件树内部（防自拷贝），过滤拷贝。 */
  private async fetchLocal(source: Extract<PluginPackageSource, { kind: 'local' }>, staging: string): Promise<string> {
    const st = await stat(source.path).catch(() => undefined);
    if (st?.isDirectory() !== true) {
      throw new HelmError('plugin_package_install_failed', `本地插件目录不存在或不是目录：${source.path}`, 404, { path: source.path });
    }
    const rel = relative(resolve(this.pluginsDir()), resolve(source.path));
    const inside = !(rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    if (inside) {
      throw new HelmError(
        'validation_error',
        `本地插件目录位于受管插件树内部（${this.pluginsDir()}），禁止自安装：${source.path}`,
        400,
        { path: source.path },
      );
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(source.path, payload);
    return payload;
  }

  /**
   * staging 副本内安装运行时依赖（npm/git/local 同权：凡携带 package.json
   * 即补装；--omit=dev 且永不运行 lifecycle scripts；local 源已是过滤拷贝，
   * 用户源目录不受影响）。无 package.json 时为 no-op。
   */
  private async installRuntimeDeps(dir: string): Promise<void> {
    const pkgJson = join(dir, 'package.json');
    const has = await stat(pkgJson).then(() => true).catch(() => false);
    if (!has) return;
    const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts', '--no-package-lock-only'];
    const result = await this.run('npm', args, dir);
    if (result.code !== 0) throw commandError('install', 'npm', args, result);
  }

  /**
   * 从 payload 目录识别插件 id：优先 plugin.json/package.json helm 字段推导，
   * 回退约定入口探测名；最终以 doctor 报告的 pluginId 为准。
   */
  private async identifyPlugin(payloadDir: string, source: PluginPackageSource): Promise<{ pluginId: string; dirName: string }> {
    const report = await doctorPluginDir(payloadDir);
    if (report.ok && report.pluginId !== undefined) {
      return { pluginId: report.pluginId, dirName: report.pluginId };
    }
    // doctor 未到达定义导出：用清单声明的 id 兜底目录名（doctor 失败会在随后步骤如实报错）
    const declared = await readDeclaredPluginId(payloadDir);
    if (declared !== undefined) return { pluginId: declared, dirName: declared };
    throw new HelmError(
      'plugin_package_doctor_failed',
      `无法识别插件 id（doctor 未通过且清单未声明 id）：${source.raw}`,
      422,
      { source, report },
    );
  }

  private async run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
    const workDir = cwd ?? (await this.ensureStagingRoot());
    const result = await this.runner(cmd, args, { cwd: workDir, timeoutMs: this.timeoutMs });
    // npm pack 的非零退出在调用处加工（需要 tarball 探测语义）；其余命令统一报错
    const isNpmPack = cmd === 'npm' && args[0] === 'pack';
    if (result.code !== 0 && !isNpmPack) {
      throw commandError('install', cmd, args, result);
    }
    return result;
  }
}

/** 路径存在性探测（目录或文件；IO 错误原样上抛，不肩吞）。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** 读 plugin.json id / package.json name|helm 字段（仅目录名推导用）。 */
async function readDeclaredPluginId(dir: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  const pluginJson = join(dir, 'plugin.json');
  try {
    const manifest = JSON.parse(await readFile(pluginJson, 'utf8')) as Record<string, unknown>;
    if (typeof manifest['id'] === 'string' && manifest['id'].length > 0) return manifest['id'];
    if (typeof manifest['main'] === 'string') return undefined; // main 存在但无 id：交给 doctor
  } catch { /* 无 plugin.json 或损坏：doctor 链会给结构化报告 */ }
  const pkgJson = join(dir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as Record<string, unknown>;
    const helm = pkg['helm'];
    if (typeof helm === 'object' && helm !== null && typeof (helm as Record<string, unknown>)['id'] === 'string') {
      return (helm as Record<string, unknown>)['id'] as string;
    }
    if (typeof pkg['name'] === 'string' && PLUGIN_ID_PATTERN.test(pkg['name'])) return pkg['name'];
  } catch { /* 同上 */ }
  return undefined;
}
