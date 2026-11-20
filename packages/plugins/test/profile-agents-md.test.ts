/**
 * builtin:profile 工作区 AGENTS.md 自动注入测试（真 PluginHost + 真文件系统
 * for local；远端用受控 executionEnv 桩验证跨节点契约）。
 *
 * 覆盖：
 * - 工作区存在 AGENTS.md → before_turn 注入 profile.agents（含
 *   <project_instructions path="..."> 与正文，位于 profile.system 后、
 *   profile.skills 前）；文件修改下一回合实时生效；
 * - 无文件 / 纯空白 / 同名目录 → 不注入任何 AGENTS 段；
 * - 机密内容经 ctx.host.redact 脱敏后注入；
 * - 超过 MAX_AGENTS_MD_CHARS（64k）截断并附显式说明；
 * - 远端节点在线经 executionEnv 读远端路径（Windows / POSIX 形状路径合成）；
 *   离线（isOnline === false）不进入 executionEnv、显式注入不可用段；
 * - 诚实性红线（能力未接线绝不静默跳过）：isOnline 抛错（含未接线
 *   node_ipc_unavailable）、executionEnv 未接线（unsupported）均显式注入
 *   profile.agents-unavailable；
 * - 有界安全读取（canonicalPath + openBinaryReader({ noFollow: true }) 同
 *   句柄 info/read/close，绝无 readTextFile 无界整读）：
 *   - 同句柄 info 报告超过 MAX_AGENTS_MD_BYTES → 不调用 read，显式不可用；
 *   - read 至多请求 MAX_AGENTS_MD_BYTES + 1 字节（超限即实证拒绝）；
 *   - 特殊文件（打开报 invalid / 打开后句柄 kind 非 file）→ 不读正文，
 *     显式不可用；预检后路径被换成软链（noFollow 打开失败）不落到任何
 *     按路径读取，显式不可用；
 *   - 读后二次 info 复核：读取期间 size/mtime 变化或实读字节数与稳定
 *     size 不一致 → 显式不可用，绝不把旧前缀当完整快照；
 *   - info / read 报错或抛异常、close 抛错 → 显式不可用并脱敏；
 *   - 成功与全部失败路径均显式 close 句柄；
 *   - 稳定内容按 UTF-8 解码后正常注入（多字节字符保真）；
 * - 读取阶段 not_found / is_directory（含 EISDIR 消息）按常态缺失不注入；
 *   目录 / 悬空软链同属常态。
 * runner: tsx --test；每项 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import {
  FileError,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type FileErrorCode,
  type Result,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { AGENTS_MD_FILENAME, MAX_AGENTS_MD_CHARS, createProfilePlugin } from '../src/profile.js'
import {
  MAX_AGENTS_MD_BYTES,
  computeAgentsMdSection,
  type AgentsMdHostPort,
} from '../src/profile/agents-md.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary } from './helpers/plugin-test-env.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const makeConversation = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary =>
  makeConversationSummary({ id, ...over })

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
        throw new HelmxError('node_ipc_unavailable', '测试桩不提供 nodeIpc.call', 501)
      },
      subscribe: () => {
        throw new HelmxError('node_ipc_unavailable', '测试桩不提供 nodeIpc.subscribe', 501)
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
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-profile-agents-'))
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

// ---------------------------------------------------------------------------
// 受控执行环境桩：openBinaryReader + 同句柄 info/read/close
// ---------------------------------------------------------------------------

/**
 * 单次读取全协议调用记录：op 序列即断言面（readTextFile / fileInfo 出现
 * 即失败——生产实现绝不允许退回无界或按路径读取）。
 */
type FakeCall =
  | { op: 'canonicalPath' | 'openBinaryReader' | 'readTextFile' | 'fileInfo'; path: string }
  | { op: 'openBinaryReader'; path: string; noFollow: boolean }
  | { op: 'info' }
  | { op: 'read'; offset: number; length: number }
  | { op: 'close' }

/**
 * 同句柄脚本：infos 为 info 应答序列（第 n 次 info 取第 n 项，耗尽后复用
 * 末项；缺省按 bytes/kind/size/mtimeMs 派生稳定基线）；read 覆写缺省按
 * bytes 有界切片；closeError 让 close 抛错（成功读取路径同样显式不可用）。
 */
interface FakeHandle {
  infos?: Array<Result<FileInfo, FileError>>
  read?: (offset: number, length: number) => Result<Uint8Array, FileError>
  bytes?: Uint8Array
  text?: string
  kind?: FileInfo['kind']
  size?: number
  mtimeMs?: number
  closeError?: unknown
}

interface FakeEnvStages {
  canonicalPath?: (path: string) => Result<string, FileError>
  /** 打开应答：错误（not_found / is_directory / invalid…）或成功句柄脚本。 */
  openBinaryReader?: (path: string) => Result<FakeHandle, FileError>
}

interface FakeEnv extends ExecutionEnv {
  calls: FakeCall[]
  /** 每次 reader.read 请求的 length（有界断言面）。 */
  readLengths: number[]
}

/**
 * 受控执行环境：记录 canonicalPath / openBinaryReader / 句柄 info / read /
 * close 全部调用并按脚本应答。未脚本化的 readTextFile / fileInfo 被显式
 * 禁用（抛错并留痕）：生产实现已改用 openBinaryReader 同句柄有界读取，
 * 任何回退到无界 readTextFile 或路径级 fileInfo 预检的回归都会当场炸响。
 */
function fakeEnv(stages: FakeEnvStages = {}): FakeEnv {
  const calls: FakeCall[] = []
  const readLengths: number[] = []
  const encoder = new TextEncoder()
  const openFor = (path: string): Result<FakeHandle, FileError> =>
    stages.openBinaryReader
      ? stages.openBinaryReader(path)
      : { ok: true, value: { text: '# 受控桩默认约定\n' } }

  const env = {
    calls,
    readLengths,
    async canonicalPath(path: string): Promise<Result<string, FileError>> {
      calls.push({ op: 'canonicalPath', path })
      return stages.canonicalPath ? stages.canonicalPath(path) : { ok: true, value: path }
    },
    async openBinaryReader(
      path: string,
      options: { noFollow?: boolean } | undefined,
    ): Promise<Result<BinaryReader, FileError>> {
      calls.push({ op: 'openBinaryReader', path, noFollow: options?.noFollow === true })
      const opened = openFor(path)
      if (!opened.ok) return opened
      const script = opened.value
      const bytes = script.bytes ?? encoder.encode(script.text ?? '')
      const baseInfo = (): FileInfo => ({
        name: AGENTS_MD_FILENAME,
        path,
        kind: script.kind ?? 'file',
        size: script.size ?? bytes.byteLength,
        mtimeMs: script.mtimeMs ?? 1_000,
      })
      const scriptedInfos = [...(script.infos ?? [])]
      const takeInfo = (): Result<FileInfo, FileError> => {
        if (scriptedInfos.length > 1) return scriptedInfos.shift()!
        if (scriptedInfos.length === 1) return scriptedInfos[0]!
        return { ok: true, value: baseInfo() }
      }
      let closed = false
      const handle: BinaryReader = {
        async info(): Promise<Result<FileInfo, FileError>> {
          calls.push({ op: 'info' })
          if (closed) return { ok: false, error: new FileError('invalid', 'Binary reader is closed', path) }
          return takeInfo()
        },
        async read(offset: number, length: number): Promise<Result<Uint8Array, FileError>> {
          calls.push({ op: 'read', offset, length })
          readLengths.push(length)
          if (length > MAX_AGENTS_MD_BYTES + 1) {
            throw new Error(`fake reader 拒绝超长读取请求：length=${length}（上限 ${MAX_AGENTS_MD_BYTES + 1}）`)
          }
          if (closed) return { ok: false, error: new FileError('invalid', 'Binary reader is closed', path) }
          if (script.read) return script.read(offset, length)
          return { ok: true, value: bytes.subarray(offset, Math.min(offset + length, bytes.byteLength)) }
        },
        async scanLines(): Promise<Result<never, FileError>> {
          throw new Error('fake reader 未脚本化 scanLines（AGENTS.md 读取不应调用）')
        },
        async close(): Promise<void> {
          calls.push({ op: 'close' })
          closed = true
          if (script.closeError !== undefined) throw script.closeError
        },
      }
      return { ok: true, value: handle }
    },
    async readTextFile(path: string): Promise<Result<string, FileError>> {
      calls.push({ op: 'readTextFile', path })
      throw new Error(`fake readTextFile 绝不允许被调用（无界读取已被 openBinaryReader 取代）: ${path}`)
    },
    async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
      calls.push({ op: 'fileInfo', path })
      throw new Error(`fake fileInfo 不再参与 AGENTS.md 读取（同句柄 reader.info 为权威）: ${path}`)
    },
  }
  return env as unknown as FakeEnv
}

function opsOf(env: FakeEnv): string[] {
  return env.calls.map((c) => c.op)
}

function readCallLengths(env: FakeEnv): number[] {
  return env.readLengths
}

function fileInfoOf(path: string, over: Partial<FileInfo> = {}): FileInfo {
  return { name: AGENTS_MD_FILENAME, path, kind: 'file', size: 128, mtimeMs: 0, ...over }
}

/** 纯函数直测宿主：恒在线、恒等脱敏，executionEnv 返回受控桩。 */
function hostOf(env: ExecutionEnv, over: Partial<AgentsMdHostPort> = {}): AgentsMdHostPort {
  return {
    executionEnv: () => env,
    redact: (t) => t,
    nodeIpc: { isOnline: () => true },
    ...over,
  }
}

async function freshWorkspace(): Promise<string> {
  return mkdtempSync(join(tmpdir(), 'helmx-agents-ws-'))
}

// ---------------------------------------------------------------------------
// 集成：本地工作区（真实文件系统，走真实 openBinaryReader 同句柄管线）
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

  // 3. 同名目录（真实 openBinaryReader 报 is_directory → 常态缺失）
  const dirWs = await freshWorkspace()
  mkdirSync(join(dirWs, AGENTS_MD_FILENAME))
  const dirEnv = await makeEnv(dirWs)
  try {
    const sections = await runBeforeTurn(dirEnv, makeTurn(dirWs))
    assert.ok(!sections.some((s) => s.id === 'profile.agents' || s.id === 'profile.agents-unavailable'), '同名目录不注入')
  } finally {
    await dirEnv.close()
  }

  // 4. cwd 为空串：跳过读取（真实钩子载荷校验拒绝空 cwd，此分支由纯函数
  //    直测覆盖，见下方 computeAgentsMdSection 单测）。
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
    const note = `[ helmx 提示：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符上限，以上为前 ${MAX_AGENTS_MD_CHARS} 字符 ]`
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

test(`before_turn：本地真实文件超过 ${MAX_AGENTS_MD_BYTES} 字节 → 同句柄 info 权威拒绝，不读正文`, { timeout: 60_000 }, async () => {
  const workspace = await freshWorkspace()
  const size = MAX_AGENTS_MD_BYTES + 1
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), Buffer.alloc(size, 0x61))
  const env = await makeEnv(workspace)
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes(`为 ${size} 字节`), '实际字节数呈现')
    assert.ok(unavailable.text.includes(`超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限`), '上限与未读取正文说明呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
  } finally {
    await env.close()
  }
})

test('before_turn：测试桩未接线 executionEnv（unsupported）→ 显式注入 agents-unavailable，绝不静默跳过', { timeout: 60_000 }, async () => {
  const workspace = await freshWorkspace()
  writeFileSync(join(workspace, AGENTS_MD_FILENAME), '# 约定\n')
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-profile-agents-'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    // 未覆写 executionEnv：标准夹具抛 HelmxError('unsupported', 501)
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
    assert.ok(ids.includes('profile.agents-unavailable'), `显式不可用段：${ids.join(',')}`)
    assert.ok(!ids.includes('profile.agents'), '未接线绝不伪造正文注入')
    const unavailable = result.value!.sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('（unsupported）'), '错误码如实呈现')
    assert.ok(unavailable.text.includes('host.executionEnv'), '错误消息如实呈现（宿主能力未接线）')
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 集成：远端节点（受控 executionEnv / nodeIpc，openBinaryReader 同句柄协议）
// ---------------------------------------------------------------------------

test('before_turn：远端节点在线 → 经 executionEnv openBinaryReader 读远端路径（Windows 形状 + noFollow）', { timeout: 60_000 }, async () => {
  const workspace = 'C:\\repo'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({ ok: true, value: { text: '# 远端约定\n\n使用 pnpm。\n' } }),
  })
  const env = await makeEnv(workspace, { envFor: (nodeId, cwd) => {
    assert.equal(nodeId, 'remote-1')
    assert.equal(cwd, workspace)
    return remoteEnv
  } })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const agents = sections.find((s) => s.id === 'profile.agents')!
    assert.ok(agents.text.includes('<project_instructions path="C:\\repo\\AGENTS.md">'), 'path 属性为远端 Windows 路径')
    assert.ok(agents.text.includes('使用 pnpm。'), '正文进入注入段')
    assert.ok(
      env.backend.envCalls.length >= 1 &&
        env.backend.envCalls.every((e) => e.nodeId === 'remote-1' && e.cwd === workspace),
      '以靶点 nodeId+cwd 取执行环境（同回合 AGENTS.md 读取与节点技能扫描各取一次短生命周期 env）',
    )
    const openCalls = remoteEnv.calls.filter((c) => c.op === 'openBinaryReader') as Array<{ op: 'openBinaryReader'; path: string; noFollow: boolean }>
    assert.deepEqual(openCalls.map((c) => c.path), ['C:\\repo\\AGENTS.md'], 'win32 形状按反斜杠合成')
    assert.equal(openCalls[0]!.noFollow, true, 'noFollow 打开封软链替换竞态')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile'), '绝不调用无界 readTextFile')
  } finally {
    await env.close()
  }
})

test('before_turn：远端节点 POSIX 路径按 POSIX 规则合成并锚定打开', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text: '# srv 约定\n' } }) })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-2' }))
    const openCalls = remoteEnv.calls.filter((c) => c.op === 'openBinaryReader') as Array<{ op: 'openBinaryReader'; path: string; noFollow: boolean }>
    assert.deepEqual(openCalls.map((c) => c.path), ['/srv/app/AGENTS.md'])
    assert.equal(openCalls[0]!.noFollow, true, 'noFollow 打开封预检后软链替换竞态')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile'), '绝不调用无界 readTextFile')
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

test('before_turn：isOnline 抛未接线 HelmxError（node_ipc_unavailable）→ 显式注入 agents-unavailable，不进入 executionEnv', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    online: () => {
      throw new HelmxError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501)
    },
    envFor: () => {
      throw new Error('在线探测失败后不应触达 executionEnv')
    },
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('在线状态失败（node_ipc_unavailable）'), '探测失败错误码如实呈现')
    assert.ok(unavailable.text.includes('EnvFabric 未接线'), '探测失败原因呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    assert.equal(env.backend.envCalls.length, 0, '能力未接线不进入执行环境（不再有静默兼容回退）')
  } finally {
    await env.close()
  }
})

test('before_turn：远端 read 报错（permission_denied）→ 显式注入 agents-unavailable（含错误码与脱敏消息），句柄仍关闭', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: (path) => ({
      ok: true,
      value: {
        read: () => ({
          ok: false,
          error: new FileError('permission_denied', `EACCES: permission denied, read '${path}'（含机密 SECRET_x9y8）`, path),
        }),
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('读取工作区 /srv/app/AGENTS.md 失败（permission_denied）'), '错误码如实呈现')
    assert.ok(unavailable.text.includes('EACCES'), '错误消息呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'close'], '读错误后仍显式关闭句柄')
  } finally {
    await env.close()
  }
})

test('before_turn：远端 read 抛异常（node_offline）→ 同样显式注入 agents-unavailable，句柄仍关闭', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        read: () => {
          throw new HelmxError('node_offline', '节点 remote-1 连接中断', 409)
        },
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('（node_offline）'), '异常错误码呈现')
    assert.ok(unavailable.text.includes('连接中断'), '异常消息呈现')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'close'], '异常路径 finally 关闭句柄')
  } finally {
    await env.close()
  }
})

test('before_turn：远端打开报 unknown 错误 → 显式注入 agents-unavailable，错误消息含机密时经 redact 脱敏', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const env = await makeEnv(workspace, {
    redact: (text) => text.replaceAll('SECRET_q7w6', '[REDACTED]'),
    envFor: () =>
      fakeEnv({
        openBinaryReader: (path) => ({
          ok: false,
          error: new FileError('unknown', `RPC 断连（token SECRET_q7w6）: ${path}`, path),
        }),
      }),
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

test(`before_turn：远端同句柄 info 报告超过 ${MAX_AGENTS_MD_BYTES} 字节 → 不调用 read，显式注入 agents-unavailable`, { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const size = MAX_AGENTS_MD_BYTES + 1
  const remoteEnv = fakeEnv({
    openBinaryReader: (path) => ({ ok: true, value: { size, mtimeMs: 5 } }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes(`为 ${size} 字节`), '实际字节数呈现')
    assert.ok(unavailable.text.includes(`超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限`), '上限与未读取正文说明呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'read'), '超大文件绝不读正文')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'close'], '只做元数据权威检查并关闭句柄')
  } finally {
    await env.close()
  }
})

test(`before_turn：打开后文件增长使 read 实证超过 ${MAX_AGENTS_MD_BYTES} 字节 → 显式注入 agents-unavailable`, { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        // 预检时 info 报告 1 字节，read 实际返回上限+1 字节（info 与 read 之间增长）
        infos: [{ ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 1, mtimeMs: 1 }) }],
        read: () => ({ ok: true, value: new Uint8Array(MAX_AGENTS_MD_BYTES + 1) }),
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(
      unavailable.text.includes(`读取到 ${MAX_AGENTS_MD_BYTES + 1} 字节，超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限`),
      '实证超限说明呈现',
    )
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    assert.deepEqual(readCallLengths(remoteEnv), [MAX_AGENTS_MD_BYTES + 1], 'read 请求恰好为上限+1')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'close'])
  } finally {
    await env.close()
  }
})

test('before_turn：远端特殊文件（打开报 invalid）→ 不读正文，显式注入 agents-unavailable', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: (path) => ({ ok: false, error: new FileError('invalid', 'Not a regular file', path) }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('（invalid）'), '错误码如实呈现')
    assert.ok(unavailable.text.includes('Not a regular file'), '错误消息呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader'], '特殊文件在打开处止步，不进入句柄读取（FIFO 等可能无限阻塞）')
  } finally {
    await env.close()
  }
})

test('before_turn：打开后句柄 kind 非 file（路径被替换）→ 拒绝读取并显式注入 agents-unavailable，句柄关闭', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({ ok: true, value: { kind: 'directory' } }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('在打开后不是普通文件（kind=directory）'), '同句柄权威 kind 呈现')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'read'), '不读正文')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile'), '绝不落到无界 readTextFile')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'close'])
  } finally {
    await env.close()
  }
})

test('before_turn：预检后路径被换成软链（noFollow 打开拒绝）→ 显式注入 agents-unavailable，不落到按路径读取', { timeout: 60_000 }, async () => {
  const workspace = '/repo'
  const real = '/srv/shared/AGENTS.md'
  const remoteEnv = fakeEnv({
    canonicalPath: () => ({ ok: true, value: real }),
    openBinaryReader: (path) => ({
      ok: false,
      error: new FileError('invalid', `ELOOP: too many levels of symbolic links（预检后 ${path} 被替换为软链）`, path),
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('（invalid）'), 'ELOOP 按显式不可读处理')
    assert.ok(unavailable.text.includes('ELOOP'), '拒绝原因呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '不注入正文')
    const openCalls = remoteEnv.calls.filter((c) => c.op === 'openBinaryReader') as Array<{ op: 'openBinaryReader'; path: string; noFollow: boolean }>
    assert.deepEqual(openCalls.map((c) => c.path), [real], '打开锚定解析后的真实路径')
    assert.equal(openCalls[0]!.noFollow, true, 'noFollow 封软链替换竞态')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader'], '打开失败即止步，无任何按路径正文读取')
  } finally {
    await env.close()
  }
})

test('before_turn：远端 AGENTS.md 为软链 → 解析真实目标打开读取，注入段仍显示词法路径', { timeout: 60_000 }, async () => {
  const workspace = '/repo'
  const real = '/srv/shared/AGENTS.md'
  const remoteEnv = fakeEnv({
    canonicalPath: () => ({ ok: true, value: real }),
    openBinaryReader: () => ({ ok: true, value: { text: '# 共享约定\n' } }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const agents = sections.find((s) => s.id === 'profile.agents')!
    assert.ok(agents.text.includes('<project_instructions path="/repo/AGENTS.md">'), 'path 属性保持工作区词法路径')
    assert.ok(agents.text.includes('# 共享约定'), '真实目标内容进入注入段')
    const openCalls = remoteEnv.calls.filter((c) => c.op === 'openBinaryReader') as Array<{ op: 'openBinaryReader'; path: string }>
    assert.deepEqual(openCalls.map((c) => c.path), [real], '打开锚定解析后的真实目标')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile'), '软链正文同样走同句柄有界读取')
  } finally {
    await env.close()
  }
})

test('before_turn：读取期间 mtime 变化 → 显式注入 agents-unavailable，绝不注入可能不完整的快照', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        text: 'stable!',
        infos: [
          { ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 7, mtimeMs: 1 }) },
          { ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 7, mtimeMs: 2 }) },
        ],
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('读取期间文件发生变化'), '变化显式说明')
    assert.ok(unavailable.text.includes('mtime 1 -> 2'), 'mtime 前后对比呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '绝不把旧前缀当完整快照注入')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'], '读后二次复核 + 关闭句柄')
  } finally {
    await env.close()
  }
})

test('before_turn：读取期间 size 增长 → 显式注入 agents-unavailable', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        text: '0123456789',
        infos: [
          { ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 10, mtimeMs: 1 }) },
          { ok: true, value: fileInfoOf('/srv/app/AGENTS.md', { size: 12, mtimeMs: 2 }) },
        ],
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('读取期间文件发生变化（size 10 -> 12'), 'size 前后对比呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'))
  } finally {
    await env.close()
  }
})

test('before_turn：实读字节数与稳定 size 不一致（短读）→ 显式注入 agents-unavailable', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: {
        text: '0123456789',
        // 默认 info 稳定报 10 字节，但 read 只交回前 7 字节（EOF 撒谎）
        read: (offset, length) => ({
          ok: true,
          value: new TextEncoder().encode('0123456789').subarray(offset, Math.min(offset + length, 7)),
        }),
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('读取到 7 字节与稳定大小 10 不一致'), '短读与稳定大小对比呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '绝不把截断前缀当完整快照注入')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'])
  } finally {
    await env.close()
  }
})

test('before_turn：打开后 info 报错 → 显式注入 agents-unavailable，不读正文', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: (path) => ({
      ok: true,
      value: { infos: [{ ok: false, error: new FileError('unknown', '句柄元信息故障', path) }] },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('（unknown）'), '错误码如实呈现')
    assert.ok(unavailable.text.includes('句柄元信息故障'), '错误消息呈现')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'read'), '不读正文')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'close'])
  } finally {
    await env.close()
  }
})

test('before_turn：读后复核 info 报错 → 显式注入 agents-unavailable', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: (path) => ({
      ok: true,
      value: {
        text: '# 约定\n',
        infos: [
          { ok: true, value: fileInfoOf(path, { size: 5, mtimeMs: 1 }) },
          { ok: false, error: new FileError('unknown', '读后复核故障', path) },
        ],
      },
    }),
  })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('读后复核故障'), '复核错误如实呈现')
    assert.ok(!sections.some((s) => s.id === 'profile.agents'))
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'])
  } finally {
    await env.close()
  }
})

test('before_turn：close 抛错 → 显式注入 agents-unavailable（脱敏），绝不静默丢句柄错误', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({
    openBinaryReader: () => ({
      ok: true,
      value: { text: '# 约定\n', closeError: new Error('close 失败 SECRET_c1') },
    }),
  })
  const env = await makeEnv(workspace, {
    redact: (text) => text.replaceAll('SECRET_c1', '[REDACTED]'),
    envFor: () => remoteEnv,
  })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const unavailable = sections.find((s) => s.id === 'profile.agents-unavailable')!
    assert.ok(unavailable.text.includes('close 失败'), '关闭错误如实呈现')
    assert.ok(unavailable.text.includes('[REDACTED]'), '关闭错误消息脱敏')
    assert.ok(!unavailable.text.includes('SECRET_c1'))
    assert.ok(!sections.some((s) => s.id === 'profile.agents'), '句柄关闭失败不注入正文')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'])
  } finally {
    await env.close()
  }
})

test('before_turn：read 请求长度恒为上限+1（有界），多回合重复读取同样受限', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const remoteEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text: '# 稳定约定\n' } }) })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    assert.deepEqual(readCallLengths(remoteEnv), [MAX_AGENTS_MD_BYTES + 1, MAX_AGENTS_MD_BYTES + 1], '每次读取恰好请求上限+1 字节')
    assert.ok(readCallLengths(remoteEnv).every((l) => l <= MAX_AGENTS_MD_BYTES + 1), '任何读取请求都不超过上限+1')
    assert.ok(!remoteEnv.calls.some((c) => c.op === 'readTextFile' || c.op === 'fileInfo'), '无 readTextFile / fileInfo 调用')
  } finally {
    await env.close()
  }
})

test('before_turn：稳定多字节内容按 UTF-8 解码后逐字注入', { timeout: 60_000 }, async () => {
  const workspace = '/srv/app'
  const text = '# 约定 𠮷 中文 emoji 🚀 конец\n'
  const remoteEnv = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text } }) })
  const env = await makeEnv(workspace, { envFor: () => remoteEnv })
  try {
    const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
    const agents = sections.find((s) => s.id === 'profile.agents')!
    const body = agents.text.slice(
      `<project_instructions path="/srv/app/AGENTS.md">\n`.length,
      agents.text.length - '\n</project_instructions>'.length,
    )
    assert.equal(body, text, '多字节字符 UTF-8 解码逐字保真')
    assert.deepEqual(opsOf(remoteEnv), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'], '完整同句柄管线')
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

test('computeAgentsMdSection：executionEnv 未接线（unsupported）→ 显式注入不可用段', { timeout: 60_000 }, async () => {
  const host: AgentsMdHostPort = {
    executionEnv() {
      throw new HelmxError('unsupported', '测试夹具未实现宿主能力：host.executionEnv（需在具体 fixture 覆写）', 501)
    },
    redact: (t) => t,
    nodeIpc: { isOnline: () => true },
  }
  const result = await computeAgentsMdSection(host, 'remote-1', '/srv/app')
  assert.equal(result.kind, 'section')
  if (result.kind !== 'section') return
  assert.equal(result.id, 'profile.agents-unavailable')
  assert.ok(result.text.includes('（unsupported）'), '错误码如实呈现')
  assert.ok(result.text.includes('host.executionEnv'), '错误消息如实呈现')
})

test('computeAgentsMdSection：打开阶段 not_found / is_directory（含 EISDIR 消息）→ 按常态不注入', { timeout: 60_000 }, async () => {
  const hostOfOpenError = (code: FileErrorCode, message: string): AgentsMdHostPort =>
    hostOf(
      fakeEnv({
        openBinaryReader: (path) => ({ ok: false, error: new FileError(code, message, path) }),
      }),
    )
  assert.deepEqual(await computeAgentsMdSection(hostOfOpenError('not_found', 'ENOENT: no such file'), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(await computeAgentsMdSection(hostOfOpenError('is_directory', 'EISDIR: illegal operation'), 'remote-1', '/srv/app'), { kind: 'none' })
  // 错误码非 is_directory 但消息含 EISDIR 同样按目录处理
  const eisdir = hostOf(
    fakeEnv({
      openBinaryReader: (path) => ({ ok: false, error: new FileError('unknown', 'EISDIR: read', path) }),
    }),
  )
  assert.deepEqual(await computeAgentsMdSection(eisdir, 'remote-1', '/srv/app'), { kind: 'none' })
})

test('computeAgentsMdSection：canonicalPath 报目录 / 悬空软链（not_found）→ 常态不注入，不打开句柄', { timeout: 60_000 }, async () => {
  // 悬空软链（canonicalPath not_found，与文件不存在同口径）
  const danglingEnv = fakeEnv({
    canonicalPath: (path) => ({ ok: false, error: new FileError('not_found', 'ENOENT: no such file or directory', path) }),
  })
  assert.deepEqual(await computeAgentsMdSection(hostOf(danglingEnv), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(opsOf(danglingEnv), ['canonicalPath'], '悬空软链在路径解析处短路')

  // canonicalPath 其他错误（如权限）显式不可读
  const refusedEnv = fakeEnv({
    canonicalPath: (path) => ({ ok: false, error: new FileError('permission_denied', 'EACCES: realpath', path) }),
  })
  const refused = await computeAgentsMdSection(hostOf(refusedEnv), 'remote-1', '/srv/app')
  assert.equal(refused.kind, 'section')
  if (refused.kind !== 'section') return
  assert.equal(refused.id, 'profile.agents-unavailable')
  assert.ok(refused.text.includes('解析工作区 /srv/app/AGENTS.md 真实路径失败（permission_denied）'), '解析失败如实呈现')
})

test('computeAgentsMdSection：纯空白正文 → 不注入（同句柄稳定读取后判定）', { timeout: 60_000 }, async () => {
  const env = fakeEnv({ openBinaryReader: () => ({ ok: true, value: { text: '   \n\t\n' } }) })
  assert.deepEqual(await computeAgentsMdSection(hostOf(env), 'remote-1', '/srv/app'), { kind: 'none' })
  assert.deepEqual(opsOf(env), ['canonicalPath', 'openBinaryReader', 'info', 'read', 'info', 'close'], '空白判定仍走完整有界管线')
})

test('computeAgentsMdSection：远端在线预检异常显式注入不可用段并脱敏', { timeout: 60_000 }, async () => {
  const host: AgentsMdHostPort = {
    executionEnv() {
      throw new Error('在线预检失败后不应继续访问执行环境')
    },
    redact: (text) => text.replaceAll('SECRET_probe', '[REDACTED]'),
    nodeIpc: {
      isOnline() {
        throw new Error('探测失败 SECRET_probe')
      },
    },
  }
  const result = await computeAgentsMdSection(host, 'remote-1', '/srv/app')
  assert.equal(result.kind, 'section')
  if (result.kind !== 'section') return
  assert.equal(result.id, 'profile.agents-unavailable')
  assert.ok(result.text.includes('在线状态失败（unknown）'))
  assert.ok(result.text.includes('[REDACTED]'))
  assert.ok(!result.text.includes('SECRET_probe'))
})
