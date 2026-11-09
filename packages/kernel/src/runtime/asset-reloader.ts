/**
 * 资产热重载协调器：监听静态资产变更，抖动合并后串行触发模型与配置热重载。
 *
 * 职责：
 * 1. 仅监听静态资产路径（providers.json / credentials.json / config.json /
 *    profiles/** / skills/**），排除 state.sqlite、artifacts、workflows 与临时文件；
 * 2. config.json 变更刷新插件配置镜像（pluginConfig.load），失败显式通知；
 * 3. providers.json / credentials.json 变更经 200ms 防抖后串行 reloadModels；
 * 4. 外部注入 Models（options.externalModels）时空操作，保持调用方所有权；
 * 5. 关停顺序保障：先 stop 停止新事件与防抖定时器，再 waitForInflight 等待在途 reload。
 */

import { AssetWatcher } from '../services/index.js'

export interface AssetReloaderOptions {
  readonly dataDir: string
  /** 外部传入 Models（测试或外部拥有）时为 true；此时不替换模型，scheduleReloadModels 视为空操作。 */
  readonly externalModels?: boolean
  /** 触发模型重载（如调用 modelsRegistry.reloadModels()）。 */
  readonly reloadModels: () => Promise<void>
  /** 触发插件配置镜像刷新（如调用 pluginConfig.load()）。 */
  readonly reloadPluginConfig: () => Promise<void>
  /** 错误通知发布接口（如发布到 events 'notification'）。 */
  readonly notifyError: (title: string, error: unknown) => void
  /** 自定义 watcher 工厂（主要用于测试注入 mock watcher）。 */
  readonly createWatcher?: (
    dir: string,
    onChange: (paths: string[]) => void,
    options: { onError: (err: Error) => void },
  ) => { start(): void; close(): void }
}

export class AssetReloader {
  private watcher: { start(): void; close(): void } | undefined
  /** reloadModels 串行链 + 抖动合并（providers/credentials 热重载共用）。 */
  private reloadChain: Promise<void> = Promise.resolve()
  /** reloadPluginConfig 在途链。 */
  private reloadConfigChain: Promise<void> = Promise.resolve()
  private reloadTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(private readonly options: AssetReloaderOptions) {}

  /**
   * 启动资产监听。
   * 仅监听静态资产路径（providers.json / credentials.json / config.json /
   * profiles/** / skills/**）。排除 state.sqlite、artifacts、workflows、
   * plugins 数据目录与一切临时文件——它们非「配置输入」，监听只增噪音。
   * models 注入时（外部/测试 Models）模型集合归调用方，绝不重建替换。
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
          // watcher 故障显式通知，不静默吞（热重载降级但主流程不受影响）。
          this.options.notifyError('资产热重载监听失败', err)
        },
      },
    )
    this.watcher.start()
  }

  /** 资产变更路径分流。 */
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
    // profiles/skills 每回合 before_turn 都 fresh 读取，无需缓存失效。
    void profilesOrSkills
    if (configTouched) {
      // 插件配置镜像刷新（读取失败显式通知，不吞）。
      this.reloadConfigChain = this.reloadConfigChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadPluginConfig()))
        .catch((error) => {
          this.options.notifyError('插件配置热重载失败', error)
        })
    }
    if (providersTouched || credentialsTouched) {
      this.scheduleReloadModels()
    }
  }

  /** 抖动合并 + 串行 reloadModels（外部注入 Models 时空操作）。 */
  scheduleReloadModels(): void {
    if (this.closed || this.options.externalModels) return
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined
      if (this.closed) return
      this.reloadChain = this.reloadChain
        .then(() => (this.closed ? Promise.resolve() : this.options.reloadModels()))
        .catch((error) => {
          this.options.notifyError('模型配置热重载失败', error)
        })
    }, 200)
  }

  /**
   * 关停第一阶段：停止监听并清除待触发防抖定时器，不再产生新副作用。
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
   * 关停第二阶段：等待在途 reloadModels 与 reloadPluginConfig 链收敛。
   */
  async waitForInflight(): Promise<void> {
    await Promise.all([this.reloadChain, this.reloadConfigChain])
  }

  /** 完整关闭：先 stop 阻止新事件，再等待在途收敛。 */
  async close(): Promise<void> {
    this.stop()
    await this.waitForInflight()
  }
}
