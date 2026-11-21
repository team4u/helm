/**
 * builtin:profile 节点技能库测试（真 PluginHost + 真文件系统 for local；
 * 远端用受控 executionEnv / isOnline 桩验证跨节点契约）。
 *
 * 覆盖（对齐需求验收重点）：
 * - 发现：`.helmx/skills` 缺失属常态（空目录，不注入不可用段）；正常技能
 *   （SKILL.md + references 嵌套）进 catalog；隐藏 / node_modules /
 *   __pycache__ / dist 跳过；非法 id 目录、无 SKILL.md、frontmatter 非法
 *   跳过；SKILL.md 超 MAX_NODE_SKILL_FILE_BYTES / 条目数超上限显式
 *   unavailable；managedByPlugin 强制剥离（节点文件不得冒充受管技能）；
 * - 同名优先级契约：Hub dataDir 技能 > 节点技能；同名时 catalog 只出现
 *   Hub 版本、load_skill 永远读到 Hub 内容（无来源参数，不可绕过）；
 * - 会话节点隔离：catalog / load_skill 均按会话自身 (nodeId, cwd)；
 * - load_skill：节点 SKILL.md 与 references 的精确读取；path 穿越 /
 *   绝对路径 / 反斜杠拒绝（400）；节点不存在 → 404；Profile 白名单外 →
 *   403 skill_not_available（与 Hub 技能同规则）；
 * - 更新下一回合生效：修改节点 SKILL.md 后下一 before_turn 的 catalog 与
 *   load_skill 都反映最新内容（无缓存、不回写历史上下文）；
 * - 显式诊断（绝不静默降级）：远端离线（isOnline === false，不进入
 *   executionEnv）与 isOnline 抛错 → before_turn 注入
 *   profile.node-skills-unavailable 段；load_skill 抛 409 node_offline；
 *   listDir permission_denied → 显式 unavailable / 502
 *   node_skill_read_failed；读取期间文件变化（同句柄复核）→ 显式拒绝；
 * - 有界安全读取纪律：canonicalPath + openBinaryReader({ noFollow: true })
 *   同句柄 info/read/close，read 至多请求 MAX_NODE_SKILL_FILE_BYTES + 1。
 * runner: tsx --test；每项 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HelmxError, type ConversationSummary, type SkillSummary } from '@helmx/protocol'
import {
  FileError,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type Result,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { ProfileService } from '../../kernel/src/services/index.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { createProfilePlugin } from '../src/profile.js'
import {
  MAX_NODE_SKILL_FILE_BYTES,
  MAX_NODE_SKILLS,
  NODE_SKILLS_RELATIVE_DIR,
  scanNodeSkills,
} from '../src/profile/node-skills.js'
import type { NodeSkillsHostPort } from '../src/profile/node-skills.js'
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
  conversations: Map<number, ConversationSummary>
}

interface BackendOptions {
  /** 远端在线判定（local 恒不调用）；缺省恒在线。 */
  online?: (nodeId: string) => boolean
  /** executionEnv 工厂：缺省真实 NodeExecutionEnv（真文件系统）。 */
  envFor?: (nodeId: string, cwd: string) => ExecutionEnv
  redact?: (text: string) => string
}

function makeBackend(opts: BackendOptions = {}): ControlledBackend {
  const envCalls: EnvCall[] = []
  const conversations = new Map<number, ConversationSummary>()
  return {
    ...createPluginHostBackendFixture(),
    envCalls,
    conversations,
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
    getConversation(id: number) {
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
  }
}

interface Env {
  dataDir: string
  host: PluginHost
  backend: ControlledBackend
  close(): Promise<void>
}

async function makeEnv(opts: BackendOptions = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-node-skills-'))
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
    host,
    backend,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
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

/** 触发 load_skill 并断言成功返回 { text }。 */
async function loadSkillOk(env: Env, conversationId: number, input: { skillId: string; path?: string }): Promise<string> {
  const result = (await env.host.executeTool('load_skill', input, { conversationId })) as { text: string }
  assert.ok(typeof result.text === 'string')
  return result.text
}

/** 触发 load_skill 并断言失败，返回 HelmxError（经 assertRejectsCode 同源校验）。 */
async function loadSkillErr(env: Env, conversationId: number, input: { skillId: string; path?: string }): Promise<HelmxError> {
  try {
    await env.host.executeTool('load_skill', input, { conversationId })
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    return err
  }
  assert.fail('expected load_skill to throw')
}

function skillSection(sections: Array<{ id: string; text: string }>): string | undefined {
  return sections.find((s) => s.id === 'profile.skills')?.text
}

/** 在工作区写入一个节点技能（返回技能目录绝对路径）。 */
function writeNodeSkill(
  workspace: string,
  id: string,
  skillMd: string,
  references: Record<string, string> = {},
): string {
  const dir = join(workspace, NODE_SKILLS_RELATIVE_DIR, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  for (const [rel, content] of Object.entries(references)) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

/** 在 Hub dataDir 写入一个技能（同名优先级的高优先级侧）。 */
function writeHubSkill(dataDir: string, id: string, skillMd: string): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
}

const SKILL_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

// ---------------------------------------------------------------------------
// scanNodeSkills 单元面（不经 PluginHost）
// ---------------------------------------------------------------------------

test('scanNodeSkills: workspace without .helmx/skills is an ordinary empty (ok, no diagnostics)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  assert.deepEqual((scan as { skills: SkillSummary[] }).skills, [])
})

test('scanNodeSkills: empty cwd resolves to empty without touching any node', { timeout: 60_000 }, async (t) => {
  let envCreated = false
  const host: NodeSkillsHostPort = {
    executionEnv: () => {
      envCreated = true
      throw new Error('must not be reached')
    },
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'remote-1', '')
  assert.equal(scan.kind, 'ok')
  assert.deepEqual((scan as { skills: SkillSummary[] }).skills, [])
  assert.ok(!envCreated)
})

// ---------------------------------------------------------------------------
// before_turn catalog 注入（发现 / 同名优先级 / 隔离 / 显式诊断）
// ---------------------------------------------------------------------------

test('before_turn injects node skills into the available_skills catalog (source node, nested references)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'deploy-helper', SKILL_MD('Deploy Helper', 'Node-local deploy runbook'), {
    'references/runbook.md': '# runbook\nstep 1\n',
    'references/advanced/tuning.md': '# tuning\n',
  })
  // 常态跳过面：隐藏目录、依赖产物目录、非法 id、无 SKILL.md、frontmatter 非法。
  writeNodeSkill(workspace, '.hidden-skill', SKILL_MD('hidden', 'should be skipped'))
  const nodeModulesDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'in-node-modules', 'node_modules', 'x')
  mkdirSync(nodeModulesDir, { recursive: true })
  writeFileSync(join(nodeModulesDir, 'SKILL.md'), SKILL_MD('x', 'x'))
  const badIdDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'bad id with spaces')
  mkdirSync(badIdDir, { recursive: true })
  writeFileSync(join(badIdDir, 'SKILL.md'), SKILL_MD('bad', 'id'))
  const noSkillMdDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'no-skill-md')
  mkdirSync(noSkillMdDir, { recursive: true })
  writeFileSync(join(noSkillMdDir, 'README.md'), 'not a skill')
  const brokenDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'broken-frontmatter')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'SKILL.md'), '---\nmanagedByPlugin:\n---\nbody\n')

  const env = await makeEnv()
  t.after(() => env.close())
  const sections = await runBeforeTurn(env, makeTurn(workspace))
  const catalog = skillSection(sections)
  assert.ok(catalog !== undefined, 'catalog section present (helmx-cli + node skill)')
  assert.ok(catalog.includes('<skill id="deploy-helper">'), 'node skill listed')
  assert.ok(catalog.includes('<name>Deploy Helper</name>'))
  assert.ok(catalog.includes('<description>Node-local deploy runbook</description>'))
  assert.ok(catalog.includes('<references>references/advanced/tuning.md, references/runbook.md</references>'))
  for (const missing of ['.hidden-skill', 'in-node-modules', 'bad id', 'no-skill-md', 'broken-frontmatter']) {
    assert.ok(!catalog.includes(missing), `skipped entry not in catalog: ${missing}`)
  }
  assert.ok(sections.every((s) => s.id !== 'profile.node-skills-unavailable'), 'no unavailable section for ordinary states')
})

test('node SKILL.md managedByPlugin is stripped — the node cannot fake a host-managed skill', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'fake-managed', '---\nname: Fake\nmanagedByPlugin: builtin:profile\n---\nbody\n')
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  const skill = (scan as { skills: SkillSummary[] }).skills.find((s) => s.id === 'fake-managed')
  assert.ok(skill !== undefined)
  assert.ok(skill.managedByPlugin === undefined, 'managedByPlugin must be stripped from node skills')
  assert.equal(skill.source, 'node')
})

test('same-name priority: Hub dataDir skill wins the catalog and load_skill; the node version is unreachable', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'shared-name', SKILL_MD('Node Variant', 'node description must not surface'))
  const env = await makeEnv()
  t.after(() => env.close())
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub description wins'))
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog !== undefined)
  assert.ok(catalog.includes('<skill id="shared-name">'))
  assert.ok(catalog.includes('Hub Variant') && catalog.includes('hub description wins'))
  assert.ok(!catalog.includes('Node Variant') && !catalog.includes('node description must not surface'), 'node variant never surfaces')

  const text = await loadSkillOk(env, 1, { skillId: 'shared-name' })
  assert.ok(text.includes('Hub Variant'), 'load_skill resolves the Hub version (highest priority)')
  assert.ok(!text.includes('Node Variant'))
  // load_skill 的 Hub 分支不触达节点执行环境（before_turn 的节点扫描除外，次数不因 load_skill 增加）。
  const callsAfterCatalog = env.backend.envCalls.length
  await loadSkillOk(env, 1, { skillId: 'shared-name' })
  assert.equal(env.backend.envCalls.length, callsAfterCatalog, 'Hub-resolved load_skill never touches the node env')
})

test('node skills are isolated per conversation (nodeId, cwd) — another workspace never sees them', { timeout: 60_000 }, async (t) => {
  const wsA = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  const wsB = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  })
  writeNodeSkill(wsA, 'ws-a-only', SKILL_MD('A Only', 'from workspace A'))
  const env = await makeEnv()
  t.after(() => env.close())

  const catalogA = skillSection(await runBeforeTurn(env, makeTurn(wsA)))
  const catalogB = skillSection(await runBeforeTurn(env, makeTurn(wsB)))
  assert.ok(catalogA?.includes('ws-a-only'))
  assert.ok(!catalogB?.includes('ws-a-only'), 'workspace B catalog must not list workspace A node skills')
})

test('remote node skills route through executionEnv(nodeId, cwd) with an online precheck', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'remote-skill', SKILL_MD('Remote Skill', 'lives on the remote node'))
  let onlineChecked: string[] = []
  const env = await makeEnv({ online: (nodeId) => (onlineChecked.push(nodeId), true) })
  t.after(() => env.close())

  const turn = makeTurn(workspace, { nodeId: 'remote-1' })
  const catalog = skillSection(await runBeforeTurn(env, turn))
  assert.ok(catalog?.includes('remote-skill'))
  // 同一回合内节点技能扫描与 AGENTS.md 读取都会预检在线状态，均以目标节点为参。
  assert.ok(onlineChecked.length >= 1 && onlineChecked.every((id) => id === 'remote-1'))
  assert.ok(env.backend.envCalls.length >= 1)
  assert.deepEqual(env.backend.envCalls[0], { nodeId: 'remote-1', cwd: workspace })
})

test('remote node offline: explicit unavailable section (never silently empty), load_skill fails node_offline', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'remote-skill', SKILL_MD('Remote Skill', 'unreachable while offline'))
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace, nodeId: 'remote-1' }))

  const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined, 'offline state injects an explicit unavailable section')
  assert.ok(unavailable.text.includes('<node_skills_unavailable'))
  assert.ok(unavailable.text.includes('remote-1'))
  assert.ok(unavailable.text.includes('离线'))
  // 离线即止步：绝不进入 executionEnv（远端 RPC 会阻塞在重连窗口）。
  assert.deepEqual(env.backend.envCalls, [])

  const err = await loadSkillErr(env, 1, { skillId: 'remote-skill' })
  assert.equal(err.code, 'node_offline')
  assert.equal(err.status, 409)
})

test('isOnline throwing (unwired host capability) is stated explicitly, never treated as online', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const env = await makeEnv({
    online: () => {
      throw new HelmxError('node_ipc_unavailable', '测试桩未接线 nodeIpc', 501)
    },
  })
  t.after(() => env.close())

  const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined)
  assert.ok(unavailable.text.includes('node_ipc_unavailable'))
})

// ---------------------------------------------------------------------------
// load_skill：节点分支精确读取 / 边界拒绝 / 白名单 / 更新生效
// ---------------------------------------------------------------------------

test('load_skill reads node SKILL.md and references precisely (latest node content, no cache)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const dir = writeNodeSkill(
    workspace,
    'node-tool',
    SKILL_MD('Node Tool', 'v1 description'),
    { 'references/guide.md': '# guide v1\n' },
  )
  const env = await makeEnv()
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const md = await loadSkillOk(env, 1, { skillId: 'node-tool' })
  assert.ok(md.includes('# Node Tool'))
  const guide = await loadSkillOk(env, 1, { skillId: 'node-tool', path: 'references/guide.md' })
  assert.equal(guide, '# guide v1\n')

  // 节点事实来源更新：下一回合 catalog 与 load_skill 都反映最新内容（不回写历史）。
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('Node Tool', 'v2 description'))
  writeFileSync(join(dir, 'references', 'guide.md'), '# guide v2\n')
  const md2 = await loadSkillOk(env, 1, { skillId: 'node-tool' })
  assert.ok(md2.includes('v2 description'))
  const guide2 = await loadSkillOk(env, 1, { skillId: 'node-tool', path: 'references/guide.md' })
  assert.equal(guide2, '# guide v2\n')
  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog?.includes('v2 description'))
})

test('load_skill rejects traversal / absolute / backslash paths on the node branch (400)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  const env = await makeEnv()
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  for (const path of ['../outside.md', 'references/../../outside.md', '/etc/passwd', 'a\\b.md']) {
    const err = await loadSkillErr(env, 1, { skillId: 'node-tool', path })
    assert.equal(err.code, 'validation_error', `path=${path}`)
    assert.equal(err.status, 400)
  }
})

test('load_skill on a node skill missing everywhere is a plain 404 (no fabrication)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const env = await makeEnv()
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const err = await loadSkillErr(env, 1, { skillId: 'never-exists' })
  assert.equal(err.code, 'not_found')
  assert.equal(err.status, 404)
})

test('Profile whitelist applies to node skills with the same rule as Hub skills (403 outside)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  writeNodeSkill(workspace, 'node-other', SKILL_MD('Node Other', 'd'))
  const env = await makeEnv()
  t.after(() => env.close())
  const assistant = await (env.backend as unknown as { profiles: { get(id: string): Promise<unknown> } }).profiles.get('assistant')
  assert.ok(assistant !== undefined)
  // 通过宿主 profiles 端口保存白名单（只允许 node-tool）。
  const profilesPort = (env.backend as unknown as { profiles: { save(p: unknown): Promise<unknown> } }).profiles
  await profilesPort.save({ ...(assistant as object), skills: ['node-tool'] })
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace }))

  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog?.includes('node-tool'))
  assert.ok(!catalog?.includes('node-other'), 'non-whitelisted node skill filtered from catalog')

  const okText = await loadSkillOk(env, 1, { skillId: 'node-tool' })
  assert.ok(okText.includes('# Node Tool'))
  const err = await loadSkillErr(env, 1, { skillId: 'node-other' })
  assert.equal(err.code, 'skill_not_available')
  assert.equal(err.status, 403)
})

// ---------------------------------------------------------------------------
// 显式故障面：listDir 权限错误 / 超限 / 读取期间变化
// ---------------------------------------------------------------------------

/** Path separator that matches the path's own shape (POSIX / Windows targets both safe). */
function sepLike(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** 受控执行环境：委托真实 NodeExecutionEnv，但可覆写 listDir / openBinaryReader 应答。 */
function controlledEnv(workspace: string, over: {
  listDir?: (path: string) => Result<FileInfo[], FileError>
  wrapReader?: (path: string, reader: BinaryReader) => BinaryReader
}): ExecutionEnv {
  const real = new NodeExecutionEnv({ cwd: workspace })
  const env: ExecutionEnv = {
    id: real.id,
    cwd: real.cwd,
    absolutePath: (p, c) => real.absolutePath(p, c),
    joinPath: (p, c) => real.joinPath(p, c),
    readTextFile: (p, c) => real.readTextFile(p, c),
    openTextLineReader: (p, c) => real.openTextLineReader(p, c),
    readTextLines: (p, o, c) => real.readTextLines(p, o, c),
    readBinaryFile: (p, c) => real.readBinaryFile(p, c),
    openBinaryReader: async (p, o, c) => {
      const opened = await real.openBinaryReader(p, o, c)
      if (!opened.ok || over.wrapReader === undefined) return opened
      return { ok: true, value: over.wrapReader(p, opened.value) }
    },
    writeFile: (p, x, c) => real.writeFile(p, x, c),
    appendFile: (p, x, c) => real.appendFile(p, x, c),
    truncateFile: (p, s, c) => real.truncateFile(p, s, c),
    flushFile: (p, c) => real.flushFile(p, c),
    renameFile: (s, d, c) => real.renameFile(s, d, c),
    fileInfo: (p, c) => real.fileInfo(p, c),
    listDir: async (p, c) => (over.listDir ? over.listDir(p) : real.listDir(p, c)),
    openDirReader: (p, c) => real.openDirReader(p, c),
    watch: (tg, o, c) => real.watch(tg, o, c),
    canonicalPath: (p, c) => real.canonicalPath(p, c),
    exists: (p, c) => real.exists(p, c),
    createDir: (p, o, c) => real.createDir(p, o, c),
    remove: (p, o, c) => real.remove(p, o, c),
    createTempDir: (p, c) => real.createTempDir(p, c),
    createTempFile: (o, c) => real.createTempFile(o, c),
    cleanup: (c) => real.cleanup(c),
    async exec() {
      throw new Error('not needed in this test')
    },
  }
  return env
}

test('listDir permission failure surfaces as an explicit unavailable section (never silent empty)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  const env = await makeEnv({
    envFor: (nodeId, cwd) =>
      controlledEnv(workspace, {
        listDir: (path) =>
          path.split(sepLike(path)).includes('skills') && path.includes('.helmx')
            ? { ok: false, error: new FileError('permission_denied', 'EACCES: permission denied', path) }
            : { ok: true, value: [] as FileInfo[] },
      }),
  })
  t.after(() => env.close())

  const sections = await runBeforeTurn(env, makeTurn(workspace, { nodeId: 'remote-1' }))
  const unavailable = sections.find((s) => s.id === 'profile.node-skills-unavailable')
  assert.ok(unavailable !== undefined)
  assert.ok(unavailable.text.includes('permission_denied'))
  // Hub 技能目录照常注入（仅节点来源显式缺失）。
  assert.ok(skillSection(sections) !== undefined)
})

test('oversized SKILL.md (over MAX_NODE_SKILL_FILE_BYTES) fails the scan explicitly', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const dir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'huge-skill')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), 'x'.repeat(MAX_NODE_SKILL_FILE_BYTES + 1))
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'unavailable')
  assert.ok((scan as { reason: string }).reason.includes('huge-skill'))
})

test('exceeding MAX_NODE_SKILLS entries fails the scan explicitly (no silent truncation)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  for (let i = 0; i <= MAX_NODE_SKILLS; i++) {
    writeNodeSkill(workspace, `s${i.toString().padStart(4, '0')}`, SKILL_MD(`s${i}`, 'd'))
  }
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'unavailable')
  assert.ok((scan as { reason: string }).reason.includes(String(MAX_NODE_SKILLS)))
})

test('a node skill directory that is a symlink is skipped (never followed)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const real = writeNodeSkill(workspace, 'real-skill', SKILL_MD('Real', 'd'))
  const linkDir = join(workspace, NODE_SKILLS_RELATIVE_DIR, 'linked-skill')
  mkdirSync(join(workspace, NODE_SKILLS_RELATIVE_DIR), { recursive: true })
  symlinkSync(real, linkDir)
  const host: NodeSkillsHostPort = {
    executionEnv: (nodeId, cwd) => new NodeExecutionEnv({ cwd }),
    redact: (text) => text,
    nodeIpc: { isOnline: () => true },
  }
  const scan = await scanNodeSkills(host, 'local', workspace)
  assert.equal(scan.kind, 'ok')
  const ids = (scan as { skills: SkillSummary[] }).skills.map((s) => s.id)
  assert.ok(ids.includes('real-skill'))
  assert.ok(!ids.includes('linked-skill'), 'symlinked skill dir is listed as symlink and skipped')
})

test('load_skill on the node branch reports a mid-read size change explicitly (502)', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'node-tool', SKILL_MD('Node Tool', 'd'))
  // 受控 reader：第二次 info（读后复核）前改写文件——同句柄复核必须显式拒绝，
  // 绝不把旧前缀当完整快照返回。
  const env = await makeEnv({
    envFor: (nodeId, cwd) =>
      controlledEnv(workspace, {
        wrapReader: (path, reader): BinaryReader => {
          if (!path.endsWith('SKILL.md')) return reader
          let infoCalls = 0
          return {
            info: async (ctx) => {
              infoCalls += 1
              // 第二次 info（读后复核）前先改写文件，再取同句柄元信息：
              // size/mtime 与读前不一致必须被显式拒绝。
              if (infoCalls === 2) {
                writeFileSync(path, SKILL_MD('Node Tool', 'changed mid-read'))
              }
              return reader.info(ctx)
            },
            read: (offset, length, ctx) => reader.read(offset, length, ctx),
            scanLines: (options2, ctx) => reader.scanLines(options2, ctx),
            close: (ctx) => reader.close(ctx),
          }
        },
      }),
  })
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: workspace, nodeId: 'remote-1' }))

  const err = await loadSkillErr(env, 1, { skillId: 'node-tool' })
  assert.equal(err.code, 'node_skill_read_failed')
  assert.equal(err.status, 502)
  assert.ok(err.message.includes('变化') || err.message.includes('size'), `diagnostic mentions the mid-read change: ${err.message}`)
})

test('node catalog name/description are redacted before entering the system prompt', { timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeNodeSkill(workspace, 'leaky', '---\nname: leaky\ndescription: token sk-secret-value inside\n---\nbody\n')
  const env = await makeEnv({ redact: (text) => text.replace(/sk-secret-value/g, '[REDACTED]') })
  t.after(() => env.close())

  const catalog = skillSection(await runBeforeTurn(env, makeTurn(workspace)))
  assert.ok(catalog !== undefined)
  assert.ok(catalog.includes('[REDACTED]'))
  assert.ok(!catalog.includes('sk-secret-value'))
})

// ---------------------------------------------------------------------------
// 坐标作用域 action：skill_catalog / skill_read（scope ACL + 输入边界）
// ---------------------------------------------------------------------------

/** 触发 action 并断言失败，返回 HelmxError（与 loadSkillErr 同源校验）。 */
async function actionErr(
  env: Env,
  actionId: 'skill_catalog' | 'skill_read',
  input: unknown,
  context?: { conversationId: number },
): Promise<HelmxError> {
  try {
    await env.host.invokeAction('builtin:profile', actionId, input, context)
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
    return err
  }
  assert.fail(`expected action ${actionId} to throw`)
}

test('skill_catalog / skill_read action manifests: exposeToPrompt:false, scope excludes sessions, idempotent, no cli.command override', { timeout: 60_000 }, async (t) => {
  const env = await makeEnv()
  t.after(() => env.close())
  const manifests = env.host
    .listActions()
    .filter((m) => m.pluginId === 'builtin:profile' && (m.id === 'skill_catalog' || m.id === 'skill_read'))
  assert.equal(manifests.length, 2, 'both actions declared on the enabled plugin')
  for (const manifest of manifests) {
    // exposeToPrompt:false 由内核 renderActionDirectory 统一跳过（kernel 通用行为已由
    // kernel 测试锁定），此处锁定 manifest 结构不变量：不进 <available_actions> 目录。
    assert.equal(manifest.exposeToPrompt, false, `${manifest.id} must stay out of the model prompt catalog`)
    // scope:{conversationIds:[]} 是真正的 ACL：显式空数组排除一切带 conversationId 的调用
    // （run_action / workflow / HTTP body.conversationId）——模型连 manifest 都拿不到。
    assert.deepEqual(manifest.scope, { conversationIds: [] }, `${manifest.id} excludes every session-context call`)
    assert.equal(manifest.idempotent, true, `${manifest.id} is a read-only idempotent action`)
    assert.notEqual(manifest.exposeAsTool, true, `${manifest.id} is not a direct tool`)
    assert.equal(manifest.cli, undefined, `${manifest.id} keeps the default dynamic CLI path (no skills list/read conflict)`)
  }
})

test('scope ACL: every conversation-carrying call is rejected 403 before the handler (run_action / workflow / HTTP body.conversationId paths)', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'ws-skill', SKILL_MD('WS Skill', 'never reached through a session context'))
  const env = await makeEnv()
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: ws }))

  // 会话上下文（无论是否携带显式坐标）一律 403——会话坐标绑定路径已按安全裁定移除
  for (const input of [{}, { nodeId: 'local' }, { nodeId: 'local', cwd: ws }]) {
    const err = await actionErr(env, 'skill_catalog', input, { conversationId: 1 })
    assert.equal(err.code, 'conversation_scope_violation', `session-context call rejected: ${JSON.stringify(input)}`)
    assert.equal(err.status, 403)
  }
  const steered = await actionErr(env, 'skill_read', { skillId: 'ws-skill', nodeId: 'local', cwd: ws }, { conversationId: 1 })
  assert.equal(steered.code, 'conversation_scope_violation')
  assert.equal(steered.status, 403)
  // 失效会话目标 → scope 判定前 getConversation 显式 404（不猜测）
  const missing = await actionErr(env, 'skill_catalog', {}, { conversationId: 404 })
  assert.equal(missing.code, 'not_found')
})

test('skill_catalog: context-free calls require the explicit pair; relative cwd, extra properties and unregistered nodeIds are rejected', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'explicit-skill', SKILL_MD('Explicit', 'discovered via explicit coordinates'))
  // 默认桩对一切 nodeId 报在线；显式关闭后 ghost-node 在边界被拒（local 恒不查 isOnline）
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close())

  for (const input of [{}, { nodeId: 'local' }, { cwd: ws }]) {
    const err = await actionErr(env, 'skill_catalog', input)
    assert.equal(err.code, 'validation_error', `missing half of the pair rejected: ${JSON.stringify(input)}`)
  }
  const relative = await actionErr(env, 'skill_catalog', { nodeId: 'local', cwd: 'relative/path' })
  assert.equal(relative.code, 'validation_error')
  assert.ok(relative.message.includes('absolute'))
  const extra = await actionErr(env, 'skill_catalog', { nodeId: 'local', cwd: ws, bogus: true })
  assert.equal(extra.code, 'validation_error', 'input boundary: additionalProperties rejected')
  // 未注册 nodeId（与已断线不可区分）在输入边界显式 400，绝不进入扫描
  const ghost = await actionErr(env, 'skill_catalog', { nodeId: 'ghost-node', cwd: ws })
  assert.equal(ghost.code, 'validation_error')
  assert.ok(ghost.message.includes('not currently registered'), `honest registration diagnostic: ${ghost.message}`)
  assert.deepEqual(env.backend.envCalls, [], 'an unregistered nodeId never reaches executionEnv')

  const catalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'local', cwd: ws })) as {
    nodeId: string
    cwd: string
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
    nodeUnavailable?: string
  }
  assert.equal(catalog.nodeId, 'local')
  assert.equal(catalog.cwd, ws)
  assert.ok(catalog.skills.some((s) => s.id === 'explicit-skill' && s.source === 'node'))
  assert.deepEqual(catalog.shadowedNodeSkillIds, [])
  assert.ok(catalog.nodeUnavailable === undefined)
})

test('skill_catalog: same-name node skill is shadowed — the Hub version stays effective and shadowedNodeSkillIds reports it explicitly', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'shared-name', SKILL_MD('Node Variant', 'node description must not surface'))
  writeNodeSkill(ws, 'node-only', SKILL_MD('Node Only', 'node supplement'))
  const env = await makeEnv()
  t.after(() => env.close())
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub description wins'))

  const catalog = (await env.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'local', cwd: ws })) as {
    skills: SkillSummary[]
    shadowedNodeSkillIds: string[]
  }
  const shared = catalog.skills.find((s) => s.id === 'shared-name')
  assert.ok(shared !== undefined)
  assert.equal(shared.name, 'Hub Variant', 'the Hub version is the effective one')
  assert.notEqual(shared.source, 'node')
  assert.ok(!catalog.skills.some((s) => s.id === 'shared-name' && s.source === 'node'), 'node variant never enters the merged catalog')
  assert.deepEqual(catalog.shadowedNodeSkillIds, ['shared-name'], 'the shadowed node id is reported explicitly')
  assert.ok(catalog.skills.some((s) => s.id === 'node-only' && s.source === 'node'), 'non-shadowed node skills still supplement')
})

test('skill_catalog: an offline remote nodeId is rejected at the input boundary; a post-boundary offline race still surfaces nodeUnavailable', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'remote-skill', SKILL_MD('Remote', 'unreachable while offline'))
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close())
  writeHubSkill(env.dataDir, 'hub-skill', SKILL_MD('Hub Skill', 'hub side'))

  // 未注册/已断线（isOnline 语义下不可区分）→ 输入边界 400，诚实措辞不谎称能区分
  const rejected = await actionErr(env, 'skill_catalog', { nodeId: 'remote-1', cwd: ws })
  assert.equal(rejected.code, 'validation_error')
  assert.ok(rejected.message.includes('not currently registered'))
  assert.deepEqual(env.backend.envCalls, [], 'offline stops before entering executionEnv')

  // TOCTOU 竞态：边界核验时在线、扫描预检时掉线 → 扫描层显式 nodeUnavailable（Hub 目录仍返回）
  let onlineCalls = 0
  const envRace = await makeEnv({ online: () => (onlineCalls += 1) === 1 })
  t.after(() => envRace.close())
  writeHubSkill(envRace.dataDir, 'hub-skill', SKILL_MD('Hub Skill', 'still listed through the race'))
  const catalog = (await envRace.host.invokeAction('builtin:profile', 'skill_catalog', { nodeId: 'remote-1', cwd: ws })) as {
    nodeId: string
    skills: SkillSummary[]
    nodeUnavailable?: string
  }
  assert.equal(onlineCalls, 2, 'boundary precheck + scan precheck are the two registration probes')
  assert.ok(catalog.nodeUnavailable !== undefined, 'the post-boundary race surfaces an explicit diagnostic')
  assert.ok(catalog.nodeUnavailable.includes('remote-1'))
  assert.ok(catalog.skills.some((s) => s.id === 'hub-skill'), 'Hub skills are still returned')
  assert.ok(!catalog.skills.some((s) => s.id === 'remote-skill'))
  assert.deepEqual(envRace.backend.envCalls, [], 'offline stops before entering executionEnv')
})

test('skill_read: Hub hit wins first; node-only ids read live from the node (SKILL.md and references); boundary rejections', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'shared-name', SKILL_MD('Node Variant', 'unreachable node body'))
  writeNodeSkill(ws, 'node-only', SKILL_MD('Node Only', 'node body'), { 'references/guide.md': '# node guide\n' })
  const env = await makeEnv()
  t.after(() => env.close())
  writeHubSkill(env.dataDir, 'shared-name', SKILL_MD('Hub Variant', 'hub body wins'))

  const hubRead = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'shared-name', nodeId: 'local', cwd: ws })) as { text: string }
  assert.ok(hubRead.text.includes('Hub Variant'), 'Hub catalog hit reads the Hub version first')
  assert.ok(!hubRead.text.includes('Node Variant'))
  const callsAfterHubRead = env.backend.envCalls.length
  await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'shared-name', nodeId: 'local', cwd: ws })
  assert.equal(env.backend.envCalls.length, callsAfterHubRead, 'Hub-resolved reads never touch the node env')

  const nodeRead = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'node-only', nodeId: 'local', cwd: ws })) as { text: string }
  assert.ok(nodeRead.text.includes('Node Only'))
  const refRead = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'node-only', path: 'references/guide.md', nodeId: 'local', cwd: ws })) as { text: string }
  assert.ok(refRead.text.includes('# node guide'))

  const notFound = await actionErr(env, 'skill_read', { skillId: 'missing-everywhere', nodeId: 'local', cwd: ws })
  assert.equal(notFound.code, 'not_found')
  assert.equal(notFound.status, 404)
  const traversal = await actionErr(env, 'skill_read', { skillId: 'node-only', path: '../escape.md', nodeId: 'local', cwd: ws })
  assert.equal(traversal.code, 'validation_error')
  assert.equal(traversal.status, 400)
})

test('skill_read: session-context calls are excluded by scope; context-free explicit coordinates are the only path', { timeout: 60_000 }, async (t) => {
  const wsA = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  const wsB = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  })
  writeNodeSkill(wsA, 'ws-a-skill', SKILL_MD('A Skill', 'from workspace A'))
  writeNodeSkill(wsB, 'ws-b-skill', SKILL_MD('B Skill', 'from workspace B'))
  // online:()=>false 使未注册 nodeId 在边界被拒；local 靶点恒不查 isOnline
  const env = await makeEnv({ online: () => false })
  t.after(() => env.close())
  env.backend.conversations.set(1, makeConversation(1, { cwd: wsA }))

  // 会话上下文（无论 body 给什么坐标）一律 403——Profile.skills 白名单语义只归 load_skill
  for (const input of [{ skillId: 'ws-a-skill' }, { skillId: 'ws-b-skill', nodeId: 'local', cwd: wsB }]) {
    const err = await actionErr(env, 'skill_read', input, { conversationId: 1 })
    assert.equal(err.code, 'conversation_scope_violation')
    assert.equal(err.status, 403)
  }

  // 无会话上下文 + 显式成对坐标：人类调用方自由选择靶点（CLI --current 由客户端解析坐标后走此路径）
  const readA = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'ws-a-skill', nodeId: 'local', cwd: wsA })) as { text: string }
  assert.ok(readA.text.includes('from workspace A'))
  const readB = (await env.host.invokeAction('builtin:profile', 'skill_read', { skillId: 'ws-b-skill', nodeId: 'local', cwd: wsB })) as { text: string }
  assert.ok(readB.text.includes('from workspace B'))

  const missingCoords = await actionErr(env, 'skill_read', { skillId: 'ws-b-skill' })
  assert.equal(missingCoords.code, 'validation_error')
  const relative = await actionErr(env, 'skill_read', { skillId: 'ws-b-skill', nodeId: 'local', cwd: 'relative/path' })
  assert.equal(relative.code, 'validation_error')
  const ghost = await actionErr(env, 'skill_read', { skillId: 'ws-b-skill', nodeId: 'ghost-node', cwd: wsB })
  assert.equal(ghost.code, 'validation_error')
  assert.ok(ghost.message.includes('not currently registered'))
})

test('skill_read: an offline race after the boundary still fails explicitly (409 node_offline)', { timeout: 60_000 }, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'helmx-node-skills-ws-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  writeNodeSkill(ws, 'node-tool', SKILL_MD('Node Tool', 'drops offline mid-call'))
  let onlineCalls = 0
  const env = await makeEnv({ online: () => (onlineCalls += 1) === 1 })
  t.after(() => env.close())

  const err = await actionErr(env, 'skill_read', { skillId: 'node-tool', nodeId: 'remote-1', cwd: ws })
  assert.equal(err.code, 'node_offline', 'the read layer keeps its explicit offline semantics for races')
  assert.equal(err.status, 409)
})
