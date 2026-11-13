/**
 * Hub attach-or-spawn 监督器（纯 Node，零 Electron 依赖，可独立测试）。
 *
 * 机制：
 * - start()：先探测 127.0.0.1:<port>/api/auth/status（hub 身份形状校验），就绪 → attached
 *   （外部已运行 Hub，不接管生命周期）；未就绪 → 选择运行器（runners.ts）spawn Hub
 *   子进程并轮询就绪，就绪 → owned（本进程托管）。
 * - owned 崩溃监督：意外退出按指数退避自动重启（上限 restartMaxRetries，稳定
 *   stableMs 后重置预算；耗尽 → failed + problem 事件，绝不静默装活）。
 * - stop()：attached 仅解除状态；owned SIGTERM → 优雅期 → SIGKILL，幂等。
 * - 诊断诚实：子进程 stderr 环形缓冲（默认尾部 40 行），端口冲突 / 启动失败 /
 *   就绪超时均显式错误码附诊断尾部。
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
  /** 非致命诊断（重启失败链路、重启预算耗尽等）。 */
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
  /** stderr 环形缓冲行数（诊断尾部快照）。 */
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

  /** 当前是否托管 Hub 子进程（stop 需回收）。 */
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
      throw new DesktopError('supervisor_invalid_state', `start() 仅可在 idle/stopped/failed 状态调用，当前: ${this._state}`);
    }
    this.setState('starting');
    this.stopping = false;
    this.restartBudgetUsed = 0;

    // 1) attach：外部 Hub 已在目标端口就绪 → 只借用，不托管。
    if (await this.probeOnce()) {
      this.handle = null;
      this.setState('attached');
      return { mode: 'attached', hubUrl: this.config.hubUrl };
    }

    // 2) spawn：入口存在性强校验（缺产物显式报错，不静默回退）。
    const entry = resolveHubEntry(this.config);
    if (entry !== null && !existsSync(entry.entry)) {
      const code = entry.source === 'payload' ? 'payload_entry_missing' : 'hub_entry_missing';
      const hint = entry.source === 'payload'
        ? `payload 入口不存在: ${entry.entry}（检查 HELM_DESKTOP_PAYLOAD_ENTRY）`
        : `kernel 构建产物不存在: ${entry.entry}（先在仓库根执行 pnpm build，或设置 HELM_DESKTOP_HUB_ENTRY / HELM_DESKTOP_PAYLOAD_ENTRY）`;
      this.setState('failed');
      throw new DesktopError(code, hint, { entry: entry.entry });
    }

    try {
      this.runner = await selectRunner(this.config, {
      isElectron: this.isElectron,
      execPath: this.execPath,
      childWrapper: this.childWrapper,
      env: this.env,
      onSkip: (kind, reason) => this.events.problem?.(new DesktopError('hub_runner_skipped', `运行器候选 ${kind} 被跳过: ${reason}`, { kind, reason })),
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

  /** 幂等停止：attached 仅解除状态；owned 优雅期后强杀。 */
  async stop(): Promise<void> {
    if (this._state === 'idle' || this._state === 'stopped') return;
    if (this._state === 'starting') {
      throw new DesktopError('supervisor_invalid_state', 'start() 进行中，禁止并发 stop()');
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

  // ---- 内部机制 ----

  private setState(next: SupervisorState): void {
    const prev = this._state;
    this._state = next;
    this.events.stateChange?.(next, prev);
  }

  /** hub 身份探测：/api/auth/status 返回 200 JSON 且含 boolean configured 才算 hub。 */
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
    // stdout 仅消费防背压（hub 启动横幅不进诊断）。
    handle.child.stdout?.on('data', () => {});
    handle.child.once('exit', (code, signal) => {
      handle.exited = { code, signal };
    });
    return handle;
  }

  /** 就绪等待：子进程先行退出 → 分类报错；超时 → 回收子进程后报错。 */
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
          `Hub 子进程 ${this.config.readyTimeoutMs}ms 内未就绪（${handle.runner.command.join(' ')}）`,
          { command: handle.runner.command, stderrTail: [...handle.stderrTail] },
        );
      }
      await sleep(Math.min(this.config.probeIntervalMs, Math.max(deadline - Date.now(), 1)));
    }
  }

  private classifyExit(handle: ChildHandle): DesktopError {
    const tail = [...handle.stderrTail];
    const text = tail.join('\n');
    const exitNote = handle.exited === null ? '未退出' : `code=${handle.exited.code} signal=${handle.exited.signal}`;
    if (text.includes('EADDRINUSE')) {
      return new DesktopError(
        'hub_port_conflict',
        `端口 ${this.config.port} 已被占用且非可 attach 的 Hub（${exitNote}）；如外部 Hub 正在启动请稍后重试`,
        { port: this.config.port, exit: exitNote, stderrTail: tail },
      );
    }
    return new DesktopError(
      'hub_start_failed',
      `Hub 子进程启动即退出（${exitNote}）`,
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

  /** owned 崩溃监督：意外退出 → 指数退避重启；预算耗尽 → failed。 */
  private watchChild(handle: ChildHandle): void {
    handle.child.once('exit', () => {
      if (this.stopping || this._state !== 'owned' || this.handle !== handle) return;
      if (this.stableTimer !== null) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      void this.recoverAfterCrash(`owned Hub 子进程意外退出（code=${handle.exited?.code} signal=${handle.exited?.signal}）`);
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
        `Hub 崩溃重启预算耗尽（${this.config.restartMaxRetries} 次）: ${reason}`,
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
