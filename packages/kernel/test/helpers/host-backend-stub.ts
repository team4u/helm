/**
 * PluginHostBackend 标准桩（各业务 fixture 组合共享）。
 *
 * 基于 `createPluginHostBackendFixture()` 派生，仅对纯机制/无业务语义成员
 * 提供安全空默认实现；其余业务面成员继承基线显式 501 拒绝（被测插件误调用
 * 时测试立刻 RED，绝不以成功空响应遮错）。
 *
 * 用法：hostBackendStub() 直接做基线；completeBackend(partial) 把业务
 * 成员合成进去（Object.assign，业务成员显式覆盖桩成员）。
 */
import type { PluginHostBackend } from '../../src/plugins/index.js'
import { createPluginHostBackendFixture } from './plugin-host-backend.js'

/** 返回带安全空默认实现（纯机制端口）的 PluginHostBackend 标准桩。 */
export function hostBackendStub(): PluginHostBackend {
  const base = createPluginHostBackendFixture()
  return {
    ...base,
    profiles: {
      ...base.profiles,
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
    },
    skills: {
      ...base.skills,
      list: () => Promise.resolve([]),
    },
    secrets: {
      ...base.secrets,
      get: () => Promise.resolve(undefined),
      addRedaction: () => () => {},
    },
    listConversations: () => [],
    getConversationOwnership: () => 'human',
    listArtifacts: () => Promise.resolve([]),
    withFileLock: <T,>(_path: string, fn: () => Promise<T>) => fn(),
    withFileMutationQueue: <T,>(_t: unknown, fn: () => Promise<T>) => fn(),
    buildSpawnEnv: () => ({}),
    listActiveSpawnExecutions: () => [],
    onEvent: () => () => {},
    emitEvent: () => {},
    cancelAsk: () => Promise.resolve(),
    registerAskSeqResolver: () => () => {},
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
  }
}

/** 业务 backend（类实例/部分字面量）+ 桩成员合成完整 PluginHostBackend。 */
export function completeBackend<T extends object>(partial: T): T & PluginHostBackend {
  return Object.assign(hostBackendStub(), partial) as T & PluginHostBackend
}
