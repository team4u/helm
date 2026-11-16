/**
 * external plugin package manage:install / update / remove transaction.
 *
 * imitate Pi package manager  source model (npm / git / local one step to), but helm
 * install semantics isstaging copy + existing doctor all chain + atomic enter managed directory + persist
 * record + register enter PluginHost, does not market database, does not version directory pool, does not to after migration.
 *
 * security and honest discipline:
 * - npm install forever do not run lifecycle scripts(--ignore-scripts --no-audit --no-fund,
 *   --foreground-scripts make any bypass explicit visible);git use non- interaction environment variable
 *   (GIT_TERMINAL_PROMPT=0/GIT_ASKPASS=echo) and --depth 1 shallow clone;
 * - staging one rule in <dataDir>/plugins/.staging/<uuid>/ inside; after success atomic rename
 *   enter <dataDir>/plugins/<safeName>/; failed (contains doctor failed, register failed) clean up
 *   staging, never half artifact;rename failed explicit errors and clean up;
 * - local source and npm/git same copy enter managed directory (do not symlink):PluginHost.register
 *   will <dataDir>/plugins/<pluginId> also as plugin source directory and ctx.dataDir, symbol
 *   link will plugin data write user source code tree,remove will break user file. proxy price (edit source code
 *   must update heavy sync) in install result and error information in such as note;
 * - copy exclude node_modules / .git / point open head file/directory (managed install excludes build artifact and
 *   VCS metadata;npm source runtime dependency declaration at package.json.dependencies, by
 *   managed install step with --omit=dev patch complete and same do not run lifecycle scripts);
 * - subject to message plugin process inside execute boundary such as declaration:doctor/register/enable plugin code in this Hub
 *   process inside run, own host permission; this manage path validate only is managed directory boundary convention,
 *   is not sandbox. this file head and error information by this opening path table state, never sound call sandbox.
 *
 * install directory name safeName: takes precedence package inside define id(plugin.json/package.json helm field
 * parse after plugin id), fall back directory probe name; eventually with doctor real import obtain to plugin id
 * is allow (directory name and id inconsistent when with id is allow, install record same by id key control).
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HelmError, type PluginBuildProvider, type PluginInstallResult, type PluginPackageRecord, type PluginRemoveResult, type PluginPackageSource, type PluginSummary, type PluginUpdateResult } from '@helm/protocol';
import { parsePluginSource } from './package-source.js';
import { doctorPluginDir } from './plugin-doctor.js';
import { readHelmClientDependencies } from './plugin-manifest.js';
import type { PluginPackageManagerStore } from './package-store.js';

// ---------------------------------------------------------------------------
// process execute bottom seat (can inject fake: test independent of real network)
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** process run: real implement spawn npm/git; test inject fake. */
export type PackageRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

/** by default runner: non- interaction environment, merge stdout/stderr, timeout SIGKILL. */
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

/** end 40 row snapshot (honest discipline: external handover failed must attach terminal output). */
export function tailLines(text: string, lines = 40): string {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim();
}

function commandError(kind: string, cmd: string, args: string[], result: RunResult): HelmError {
  return new HelmError(
    `plugin_package_${kind}_failed`,
    `plugin package${kind === 'install' ? 'install' : kind === 'update' ? 'update' : 'remove'}command failed:${cmd} ${args.join(' ')}(exit ${result.code})\n${tailLines(result.stderr || result.stdout)}`,
    500,
    { cmd, args, code: result.code, stdoutTail: tailLines(result.stdout), stderrTail: tailLines(result.stderr) },
  );
}

// ---------------------------------------------------------------------------
// manage
// ---------------------------------------------------------------------------

/** PluginHost collection into port (real PluginHost structure compatibility, convenient at test inject fake host). */
export interface PackageManagerHost {
  registerManagedPlugin(dir: string, options: { enabled: boolean }): Promise<{ summary: PluginSummary; pluginId: string }>;
  /** install after enable (install enable: true path; failed diagnose to on pass-through, do not rollback install). */
  enableManagedPlugin(pluginId: string): Promise<PluginSummary>;
  /** update switch before security preflight: in-flight task 409 / provider busy then reject (old instance and old directory do not motion). */
  assertManagedPluginUpdateSafe(pluginId: string): Promise<void> | void;
  updateManagedPlugin(pluginId: string, dir: string, options: { keepEnabled: boolean }): Promise<{ summary: PluginSummary }>;
  removeManagedPlugin(pluginId: string): Promise<{ wasEnabled: boolean }>;
  /**
   * unload related clean up: delete the plugin persist document data (global doc + conversation document) and wait for
   * DELETE real; failed explicit reject,remove based on this keep directory and install record with convenient retry.
   */
  purgePluginPersistentData(pluginId: string): Promise<void>;
  listSummaries(): PluginSummary[];
}

export interface PluginPackageManagerOptions {
  dataDir: string
  /** Hub cwd(each other for local path parse base allow). */
  cwd: string
  store: PluginPackageManagerStore
  host: PackageManagerHost
  runner?: PackageRunner
  /** single command timeout (by default 120s). */
  commandTimeoutMs?: number
  /**
   * plugin build port (runtime inject, and PluginHostOptions.buildProvider the same instance):
   * install/update  doctor preflight and produce the same compile/transpile opening path. missing when carries client reference
   * or TS source package in doctor where such as failed, not silently fall back.
   */
  buildProvider?: PluginBuildProvider
}

const COPY_IGNORE = new Set(['node_modules', '.git', '.staging']);
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeDirName(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.startsWith('builtin:')) {
    throw new HelmError('invalid_plugin_definition', `plugin id disallows as managed install directory name:${pluginId}`, 400, { pluginId });
  }
  return pluginId;
}

function assertInsideDataDir(dataDir: string, target: string): void {
  const rel = relative(resolve(dataDir), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError('validation_error', `install target exceeds out managed plugin directory:${target}`, 400, { target });
  }
}

/** pure data directory copy (excludes symlink target; ignore node_modules/.git/point prefix). */
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
    // symlink / fifo etc. special file skip (managed install does not carry link and device file)
  }
}

/**
 * plugin package manage. all operation via manager level mutual exclusion queue serial (install/update/remove
 * mutual do not concurrency;PluginHost internal per-plugin lifecycle queue by host port guarantee).
 */
export class PluginPackageManager {
  private readonly dataDir: string;
  private readonly cwd: string;
  private readonly store: PluginPackageManagerStore;
  private readonly host: PackageManagerHost;
  private readonly runner: PackageRunner;
  private readonly timeoutMs: number;
  private readonly buildProvider?: PluginBuildProvider;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: PluginPackageManagerOptions) {
    this.dataDir = options.dataDir;
    this.cwd = options.cwd;
    this.store = options.store;
    this.host = options.host;
    this.runner = options.runner ?? defaultPackageRunner;
    this.timeoutMs = options.commandTimeoutMs ?? 120_000;
    this.buildProvider = options.buildProvider;
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

  /** staging directory create (idempotent; first time install before guarantee store in). */
  private async ensureStagingRoot(): Promise<string> {
    const root = this.stagingRoot();
    await mkdir(root, { recursive: true });
    return root;
  }

  // --- install -------------------------------------------------------------

  /**
   * install plugin package: parse source -> staging get -> runtime dependency -> doctor all chain ->
   * atomic enter managed directory -> persist record -> register (by default disabled).
   *
   * transaction semantics (do not half artifact, do not break run in instance):
   * - duplicate install protect: same pluginId already has managed record or registered instance when explicit 409
   *   plugin_package_already_installed(not silently override; must update please away update);
   * - target directory occupy protect:target already exists (leftover directory or same name other plugin directory) when
   *   explicit 409, do not first delete after install;
   * - rename enter after any failed (register / persist): delete new target rollback,staging
   *   one and clean up, never not registered directory and registered instance tear state;
   * - enable: true enable failed do not rollback install (design allows, failed diagnose via enableError
   *   pass-through), but install/record chain itself on failure must fully rollback; enable on failure plugin keep
   *   disabled, record persisted, after restart can normal load and retry enable.
   */
  async install(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    const parsed = parsePluginSource(source, this.cwd);
    return this.enqueue(async () => {
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      let inPlace = false; // payload already rename enter managed target
      try {
        const payloadDir = await this.fetchIntoStaging(parsed, staging);
        // runtime dependency first at doctor: carries package.json package (npm/git/local same right) in
        // staging copy inside patch install --omit=dev(do not trigger touch user local source:local already is filter copy),
        // otherwise dependency npm package entry in doctor proxy boundary import when i.e. failed (mistakenly report is plugin defect).
        await this.installRuntimeDeps(payloadDir);
        const { pluginId, dirName } = await this.identifyPlugin(payloadDir, parsed);
        // doctor all chain (manifest/backend/register/client) in dependency ready after execute
        const report = await doctorPluginDir(payloadDir, { buildProvider: this.buildProvider });
        if (!report.ok) {
          const first = report.checks.find((c) => c.error !== undefined);
          throw new HelmError(
            'plugin_package_doctor_failed',
            `plugin package install preflight failed (${first ? `${first.label}:${first.error!.message}` : 'unknown check failed'}), already abandon install`,
            422,
            { source: parsed, staging: payloadDir, report },
          );
        }
        // duplicate install protect (first at any directory operation): already has managed record or registered instance all reject
        if (this.store.getRecord(pluginId) !== undefined) {
          throw new HelmError(
            'plugin_package_already_installed',
            `plugin ${pluginId} already managed install (please use update update, or first remove after heavy install)`,
            409,
            { pluginId },
          );
        }
        if (this.host.listSummaries().some((s) => s.id === pluginId)) {
          throw new HelmError(
            'plugin_package_already_installed',
            `plugin ${pluginId} registered (may is manually put placement directory external plugin), reject duplicate install`,
            409,
            { pluginId },
          );
        }
        const target = join(this.pluginsDir(), safeDirName(dirName));
        assertInsideDataDir(this.pluginsDir(), target);
        if (await pathExists(target)) {
          throw new HelmError(
            'plugin_package_target_occupied',
            `install target directory already exists (unknown source leftover, please human check post-process):${target}`,
            409,
            { pluginId, target },
          );
        }
        await mkdir(dirname(target), { recursive: true });
        await rename(payloadDir, target);
        inPlace = true;
        // register -> persist: any one failed delete new target fully rollback (not registered directory leaves no residue)
        let registered: Awaited<ReturnType<PackageManagerHost['registerManagedPlugin']>>;
        try {
          registered = await this.host.registerManagedPlugin(target, { enabled: false });
        } catch (err) {
          // register failed may is concurrency host heavy scan (rescan/load chain, do not via this manager mutual exclusion)
          // already from same directory grab first register same name plugin: now directory already ownership that instance,rm will hollow out
          // its source directory and dataDir. only confirm without same name registered instance when only then delete directory rollback.
          if (this.host.listSummaries().some((s) => s.id === pluginId)) {
            inPlace = false;
            throw new HelmError(
              'plugin_package_install_failed',
              `plugin ${pluginId} install after register failed: detect to same name plugin registered (may is concurrency scan from same directory grab first register), directory and the instance already keep, please human confirm after use remove take over (without managed install record):${err instanceof Error ? err.message : String(err)}`,
              500,
              {
                pluginId,
                target,
                rolledBack: false,
                cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
              },
            );
          }
          await rm(target, { recursive: true, force: true }).catch(() => {});
          inPlace = false;
          throw new HelmError(
            'plugin_package_install_failed',
            `plugin ${pluginId} install after register failed, already rollback (new directory deleted):${err instanceof Error ? err.message : String(err)}`,
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
            // enable failed do not rollback install (design allows): plugin keep disabled, diagnose pass-through;
            // register and directory all already in, record persist after restart can load retry.
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
          // persist failed: deregister instance after delete directory whole rollback. deregister failed (such as in-flight task 409)
          // when never for still register run instance rm hollow out source directory - - keep now state and such as errors.
          let unregisterError: unknown;
          try {
            await this.host.removeManagedPlugin(registered.pluginId);
          } catch (removeErr) {
            unregisterError = removeErr;
          }
          if (unregisterError === undefined) {
            await rm(target, { recursive: true, force: true }).catch(() => {});
            inPlace = false;
            throw new HelmError(
              'plugin_package_install_failed',
              `plugin ${pluginId} install record persist failed, already rollback (instance deregister, new directory delete):${err instanceof Error ? err.message : String(err)}`,
              500,
              {
                pluginId,
                target,
                rolledBack: true,
                cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
              },
            );
          }
          throw new HelmError(
            'plugin_package_install_failed',
            `plugin ${pluginId} install record persist failed, and rollback deregister instance failed (${unregisterError instanceof Error ? unregisterError.message : String(unregisterError)}); directory and instance already keep (please clean up in-flight task after manually remove)`,
            500,
            {
              pluginId,
              target,
              rolledBack: false,
              cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
              rollbackError: unregisterError instanceof Error
                ? { message: unregisterError.message, stack: unregisterError.stack }
                : { message: String(unregisterError) },
            },
          );
        }
      } finally {
        // staging all amount clean up; rollback path under target already separate delete, without going through staging
        void inPlace;
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** summary additional managed package metadata (PluginSummary.managed mapping). */
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

  // --- update -------------------------------------------------------------

  /**
   * atomic update installed plugin package:
   * 1. security preflight (in-flight task 409 / provider busy) - - old instance and old directory keep do not motion;
   * 2. staging heavy take source -> runtime dependency patch install -> doctor all chain (same do not motion old directory);
   * 3. switch: old directory rename to staging backup -> new payload rename enter managed directory
   *    -> reload heavy register (keep enable state); after success delete backup;
   * 4. switch failed (reload/register throws): new directory move back staging,backup rename
   *    back managed directory, again reload restore old instance; rollback failed such as on report (must human introduce).
   * record only in switch after success push enter.local source code edit after update i.e. re- copy sync.
   */
  async update(pluginId: string): Promise<PluginUpdateResult> {
    return this.enqueue(async () => {
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmError('unknown_plugin_package', `plugin ${pluginId} no managed install record (only managed install plugin can update)`, 404, { pluginId });
      }
      // 1. security preflight: in-flight task / provider busy when reject, old directory and old instance do not motion
      await this.host.assertManagedPluginUpdateSafe(pluginId);
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      const backup = join(staging, 'backup');
      let switched = false;
      try {
        // 2. staging heavy take + dependency + doctor(all in staging inside, old directory do not motion)
        const payloadDir = await this.fetchIntoStaging(record.source, staging);
        await this.installRuntimeDeps(payloadDir);
        const identified = await this.identifyPlugin(payloadDir, record.source);
        if (identified.pluginId !== pluginId) {
          throw new HelmError(
            'plugin_package_id_changed',
            `update after plugin id change (expectation ${pluginId}, actual ${identified.pluginId}), reject replace`,
            409,
            { pluginId, actualId: identified.pluginId },
          );
        }
        const report = await doctorPluginDir(payloadDir, { buildProvider: this.buildProvider });
        if (!report.ok) {
          const first = report.checks.find((c) => c.error !== undefined);
          throw new HelmError(
            'plugin_package_doctor_failed',
            `plugin package update preflight failed (${first ? `${first.label}:${first.error!.message}` : 'unknown check failed'}), already keep now install`,
            422,
            { source: record.source, staging: payloadDir, report },
          );
        }
        const target = record.installPath;
        assertInsideDataDir(this.pluginsDir(), target);
        const previousVersion = record.version;
        // 3. atomic switch: old directory -> staging backup, new payload -> managed directory
        if (await pathExists(target)) {
          await rename(target, backup);
        }
        try {
          await rename(payloadDir, target);
          switched = true;
        } catch (err) {
          // new directory not enter:backup immediately back original, old instance not subject to any affect
          if (await pathExists(backup)) await rename(backup, target).catch(() => {});
          throw err;
        }
        // reload heavy register (keep enable state); failed then rollback directory and instance
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
            // version string not change but content heavy sync still is fact change (local source edit after update); such as true
            changed: true,
            previousVersion,
          };
        } catch (err) {
          reloadError = err;
        }
        // 4. reload failed rollback: new directory move back staging,backup back managed directory, old instance reload.
        // directory restore and instance restore open such as on report: restore reload on failure instance may deregistered
        //(reloadExternalPlugin switch failed i.e. deregister), never swallow wrong lie report old version continue available.
        let rollbackError: { message: string } | undefined;
        try {
          await rename(target, join(staging, 'failed-new'));
          if (await pathExists(backup)) await rename(backup, target);
        } catch (rollbackErr) {
          rollbackError = {
            message: `directory restore failed:${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}, must human check managed directory`,
          };
        }
        if (rollbackError === undefined) {
          try {
            await this.host.updateManagedPlugin(pluginId, target, { keepEnabled: true });
          } catch (restoreErr) {
            rollbackError = {
              message: `old directory already restore, but old instance reload failed:${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}, plugin when before may deregistered, must human handle after retry`,
            };
          }
        }
        throw new HelmError(
          'plugin_package_update_failed',
          `plugin ${pluginId} update after reload failed${rollbackError === undefined ? '(already rollback to update before directory and instance, old version continue available)' : `(rollback do not complete:${rollbackError.message})`}:${reloadError instanceof Error ? reloadError.message : String(reloadError)}`,
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
        // staging clean up:switched after success backup(old version) follow staging one and delete
        void switched;
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // --- remove -------------------------------------------------------------

  /**
   * remove managed install:unregister(builtin/in-flight task/providers by host protect)->
   * related clean up persist document data (wait for DELETE real, failed explicit reject)-> delete
   * managed directory -> delete record.local source only delete managed copy and record, never trigger touch user source directory
   * (install i.e. copy, user source from not enter managed tree). clean up in delete directory/record before and wait for
   * : any one step failed can retry (record not delete i.e. idempotent can continue).
   */
  async remove(pluginId: string): Promise<PluginRemoveResult> {
    return this.enqueue(async () => {
      if (pluginId.startsWith('builtin:')) {
        throw new HelmError('plugin_locked', `built-in plugin ${pluginId} cannot remove`, 403, { pluginId });
      }
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmError('unknown_plugin_package', `plugin ${pluginId} no managed install record (manually put placement directory plugin please directly delete directory)`, 404, { pluginId });
      }
      const { wasEnabled } = await this.host.removeManagedPlugin(pluginId);
      // purge wait for DELETE real after only then resolve: failed in this explicit reject, directory and
      // install record keep original (record not delete i.e. idempotent can retry).
      await this.host.purgePluginPersistentData(pluginId);
      const target = record.installPath;
      assertInsideDataDir(this.pluginsDir(), target);
      await rm(target, { recursive: true, force: true });
      await this.store.delete(pluginId);
      return { pluginId, installPath: target, wasEnabled, installId: record.id };
    });
  }

  // --- staging get (by source dispatch) ----------------------------------------

  private async fetchIntoStaging(source: PluginPackageSource, staging: string): Promise<string> {
    if (source.kind === 'npm') return this.fetchNpm(source, staging);
    if (source.kind === 'git') return this.fetchGit(source, staging);
    return this.fetchLocal(source, staging);
  }

  /** npm pack pull tarball + unwrap (does not global npm install, never run scripts). */
  private async fetchNpm(source: Extract<PluginPackageSource, { kind: 'npm' }>, staging: string): Promise<string> {
    const packDir = join(staging, 'pack');
    await mkdir(packDir, { recursive: true });
    const packArgs = ['pack', source.spec, '--pack-destination', packDir, '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts'];
    const pack = await this.run('npm', packArgs);
    if (pack.code !== 0) {
      throw commandError('install', 'npm', packArgs, pack);
    }
    // find tarball and unwrap to payload/
    const files = await readdir(packDir);
    const tarball = files.find((f) => f.endsWith('.tgz'));
    if (tarball === undefined) {
      throw new HelmError('plugin_package_install_failed', `npm pack not produce out tarball(spec: ${source.spec})`, 500, { spec: source.spec, stdoutTail: tailLines(pack.stdout) });
    }
    const payload = join(staging, 'payload');
    await mkdir(payload, { recursive: true });
    const extract = await this.run('tar', ['-xzf', join(packDir, tarball), '-C', payload]);
    if (extract.code !== 0) throw commandError('install', 'tar', ['-xzf'], extract);
    // npm tarball inside layer is package/ directory
    const inner = join(payload, 'package');
    const innerStat = await stat(inner).catch(() => undefined);
    return innerStat?.isDirectory() === true ? inner : payload;
  }

  /** git clone --depth 1(carries ref when add --branch)+ subdirectory locate. */
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
        throw new HelmError('plugin_package_install_failed', `git repository inside subdirectory missing:${source.subdirectory}`, 404, { repo: source.repo, subdirectory: source.subdirectory });
      }
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(root, payload);
    return payload;
  }

  /** local: validate directory store in and do not in managed plugin tree internal (guard against self copy), filter copy. */
  private async fetchLocal(source: Extract<PluginPackageSource, { kind: 'local' }>, staging: string): Promise<string> {
    const st = await stat(source.path).catch(() => undefined);
    if (st?.isDirectory() !== true) {
      throw new HelmError('plugin_package_install_failed', `local plugin directory missing or is not directory:${source.path}`, 404, { path: source.path });
    }
    const rel = relative(resolve(this.pluginsDir()), resolve(source.path));
    const inside = !(rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    if (inside) {
      throw new HelmError(
        'validation_error',
        `local plugin directory at managed plugin tree internal (${this.pluginsDir()}), forbidden self install:${source.path}`,
        400,
        { path: source.path },
      );
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(source.path, payload);
    return payload;
  }

  /**
   * staging copy inside install runtime dependency (npm/git/local same right: ordinary carry package.json
   * i.e. patch install;--omit=dev and forever do not run lifecycle scripts;local source already is filter copy,
   * user source directory do not subject to affect). without package.json when is no-op.
   *
   * frontend subject to control dependency (manifest clientDependencies) separate patch install: they is not runtime
   * dependencies(--no-save never change write package.json), but must enter node_modules- -
   * otherwise doctor / client compile chain because dependency missing explicit failed. version takes precedence take package.json
   * already declaration range(dependencies/devDependencies all recognize, guarantee can re- now), not declaration
   * when by note symbol for should package name install (sub- path note symbol only used to compile parse, cannot as npm package name).
   */
  private async installRuntimeDeps(dir: string): Promise<void> {
    const pkgJson = join(dir, 'package.json');
    const hasPkg = await stat(pkgJson).then(() => true).catch(() => false);
    const clientSpecs = readHelmClientDependencies(dir);
    if (!hasPkg && clientSpecs.length === 0) return;
    if (clientSpecs.length === 0) {
      const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts', '--no-package-lock-only'];
      const result = await this.run('npm', args, dir);
      if (result.code !== 0) throw commandError('install', 'npm', args, result);
      return;
    }
    const ranges = new Map<string, string>();
    if (hasPkg) {
      const { readFile } = await import('node:fs/promises');
      const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as Record<string, unknown>;
      for (const group of ['dependencies', 'devDependencies'] as const) {
        const declared = pkg[group];
        if (typeof declared !== 'object' || declared === null) continue;
        for (const [name, range] of Object.entries(declared as Record<string, unknown>)) {
          if (typeof range === 'string' && range.length > 0) ranges.set(name, range);
        }
      }
    }
    // note symbol take package name part (sub- path declaration such as pkg/sub.js version by package range decide).
    const installSpecs = clientSpecs.map((spec) => {
      const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);
      const range = ranges.get(pkgName);
      return range !== undefined ? `${pkgName}@${range}` : pkgName;
    });
    const args = [
      'install', '--omit=dev', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
      '--foreground-scripts', ...installSpecs,
    ];
    const result = await this.run('npm', args, dir);
    if (result.code !== 0) throw commandError('install', 'npm', args, result);
  }

  /**
   * from payload directory identify plugin id: takes precedence plugin.json/package.json helm field push lead,
   * fall back convention entry probe name; eventually with doctor report pluginId is allow.
   */
  private async identifyPlugin(payloadDir: string, source: PluginPackageSource): Promise<{ pluginId: string; dirName: string }> {
    const report = await doctorPluginDir(payloadDir, { buildProvider: this.buildProvider });
    if (report.ok && report.pluginId !== undefined) {
      return { pluginId: report.pluginId, dirName: report.pluginId };
    }
    // doctor not reach define export: use manifest declaration id fall back directory name (doctor failed will in then step such as errors)
    const declared = await readDeclaredPluginId(payloadDir);
    if (declared !== undefined) return { pluginId: declared, dirName: declared };
    throw new HelmError(
      'plugin_package_doctor_failed',
      `cannot identify plugin id(doctor not via and manifest not declaration id):${source.raw}`,
      422,
      { source, report },
    );
  }

  private async run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
    const workDir = cwd ?? (await this.ensureStagingRoot());
    const result = await this.runner(cmd, args, { cwd: workDir, timeoutMs: this.timeoutMs });
    // npm pack non-zero exit in invoke where add work (need to tarball probe semantics); the rest command unify errors
    const isNpmPack = cmd === 'npm' && args[0] === 'pack';
    if (result.code !== 0 && !isNpmPack) {
      throw commandError('install', cmd, args, result);
    }
    return result;
  }
}

/** path store in probe (directory or file;IO error original on throw, do not shoulder swallow). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** read plugin.json id / package.json name|helm field (only directory name push lead use). */
async function readDeclaredPluginId(dir: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  const pluginJson = join(dir, 'plugin.json');
  try {
    const manifest = JSON.parse(await readFile(pluginJson, 'utf8')) as Record<string, unknown>;
    if (typeof manifest['id'] === 'string' && manifest['id'].length > 0) return manifest['id'];
    if (typeof manifest['main'] === 'string') return undefined; // main store in but without id: hand over to doctor
  } catch { /* without plugin.json or corrupt:doctor chain will to structure report */ }
  const pkgJson = join(dir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as Record<string, unknown>;
    const helm = pkg['helm'];
    if (typeof helm === 'object' && helm !== null && typeof (helm as Record<string, unknown>)['id'] === 'string') {
      return (helm as Record<string, unknown>)['id'] as string;
    }
    if (typeof pkg['name'] === 'string' && PLUGIN_ID_PATTERN.test(pkg['name'])) return pkg['name'];
  } catch { /* same on */ }
  return undefined;
}
