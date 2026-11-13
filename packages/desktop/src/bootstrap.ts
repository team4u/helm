import { existsSync } from 'node:fs';
import { DesktopError } from './errors.js';
import { join } from 'node:path';
import { resolveDesktopConfig, type DesktopConfig } from './config.js';
import { HubSupervisor, type HubSupervisorOptions, type StartResult } from './supervisor.js';
import { compareSemVer, type PayloadInfo, type PayloadUpdateStatus, type PayloadUpdater } from './updater.js';

export interface BootOptions {
  config: DesktopConfig;
  updater: PayloadUpdater;
  baselineVersion?: string;
  supervisorOptions?: Omit<HubSupervisorOptions, 'config'>;
  log?: (message: string) => void;
}

/** 候选必须启动成功才提交；下载只暂存，下一次启动才切换。 */
export class DesktopBoot {
  supervisor: HubSupervisor;
  private candidate: PayloadInfo | null = null;
  private result: StartResult | null = null;
  private checking: Promise<PayloadUpdateStatus> | null = null;
  constructor(private readonly options: BootOptions) {
    this.supervisor = this.makeSupervisor(options.config);
  }

  private makeSupervisor(config: DesktopConfig): HubSupervisor {
    return new HubSupervisor({ ...this.options.supervisorOptions, config });
  }

  private fromPayload(payload: PayloadInfo | null): DesktopConfig {
    if (payload === null || payload.entryPath === undefined || payload.releaseDir === undefined) return this.options.config;
    const cli = join(payload.releaseDir, 'cli', 'dist', 'index.js');
    // 仅本次 Hub 使用与该载荷同版的资源；显式用户覆盖仍优先。
    return resolveDesktopConfig({}, {
      ...this.options.config,
      payloadEntry: payload.entryPath,
      payloadEntryArgs: [...(payload.entryArgs ?? [])],
      webDistDir: join(payload.releaseDir, 'web', 'dist'),
      cliEntry: existsSync(cli) ? cli : undefined,
    });
  }

  async start(): Promise<StartResult> {
    const { config, updater } = this.options;
    // 探测外部 Hub 后直接附着，其生命周期与更新均不由桌面端接管。
    try {
      const response = await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(config.probeTimeoutMs) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (body !== null && typeof body === 'object' && 'configured' in body && typeof body.configured === 'boolean') {
          this.result = await this.supervisor.start();
          return this.result;
        }
      }
    } catch { /* 无监听时继续启动受管 Hub；端口冲突由监督器显式报告。 */ }
    if (config.hubCommand === undefined && config.payloadEntry === undefined) {
      this.candidate = updater.resolvePending();
      this.supervisor = this.makeSupervisor(this.fromPayload(this.candidate ?? updater.resolveCurrent()));
    }
    try {
      this.result = await this.supervisor.start();
      return this.result;
    } catch (error) {
      if (this.candidate === null) throw error;
      return this.restore(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** GUI 在 React 首帧完成后提交；headless 在 Hub HTTP 就绪后提交。 */
  async confirmReady(): Promise<void> {
    if (this.candidate !== null && this.result?.mode === 'owned') {
      await this.options.updater.activate(this.candidate);
      this.options.log?.(`更新已启用：${this.candidate.version}`);
      this.candidate = null;
    }
  }

  async restore(error: Error): Promise<StartResult> {
    // 环境/存储故障并不证明载荷有缺陷；显式失败并保留重试机会，不能永久阻断版本。
    if (this.candidate === null || (error instanceof DesktopError && [
      'hub_port_conflict', 'hub_runner_probe_failed', 'hub_runner_incapable', 'updater_state_write_failed',
    ].includes(error.code))) throw error;
    await this.supervisor.stop();
    await this.options.updater.reject(this.candidate, error);
    this.options.log?.(`更新 ${this.candidate.version} 启动失败，已保留上一版本：${error.message}`);
    this.candidate = null;
    this.supervisor = this.makeSupervisor(this.fromPayload(this.options.updater.resolveCurrent()));
    this.result = await this.supervisor.start();
    return this.result;
  }

  async checkForUpdate(): Promise<PayloadUpdateStatus> {
    if (this.result?.mode !== 'owned') throw new Error('当前连接的 Hub 由外部进程管理，请通过其安装渠道更新');
    if (this.checking !== null) return this.checking;
    this.checking = (async () => {
      const status = await this.options.updater.check();
      const { baselineVersion, config } = this.options;
      if (status.current === null && status.latest !== null && baselineVersion !== undefined &&
          (config.payloadVersion === undefined || config.payloadVersion === 'latest')) {
        const order = compareSemVer(baselineVersion, status.latest.version);
        if (order !== null && order >= 0) return { ...status, updateAvailable: false, reason: 'up_to_date' };
      }
      if (status.updateAvailable && status.latest !== null) {
        await this.options.updater.stage({ name: status.latest.name, version: status.latest.version });
        this.options.log?.(`更新 ${status.latest.version} 已下载，下次启动时安装`);
      }
      return status;
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
}
