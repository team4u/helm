/**
 * asset hot reload coordinate tune: listen static asset change, jitter merge after serial trigger model and config hot reload.
 *
 * responsibility:
 * 1. only listen static asset path (providers.json / credentials.json / config.json /
 *    profiles/** / skills/**), exclude state.sqlite,artifacts,workflows and temp file;
 * 2. config.json change refresh plugin config mirror (pluginConfig.load), failed explicit notify;
 * 3. providers.json / credentials.json change via 200ms guard against jitter after serial reloadModels;
 * 4. external inject Models(options.externalModels) when empty operation, keep caller ownership;
 * 5. closure stop order keep fault: first stop stop new event and guard against jitter timer, again waitForInflight wait for in-flight reload.
 */

import { AssetWatcher } from '../services/index.js'

export interface AssetReloaderOptions {
  readonly dataDir: string
  /** external pass Models(test or external own) when is true; now do not replace model,scheduleReloadModels treated as empty operation. */
  readonly externalModels?: boolean
  /** trigger model reload (such as invoke modelsRegistry.reloadModels()). */
  readonly reloadModels: () => Promise<void>
  /** trigger plugin config mirror refresh (such as invoke pluginConfig.load()). */
  readonly reloadPluginConfig: () => Promise<void>
  /** error notify publish interface (such as publish to events 'notification'). */
  readonly notifyError: (title: string, error: unknown) => void
  /** self define watcher work vendor (mainly used to test inject mock watcher). */
  readonly createWatcher?: (
    dir: string,
    onChange: (paths: string[]) => void,
    options: { onError: (err: Error) => void },
  ) => { start(): void; close(): void }
}

export class AssetReloader {
  private watcher: { start(): void; close(): void } | undefined
  /** reloadModels serial chain + jitter merge (providers/credentials hot reload shared use). */
  private reloadChain: Promise<void> = Promise.resolve()
  /** reloadPluginConfig in-flight chain. */
  private reloadConfigChain: Promise<void> = Promise.resolve()
  private reloadTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(private readonly options: AssetReloaderOptions) {}

  /**
   * start asset listen.
   * only listen static asset path (providers.json / credentials.json / config.json /
   * profiles/** / skills/**). exclude state.sqlite,artifacts,workflows,
   * plugins data directory and everything temp file - - they non- config input, listen only increase noise sound.
   * models inject when (external/test Models) model set archive caller, never rebuild replace.
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
          // watcher fault explicit notify, not silently swallow (hot reload fall back but main stream process do not subject to affect).
          this.options.notifyError('asset hot reload listen failed', err)
        },
      },
    )
    this.watcher.start()
  }

  /** asset change path stream. */
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
    // profiles/skills each turn before_turn all fresh read, no need to cache expires.
    void profilesOrSkills
    if (configTouched) {
      // plugin config mirror refresh (failed to read explicit notify, do not swallow).
      this.reloadConfigChain = this.reloadConfigChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadPluginConfig()))
        .catch((error) => {
          this.options.notifyError('plugin config hot reload failed', error)
        })
    }
    if (providersTouched || credentialsTouched) {
      this.scheduleReloadModels()
    }
  }

  /** jitter merge + serial reloadModels(external inject Models when empty operation). */
  scheduleReloadModels(): void {
    if (this.closed || this.options.externalModels) return
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined
      if (this.closed) return
      this.reloadChain = this.reloadChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadModels()))
        .catch((error) => {
          this.options.notifyError('model config hot reload failed', error)
        })
    }, 200)
  }

  /**
   * closure stop one phase: stop listen and clear await trigger guard against jitter timer, no longer produce new side effect.
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
   * closure stop second phase: wait for in-flight reloadModels and reloadPluginConfig chain converge.
   */
  async waitForInflight(): Promise<void> {
    await Promise.all([this.reloadChain, this.reloadConfigChain])
  }

  /** complete close: first stop block stop new event, again wait for in-flight converge. */
  async close(): Promise<void> {
    this.stop()
    await this.waitForInflight()
  }
}
