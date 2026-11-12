/**
 * PluginHostBackend 标准桩（各业务 fixture 组合共享）。
 *
 * core 宿主端口收敛后，PluginHostBackend 要求完整 HelmHostApi 成员
 * （profiles/skills/secrets 子端口 + 文件机制 + spawn 靶点解析/fs 探测/
 * 脱敏等）。各 fixture 只关心自己的业务面；本模块提供「无业务行为的默认
 * 实现」：
 * - 纯机制/无业务语义成员给安全空实现（isClosing=false、redact 恒等、
 *   listActions/listActiveSpawnExecutions 空数组等）；
 * - 业务面成员默认显式 501 拒绝（被测插件误调用时测试立刻 RED，绝不以
 *   成功空响应遮错）。
 *
 * 用法：hostBackendStub() 直接做基线；completeBackend(partial) 把业务
 * 成员合成进去（Object.assign，业务成员显式覆盖桩成员）。
 */
import { HelmError } from '@helm/protocol'
import type { PluginHostBackend } from '../../src/plugins/index.js'

/** 不参与业务面的成员默认显式拒绝（被测插件误调用时测试立刻 RED）。 */
function unsupported(what: string): never {
  throw new HelmError('unsupported', `本 fixture 不提供 host.${what}`, 501)
}

export function hostBackendStub(): PluginHostBackend {
  return {
    isClosing: () => false,
    profiles: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      getSystem: () => unsupported('profiles.getSystem'),
      save: () => unsupported('profiles.save'),
      directory: () => unsupported('profiles.directory'),
    },
    skills: {
      list: () => Promise.resolve([]),
      readFile: () => unsupported('skills.readFile'),
      directory: () => unsupported('skills.directory'),
      ensureSkill: () => unsupported('skills.ensureSkill'),
    },
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => unsupported('secrets.set'),
      delete: () => unsupported('secrets.delete'),
      addRedaction: () => () => {},
    },
    plugins: {
      doctorPlugin: () => unsupported('plugins.doctor'),
      installPlugin: () => unsupported('plugins.install'),
      updatePlugin: () => unsupported('plugins.update'),
      removePlugin: () => unsupported('plugins.remove'),
      enablePlugin: () => unsupported('plugins.enable'),
      disablePlugin: () => unsupported('plugins.disable'),
    },
    setPluginConfig: () => unsupported('setPluginConfig'),
    dispatchTrigger: () => unsupported('dispatchTrigger'),
    submitInput: () => unsupported('submitInput'),
    submitInputGuarded: () => unsupported('submitInputGuarded') as never as Promise<void>,
    createConversation: () => unsupported('createConversation'),
    listConversations: () => [],
    getConversation: () => unsupported('getConversation'),
    getConversationDetail: () => unsupported('getConversationDetail'),
    updateConversation: () => unsupported('updateConversation'),
    abortConversation: () => unsupported('abortConversation'),
    abortConversationGuarded: () => unsupported('abortConversationGuarded') as never as Promise<void>,
    getConversationOwnership: () => 'human',
    getConversationActivity: () => ({ consecutiveErrors: 0 }),
    listArtifacts: () => Promise.resolve([]),
    getArtifact: () => unsupported('getArtifact'),
    redact: (text: string) => text,
    redactText: (text: string) => text,
    refreshModels: () => unsupported('refreshModels'),
    completeText: () => unsupported('completeText'),
    executionEnv: () => unsupported('executionEnv') as never,
    withFileLock: <T,>(_path: string, fn: () => Promise<T>) => fn(),
    atomicWriteFile: () => unsupported('atomicWriteFile'),
    withFileMutationQueue: <T,>(_t: unknown, fn: () => Promise<T>) => fn(),
    buildSpawnEnv: () => ({}),
    spawnAgent: () => unsupported('spawnAgent'),
    runGate: () => unsupported('runGate'),
    execEnv: () => unsupported('execEnv'),
    prepareInterruptedConversations: () => Promise.resolve(),
    resolveSpawnTarget: () => unsupported('resolveSpawnTarget'),
    listActiveSpawnExecutions: () => [],
    probeNodeFs: () => unsupported('probeNodeFs'),
    invokeAction: () => unsupported('invokeAction'),
    prepareAction: () => ({ idempotent: false }),
    listActions: () => [],
    onEvent: () => () => {},
    emitEvent: () => {},
    createAsk: () => unsupported('createAsk'),
    cancelAsk: () => Promise.resolve(),
    registerAskSeqResolver: () => () => {},
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
  } as PluginHostBackend
}

/** 业务 backend（类实例/部分字面量）+ 桩成员合成完整 PluginHostBackend。 */
export function completeBackend<T extends object>(partial: T): T & PluginHostBackend {
  return Object.assign(hostBackendStub(), partial) as T & PluginHostBackend
}
