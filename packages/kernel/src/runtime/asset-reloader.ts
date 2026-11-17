/**
 * Asset hot-reload coordinator: watches static asset changes and serially triggers debounced model and config reloads.
 *
 * Responsibilities:
 * 1. Watches only static asset paths (`providers.json` / `credentials.json` / `config.json` /
 *    `profiles/**` / `skills/**`), excluding `state.sqlite`, artifacts, workflows, and temp files;
 * 2. On `config.json` changes, refreshes the plugin config mirror (`pluginConfig.load`) and explicitly notifies on failure;
 * 3. On `providers.json` / `credentials.json` changes, debounces for 200ms then serially runs `reloadModels`;
 * 4. No-ops model reloads when `Models` is externally injected (`options.externalModels`), preserving caller ownership;
 * 5. Shutdown ordering guarantee: `stop()` halts new events and clears debounce timers first, then `waitForInflight()` awaits in-flight reloads.
 */

import { AssetWatcher } from '../services/index.js'

export interface AssetReloaderOptions {
  readonly dataDir: string
  /** True when `Models` is externally supplied (tests or external owners); `scheduleReloadModels` becomes a no-op so models are never replaced. */
  readonly externalModels?: boolean
  /** Trigger model reload (e.g., `modelsRegistry.reloadModels()`). */
  readonly reloadModels: () => Promise<void>
  /** Trigger plugin config mirror refresh (e.g., `pluginConfig.load()`). */
  readonly reloadPluginConfig: () => Promise<void>
  /** Error notification publisher (e.g., emitted as an event `'notification'`). */
  readonly notifyError: (title: string, error: unknown) => void
  /** Custom watcher factory (primarily for injecting mock watchers in tests). */
  readonly createWatcher?: (
    dir: string,
    onChange: (paths: string[]) => void,
    options: { onError: (err: Error) => void },
  ) => { start(): void; close(): void }
}

export class AssetReloader {
  private watcher: { start(): void; close(): void } | undefined
  /** Serialized `reloadModels` chain + debounce coalescing (shared by providers/credentials hot reloads). */
  private reloadChain: Promise<void> = Promise.resolve()
  /** In-flight `reloadPluginConfig` chain. */
  private reloadConfigChain: Promise<void> = Promise.resolve()
  private reloadTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(private readonly options: AssetReloaderOptions) {}

  /**
   * Start asset watching.
   * Watches only static asset paths (`providers.json` / `credentials.json` / `config.json` /
   * `profiles/**` / `skills/**`), excluding `state.sqlite`, artifacts, workflows, plugin data directories,
   * and temp files — those are not config inputs and watching them only adds noise.
   * When `models` are injected (external/test `Models`), ownership belongs to the caller and models are never rebuilt.
   */
  start(): void {
    if (this.closed || this.watcher) return
    const create =
      this.options.createWatcher ??
      ((dir, onChange, opts) => new AssetWatcher(dir, onChange, opts))
    this.watcher = create(
      this.options.dataDir,
      (changed) => this.onAssetsChanged(changed),
      {
        onError: (err) => {
          // Watcher failures are explicitly notified rather than silently swallowed (hot reload degrades without affecting main flow).
          this.options.notifyError('Asset hot-reload watcher failed', err)
        },
      },
    )
    this.watcher.start()
  }

  /** Dispatch changed asset paths. */
  onAssetsChanged(changedPaths: string[]): void {
    if (this.closed) return
    let providersTouched = false
    let credentialsTouched = false
    let configTouched = false
    let profilesOrSkills = false
    for (const rel of changedPaths) {
      const [head, second] = rel.split('/')
      if (head === 'providers.json') providersTouched = true
      else if (head === 'credentials.json') credentialsTouched = true
      else if (head === 'config.json') configTouched = true
      else if (head === 'profiles' || head === 'skills') profilesOrSkills = true
      else continue
      void second
    }
    // `profiles` and `skills` are read fresh on every `before_turn`, so no cache invalidation is needed.
    void profilesOrSkills
    if (configTouched) {
      // Refresh plugin config mirror (explicitly notify on read failure rather than swallowing).
      this.reloadConfigChain = this.reloadConfigChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadPluginConfig()))
        .catch((error) => {
          this.options.notifyError('Plugin config hot reload failed', error)
        })
    }
    if (providersTouched || credentialsTouched) {
      this.scheduleReloadModels()
    }
  }

  /** Debounce + serialize `reloadModels` (no-op when `Models` is externally injected). */
  scheduleReloadModels(): void {
    if (this.closed || this.options.externalModels) return
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined
      if (this.closed) return
      this.reloadChain = this.reloadChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadModels()))
        .catch((error) => {
          this.options.notifyError('Model config hot reload failed', error)
        })
    }, 200)
  }

  /**
   * Shutdown phase 1: stop watching and clear pending debounce timers so no new side effects are triggered.
   */
  stop(): void {
    this.closed = true
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = undefined
    }
    this.watcher?.close()
    this.watcher = undefined
  }

  /**
   * Shutdown phase 2: wait for in-flight `reloadModels` and `reloadPluginConfig` chains to settle.
   */
  async waitForInflight(): Promise<void> {
    await Promise.all([this.reloadChain, this.reloadConfigChain])
  }

  /** Full shutdown: `stop()` first to prevent new events, then await in-flight chains. */
  async close(): Promise<void> {
    this.stop()
    await this.waitForInflight()
  }
}
