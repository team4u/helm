/**
 * builtin:profile 工作区 AGENTS.md 自动注入测试（真 PluginHost + 真文件系统
 * for local；远端用受控 executionEnv / nodeIpc 桩验证跨节点契约）。
 *
 * 覆盖：
 * - 工作区存在 AGENTS.md → before_turn 注入 profile.agents（含
 *   <project_instructions path="..."> 与正文，位于 profile.system 后、
 *   profile.skills 前）；文件修改下一回合实时生效；
 * - 无文件 / 纯空白 / 同名目录（is_directory）→ 不注入任何 AGENTS 段；
 * - 机密内容经 ctx.host.redact 脱敏后注入；
 * - 超过 MAX_AGENTS_MD_CHARS（64k）截断并附显式说明；
 * - 远端节点在线经 executionEnv 读远端路径（Windows 形状路径合成）；
 *   离线（isOnline === false）不进入 executionEnv、读取报错
 *   （permission_denied / 抛出异常）显式注入 profile.agents-unavailable；
 * - 测试桩未接线 executionEnv（unsupported）静默跳过（夹具兼容）。
 * runner: tsx --test；每项 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type ConversationSummary } from '@helm/protocol'
import { FileError, type ExecutionEnv, type Result } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { AGENTS_MD_FILENAME, MAX_AGENTS_MD_CHARS, createProfilePlugin } from '../src/profile.js'
import { computeAgentsMdSection, type AgentsMdHostPort } from '../src/profile/agents-md.js'
import { createPluginBuildProvider } from '@helm/plugin-build'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, value)
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

interface EnvCall {
  nodeId: string
  cwd: string
}

interface ControlledBackend extends PluginHostBackend {
  envCalls: EnvCall[]
}

interface BackendOptions {
  /** 远端在线判定（local 恒不调用）；缺省恒在线。 */
  online?: (nodeId: string) => boolean
  /** executionEnv 工厂：缺省 local 真实 NodeExecutionEnv（真文件系统）。 */
  envFor?: (nodeId: string, cwd: string) => ExecutionEnv
  redact?: (text: string) => string
}

function makeBackend(opts: BackendOptions = {}): ControlledBackend {
  const envCalls: EnvCall[] = []
  return {
    ...createPluginHostBackendFixture(),
    envCalls,
    nodeIpc: {
      isOnline: opts.online ?? (() => true),
      call: () => {
        throw new HelmError('node_ipc_unavailable', '测试桩不提供 nodeIpc.call', 501)
      },
      subscribe: () => {
        throw new HelmError('node_ipc_unavailable', '测试桩不提供 nodeIpc.subscribe', 501)
      },
    },
    executionEnv(nodeId: string, cwd: string) {
      envCalls.push({ nodeId, cwd })
      return opts.envFor ? opts.envFor(nodeId, cwd) : new NodeExecutionEnv({ cwd })
    },
    ...(opts.redact !== undefined ? { redact: opts.redact } : {}),
    async emitEvent() {},
  }
}

interface Env {
  dataDir: string
  workspace: string
  host: PluginHost
  backend: ControlledBackend
  close(): Promise<void>
}

async function makeEnv(workspace: string, opts: BackendOptions = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-profile-agents-'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const backend = Object.assign(makeBackend(opts), createProfileFileHost(dataDir, profiles))
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
  })
  await host.register(createProfilePlugin(), { enabled: true })
  return {
    dataDir,
    workspace,
    host,
    backend,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    },
  }
}

interface TurnLike {
  conversation: ConversationSummary
  sections: Array<{ id: string; text: string }>
  tools: Array<{ name: string }>
  inputs: unknown[]
  messages: Array<Record<string, unknown>>
}

function makeTurn(cwd: string, over: Partial<ConversationSummary> = {}): TurnLike {
  return {
    conversation: makeConversation(1, { cwd, ...over }),
    sections: [],
    tools: [],
    inputs: [],
    messages: [],
  }
}

async function runBeforeTurn(env: Env, turn: TurnLike): Promise<Array<{ id: string; text: string }>> {
  const result = (await env.host.runHook('before_turn', turn as never)) as {
    action: string
    value?: TurnLike
  }
  assert.equal(result.action, 'transform')
  return result.value!.sections
}

/** 受控远端/失败执行环境：仅实现被消费的 readTextFile（其余成员不触达）。 */
function fakeEnv(
  handler: (path: string) => Promise<Result<string, FileError>>,
): ExecutionEnv {
  return { readTextFile: (path: string) => handler(path) } as unknown as ExecutionEnv
}

async function freshWorkspace(): Promise<string> {
  return mkdtempSync(join(tmpdir(), 'helm-agents-ws-'))
}

// ---------------------------------------------------------------------------
// 集成：本地工作区（真实文件系统）
// ---------------------------------------------------------------------------

test('before_turn：工作区存在 AGENTS.md → 注入 profile.agents（system 后、skills 前），修改下一回合生效', { timeout: 60_000 }, async () => {
  const workspace = await freshWorkspace()
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 项目约定\n\n所有提交使用中文 Conventional Commits。\n')
  const env = await makeEnv(workspace)
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace))
    const ids = sections.map((s) => s.id)
    assert.ok(ids.includes('profile.system'), 'SYSTEM.md 存在注入 profile.system')
    assert.ok(ids.includes('profile.skills'), '技能目录注入 profile.skills')
    assert.ok(
      ids.indexOf('profile.system') < ids.indexOf('profile.agents') && ids.indexOf('profile.agents') < ids.indexOf('profile.skills'),
      `profile.agents 介于 profile.system 与 profile.skills 之间：${ids.join(', ')}`,
    )
    const agents = sections.find((s) => s.id === 'profile.agents')!
    assert.ok(agents.text.startsWith(`<project_instructions path="${workspace}/AGENTS.md">\n`), '以带 path 属性的标签开头')
    assert.ok(agents.text.endsWith('</project_instructions>'))
    assert.ok(agents.text.includes('所有提交使用中文 Conventional Commits。'), '正文进入注入段')
    assert.ok(!sections.some((s) => s.id === 'profile.agents-unavailable'), '成功读取不注入不可用段')

    // 文件修改 → 下一回合实时生效（逐回合重读，无缓存）
    writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 新约定\n\n禁止 force push。\n')
    const again = await runBeforeTurn(env, makeTurn(workspace))
    const agentsAgain = again.find((s) => s.id === 'profile.agents')!
    assert.ok(agentsAgain.text.includes('禁止 force push。'), '修改后下一回合生效')
    assert.ok(!agentsAgain.text.includes('所有提交使用中文 Conventional Commits'), '旧内容不再残留')
  } finally {
    await env.close()
  }
})

test('before_turn：无 AGENTS.md / 纯空白 / 同名目录 → 不注入任何 AGENTS 段', { timeout: 60_000 }, async () => {
  // 1. 无文件
  const emptyWs = await freshWorkspace()
  const noFile = await makeEnv(emptyWs)
  try {
    const sections = await runBeforeTurn(noFile, makeTurn(emptyWs))
    assert.ok(!sections.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'), '无文件不注入')
  } finally {
    await noFile.close()
  }

  // 2. 纯空白文件
  const blankWs = await freshWorkspace()
  writeFileSync(join(blankWs, AGENTS_MD_FILENAME), '   \n\t\n')
  const blank = await makeEnv(blankWs)
  try {
    const sections = await runBeforeTurn(blank, makeTurn(blankWs))
    assert.ok(!sections.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'), '空白文件不注入')
  } finally {
    await blank.close()
  }

  // 4. cwd 为空串：跳过读取（真实钩子载荷校验拒绝空 cwd，此分支由纯函数
  //    直测覆盖，见下方 computeAgentsMdSection 单测）。

  // 3. 同名目录（真实 fs 报 is_directory）
  const dirWs = await freshWorkspace()
  mkdirSync(join(dirWs, AGENTS_MD_FILENAME))
  const dirEnv = await makeEnv(dirWs)
  try {
    const sections = await runBeforeTurn(dirEnv, makeTurn(dirWs))
    assert.ok(!sections.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'), '同名目录不注入')
  } finally {
    await dirEnv.close()
  }
})

test('before_turn：AGENTS.md 含机密 → 注入前经 ctx.host.redact 脱敏', { timeout: 60_000 }, async () => {
  const workspace = await freshWorkspace()
  // 纯字面量假机密（非任何真实凭据），验证注入前过宿主脱敏。
  const fakeSecret = 'FAKE_SECRET_TOKEN_42'
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), `部署令牌：${fakeSecret}，请保密。\n`)
  const env = await makeEnv(workspace, {
    redact: (text) => text.replaceAll(fakeSecret, 'REDACTED_MARKER'),
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace))
    const agents = sections.find((s) => s.id === 'profile.agents')!
    assert.ok(agents.text.includes('REDACTED_MARKER'), '机密替换为脱敏标记')
    assert.ok(!agents.text.includes(fakeSecret), '机密明文绝不进入系统提示词')
  } finally {
    await env.close()
  }
})

test(`before_turn：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符 → 截断并附显式说明`, { timeout: 60_000 }, async () => {
  const workspace = await freshWorkspace()
  const filler = '约'.repeat(500)
  const long = `${filler}\n`.repeat(MAX_AGENTS_MD_CHARS / 500 + 2)
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), long)
  const env = await makeEnv(workspace)
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace))
    const agents = sections.find((s) => s.id === 'profile.agents')!
    const note = `[ helm 提示：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符上限，以上为前 ${MAX_AGENTS_MD_CHARS} 字符 ]`
    assert.ok(agents.text.includes(note), '显式截断说明')
    // 标签头 + 截断正文 + 说明 + 标签尾；正文恰好为前 64k 字符
    const body = agents.text.slice(
      `<project_instructions path="${workspace}/AGENTS.md">\n`.length,
      agents.text.length - `\n${note}\n</project_instructions>`.length,
    )
    assert.equal(body.length, MAX_AGENTS_MD_CHARS, '正文恰好截取前 64k 字符')
    assert.equal(body, long.slice(0, MAX_AGENTS_MD_CHARS), '截断内容与原文前 64k 一致')
  } finally {
    await env.close()
  }
})

test('before_turn：测试桩未接线 executionEnv（unsupported）→ 静默跳过不注入', { timeout: 60_000 }, async () => {
  const workspace = await freshWorkspace()
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 约定\n')
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-profile-agents-'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    // 未覆写 executionEnv：标准夹具抛 HelmError('unsupported', 501)
    host: Object.assign(createPluginHostBackendFixture(), createProfileFileHost(dataDir, profiles), {
      async emitEvent() {},
    }),
    docs: new MemoryDocStore(),
  })
  try {
    await host.register(createProfilePlugin(), { enabled: true })
    const result = (await host.runHook('before_turn', makeTurn(workspace) as never)) as {
      action: string
      value?: TurnLike
    }
    assert.equal(result.action, 'transform')
    const ids = result.value!.sections.map((s) => s.id)
    assert.ok(!ids.includes('profile.agents') && !ids.includes('profile.agents-unavailable'), `不注入：${ids.join(',')}`)
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 集成：远端节点（受控 executionEnv / nodeIpc）
// ---------------------------------------------------------------------------

test('before_turn：远端节点在线 → 经 executionEnv 读远端路径（Windows 形状路径合成）', { timeout: 60_000 }, async () => {
  const workspace = 'C:\\repo'
  const readPaths: string[] = []
  const env = await makeEnv(workspace, {
    envFor: (nodeId, cwd) =>
      fakeEnv(async (path) => {
        assert.equal(nodeId, 'remote-1')
        assert.equal(cwd, workspace)
        readPaths.push(path)
        return { ok: true, value: '# 远端约定\n\n使用 pnpm。\n' }
      }),
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    assert.deepEqual(readPaths, ['C:\\repo\\AGENTS.md'], 'win32 形状按反斜杠合成')
    const agents = sections.find((s) => s.id === 'profile.agents')!
    assert.ok(agents.text.includes('<project_instructions path="C:\\repo\\AGENTS.md">'), 'path 属性为远端 Windows 路径')
    assert.ok(agents.text.includes('使用 pnpm。'))
    assert.deepEqual(env.backend.envCalls, [{ nodeId: 'remote-1', cwd: workspace }], '以靶点 nodeId+cwd 取执行环境')
  } finally {
    await env.close()
  }
})

test('before_turn：远端节点 POSIX 路径按 POSIX 规则合成', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const readPaths: string[] = []
  const env = await makeEnv(workspace, {
    envFor: () => fakeEnv(async (path) => {
      readPaths.push(path)
      return { ok: true, value: '# srv 约定\n' }
    }),
  })
  try {
    await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-2' }))
    assert.deepEqual(readPaths, ['/srv/app/AGENTS.md'])
  } finally {
    await env.close()
  }
})

test('before_turn：远端节点离线（isOnline=false）→ 显式注入 agents-unavailable，不进入 executionEnv', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    online: (nodeId) => nodeId !== 'remote-1',
    envFor: () => {
      throw new Error('离线时不应触达 executionEnv')
    },
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.startsWith('<project_instructions_unavailable path="/srv/app/AGENTS.md" node="remote-1">'), '显式说明段')
    assert.ok(unavailable.text.includes('目标节点 remote-1 当前离线'), '包含离线原因')
    assert.ok(!unavailable.text.includes('REMOTE_SECRET'))
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    assert.equal(env.backend.envCalls.length, 0, '离线短路，不阻塞等待远端 RPC')
  } finally {
    await env.close()
  }
})

test('before_turn：远端读取报错（permission_denied）→ 显式注入 agents-unavailable（含错误码与脱敏消息）', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    envFor: () =>
      fakeEnv(async (path) => ({
        ok: false,
        error: new FileError('permission_denied', `EACCES: permission denied, open '${path}'（含机密 SECRET_x9y8）`, path),
      })),
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('读取工作区 /srv/app/AGENTS.md 失败（permission_denied）'), '错误码如实呈现')
    assert.ok(unavailable.text.includes('EACCES'), '错误消息呈现')
  } finally {
    await env.close()
  }
})

test('before_turn：远端读取抛异常（node_offline）→ 同样显式注入 agents-unavailable', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    envFor: () =>
      fakeEnv(() => {
        throw new HelmError('node_offline', '节点 remote-1 连接中断', 409)
      }),
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('（node_offline）'), '异常错误码呈现')
    assert.ok(unavailable.text.includes('连接中断'), '异常消息呈现')
  } finally {
    await env.close()
  }
})

test('before_turn：isOnline 抛未接线 HelmError → 继续尝试 executionEnv，真实结果如实处理', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    online: () => {
      throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501)
    },
    envFor: () => fakeEnv(async () => ({ ok: true, value: '# IPC 未接线但执行环境可用\n' })),
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const agents = sections.find((s) => s.id === 'profile.agents')!
    assert.ok(agents.text.includes('IPC 未接线但执行环境可用'), 'isOnline 抛错不误判离线，读取结果如实注入')
  } finally {
    await env.close()
  }
})

test('before_turn：远端 not_found → 属常态不注入；错误消息含机密时经 redact 脱敏', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    redact: (text) => text.replaceAll('SECRET_q7w6', '[REDACTED]'),
    envFor: () =>
      fakeEnv(async (path) => ({
        ok: false,
        error: new FileError('unknown', `RPC 断连（token SECRET_q7w6）: ${path}`, path),
      })),
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('[REDACTED]'), '错误消息中的机密已脱敏')
    assert.ok(!unavailable.text.includes('SECRET_q7w6'))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 纯函数：computeAgentsMdSection 直测（钩子载荷校验覆盖不到的分支）
// ---------------------------------------------------------------------------

test('computeAgentsMdSection：cwd 为空串直接跳过，不触达 executionEnv / nodeIpc', { timeout: 60_000 }, async () => {
  const host: AgentsMdHostPort = {
    executionEnv() {
      throw new Error('空 cwd 不应触达 executionEnv')
    },
    redact: (t) => t,
    nodeIpc: {
      isOnline() {
        throw new Error('空 cwd 不应触达 nodeIpc')
      },
    },
  }
  assert.deepEqual(await computeAgentsMdSection(host, 'remote-1', ''), { kind: 'none' })
  assert.deepEqual(await computeAgentsMdSection(host, undefined, ''), { kind: 'none' })
})

test('computeAgentsMdSection：远端 not_found / is_directory（含 EISDIR 消息）→ 属常态不注入', { timeout: 60_000 }, async () => {
  const hostOf = (code: 'not_found' | 'is_directory', message: string): AgentsMdHostPort => ({
    executionEnv: () => fakeEnv(async (path) => ({ ok: false, error: new FileError(code, message, path) })),
    redact: (t) => t,
    nodeIpc: { isOnline: () => true },
  })
  assert.deepEqual(await computeAgentsMdSection(hostOf('not_found', 'ENOENT: no such file'), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(await computeAgentsMdSection(hostOf('is_directory', 'EISDIR: illegal operation'), 'remote-1', '/srv/app'), { kind: 'none' })
  // 错误码非 is_directory 但消息含 EISDIR 同样按目录处理
  const eisdir = {
    executionEnv: () => fakeEnv(async (path) => ({ ok: false, error: new FileError('unknown', 'EISDIR: read', path) })),
    redact: (t: string) => t,
    nodeIpc: { isOnline: () => true },
  } satisfies AgentsMdHostPort
  assert.deepEqual(await computeAgentsMdSection(eisdir, 'remote-1', '/srv/app'), { kind: 'none' })
})

