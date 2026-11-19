/**
 * External plugin package management: install / update / remove transactions.
 *
 * Follows pi's source model (npm / git / local), with helmx semantics:
 * staging copy + full doctor preflight + atomic move into managed directory +
 * persisted record + registration into PluginHost. No marketplace DB, versioned pool,
 * or migration scripts.
 *
 * Security & honesty invariants:
 * - `npm install` never runs lifecycle scripts (`--ignore-scripts --no-audit --no-fund --foreground-scripts`
 *   makes any bypass visible); `git` runs non-interactively (`GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS=echo`)
 *   with `--depth 1` shallow clones;
 * - Staging happens under `<dataDir>/plugins/.staging/<uuid>/`, atomically renamed into
 *   `<dataDir>/plugins/<safeName>/`; failures (including doctor or registration failure) clean up
 *   staging without leaving partial artifacts;
 * - Local sources are copied (not symlinked) into the managed directory, because PluginHost.register
 *   uses `<dataDir>/plugins/<pluginId>` as both source dir and `ctx.dataDir` (symlinks would write data
 *   into user source trees and `remove` would delete user files);
 * - Copies exclude `node_modules`, `.git`, and dot-prefixed entries; runtime dependencies declared in
 *   `package.json.dependencies` are installed cleanly with `--omit=dev` and lifecycle scripts disabled;
 * - In-process execution disclosure: doctor/register/enable run plugin code inside the Hub process with
 *   full host permissions; this manager enforces managed path boundaries only, never claiming sandboxing.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HelmxError, type PluginBuildProvider, type PluginInstallResult, type PluginPackageRecord, type PluginRemoveResult, type PluginPackageSource, type PluginSummary, type PluginUpdateResult } from '@helmx/protocol';
import { verifyDeclaredPrebuiltDir } from './external-loader.js';
import { parsePluginSource } from './package-source.js';
import { doctorPluginDir } from './plugin-doctor.js';
import { readHelmxClientDependencies } from './plugin-manifest.js';
import type { PluginPackageManagerStore } from './package-store.js';

// ---------------------------------------------------------------------------
// Process runner (injectable for tests without real network access)
// ---------------------------------------------------------------------------

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Process execution abstraction: spawns npm/git in production; mocked in tests. */
export type PackageRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

/** Default runner: non-interactive env, merged stdio tails, SIGKILL on timeout. */
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

/** Trailing 40-line snapshot (honesty invariant: external tool failures attach terminal output tail). */
export function tailLines(text: string, lines = 40): string {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim();
}

function commandError(kind: string, cmd: string, args: string[], result: RunResult): HelmxError {
  return new HelmxError(
    `plugin_package_${kind}_failed`,
    `plugin package ${kind} command failed: ${cmd} ${args.join(' ')} (exit ${result.code})\n${tailLines(result.stderr || result.stdout)}`,
    500,
    { cmd, args, code: result.code, stdoutTail: tailLines(result.stdout), stderrTail: tailLines(result.stderr) },
  );
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Host integration port required by PluginPackageManager (structurally compatible with PluginHost). */
export interface PackageManagerHost {
  registerManagedPlugin(dir: string, options: { enabled: boolean }): Promise<{ summary: PluginSummary; pluginId: string }>;
  /** Enable after install (enable: true path; failure surfaces on diagnostic field without rolling back install). */
  enableManagedPlugin(pluginId: string): Promise<PluginSummary>;
  /** Safety preflight before update swap: reject 409 on live tasks / busy providers without touching old instance or dir. */
  assertManagedPluginUpdateSafe(pluginId: string): Promise<void> | void;
  updateManagedPlugin(pluginId: string, dir: string, options: { keepEnabled: boolean }): Promise<{ summary: PluginSummary }>;
  removeManagedPlugin(pluginId: string): Promise<{ wasEnabled: boolean }>;
  /**
   * Purge persisted plugin data (global docs + session docs) on remove and await durable DELETE flush;
   * rejects explicitly on failure so the directory and record remain intact for retry.
   */
  purgePluginPersistentData(pluginId: string): Promise<void>;
  listSummaries(): PluginSummary[];
}

interface PluginPackageManagerOptions {
  dataDir: string
  /** Hub working directory (base directory for resolving relative local paths). */
  cwd: string
  store: PluginPackageManagerStore
  host: PackageManagerHost
  runner?: PackageRunner
  /** Per-command timeout in ms (defaults to 120s). */
  commandTimeoutMs?: number
  /**
   * Plugin build port (shared instance with PluginHostOptions.buildProvider):
   * used during doctor preflight for client module compilation and backend TS transpilation.
   * Rejects explicitly when missing for packages requiring compilation/transpilation.
   */
  buildProvider?: PluginBuildProvider
}

const COPY_IGNORE = new Set(['node_modules', '.git', '.staging']);
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeDirName(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.startsWith('builtin:')) {
    throw new HelmxError('invalid_plugin_definition', `plugin id is not allowed as a managed install directory name: ${pluginId}`, 400, { pluginId });
  }
  return pluginId;
}

function assertInsideDataDir(dataDir: string, target: string): void {
  const rel = relative(resolve(dataDir), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmxError('validation_error', `install target escapes managed plugins directory: ${target}`, 400, { target });
  }
}

/** Copy directory contents excluding symlinks, dot-prefixed entries, node_modules, and VCS metadata. */
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
    // Skip special files such as symlinks and FIFOs.
  }
}

/**
 * Plugin package manager: all install/update/remove operations are serialized through a manager-level queue,
 * while PluginHost maintains its own per-plugin lifecycle queue.
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

  /** Ensure staging directory exists (idempotent). */
  private async ensureStagingRoot(): Promise<string> {
    const root = this.stagingRoot();
    await mkdir(root, { recursive: true });
    return root;
  }

  // --- install -------------------------------------------------------------

  /**
   * Install a plugin package: parse source -> fetch into staging -> install runtime deps -> doctor preflight ->
   * atomic move into managed directory -> persist record -> register (disabled by default).
   *
   * Transactional semantics (no partial artifacts, live instance stays safe):
   * - Duplicate install protection: existing managed record or registered instance rejects with 409
   *   `plugin_package_already_installed`;
   * - Target occupancy protection: existing target directory rejects with 409 without deleting first;
   * - Post-rename failure (register / persist): removes new target and cleans staging completely;
   * - With `enable: true`, enable failure surfaces via `enableError` without rolling back installation.
   */
  async install(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    const parsed = parsePluginSource(source, this.cwd);
    return this.enqueue(async () => {
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      let inPlace = false; // payload already moved into managed target
      try {
        const payloadDir = await this.fetchIntoStaging(parsed, staging);
        // Install runtime dependencies in staging before doctor preflight so package imports succeed.
        await this.installRuntimeDeps(payloadDir);
        const { pluginId, dirName } = await this.identifyPlugin(payloadDir, parsed);
        // Full doctor preflight (manifest/backend/register/client) once dependencies are present.
        const report = await doctorPluginDir(payloadDir, { buildProvider: this.buildProvider });
        if (!report.ok) {
          const first = report.checks.find((c) => c.error !== undefined);
          throw new HelmxError(
            'plugin_package_doctor_failed',
            `plugin package install preflight failed (${first ? `${first.label}: ${first.error!.message}` : 'unknown check failed'}); aborting install`,
            422,
            { source: parsed, staging: payloadDir, report },
          );
        }
        // Duplicate install protection: reject if a managed record or registered instance already exists.
        if (this.store.getRecord(pluginId) !== undefined) {
          throw new HelmxError(
            'plugin_package_already_installed',
            `plugin ${pluginId} is already installed via package manager (run update or remove before reinstalling)`,
            409,
            { pluginId },
          );
        }
        if (this.host.listSummaries().some((s) => s.id === pluginId)) {
          throw new HelmxError(
            'plugin_package_already_installed',
            `plugin ${pluginId} is already registered (possibly manually placed in plugins directory); refusing duplicate install`,
            409,
            { pluginId },
          );
        }
        const target = join(this.pluginsDir(), safeDirName(dirName));
        assertInsideDataDir(this.pluginsDir(), target);
        if (await pathExists(target)) {
          throw new HelmxError(
            'plugin_package_target_occupied',
            `install target directory already exists (untracked leftover; inspect and clean up manually): ${target}`,
            409,
            { pluginId, target },
          );
        }
        await mkdir(dirname(target), { recursive: true });
        await rename(payloadDir, target);
        inPlace = true;
        // register -> persist: remove target completely on failure so no unregistered directory lingers.
        let registered: Awaited<ReturnType<PackageManagerHost['registerManagedPlugin']>>;
        try {
          registered = await this.host.registerManagedPlugin(target, { enabled: false });
        } catch (err) {
          // Keep directory & instance if a concurrent scan already registered the same plugin ID.
          if (this.host.listSummaries().some((s) => s.id === pluginId)) {
            inPlace = false;
            throw new HelmxError(
              'plugin_package_install_failed',
              `Plugin ${pluginId} registration failed after install: same name plugin registered concurrently; keeping existing directory and instance without managed record: ${err instanceof Error ? err.message : String(err)}`,
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
          throw new HelmxError(
            'plugin_package_install_failed',
            `Plugin ${pluginId} registration failed after install; rolled back and deleted directory: ${err instanceof Error ? err.message : String(err)}`,
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
            // Enable failure does not roll back install (by design): plugin stays disabled and diagnostics pass through;
            // register and directory all already in, record persist after restart can load retry.
            enableError = {
              message: err instanceof Error ? err.message : String(err),
              code: err instanceof HelmxError ? err.code : 'plugin_enable_failed',
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
            throw new HelmxError(
              'plugin_package_install_failed',
              `Plugin ${pluginId} failed to persist install record; rolled back (unregistered and deleted directory): ${err instanceof Error ? err.message : String(err)}`,
              500,
              {
                pluginId,
                target,
                rolledBack: true,
                cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
              },
            );
          }
          throw new HelmxError(
            'plugin_package_install_failed',
            `Plugin ${pluginId} failed to persist install record, and rollback unregister failed (${unregisterError instanceof Error ? unregisterError.message : String(unregisterError)}); directory and instance already keep`,
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

  /** Attach managed package metadata (`PluginSummary.managed`). */
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
   * Atomically update an installed plugin package:
   * 1. Safety preflight (409 on live tasks / busy providers; old instance and directory untouched);
   * 2. Re-fetch into staging -> install runtime deps -> full doctor preflight;
   * 3. Swap: rename old directory to staging backup -> move new payload into managed directory ->
   *    re-register while keeping enabled state -> delete backup on success;
   * 4. On swap failure, restore backup directory and reload the old instance (surfaces rollback error if restore fails).
   */
  async update(pluginId: string): Promise<PluginUpdateResult> {
    return this.enqueue(async () => {
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmxError('unknown_plugin_package', `plugin ${pluginId} has no managed install record (only managed packages can be updated)`, 404, { pluginId });
      }
      // 1. Safety preflight: reject when live tasks or busy providers exist without modifying anything.
      await this.host.assertManagedPluginUpdateSafe(pluginId);
      await this.ensureStagingRoot();
      const staging = await mkdtemp(join(this.stagingRoot(), 'pkg-'));
      const backup = join(staging, 'backup');
      let switched = false;
      try {
        // 2. Staging fetch + dependencies + doctor preflight (leaves live directory untouched).
        const payloadDir = await this.fetchIntoStaging(record.source, staging);
        await this.installRuntimeDeps(payloadDir);
        const identified = await this.identifyPlugin(payloadDir, record.source);
        if (identified.pluginId !== pluginId) {
          throw new HelmxError(
            'plugin_package_id_changed',
            `plugin id changed during update (expected ${pluginId}, actual ${identified.pluginId}); rejecting replacement`,
            409,
            { pluginId, actualId: identified.pluginId },
          );
        }
        const report = await doctorPluginDir(payloadDir, { buildProvider: this.buildProvider });
        if (!report.ok) {
          const first = report.checks.find((c) => c.error !== undefined);
          throw new HelmxError(
            'plugin_package_doctor_failed',
            `Plugin package update preflight failed (${first ? `${first.label}: ${first.error!.message}` : 'unknown check failed'}); keeping existing installation`,
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
        throw new HelmxError(
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
   * Remove a managed plugin installation: unregister (protected against builtin / live tasks / busy providers) ->
   * purge persistent plugin documents (awaiting real DELETE flush; rejects explicitly on failure) ->
   * delete managed directory -> delete package record.
   * For local sources, only the managed copy is deleted (never touches user source directory).
   */
  async remove(pluginId: string): Promise<PluginRemoveResult> {
    return this.enqueue(async () => {
      if (pluginId.startsWith('builtin:')) {
        throw new HelmxError('plugin_locked', `built-in plugin ${pluginId} cannot be removed`, 403, { pluginId });
      }
      const record = this.store.getRecord(pluginId);
      if (record === undefined) {
        throw new HelmxError('unknown_plugin_package', `plugin ${pluginId} has no managed install record (delete manually placed plugin directories directly)`, 404, { pluginId });
      }
      const { wasEnabled } = await this.host.removeManagedPlugin(pluginId);
      // Purge persisted docs and flush before removing files/records so failures remain safely retryable.
      await this.host.purgePluginPersistentData(pluginId);
      const target = record.installPath;
      assertInsideDataDir(this.pluginsDir(), target);
      await rm(target, { recursive: true, force: true });
      await this.store.delete(pluginId);
      return { pluginId, installPath: target, wasEnabled, installId: record.id };
    });
  }

  // --- staging fetch (dispatched by source kind) --------------------------------

  private async fetchIntoStaging(source: PluginPackageSource, staging: string): Promise<string> {
    if (source.kind === 'npm') return this.fetchNpm(source, staging);
    if (source.kind === 'git') return this.fetchGit(source, staging);
    return this.fetchLocal(source, staging);
  }

  /** Pull tarball via npm pack and extract (never runs global npm install or lifecycle scripts). */
  private async fetchNpm(source: Extract<PluginPackageSource, { kind: 'npm' }>, staging: string): Promise<string> {
    const packDir = join(staging, 'pack');
    await mkdir(packDir, { recursive: true });
    const packArgs = ['pack', source.spec, '--pack-destination', packDir, '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts'];
    const pack = await this.run('npm', packArgs);
    if (pack.code !== 0) {
      throw commandError('install', 'npm', packArgs, pack);
    }
    // Locate packed tarball and extract into payload/
    const files = await readdir(packDir);
    const tarball = files.find((f) => f.endsWith('.tgz'));
    if (tarball === undefined) {
      throw new HelmxError('plugin_package_install_failed', `npm pack did not produce a tarball (spec: ${source.spec})`, 500, { spec: source.spec, stdoutTail: tailLines(pack.stdout) });
    }
    const payload = join(staging, 'payload');
    await mkdir(payload, { recursive: true });
    const extract = await this.run('tar', ['-xzf', join(packDir, tarball), '-C', payload]);
    if (extract.code !== 0) throw commandError('install', 'tar', ['-xzf'], extract);
    // npm tarballs wrap contents inside a package/ directory
    const inner = join(payload, 'package');
    const innerStat = await stat(inner).catch(() => undefined);
    return innerStat?.isDirectory() === true ? inner : payload;
  }

  /** Shallow git clone --depth 1 (with --branch when ref is provided) + subdirectory resolution. */
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
        throw new HelmxError('plugin_package_install_failed', `git repository subdirectory is missing: ${source.subdirectory}`, 404, { repo: source.repo, subdirectory: source.subdirectory });
      }
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(root, payload);
    return payload;
  }

  /** Local source: verify directory exists outside the managed plugins tree (preventing self-install) and filter-copy. */
  private async fetchLocal(source: Extract<PluginPackageSource, { kind: 'local' }>, staging: string): Promise<string> {
    const st = await stat(source.path).catch(() => undefined);
    if (st?.isDirectory() !== true) {
      throw new HelmxError('plugin_package_install_failed', `local plugin path is missing or not a directory: ${source.path}`, 404, { path: source.path });
    }
    const rel = relative(resolve(this.pluginsDir()), resolve(source.path));
    const inside = !(rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    if (inside) {
      throw new HelmxError(
        'validation_error',
        `local plugin directory lies inside the managed plugins tree (${this.pluginsDir()}); self-installation is disallowed: ${source.path}`,
        400,
        { path: source.path },
      );
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(source.path, payload);
    return payload;
  }

  /**
   * Install runtime dependencies inside staging (`--omit=dev`, lifecycle scripts always disabled).
   * When a valid prebuilt frontend bundle (`clientDist` or `dist-client/`) is present, frontend
   * `clientDependencies` are skipped and only backend `package.json` runtime dependencies (if any)
   * are installed. Otherwise installs `clientDependencies` with `--no-save` so doctor and client
   * compilation find them in `node_modules` without mutating `package.json`.
   */
  private async installRuntimeDeps(dir: string): Promise<void> {
    const pkgJson = join(dir, 'package.json');
    const hasPkg = await stat(pkgJson).then(() => true).catch(() => false);
    const declaredClientSpecs = readHelmxClientDependencies(dir);
    const prebuiltDir = verifyDeclaredPrebuiltDir(dir);
    const clientSpecs = prebuiltDir !== undefined ? [] : declaredClientSpecs;
    const ranges = new Map<string, string>();
    let hasBackendRuntimeDeps = false;
    if (hasPkg) {
      const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as Record<string, unknown>;
      for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
        const declared = pkg[group];
        if (typeof declared === 'object' && declared !== null && Object.keys(declared).length > 0) {
          hasBackendRuntimeDeps = true;
        }
      }
      if (clientSpecs.length > 0) {
        for (const group of ['dependencies', 'devDependencies'] as const) {
          const declared = pkg[group];
          if (typeof declared !== 'object' || declared === null) continue;
          for (const [name, range] of Object.entries(declared as Record<string, unknown>)) {
            if (typeof range === 'string' && range.length > 0) ranges.set(name, range);
          }
        }
      }
    }
    if ((!hasPkg || !hasBackendRuntimeDeps) && clientSpecs.length === 0) return;
    if (clientSpecs.length === 0) {
      const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts', '--no-package-lock-only'];
      const result = await this.run('npm', args, dir);
      if (result.code !== 0) throw commandError('install', 'npm', args, result);
      return;
    }
    // Extract package names from specifiers (subpath specifiers like pkg/sub.js resolve version range from pkg).
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
   * Identify plugin id from payload directory (prefers doctor's imported pluginId; falls back to manifest declaration).
   */
  private async identifyPlugin(payloadDir: string, source: PluginPackageSource): Promise<{ pluginId: string; dirName: string }> {
    const report = await doctorPluginDir(payloadDir, { buildProvider: this.buildProvider });
    if (report.ok && report.pluginId !== undefined) {
      return { pluginId: report.pluginId, dirName: report.pluginId };
    }
    // Fallback to manifest-declared id if doctor could not reach definition export (doctor will reject in next step).
    const declared = await readDeclaredPluginId(payloadDir);
    if (declared !== undefined) return { pluginId: declared, dirName: declared };
    throw new HelmxError(
      'plugin_package_doctor_failed',
      `cannot determine plugin id (doctor failed and manifest declares no id): ${source.raw}`,
      422,
      { source, report },
    );
  }

  private async run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
    const workDir = cwd ?? (await this.ensureStagingRoot());
    const result = await this.runner(cmd, args, { cwd: workDir, timeoutMs: this.timeoutMs });
    // npm pack non-zero exits are handled by callers for tarball-specific diagnostics.
    const isNpmPack = cmd === 'npm' && args[0] === 'pack';
    if (result.code !== 0 && !isNpmPack) {
      throw commandError('install', cmd, args, result);
    }
    return result;
  }
}

/** Probe whether a directory or file exists (rethrows non-ENOENT IO errors cleanly). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Read plugin.json id or package.json name/helmx.id (used only as directory-name hint). */
async function readDeclaredPluginId(dir: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  const pluginJson = join(dir, 'plugin.json');
  try {
    const manifest = JSON.parse(await readFile(pluginJson, 'utf8')) as Record<string, unknown>;
    if (typeof manifest['id'] === 'string' && manifest['id'].length > 0) return manifest['id'];
    if (typeof manifest['main'] === 'string') return undefined; // main exists without id: defer to doctor
  } catch { /* missing/corrupt plugin.json: doctor reports structured error */ }
  const pkgJson = join(dir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as Record<string, unknown>;
    const helmx = pkg['helmx'];
    if (typeof helmx === 'object' && helmx !== null && typeof (helmx as Record<string, unknown>)['id'] === 'string') {
      return (helmx as Record<string, unknown>)['id'] as string;
    }
    if (typeof pkg['name'] === 'string' && PLUGIN_ID_PATTERN.test(pkg['name'])) return pkg['name'];
  } catch { /* ignore */ }
  return undefined;
}
