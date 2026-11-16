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

/** choose must start succeeded only then commit; download only staged, under once start only then switch. */
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
    // only this time Hub use and the payload same edition asset; explicit user override still takes precedence.
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
    // probe external Hub after directly attach, its lifecycle and update all do not by desktop end take over.
    try {
      const response = await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(config.probeTimeoutMs) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (body !== null && typeof body === 'object' && 'configured' in body && typeof body.configured === 'boolean') {
          this.result = await this.supervisor.start();
          return this.result;
        }
      }
    } catch { /* without listen when continue start managed Hub; port conflict by supervise explicit report. */ }
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

  /** GUI in React first frame after completion commit;headless in Hub HTTP ready after commit. */
  async confirmReady(): Promise<void> {
    if (this.candidate !== null && this.result?.mode === 'owned') {
      await this.options.updater.activate(this.candidate);
      this.options.log?.(`update enabled:${this.candidate.version}`);
      this.candidate = null;
    }
  }

  async restore(error: Error): Promise<StartResult> {
    // environment/store fault does not verify payload has defect; explicit failed and keep retry chance, cannot forever long block assert version.
    if (this.candidate === null || (error instanceof DesktopError && [
      'hub_port_conflict', 'hub_runner_probe_failed', 'hub_runner_incapable', 'updater_state_write_failed',
    ].includes(error.code))) throw error;
    await this.supervisor.stop();
    await this.options.updater.reject(this.candidate, error);
    this.options.log?.(`update ${this.candidate.version} failed to start, already keep on one version:${error.message}`);
    this.candidate = null;
    this.supervisor = this.makeSupervisor(this.fromPayload(this.options.updater.resolveCurrent()));
    this.result = await this.supervisor.start();
    return this.result;
  }

  async checkForUpdate(): Promise<PayloadUpdateStatus> {
    if (this.result?.mode !== 'owned') throw new Error('when before connect Hub by external process manage, please via its install channel update');
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
        this.options.log?.(`update ${status.latest.version} already download, under time at startup install`);
      }
      return status;
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
}
