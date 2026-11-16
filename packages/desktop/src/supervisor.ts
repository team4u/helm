/**
 * Hub attach-or-spawn supervise (pure Node, zero Electron dependency, can independent test).
 *
 * mechanism:
 * - start(): first probe 127.0.0.1:<port>/api/auth/status(hub identity shape validate), ready → attached
 *   (external already run Hub, do not take over lifecycle); not ready → choose run (runners.ts)spawn Hub
 *   child process and polling ready, ready → owned(this process hosting).
 * - owned crash supervise: unexpected exit by exponential backoff automatically restart (cap restartMaxRetries, stable
 *   stableMs after reset pre- compute; exhausted → failed + problem event, never static default install).
 * - stop():attached only solve except state;owned SIGTERM → graceful phase → SIGKILL, idempotent.
 * - diagnose honest: child process stderr ring shape buffer (by default tail part 40 row), port conflict / failed to start /
 *   ready timeout all explicit error code attach diagnose tail part.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopError } from './errors.js';
import { resolveHubEntry, type DesktopConfig } from './config.js';
import { selectRunner, type RunnerInfo } from './runners.js';

export type SupervisorState = 'idle' | 'starting' | 'attached' | 'owned' | 'stopped' | 'failed';

export interface StartResult {
  mode: 'attached' | 'owned';
  hubUrl: string;
  runner?: RunnerInfo;
}

export interface SupervisorEvents {
  stateChange?(next: SupervisorState, prev: SupervisorState): void;
  runnerSelected?(info: RunnerInfo): void;
  restartScheduled?(attempt: number, delayMs: number, reason: string): void;
  /** non- lead to life diagnose (restart failed link, restart pre- compute exhausted etc.). */
  problem?(error: unknown): void;
}

export interface HubSupervisorOptions {
  config: DesktopConfig;
  events?: SupervisorEvents;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  isElectron?: boolean;
  execPath?: string;
  childWrapper?: string;
  /** stderr ring shape buffer row count (diagnose tail part snapshot). */
  stderrTailLines?: number;
}

interface ChildHandle {
  child: ChildProcess;
  runner: RunnerInfo;
  stderrTail: string[];
  exited: { code: number | null; signal: NodeJS.Signals | null } | null;
}

const ATTACH_PROBE_PATH = '/api/auth/status';

export class HubSupervisor {
  private readonly config: DesktopConfig;
  private readonly events: SupervisorEvents;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly isElectron: boolean;
  private readonly execPath: string;
  private readonly tailLines: number;
  private readonly childWrapper?: string;

  private _state: SupervisorState = 'idle';
  private handle: ChildHandle | null = null;
  private runner: RunnerInfo | null = null;
  private stopping = false;
  private restartBudgetUsed = 0;
  private stableTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(options: HubSupervisorOptions) {
    this.config = options.config;
    this.events = options.events ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
    this.isElectron = options.isElectron ?? false;
    this.execPath = options.execPath ?? process.execPath;
    this.tailLines = options.stderrTailLines ?? 40;
    this.childWrapper = options.childWrapper;
  }

  get state(): SupervisorState {
    return this._state;
  }

  get hubUrl(): string {
    return this.config.hubUrl;
  }

  /** when before is otherwise hosting Hub child process (stop must reclaim). */
  get owned(): boolean {
    return this._state === 'owned' && this.handle !== null;
  }

  get childPid(): number | undefined {
    return this.handle?.child.pid;
  }

  get restartsUsed(): number {
    return this.restartBudgetUsed;
  }

  stderrTail(): string[] {
    return this.handle ? [...this.handle.stderrTail] : [];
  }

  async start(): Promise<StartResult> {
    if (this._state !== 'idle' && this._state !== 'stopped' && this._state !== 'failed') {
      throw new DesktopError('supervisor_invalid_state', `start() only can in idle/stopped/failed state invoke, when before: ${this._state}`);
    }
    this.setState('starting');
    this.stopping = false;
    this.restartBudgetUsed = 0;

    // 1) attach: external Hub already in target port ready → only borrow use, do not hosting.
    if (await this.probeOnce()) {
      this.handle = null;
      this.setState('attached');
      return { mode: 'attached', hubUrl: this.config.hubUrl };
    }

    // 2) spawn: entry store in strong validate (missing artifact explicit errors, not silently fall back).
    const entry = resolveHubEntry(this.config);
    if (entry !== null && !existsSync(entry.entry)) {
      const code = entry.source === 'payload' ? 'payload_entry_missing' : 'hub_entry_missing';
      const hint = entry.source === 'payload'
        ? `payload entry missing: ${entry.entry}(check HELM_DESKTOP_PAYLOAD_ENTRY)`
        : `kernel build artifact missing: ${entry.entry}(first in repository execute pnpm build, or settings HELM_DESKTOP_HUB_ENTRY / HELM_DESKTOP_PAYLOAD_ENTRY)`;
      this.setState('failed');
      throw new DesktopError(code, hint, { entry: entry.entry });
    }

    try {
      this.runner = await selectRunner(this.config, {
      isElectron: this.isElectron,
      execPath: this.execPath,
      childWrapper: this.childWrapper,
      env: this.env,
      onSkip: (kind, reason) => this.events.problem?.(new DesktopError('hub_runner_skipped', `run choose ${kind} by skip: ${reason}`, { kind, reason })),
    });
    } catch (error) {
      this.setState('failed');
      throw error;
    }
    this.events.runnerSelected?.(this.runner);

    const handle = this.spawnChild(this.runner);
    try {
      await this.waitReady(handle);
    } catch (error) {
      this.setState('failed');
      throw error;
    }
    this.handle = handle;
    this.setState('owned');
    this.watchChild(handle);
    return { mode: 'owned', hubUrl: this.config.hubUrl, runner: this.runner };
  }

  /** idempotent stop:attached only solve except state;owned graceful phase after strong kill. */
  async stop(): Promise<void> {
    if (this._state === 'idle' || this._state === 'stopped') return;
    if (this._state === 'starting') {
      throw new DesktopError('supervisor_invalid_state', 'start() in progress, forbidden concurrency stop()');
    }
    this.stopping = true;
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.stableTimer = null;
    this.restartTimer = null;

    if (this._state === 'attached' || this.handle === null) {
      this.handle = null;
      this.setState('stopped');
      return;
    }

    const handle = this.handle;
    if (handle.exited === null) {
      this.requestShutdown(handle);
      const exited = await this.waitExit(handle, this.config.stopGraceMs);
      if (!exited) {
        handle.child.kill('SIGKILL');
        await this.waitExit(handle, 2_000);
      }
    }
    this.handle = null;
    this.setState('stopped');
  }

  // ---- internal mechanism ----

  private setState(next: SupervisorState): void {
    const prev = this._state;
    this._state = next;
    this.events.stateChange?.(next, prev);
  }

  /** hub identity probe:/api/auth/status return 200 JSON and contains boolean configured only then compute hub. */
  private async probeOnce(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.config.hubUrl}${ATTACH_PROBE_PATH}`, {
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return false;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) return false;
      const body = (await response.json()) as unknown;
      return typeof body === 'object' && body !== null && typeof (body as { configured?: unknown }).configured === 'boolean';
    } catch {
      return false;
    }
  }

  private spawnChild(runner: RunnerInfo): ChildHandle {
    const handle: ChildHandle = {
      child: spawn(runner.command[0]!, runner.command.slice(1), {
        env: runner.env,
        cwd: runner.env['HELM_CWD'],
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
      runner,
      stderrTail: [],
      exited: null,
    };
    handle.child.on('error', (error) => {
      handle.exited ??= { code: null, signal: null };
      handle.stderrTail.push(`[spawn error] ${error.message}`);
    });
    handle.child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length === 0) continue;
        handle.stderrTail.push(line);
        if (handle.stderrTail.length > this.tailLines) handle.stderrTail.shift();
      }
    });
    // stdout only consume guard against back press (hub start horizontal width does not enter diagnose).
    handle.child.stdout?.on('data', () => {});
    handle.child.once('exit', (code, signal) => {
      handle.exited = { code, signal };
    });
    return handle;
  }

  /** ready wait for: child process first row exit → classify errors; timeout → reclaim child process after errors. */
  private async waitReady(handle: ChildHandle): Promise<void> {
    const deadline = Date.now() + this.config.readyTimeoutMs;
    for (;;) {
      if (handle.exited !== null) throw this.classifyExit(handle);
      if (await this.probeOnce()) {
        if (handle.exited !== null) throw this.classifyExit(handle);
        return;
      }
      if (Date.now() >= deadline) {
        await this.reap(handle);
        throw new DesktopError(
          'hub_ready_timeout',
          `Hub child process ${this.config.readyTimeoutMs}ms inside not ready (${handle.runner.command.join(' ')})`,
          { command: handle.runner.command, stderrTail: [...handle.stderrTail] },
        );
      }
      await sleep(Math.min(this.config.probeIntervalMs, Math.max(deadline - Date.now(), 1)));
    }
  }

  private classifyExit(handle: ChildHandle): DesktopError {
    const tail = [...handle.stderrTail];
    const text = tail.join('\n');
    const exitNote = handle.exited === null ? 'not exit' : `code=${handle.exited.code} signal=${handle.exited.signal}`;
    if (text.includes('EADDRINUSE')) {
      return new DesktopError(
        'hub_port_conflict',
        `port ${this.config.port} already by occupy and non- can attach  Hub(${exitNote}); such as external Hub is now start retry later`,
        { port: this.config.port, exit: exitNote, stderrTail: tail },
      );
    }
    return new DesktopError(
      'hub_start_failed',
      `Hub child process start i.e. exit (${exitNote})`,
      { command: handle.runner.command, exit: exitNote, stderrTail: tail },
    );
  }

  private requestShutdown(handle: ChildHandle): void {
    if (handle.runner.kind !== 'custom' && handle.child.connected) {
      handle.child.send({ type: 'shutdown' }, (error) => {
        if (error && handle.exited === null) handle.child.kill('SIGTERM');
      });
    } else {
      handle.child.kill('SIGTERM');
    }
  }

  private async reap(handle: ChildHandle): Promise<void> {
    if (handle.exited === null) {
      this.requestShutdown(handle);
      if (!(await this.waitExit(handle, this.config.stopGraceMs))) {
        handle.child.kill('SIGKILL');
        await this.waitExit(handle, 2_000);
      }
    }
  }

  private waitExit(handle: ChildHandle, timeoutMs: number): Promise<boolean> {
    if (handle.exited !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        handle.child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      handle.child.once('exit', onExit);
    });
  }

  /** owned crash supervise: unexpected exit → exponential backoff restart; pre- compute exhausted → failed. */
  private watchChild(handle: ChildHandle): void {
    handle.child.once('exit', () => {
      if (this.stopping || this._state !== 'owned' || this.handle !== handle) return;
      if (this.stableTimer !== null) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      void this.recoverAfterCrash(`owned Hub child process unexpected exit (code=${handle.exited?.code} signal=${handle.exited?.signal})`);
    });
    this.armStabilityReset();
  }

  private armStabilityReset(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.restartBudgetUsed = 0;
    }, this.config.stableMs);
    this.stableTimer.unref?.();
  }

  private async recoverAfterCrash(reason: string): Promise<void> {
    if (this.stopping || this._state !== 'owned' || this.runner === null) return;
    if (this.restartBudgetUsed >= this.config.restartMaxRetries) {
      const error = new DesktopError(
        'hub_restart_exhausted',
        `Hub crash restart pre- compute exhausted (${this.config.restartMaxRetries} time): ${reason}`,
        { stderrTail: this.stderrTail() },
      );
      this.setState('failed');
      this.events.problem?.(error);
      return;
    }
    this.restartBudgetUsed += 1;
    const delay = Math.min(this.config.restartBackoffMs * 2 ** (this.restartBudgetUsed - 1), this.config.restartBackoffMaxMs);
    this.events.restartScheduled?.(this.restartBudgetUsed, delay, reason);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.respawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async respawn(): Promise<void> {
    if (this.stopping || this._state !== 'owned' || this.runner === null) return;
    try {
      const handle = this.spawnChild(this.runner);
      await this.waitReady(handle);
      if (this.stopping) {
        await this.reap(handle);
        return;
      }
      this.handle = handle;
      this.watchChild(handle);
    } catch (error) {
      this.events.problem?.(error);
      await this.recoverAfterCrash(error instanceof DesktopError ? `${error.code}: ${error.message}` : String(error));
    }
  }
}
