/**
 * PluginHostBackend 测试夹具底座（新契约：isClosing 归一为零参函数、
 * profiles/skills/secrets/getConversationDetail 等端口必选）。
 *
 * 约定：
 * - 缺省只提供两类「合理缺省」：isClosing 恒 false、redact 恒等返回；
 * - 其余未用宿主操作一律显式 throw unsupported（501），绝不以成功空响应遮错；
 * - 需要 profile/skills 真文件行为时用 profile-file-host 覆写对应端口；
 * - 类 fixture 继承 PluginHostBackendFixtureBase（构造器需 super()）；
 *   对象字面量 fixture 用 createPluginHostBackendFixture() 字段 spread 后覆写
 *   （返回对象全部为自有可枚举属性，spread 不丢方法）。
 * - 方法签名一律 Parameters/ReturnType 派生自 PluginHostBackend 本体，
 *   子类覆写（含更具体返回类型）天然兼容，不引入 never 收窄。
 */
import { HelmError } from '@helm/protocol'
import type { PluginHostBackend } from '../../src/plugins/index.js'

function unsupported(what: string): never {
  throw new HelmError('unsupported', `测试夹具未实现宿主能力：${what}（需在具体 fixture 覆写）`, 501)
}

type Port<K extends keyof PluginHostBackend> = PluginHostBackend[K]

/**
 * 类 fixture 基类：默认实现全部走原型方法（子类覆写不被遮蔽）。
 * 未覆写即被真实调用的操作会显式抛 unsupported，测试如实失败。
 */
export class PluginHostBackendFixtureBase implements PluginHostBackend {
  isClosing(): boolean {
    return false
  }

  redact(text: string): string {
    return text
  }

  profiles: Port<'profiles'> = {
    list: () => unsupported('host.profiles.list'),
    get: () => unsupported('host.profiles.get'),
    getSystem: () => unsupported('host.profiles.getSystem'),
    save: () => unsupported('host.profiles.save'),
    directory: () => unsupported('host.profiles.directory'),
  }

  skills: Port<'skills'> = {
    list: () => unsupported('host.skills.list'),
    readFile: () => unsupported('host.skills.readFile'),
    directory: () => unsupported('host.skills.directory'),
    ensureSkill: () => unsupported('host.skills.ensureSkill'),
  }

  secrets: Port<'secrets'> = {
    get: () => unsupported('host.secrets.get'),
    set: () => unsupported('host.secrets.set'),
    delete: () => unsupported('host.secrets.delete'),
    addRedaction: () => unsupported('host.secrets.addRedaction'),
  }

  plugins: Port<'plugins'> = {
    doctorPlugin: () => unsupported('host.plugins.doctor'),
    installPlugin: () => unsupported('host.plugins.install'),
    updatePlugin: () => unsupported('host.plugins.update'),
    removePlugin: () => unsupported('host.plugins.remove'),
    enablePlugin: () => unsupported('host.plugins.enable'),
    disablePlugin: () => unsupported('host.plugins.disable'),
  }!

  setPluginConfig(...args: Parameters<Port<'setPluginConfig'>>): ReturnType<Port<'setPluginConfig'>> {
    void args
    unsupported('host.setPluginConfig')
  }

  dispatchTrigger(...args: Parameters<Port<'dispatchTrigger'>>): ReturnType<Port<'dispatchTrigger'>> {
    void args
    unsupported('host.dispatchTrigger')
  }

  submitInput(...args: Parameters<Port<'submitInput'>>): ReturnType<Port<'submitInput'>> {
    void args
    unsupported('host.submitInput')
  }

  createConversation(
    ...args: Parameters<Port<'createConversation'>>
  ): ReturnType<Port<'createConversation'>> {
    void args
    unsupported('host.createConversation')
  }

  listConversations(
    ...args: Parameters<Port<'listConversations'>>
  ): ReturnType<Port<'listConversations'>> {
    void args
    unsupported('host.listConversations')
  }

  getConversation(...args: Parameters<Port<'getConversation'>>): ReturnType<Port<'getConversation'>> {
    void args
    unsupported('host.getConversation')
  }

  getConversationDetail(
    ...args: Parameters<Port<'getConversationDetail'>>
  ): ReturnType<Port<'getConversationDetail'>> {
    void args
    unsupported('host.getConversationDetail')
  }

  updateConversation(
    ...args: Parameters<Port<'updateConversation'>>
  ): ReturnType<Port<'updateConversation'>> {
    void args
    unsupported('host.updateConversation')
  }

  abortConversation(
    ...args: Parameters<Port<'abortConversation'>>
  ): ReturnType<Port<'abortConversation'>> {
    void args
    unsupported('host.abortConversation')
  }

  abortConversationGuarded(
    ...args: Parameters<NonNullable<Port<'abortConversationGuarded'>>>
  ): ReturnType<NonNullable<Port<'abortConversationGuarded'>>> {
    void args
    unsupported('host.abortConversationGuarded')
  }

  submitInputGuarded(
    ...args: Parameters<NonNullable<Port<'submitInputGuarded'>>>
  ): ReturnType<NonNullable<Port<'submitInputGuarded'>>> {
    void args
    unsupported('host.submitInputGuarded')
  }

  getConversationOwnership(
    ...args: Parameters<Port<'getConversationOwnership'>>
  ): ReturnType<Port<'getConversationOwnership'>> {
    void args
    unsupported('host.getConversationOwnership')
  }

  getConversationActivity(
    ...args: Parameters<Port<'getConversationActivity'>>
  ): ReturnType<Port<'getConversationActivity'>> {
    void args
    unsupported('host.getConversationActivity')
  }

  listArtifacts(...args: Parameters<Port<'listArtifacts'>>): ReturnType<Port<'listArtifacts'>> {
    void args
    unsupported('host.listArtifacts')
  }

  getArtifact(...args: Parameters<Port<'getArtifact'>>): ReturnType<Port<'getArtifact'>> {
    void args
    unsupported('host.getArtifact')
  }

  completeText(...args: Parameters<Port<'completeText'>>): ReturnType<Port<'completeText'>> {
    void args
    unsupported('host.completeText')
  }

  executionEnv(...args: Parameters<Port<'executionEnv'>>): ReturnType<Port<'executionEnv'>> {
    void args
    unsupported('host.executionEnv')
  }

  withFileLock<T>(
    _path: string,
    _fn: () => Promise<T>,
    _opts?: { signal?: AbortSignal },
  ): Promise<T> {
    unsupported('host.withFileLock')
  }

  atomicWriteFile(
    ...args: Parameters<Port<'atomicWriteFile'>>
  ): ReturnType<Port<'atomicWriteFile'>> {
    void args
    unsupported('host.atomicWriteFile')
  }

  buildSpawnEnv(...args: Parameters<Port<'buildSpawnEnv'>>): ReturnType<Port<'buildSpawnEnv'>> {
    void args
    unsupported('host.buildSpawnEnv')
  }

  manageConversation(
    ...args: Parameters<Port<'manageConversation'>>
  ): ReturnType<Port<'manageConversation'>> {
    void args
    unsupported('host.manageConversation')
  }

  markConversationOwnership(
    ...args: Parameters<Port<'markConversationOwnership'>>
  ): ReturnType<Port<'markConversationOwnership'>> {
    void args
    unsupported('host.markConversationOwnership')
  }

  spawnAgent(...args: Parameters<Port<'spawnAgent'>>): ReturnType<Port<'spawnAgent'>> {
    void args
    unsupported('host.spawnAgent')
  }

  runGate(...args: Parameters<Port<'runGate'>>): ReturnType<Port<'runGate'>> {
    void args
    unsupported('host.runGate')
  }

  execEnv(...args: Parameters<Port<'execEnv'>>): ReturnType<Port<'execEnv'>> {
    void args
    throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
  }

  withFileMutationQueue<T>(
    _target: { nodeId: string; cwd: string; path: string },
    _fn: () => Promise<T>,
    _opts?: { signal?: AbortSignal },
  ): Promise<T> {
    throw new HelmError('unsupported', '本 fixture 不承载文件互斥队列', 501)
  }

  prepareAction(...args: Parameters<Port<'prepareAction'>>): ReturnType<Port<'prepareAction'>> {
    void args
    unsupported('host.prepareAction')
  }

  prepareInterruptedConversations(
    ...args: Parameters<Port<'prepareInterruptedConversations'>>
  ): ReturnType<Port<'prepareInterruptedConversations'>> {
    void args
    unsupported('host.prepareInterruptedConversations')
  }

  resolveSpawnTarget(
    ...args: Parameters<Port<'resolveSpawnTarget'>>
  ): ReturnType<Port<'resolveSpawnTarget'>> {
    void args
    unsupported('host.resolveSpawnTarget')
  }

  listActiveSpawnExecutions(
    ...args: Parameters<Port<'listActiveSpawnExecutions'>>
  ): ReturnType<Port<'listActiveSpawnExecutions'>> {
    void args
    unsupported('host.listActiveSpawnExecutions')
  }

  probeNodeFs(...args: Parameters<Port<'probeNodeFs'>>): ReturnType<Port<'probeNodeFs'>> {
    void args
    unsupported('host.probeNodeFs')
  }

  inspectNodePathUsage(
    ...args: Parameters<Port<'inspectNodePathUsage'>>
  ): ReturnType<Port<'inspectNodePathUsage'>> {
    void args
    unsupported('host.inspectNodePathUsage')
  }

  redactText(...args: Parameters<Port<'redactText'>>): ReturnType<Port<'redactText'>> {
    void args
    unsupported('host.redactText')
  }

  invokeAction(...args: Parameters<Port<'invokeAction'>>): ReturnType<Port<'invokeAction'>> {
    void args
    unsupported('host.invokeAction')
  }

  listActions(...args: Parameters<Port<'listActions'>>): ReturnType<Port<'listActions'>> {
    void args
    unsupported('host.listActions')
  }

  refreshModels(...args: Parameters<Port<'refreshModels'>>): ReturnType<Port<'refreshModels'>> {
    void args
    unsupported('host.refreshModels')
  }

  createAsk(...args: Parameters<Port<'createAsk'>>): ReturnType<Port<'createAsk'>> {
    void args
    unsupported('host.createAsk')
  }

  cancelAsk(...args: Parameters<Port<'cancelAsk'>>): ReturnType<Port<'cancelAsk'>> {
    void args
    unsupported('host.cancelAsk')
  }

  registerAskSeqResolver(
    ...args: Parameters<Port<'registerAskSeqResolver'>>
  ): ReturnType<Port<'registerAskSeqResolver'>> {
    void args
    unsupported('host.registerAskSeqResolver')
  }

  onEvent(...args: Parameters<Port<'onEvent'>>): ReturnType<Port<'onEvent'>> {
    void args
    unsupported('host.onEvent')
  }

  emitEvent(...args: Parameters<Port<'emitEvent'>>): ReturnType<Port<'emitEvent'>> {
    void args
    unsupported('host.emitEvent')
  }
}

/**
 * 对象字面量 fixture 的默认后端：与 PluginHostBackendFixtureBase 同一默认语义，
 * 全部成员为自有可枚举属性（可直接 spread 组合后覆写）。
 */
export function createPluginHostBackendFixture(): PluginHostBackend {
  const d = new PluginHostBackendFixtureBase()
  const f = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => fn(...a)
  return {
    isClosing: () => d.isClosing(),
    redact: (text: string) => d.redact(text),
    profiles: {
      list: d.profiles.list,
      get: d.profiles.get,
      getSystem: d.profiles.getSystem,
      save: d.profiles.save,
      directory: d.profiles.directory,
    },
    skills: {
      list: d.skills.list,
      readFile: d.skills.readFile,
      directory: d.skills.directory,
      ensureSkill: d.skills.ensureSkill,
    },
    secrets: {
      get: d.secrets.get,
      set: d.secrets.set,
      delete: d.secrets.delete,
      addRedaction: d.secrets.addRedaction,
    },
    plugins: {
      doctorPlugin: d.plugins!.doctorPlugin,
      installPlugin: d.plugins!.installPlugin,
      updatePlugin: d.plugins!.updatePlugin,
      removePlugin: d.plugins!.removePlugin,
      enablePlugin: d.plugins!.enablePlugin,
      disablePlugin: d.plugins!.disablePlugin,
    },
    setPluginConfig: f(d.setPluginConfig),
    dispatchTrigger: f(d.dispatchTrigger),
    submitInput: f(d.submitInput),
    submitInputGuarded: f(d.submitInputGuarded),
    createConversation: f(d.createConversation),
    listConversations: f(d.listConversations),
    getConversation: f(d.getConversation),
    getConversationDetail: f(d.getConversationDetail),
    updateConversation: f(d.updateConversation),
    abortConversation: f(d.abortConversation),
    abortConversationGuarded: f(d.abortConversationGuarded),
    getConversationOwnership: f(d.getConversationOwnership),
    getConversationActivity: f(d.getConversationActivity),
    listArtifacts: f(d.listArtifacts),
    getArtifact: f(d.getArtifact),
    completeText: f(d.completeText),
    executionEnv: f(d.executionEnv),
    withFileLock: <T,>(...args: Parameters<PluginHostBackend['withFileLock']>) =>
      d.withFileLock(...(args as [string, () => Promise<T>, { signal?: AbortSignal }?])) as Promise<T>,
    atomicWriteFile: f(d.atomicWriteFile),
    buildSpawnEnv: f(d.buildSpawnEnv),
    manageConversation: f(d.manageConversation),
    markConversationOwnership: f(d.markConversationOwnership),
    spawnAgent: f(d.spawnAgent),
    runGate: f(d.runGate),
    execEnv: f(d.execEnv),
    withFileMutationQueue: <T,>(...args: Parameters<PluginHostBackend['withFileMutationQueue']>) =>
      d.withFileMutationQueue(
        ...(args as unknown as [
          { nodeId: string; cwd: string; path: string },
          () => Promise<T>,
          { signal?: AbortSignal }?,
        ]),
      ),
    prepareAction: f(d.prepareAction),
    prepareInterruptedConversations: f(d.prepareInterruptedConversations),
    resolveSpawnTarget: f(d.resolveSpawnTarget),
    listActiveSpawnExecutions: f(d.listActiveSpawnExecutions),
    probeNodeFs: f(d.probeNodeFs),
    inspectNodePathUsage: f(d.inspectNodePathUsage),
    redactText: f(d.redactText),
    invokeAction: f(d.invokeAction),
    listActions: f(d.listActions),
    refreshModels: f(d.refreshModels),
    createAsk: f(d.createAsk),
    cancelAsk: f(d.cancelAsk),
    registerAskSeqResolver: f(d.registerAskSeqResolver),
    onEvent: f(d.onEvent),
    emitEvent: f(d.emitEvent),
  }
}
