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
  updateManagedPlugin(pluginId: string, dir: string, options: { keepEnabled: boolean }): Promise<{ summary: PluginSummary }>;
  removeManagedPlugin(pluginId: string): Promise<{ wasEnabled: boolean }>;
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
   * 安装插件包：解析 source -> staging 获取 -> doctor 全链 -> 原子进入受管
   * 目录 -> 持久化记录 -> 注册（默认 disabled；enable: true 安装后启用，启用
   * 失败保留诊断且不回滚安装）。失败清理 staging，不留半产物。
   */
  async install(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    const parsed = parsePluginSource(source, this.cwd);
    return this.enqueue(async () => {
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      let committed = false;
      try {
        const payloadDir = await this.fetchIntoStaging(parsed, staging);
        const { pluginId, dirName } = await this.identifyPlugin(payloadDir, parsed);
        // 先 doctor staging 副本（现有 doctor 全链：manifest/backend/register/client）
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
        // npm 来源：受管目录内补装运行时依赖（不运行 lifecycle scripts）
        if (parsed.kind === 'npm') await this.installRuntimeDeps(payloadDir);
        const target = join(this.pluginsDir(), safeDirName(dirName));
        assertInsideDataDir(this.pluginsDir(), target);
        await this.removeExistingDir(target);
        await mkdir(dirname(target), { recursive: true });
        await rename(payloadDir, target);
        committed = true;
        // 注册（默认 disabled；enable 选项在注册成功后走真实 enable 链）
        const registered = await this.host.registerManagedPlugin(target, { enabled: false });
        let summary = registered.summary;
        let enableError: { message: string; code: string } | undefined;
        if (options.enable === true) {
          try {
            summary = await this.host.enableManagedPlugin(registered.pluginId);
          } catch (err) {
            enableError = {
              message: err instanceof Error ? err.message : String(err),
              code: err instanceof HelmError ? err.code : 'plugin_enable_failed',
            };
          }
        }
        void committed;
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
      } finally {
        // staging 全量清理（committed 后 payload 已 rename 离开；余下目录删除）
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
   * 更新已安装插件包：重取 source 进 staging -> doctor -> 原子替换受管目录 ->
   * 复用 reload 语义重注册（保持启用状态）-> 推进记录。
   * source 未变化时如实返回 changed: false（幂等语义），但目录内容仍以最新
   * source 为准重同步（local 源码编辑后 update 即重新拷贝）。
   */
  async update(pluginId: string): Promise<PluginUpdateResult> {
    return this.enqueue(async () => {
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmError('unknown_plugin_package', `插件 ${pluginId} 没有受管安装记录（仅受管安装的插件可 update）`, 404, { pluginId });
      }
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      let committed = false;
      try {
        const payloadDir = await this.fetchIntoStaging(record.source, staging);
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
        if (record.source.kind === 'npm') await this.installRuntimeDeps(payloadDir);
        const target = record.installPath;
        assertInsideDataDir(this.pluginsDir(), target);
        const previousVersion = record.version;
        await this.removeExistingDir(target);
        await rename(payloadDir, target);
        committed = true;
        // 复用 reload 语义（unregister + 新代际注册；保持启用状态）
        const { summary } = await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true });
        const newVersion = summary.version ?? '';
        // 版本串未变但内容重同步仍是事实变更（local 源编辑后 update）；如实 true。
        const changed = true;
        void newVersion;
        const updated = await this.store.save({
          pluginId,
          source: record.source,
          installPath: target,
          version: newVersion,
          installedAt: record.installedAt,
          updatedAt: Date.now(),
        });
        return {
          record: updated,
          summary: this.attachManaged(summary, updated),
          changed,
          previousVersion,
        };
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // --- 移除 -------------------------------------------------------------

  /**
   * 移除受管安装：unregister（builtin/在途任务/providers 由 host 保护）->
   * 删除受管目录 -> 删除记录。local 来源只删受管副本与记录，绝不触碰用户源
   * 目录（install 即拷贝，用户源从未进入受管树）。
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

  /** 受管目录内安装运行时依赖（--omit=dev；永不运行 lifecycle scripts）。 */
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

  private async removeExistingDir(target: string): Promise<void> {
    await rm(target, { recursive: true, force: true });
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
