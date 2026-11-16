/**
 * CLI 全链路测试：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界）。
 * 验证：路径/方法/请求体/--json/--current/动态 action schema/错误信封/凭据文件保留键。
 * 模拟的是 HTTP 契约，不宣称真实 Hub 集成（无模型调用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'
import {
  makeCliEnv,
  makeConversationSummary,
  makePluginSummary,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

/**
 * 凭据文件权限断言：非 Windows 严格断言 POSIX 0600；Windows 无 POSIX mode
 * （NTFS 走 ACL，stat.mode 不表达 0600），不断言模式位，仅确认文件存在。
 */
async function assertPrivateCredentialFile(file: string): Promise<void> {
  if (process.platform === 'win32') {
    await fsp.access(file)
    return
  }
  const st = await fsp.stat(file)
  assert.equal(st.mode & 0o777, 0o600)
}

/** 仓库内 tsx/cli 的绝对路径（跨进程子进程执行 TS 入口用），自 testDir 逐级向上解析。 */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('tsx/cli')
}

test('setup/login 换 token 写 0600 cli-token，不碰 providers/pluginSecrets 键', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const credFile = path.join(dir, 'credentials.json')
  const tokenFile = path.join(dir, 'cli-token')
  // 预置服务端结构 + 额外 unknown 键（无旧 cli 键）：登录不得碰这个文件
  const legacyBefore = `${JSON.stringify({ providers: { openai: 'sk-x' }, pluginSecrets: { herdr: 's' }, futureKey: 1 }, null, 2)}\n`
  await fsp.writeFile(credFile, legacyBefore)
  const hub = await startMockHub(
    {
      'POST /api/auth/login': (body) => {
        assert.deepEqual(body, { password: 'pw' })
        return { body: { token: 'tok-1' } }
      },
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['login', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).token, 'tok-1')
  // 登录态落在独立 cli-token（0600），credentials.json 原样不动
  await assertPrivateCredentialFile(tokenFile)
  const saved = JSON.parse(await fsp.readFile(tokenFile, 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-1' })
  assert.equal(await fsp.readFile(credFile, 'utf8'), legacyBefore)
  // env HELM_TOKEN 优先级高于凭据文件
  const r2 = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: 'env-tok' }))
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
})

test('conversations list 降噪查询契约：缺省不带参数、--all 发 all=1、--parent 发 parent=<id>、非法组合拒发', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const listBody: unknown[] = []
  const hub = await startMockHub(
    {
      'GET /api/conversations': () => ({ body: listBody }),
      'GET /api/conversations?all=1': () => ({ body: listBody }),
      'GET /api/conversations?parent=3': () => ({ body: listBody }),
      'GET /api/conversations?parent=3&profileId=worker': () => ({ body: listBody }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  // 缺省：不带任何 query（服务端默认仅顶层）
  const top = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(top.code, 0, top.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations')
  // --all：全量
  const all = await runCliCaptured(['conversations', 'list', '--all', '--json'], env)
  assert.equal(all.code, 0, all.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?all=1')
  // --parent：精确直接子会话
  const parent = await runCliCaptured(['conversations', 'list', '--parent', '3', '--json'], env)
  assert.equal(parent.code, 0, parent.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?parent=3')
  // 与既有过滤维度叠加（query 序列化顺序：parent 先于 profileId，与命令实现一致）
  const combo = await runCliCaptured(['conversations', 'list', '--parent', '3', '--profile', 'worker', '--json'], env)
  assert.equal(combo.code, 0, combo.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?parent=3&profileId=worker')
  // 非法 --parent：客户端直接拒绝，不发起请求
  for (const bad of ['abc', '0', '-1', '2.5']) {
    const res = await runCliCaptured(['conversations', 'list', '--parent', bad, '--json'], env)
    assert.equal(res.code, 1, `--parent ${bad} 应报错`)
    assert.ok(res.err.includes('parent'), `报错应提及 parent：${res.err}`)
  }
  assert.equal(hub.hits.filter((h) => h.path.includes('parent=')).length, 2, '非法 --parent 不得发起请求')
  // --all 与 --parent 互斥：客户端拒绝
  const conflict = await runCliCaptured(['conversations', 'list', '--all', '--parent', '3', '--json'], env)
  assert.equal(conflict.code, 1)
  assert.ok(conflict.err.includes('互斥'), `报错应说明互斥：${conflict.err}`)
})

test('思考档位 CLI 透传：全局部分更新、当前会话覆盖与 Profile 合并', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-thinking-cli-')
  const hub = await startMockHub(
    {
      'PUT /api/models/default': (body) => ({ body }),
      'PATCH /api/conversations/7': (body) => ({ body }),
      'GET /api/profiles/worker': () => ({ body: { id: 'worker', model: 'faux/model', name: 'Worker' } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' })

  const defaults = await runCliCaptured(['models', 'default', '--thinking', 'high', '--json'], env)
  assert.equal(defaults.code, 0, defaults.err)
  assert.deepEqual(JSON.parse(defaults.out), { thinkingLevel: 'high' })

  const conversation = await runCliCaptured(['conversations', 'update', '--current', '--thinking=', '--json'], env)
  assert.equal(conversation.code, 0, conversation.err)
  assert.deepEqual(JSON.parse(conversation.out), { thinkingLevel: '' })

  const profile = await runCliCaptured(['profiles', 'update', 'worker', '--thinking', 'high', '--json'], env)
  assert.equal(profile.code, 0, profile.err)
  assert.deepEqual(JSON.parse(profile.out), { id: 'worker', model: 'faux/model', name: 'Worker', thinkingLevel: 'high' })
})

test('conversations create/send/abort/update/delete 的路径、body 与 --current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': (body) => ({ body: { id: 7, ...(body as object) } }),
      'POST /api/conversations/7/input': (body) => ({ body: { ok: true, echo: body } }),
      'POST /api/conversations/7/abort': () => ({ body: { ok: true } }),
      'PATCH /api/conversations/7': (body) => ({ body: { id: 7, ...(body as object) } }),
      'DELETE /api/conversations/7': () => ({ status: 204 }),
      'DELETE /api/conversations/1': () => ({ status: 409, body: { error: { code: 'conversation_managed_by_plugin', message: '会话由已启用插件托管，禁止删除' } } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const created = await runCliCaptured(['conversations', 'create', '--title', '任务', '--tags', 'a,b', '--model', 'openai/gpt', '--json'], env)
  assert.equal(created.code, 0, created.err)
  assert.equal(JSON.parse(created.out).id, 7)
  const createHit = hub.recorded.hits.find((h) => h.path === '/api/conversations')!
  assert.deepEqual(createHit.body, { title: '任务', tags: ['a', 'b'], model: 'openai/gpt' })

  const sent = await runCliCaptured(['send', '7', '你好 世界', '--when-busy', 'followUp', '--origin', 'agent', '--json'], env)
  assert.equal(sent.code, 0, sent.err)
  const sendHit = hub.recorded.hits.find((h) => h.path === '/api/conversations/7/input')!
  assert.deepEqual(sendHit.body, { text: '你好 世界', whenBusy: 'followUp', origin: 'agent' })

  const sentCurrent = await runCliCaptured(['send', '--current', 'hi', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
  assert.equal(sentCurrent.code, 0, sentCurrent.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/7/input')

  const aborted = await runCliCaptured(['abort', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
  assert.equal(aborted.code, 0, aborted.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/7/abort')

  const updated = await runCliCaptured(['conversations', 'update', '7', '--pinned', '--unread=false', '--json'], env)
  assert.equal(updated.code, 0, updated.err)
  const patchHit = hub.recorded.hits.find((h) => h.method === 'PATCH')!
  assert.deepEqual(patchHit.body, { pinned: true, unread: false })

  // --model 空串 = 清除模型覆盖（PATCH {model:''}）；服务端已支持，CLI 必须能表达
  const cleared = await runCliCaptured(['conversations', 'update', '7', '--model', '', '--json'], env)
  assert.equal(cleared.code, 0, cleared.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
  const clearedInline = await runCliCaptured(['conversations', 'update', '7', '--model=', '--json'], env)
  assert.equal(clearedInline.code, 0, clearedInline.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
  // 正常覆盖仍原样透传
  const overridden = await runCliCaptured(['conversations', 'update', '7', '--model', 'openai/gpt-4o', '--json'], env)
  assert.equal(overridden.code, 0, overridden.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: 'openai/gpt-4o' })

  const deleted = await runCliCaptured(['conversations', 'delete', '7', '--json'], env)
  assert.equal(deleted.code, 0, deleted.err)

  // 通用插件管理权 409 错误信封 -> stderr JSON + 非零退出
  const forbidden = await runCliCaptured(['conversations', 'delete', '1', '--json'], env)
  assert.equal(forbidden.code, 1)
  assert.equal(parseCliError(forbidden).code, 'conversation_managed_by_plugin')
})

test('--current 缺失/非法显式 ID 均显式报错', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const missing = await runCliCaptured(['send', '--current', 'x', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'current_conversation_missing')

  const bad = await runCliCaptured(['send', 'abc', 'x', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_id')

  const none = await runCliCaptured(['abort', '--json'], env)
  assert.equal(none.code, 1)
  assert.equal(parseCliError(none).code, 'missing_conversation_target')
})

test('asks answer 发送 answers JSON 与 expectedStateSeq', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/asks/ask-1/answer': () => ({ body: { askId: 'ask-1', answers: {}, answeredAt: 1 } }),
      'GET /api/asks': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['asks', 'answer', 'ask-1', '--answers', '{"field":"值"}', '--expected-state-seq', '10', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/asks/ask-1/answer')!
  assert.deepEqual(hit.body, { answers: { field: '值' }, expectedStateSeq: 10 })
})

test('skills read 直出 {text}，非 JSON 模式原样文本', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/skills/demo': () => ({ body: { text: '# 标题\n内容' } }),
      'GET /api/skills/demo?path=references%2Fguide.md': () => ({ body: { text: '手册内容' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const text = await runCliCaptured(['skills', 'read', 'demo'], env)
  assert.equal(text.code, 0, text.err)
  assert.ok(text.out.startsWith('# 标题'))

  const sub = await runCliCaptured(['skills', 'read', 'demo', '--path', 'references/guide.md', '--json'], env)
  assert.equal(sub.code, 0, sub.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.path, '/api/skills/demo?path=references%2Fguide.md')
  assert.deepEqual(JSON.parse(sub.out), { text: '手册内容' })
})

test('providers set 发送完整数组；credentials set/delete 使用 REST 路径', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/providers': () => ({ body: [] }),
      'PUT /api/providers': () => ({ body: [] }),
      'GET /api/credentials': () => ({ body: [{ id: 'openai', configured: true }] }),
      'PUT /api/credentials/openai': () => ({ body: { ok: true } }),
      'DELETE /api/credentials/openai': () => ({ status: 204 }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const providers = '[{"id":"gw","protocol":"openai","baseUrl":"https://x","models":["m"],"enabled":true}]'
  const set = await runCliCaptured(['providers', 'set', '--input', providers, '--json'], env)
  assert.equal(set.code, 0, set.err)
  const hit = hub.recorded.hits.find((h) => h.method === 'PUT' && h.path === '/api/providers')!
  assert.ok(Array.isArray(hit.body))

  const cred = await runCliCaptured(['credentials', 'set', 'openai', '--value', 'sk-1', '--json'], env)
  assert.equal(cred.code, 0, cred.err)
  assert.deepEqual(hub.recorded.hits.find((h) => h.path === '/api/credentials/openai')?.body, { value: 'sk-1' })

  const del = await runCliCaptured(['credentials', 'delete', 'openai', '--json'], env)
  assert.equal(del.code, 0, del.err)
})

test('动态 action：schema 转 flag、类型转换、--input 互斥、cli.command 路径、冲突报错', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const manifests = [
    {
      pluginId: 'builtin:test', id: 'task.create', description: '建任务',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, maxTokens: { type: 'number' }, tags: { type: 'array' }, dryRun: { type: 'boolean' } }, required: ['title'] },
      outputSchema: { type: 'object' },
      cli: { command: ['tasks', 'create'] },
    },
    {
      pluginId: 'builtin:triggers', id: 'fire', description: '触发',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
    },
  ]
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/task.create': () => ({ body: { created: true } }),
      'POST /api/actions/builtin%3Atriggers/fire': () => ({ body: { fired: true } }),
    },
    { defaultActions: manifests, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // cli.command 覆盖默认路径
  const r = await runCliCaptured(['tasks', 'create', '--title', 'T', '--max-tokens', '4096', '--tags', '["a"]', '--dry-run', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { created: true })
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/task.create')!
  assert.deepEqual(hit.body, { input: { title: 'T', maxTokens: 4096, tags: ['a'], dryRun: true } })

  // 默认路径 stripBuiltin
  const fire = await runCliCaptured(['triggers', 'fire', '--json'], env)
  assert.equal(fire.code, 0, fire.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/actions/builtin%3Atriggers/fire')

  // --current 附带 conversationId
  const cur = await runCliCaptured(['triggers', 'fire', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '3' })
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: {}, conversationId: 3 })

  // 必填缺失
  const missing = await runCliCaptured(['tasks', 'create', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_required_flag')

  // 未知 flag 拒绝
  const unknown = await runCliCaptured(['tasks', 'create', '--title', 'T', '--bogus', '--json'], env)
  assert.equal(unknown.code, 1)
  assert.equal(parseCliError(unknown).code, 'unknown_flag')

  // --input 与属性 flag 互斥
  const mixed = await runCliCaptured(['tasks', 'create', '--input', '{"title":"x"}', '--title', 'y', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'conflicting_flags')

  // --input 整体提交（含 schema 外字段，服务端校验兜底）
  const whole = await runCliCaptured(['tasks', 'create', '--input', '{"title":"x","extra":1}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: { title: 'x', extra: 1 } })

  // 帮助包含动态命令
  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /tasks create/)
  assert.match(help.out, /triggers fire/)
})

test('动态命令抢占核心路径时核心仍执行；调用动态路径才拒绝', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/actions': () => ({
        body: [
          // 与核心 ["conversations","list"] 全等冲突 + 与 ["asks"] 前缀冲突的父路径声明
          { pluginId: 'builtin:evil', id: 'list', description: '抢占', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: ['conversations', 'list'] } },
          { pluginId: 'builtin:evil', id: 'asks-parent', description: '抢占父路径', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: ['asks'] } },
        ],
      }),
      'GET /api/conversations': () => ({ body: [{ id: 9 }] }),
      'GET /api/asks': () => ({ body: [] }),
      'POST /api/plugins/builtin%3Aevil/disable': () => ({ body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // 核心命令精确匹配即执行：坏插件的冲突声明不得阻断核心管理面（故障隔离）。
  // 即使动态声明了抢占性的父路径 ["asks"]，核心 asks list 仍直接执行、不拉 manifest
  const r = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out)[0]?.id, 9)

  const coreAsks = await runCliCaptured(['asks', 'list', '--json'], env)
  assert.equal(coreAsks.code, 0, coreAsks.err)

  const disable = await runCliCaptured(['plugins', 'disable', 'builtin:evil', '--json'], env)
  assert.equal(disable.code, 0, disable.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aevil/disable')

  // 只有真正解析动态命令（非核心精确匹配）时才拉 manifest 并显式拒绝冲突
  const dyn = await runCliCaptured(['asks', 'bogus', '--json'], env)
  assert.equal(dyn.code, 1)
  assert.equal(parseCliError(dyn).code, 'command_conflict')
})

test('workflows inspect/abort：位置参数映射 runId（动态动作命令）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const manifests = [
    {
      pluginId: 'builtin:workflow', id: 'inspect', description: '查看单个工作流运行详情',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
      cli: { command: ['workflows', 'inspect'], positional: [{ field: 'runId', required: true }] },
    },
    {
      pluginId: 'builtin:workflow', id: 'abort', description: '中止工作流运行',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
      cli: { command: ['workflows', 'abort'], positional: [{ field: 'runId', required: true }] },
    },
  ]
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/inspect': () => ({ body: { run: { id: 'run-1', status: 'completed' } } }),
      'POST /api/actions/builtin%3Aworkflow/abort': () => ({ body: { run: { id: 'run-1', status: 'aborted' } } }),
    },
    { defaultActions: manifests, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const inspect = await runCliCaptured(['workflows', 'inspect', 'run-1', '--json'], env)
  assert.equal(inspect.code, 0, inspect.err)
  const inspectHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/inspect')!
  assert.deepEqual(inspectHit.body, { input: { runId: 'run-1' } })
  assert.equal((JSON.parse(inspect.out) as { run: { status: string } }).run.status, 'completed')

  // 必填位置参数缺失：显式 missing_positional
  const missing = await runCliCaptured(['workflows', 'inspect', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_positional')

  const abort = await runCliCaptured(['workflows', 'abort', 'run-1', '--json'], env)
  assert.equal(abort.code, 0, abort.err)
  const abortHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/abort')!
  assert.deepEqual(abortHit.body, { input: { runId: 'run-1' } })
})

test('artifacts：文本直出、二进制强制 --output、列表走会话端点', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/3/artifacts': () => ({ body: [{ id: 'a1', conversationId: 3, kind: 'upload', name: 'out.txt', path: 'artifacts/3/out.txt', mimeType: 'text/plain', size: 3, createdAt: 0 }] }),
      'GET /api/artifacts/a1/content': (_body, req) => {
        const accept = req.headers['accept'] ?? ''
        void accept
        return { body: 'abc' }
      },
      'GET /api/artifacts/a2/content': () => ({ body: '' }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '3' })

  const list = await runCliCaptured(['artifacts', 'list', '--current', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/3/artifacts')
  assert.equal(JSON.parse(list.out)[0]?.id, 'a1')

  const text = await runCliCaptured(['artifacts', 'get', 'a1'], env)
  assert.equal(text.code, 0, text.err)
  assert.equal(text.out, 'abc\n')
})

test('search、models、plugins、actions list、status', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/search?q=hello%20world': () => ({ body: [{ id: 1 }] }),
      'GET /api/models': () => ({ body: { models: [{ provider: 'openai', modelId: 'gpt', available: true }, { provider: 'anthropic', modelId: 'sonnet', available: true }], thinkingLevels: {} } }),
      'GET /api/models/providers': () => ({ body: [{ id: 'deepseek', name: 'DeepSeek', modelCount: 2, authMethods: [{ type: 'api_key', label: 'API Key' }] }] }),
      'POST /api/models/refresh': (body) => ({
        body: {
          providers: (body as { provider?: string }).provider !== undefined ? [(body as { provider: string }).provider] : [],
          aborted: false,
          errors: {},
          models: [{ provider: 'magpie', modelId: 'magpie-1', available: true }],
          providerCatalog: [],
        },
      }),
      'GET /api/plugins': () => ({ body: [makePluginSummary({ id: 'builtin:profile', name: 'assistant', locked: true })] }),
      'POST /api/plugins/builtin%3Aherdr/disable': () => ({ body: { ok: 1 } }),
      'GET /api/plugins/builtin%3Aherdr/config': () => ({ body: { values: { a: 1 }, schema: {} } }),
      'PUT /api/plugins/builtin%3Aherdr/config': (body) => {
        assert.deepEqual((body as { values: unknown }).values, { a: 2 })
        return { body: { values: { a: 2 }, schema: {} } }
      },
      'GET /api/auth/status': () => ({ body: { configured: true, authenticated: false } }),
      'GET /api/conversations/1': () => ({
        body: makeConversationSummary({ id: 1, title: '助理', cwd: '/', model: 'm', completionSeq: 1, createdAt: 0, updatedAt: 0 }),
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const s = await runCliCaptured(['search', 'hello', 'world', '--json'], env)
  assert.equal(s.code, 0, s.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/search?q=hello%20world')

  const m = await runCliCaptured(['models', 'list', '--json'], env)
  assert.equal(m.code, 0, m.err)
  assert.deepEqual(JSON.parse(m.out), { models: [{ provider: 'openai', modelId: 'gpt', available: true }, { provider: 'anthropic', modelId: 'sonnet', available: true }], thinkingLevels: {} })

  const providers = await runCliCaptured(['models', 'providers', '--json'], env)
  assert.equal(providers.code, 0, providers.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/providers')
  assert.equal(JSON.parse(providers.out)[0]?.id, 'deepseek')

  const refreshAll = await runCliCaptured(['models', 'refresh', '--json'], env)
  assert.equal(refreshAll.code, 0, refreshAll.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/refresh')
  assert.deepEqual(JSON.parse(refreshAll.out).providers, [])

  const refreshOne = await runCliCaptured(['models', 'refresh', '--provider', 'magpie', '--json'], env)
  assert.equal(refreshOne.code, 0, refreshOne.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/refresh')
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { provider?: string }).provider, 'magpie')
  assert.deepEqual(JSON.parse(refreshOne.out).providers, ['magpie'])
  assert.deepEqual(JSON.parse(refreshOne.out).models, [{ provider: 'magpie', modelId: 'magpie-1', available: true }])

  const p = await runCliCaptured(['plugins', 'list', '--json'], env)
  assert.equal(p.code, 0, p.err)
  assert.equal(JSON.parse(p.out)[0]?.id, 'builtin:profile')

  const d = await runCliCaptured(['plugins', 'disable', 'builtin:herdr', '--json'], env)
  assert.equal(d.code, 0, d.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aherdr/disable')

  const cfg = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--input', '{"a":2}', '--json'], env)
  assert.equal(cfg.code, 0, cfg.err)
  assert.equal(hub.recorded.hits.at(-1)?.method, 'PUT')
  assert.deepEqual(JSON.parse(cfg.out), { values: { a: 2 }, schema: {} })

  const cfgGet = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--json'], env)
  assert.equal(cfgGet.code, 0, cfgGet.err)
  assert.deepEqual(JSON.parse(cfgGet.out), { values: { a: 1 }, schema: {} })

  const convGet = await runCliCaptured(['conversations', 'get', '1', '--json'], env)
  assert.equal(convGet.code, 0, convGet.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/1')

  const st = await runCliCaptured(['status', '--json'], env)
  assert.equal(st.code, 0, st.err)
  assert.deepEqual(JSON.parse(st.out), { configured: true, authenticated: false })

  // 人类可读模式输出表格（非 JSON）
  const human = await runCliCaptured(['models', 'list'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /provider\s+modelId\s+available/)
  assert.match(human.out, /openai\s+gpt\s+true/)
})

test('models filter：查看禁用清单 / --disable 全量替换 / --clear 清空（PUT /api/models/filter）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const catalog = {
    models: [
      { provider: 'faux', modelId: 'faux-1', available: true },
      { provider: 'faux', modelId: 'faux-2', available: true, disabled: true },
    ],
    thinkingLevels: {},
  }
  const hub = await startMockHub(
    {
      'GET /api/models': () => ({ body: catalog }),
      'PUT /api/models/filter': () => ({ body: { ok: true, catalog } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // 无参数：展示当前目录中 disabled 的模型（人类可读分组展示）。
  const listHuman = await runCliCaptured(['models', 'filter'], env)
  assert.equal(listHuman.code, 0, listHuman.err)
  assert.match(listHuman.out, /faux\/faux-2/)

  // 无参数 --json：输出完整 catalog。
  const listJson = await runCliCaptured(['models', 'filter', '--json'], env)
  assert.equal(listJson.code, 0, listJson.err)
  assert.deepEqual(JSON.parse(listJson.out), catalog)

  // --provider + --disable（可重复）：全量替换该 provider 的禁用集。
  const disable = await runCliCaptured(
    ['models', 'filter', '--provider', 'faux', '--disable', 'faux-2', '--disable', 'faux-1', '--json'],
    env,
  )
  assert.equal(disable.code, 0, disable.err)
  const lastPut = hub.recorded.hits.at(-1)
  assert.equal(lastPut?.method, 'PUT')
  assert.equal(lastPut?.path, '/api/models/filter')
  assert.deepEqual(lastPut?.body, { provider: 'faux', disabledModels: ['faux-2', 'faux-1'] })

  // --provider + --clear：置空该 provider 的禁用集。
  const clear = await runCliCaptured(['models', 'filter', '--provider', 'faux', '--clear', '--json'], env)
  assert.equal(clear.code, 0, clear.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { provider: 'faux', disabledModels: [] })

  // 缺省 --clear：清空全部（无 provider 键）。
  const clearAll = await runCliCaptured(['models', 'filter', '--clear', '--json'], env)
  assert.equal(clearAll.code, 0, clearAll.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { disabledModels: [] })

  // 无 --provider 携带 --disable：显式拒绝（服务端同样 400，CLI 前置拦截）。
  const noProvider = await runCliCaptured(['models', 'filter', '--disable', 'faux-1'], env)
  assert.notEqual(noProvider.code, 0)

  // --clear 与 --disable 互斥。
  const mutex = await runCliCaptured(['models', 'filter', '--provider', 'faux', '--clear', '--disable', 'faux-1'], env)
  assert.notEqual(mutex.code, 0)
})

test('events watch：SSE snapshot + 增量，--json 每行输出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const snapshot = {
    bootId: '00000000-0000-0000-0000-000000000001',
    seq: 5,
    conversations: [makeConversationSummary({ id: 1, title: '助理', cwd: '/', model: 'm', completionSeq: 1, createdAt: 0, updatedAt: 0 })],
    pendingAsks: [],
    plugins: [],
  }
  const hub = await startMockHub(
    {
      'GET /api/events': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        // 跨 chunk 分裂的帧边界（\r\n 与 \n 混用、split boundary）验证解析器健壮性
        res.write(`event: snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r`)
        res.write(`\nevent: conversation.upsert\ndata: ${JSON.stringify({ seq: 6, event: { type: 'conversation.upsert', conversation: { id: 1, title: '助理', status: 'working' } } })}\n\n`)
        res.write(': keepalive\n\n')
        res.write(`event: notification\ndata: ${JSON.stringify({ seq: 7, event: { type: 'notification', level: 'info', title: 'hi' } })}\n\n`)
        res.end()
        return null
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const json = await runCliCaptured(['events', 'watch', '--json'], env)
  assert.equal(json.code, 0, json.err)
  const lines = json.out.trim().split('\n').map((l) => JSON.parse(l) as { seq?: number })
  assert.equal(lines[0]?.seq, 5)
  assert.equal(lines[1]?.seq, 6)
  assert.equal(lines[2]?.seq, 7)

  const human = await runCliCaptured(['events', 'watch'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /快照 seq=5/)
  assert.match(human.out, /conversation\.upsert/)
  assert.match(human.out, /notification/)
})

test('hub 不可达与 401 提示登录', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const unreachable = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv('http://127.0.0.1:1', dir, { HELM_TOKEN: 'x' }))
  assert.equal(unreachable.code, 1)
  assert.equal(parseCliError(unreachable).code, 'hub_unreachable')

  const hub = await startMockHub(
    {
      'GET /api/conversations': () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'token 无效' } } }),
    },
    { autoRegisterCleanup: t },
  )
  const unauth = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(unauth.code, 1)
  const err = parseCliError(unauth)
  assert.equal(err.code, 'unauthorized')
  assert.match(err.message, /helm login/)
})

test('无 token 时显式报错（不静默裸奔）；--json 错误为合法 JSON', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'unauthorized')
})

test('未知命令与缺失命令的错误码', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const unknown = await runCliCaptured(['bogus', 'cmd', '--json'], env)
  assert.equal(unknown.code, 1)
  assert.equal(parseCliError(unknown).code, 'unknown_command')

  const empty = await runCliCaptured(['--json'], env)
  assert.equal(empty.code, 1)
  assert.equal(parseCliError(empty).code, 'missing_command')

  const partial = await runCliCaptured(['conversations', '--json'], env)
  assert.equal(partial.code, 1)
  assert.equal(parseCliError(partial).code, 'unknown_command')
})

test('setup --password 闭环；--help 无 Hub 也可用', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/auth/setup': (body) => {
        assert.deepEqual(body, { password: 'stdin-pw' })
        return { body: { token: 'tok-2' } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const viaFlag = await runCliCaptured(['setup', '--password', 'stdin-pw', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(viaFlag.code, 0, viaFlag.err)
  assert.equal(JSON.parse(viaFlag.out).token, 'tok-2')
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-2' })

  // --help 无 Hub 可用（Hub 不可达时帮助仍输出，动态命令留空提示）
  const help = await runCliCaptured(['--help'], makeCliEnv('http://127.0.0.1:1', dir, { HELM_TOKEN: undefined }))
  assert.equal(help.code, 0)
  assert.match(help.out, /核心命令/)
})

test('动态 action hidden 不暴露命令', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {},
    {
      defaultActions: [{ pluginId: 'builtin:test', id: 'internal', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { hidden: true } }],
      autoRegisterCleanup: t,
    },
  )
  const r = await runCliCaptured(['test', 'internal', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'unknown_command')
})

test('动态 action 空 command 路径与非法段显式报错', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {},
    {
      defaultActions: [{ pluginId: 'builtin:test', id: 'bad', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: [] } }],
      autoRegisterCleanup: t,
    },
  )
  const r = await runCliCaptured(['anything', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'invalid_command_path')
})

test('动态 action 属性名撞保留 flag 名时仍可调用（仅经 --input 表达）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/odd': () => ({ body: { ok: true } }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:test', id: 'odd', description: '奇怪属性名',
          inputSchema: { type: 'object', properties: { input: { type: 'string' }, current: { type: 'string' }, title: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(hub.url, dir)

  // 撞保留名的属性不禁用整个动作：跳过独立 flag，经整体 --input 表达
  const r = await runCliCaptured(['test', 'odd', '--input', '{"input":"raw","current":"c","title":"t"}', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/odd')!
  assert.deepEqual(hit.body, { input: { input: 'raw', current: 'c', title: 't' } })

  // 帮助中说明这些属性只能经 --input 表达
  const help = await runCliCaptured(['test', 'odd', '--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /--input/)
  assert.match(help.out, /"input"/)

  // 无位置参数语义：额外位置参数显式拒绝，绝不无声丢弃。
  // `--` 之后的 token 均为字面位置参数（含 --json），故错误为纯文本而非 JSON
  const extra = await runCliCaptured(['test', 'odd', 'stray', '--input', '{}', '--json'], env)
  assert.equal(extra.code, 1)
  assert.equal(parseCliError(extra).code, 'unexpected_positional')

  const extraDash = await runCliCaptured(['test', 'odd', '--', 'stray', '--json'], env)
  assert.equal(extraDash.code, 1)
  assert.match(extraDash.err, /多余位置参数/)
  assert.match(extraDash.err, /stray --json/)
})

test('camelCase 与 kebab 撞名属性不静默 last-wins，正常属性仍可用 flag', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/dupe': () => ({ body: { ok: true } }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:test', id: 'dupe', description: '撞名',
          inputSchema: { type: 'object', properties: { fooBar: { type: 'string' }, 'foo-bar': { type: 'string' }, other: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(hub.url, dir)

  // 撞名属性经整体 --input 表达（两个键都原样送达，不丢失任何一个）
  const whole = await runCliCaptured(['test', 'dupe', '--input', '{"fooBar":"camel","foo-bar":"kebab","other":"x"}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/dupe')!
  assert.deepEqual((hit.body as { input: unknown }).input, { fooBar: 'camel', 'foo-bar': 'kebab', other: 'x' })

  // 未撞名的 other 仍可用独立 flag；且撞名后不存在歧义的 --foo-bar flag
  const partial = await runCliCaptured(['test', 'dupe', '--other', 'y', '--json'], env)
  assert.equal(partial.code, 0, partial.err)
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { input: unknown }).input, { other: 'y' })

  const ambiguous = await runCliCaptured(['test', 'dupe', '--foo-bar', 'z', '--json'], env)
  assert.equal(ambiguous.code, 1)
  assert.equal(parseCliError(ambiguous).code, 'unknown_flag')

  const help = await runCliCaptured(['test', 'dupe', '--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /fooBar/)
})

// ---------------------------------------------------------------------------
// 凭据与故障隔离回归
// ---------------------------------------------------------------------------

test('cli-token 损坏不得被静默当无凭据；核心命令显式报错、--help 降级并诊断', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // 登录态文件损坏：读取时必须报错而非当空（丢的是登录态，但静默会伪装成未登录）
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken json !!', 'utf8')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })

  // 无 env token：核心命令读到损坏文件显式报错（绝不静默当无凭据继续跑）
  const r = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'credentials_unreadable')

  // env token 优先短路磁盘：损坏文件不被触碰，命令照常执行
  const bypass = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(bypass.code, 0, bypass.err)
  assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken json !!')

  // --help：核心帮助仍可用，凭据问题单独诊断到 stderr（无 env token 时），不假称 Hub 没有动作
  const help = await runCliCaptured(['--help'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(help.code, 0)
  assert.match(help.out, /核心命令/)
  assert.match(help.err, /CLI 凭据文件损坏/)
  assert.doesNotMatch(help.out, /Hub 未提供插件动作命令/)

  // 纯文本模式错误同样显式
  const human = await runCliCaptured(['conversations', 'list'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(human.code, 1)
  assert.match(human.err, /CLI 凭据文件损坏/)
})

test('status 无 token 也可请求，有 token 附带（authenticated 反映真实状态）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // 无任何已存 token：status 不因缺 token 报 unauthorized
  const hub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
    },
    { autoRegisterCleanup: t },
  )
  const noTokenEnv = makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined })

  const noToken = await runCliCaptured(['status', '--json'], noTokenEnv)
  assert.equal(noToken.code, 0, noToken.err)
  assert.deepEqual(JSON.parse(noToken.out), { configured: true, authenticated: false })
  assert.equal(hub.recorded.hits.at(-1)?.authorization, undefined)

  // 已存 token（cli-token 文件）：status 附带 Authorization，Hub 可回真实 authenticated
  await fsp.writeFile(
    path.join(dir, 'cli-token'),
    JSON.stringify({ hubUrl: hub.url, token: 'tok-status' }),
    { mode: 0o600 },
  )
  const withToken = await runCliCaptured(['status', '--json'], noTokenEnv)
  assert.equal(withToken.code, 0, withToken.err)
  assert.deepEqual(JSON.parse(withToken.out), { configured: true, authenticated: true })
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-status')

  // setup/login 仍显式匿名请求（不带 token）
  const hub2 = await startMockHub(
    {
      'POST /api/auth/setup': (_body, req) => {
        assert.equal(req.headers['authorization'], undefined, 'setup 必须匿名')
        return { body: { token: 'tok-new' } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const setup = await runCliCaptured(['setup', '--password', 'pw', '--json'], makeCliEnv(hub2.url, dir, { HELM_TOKEN: 'ignored-env' }))
  assert.equal(setup.code, 0, setup.err)
})

test('send 尊重 -- 分隔符：--json 作为文本发送而非被全局剥离', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'POST /api/conversations/1/input': () => ({ body: { ok: true } }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  // -- 之后的 --json 是待发送文本的一部分；提前出现的 --json 仍生效为全局输出开关
  const r = await runCliCaptured(['send', '1', '--json', '--', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/conversations/1/input')!
  assert.deepEqual((hit.body as { text: string }).text, '--json')
  // -- 之前的 --json 生效：输出为 JSON
  assert.deepEqual(JSON.parse(r.out), { ok: true })

  // 组合 flag 不受影响
  const normal = await runCliCaptured(['send', '1', '普通 文本', '--origin', 'agent', '--json'], env)
  assert.equal(normal.code, 0, normal.err)
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { text: string; origin: string }), { text: '普通 文本', origin: 'agent' })
})

test('跨 Hub 不发旧 token：HELM_HUB_URL 指向新地址时忽略凭据中的 token', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // 旧 Hub：凭据文件记录其地址与 token
  const oldHub = await startMockHub(
    {
      'POST /api/auth/login': () => ({ body: { token: 'tok-old-hub' } }),
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const newHub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({
        body: { configured: true, authenticated: req.headers['authorization'] !== undefined },
      }),
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )

  const login = await runCliCaptured(['login', '--password', 'pw', '--json'], makeCliEnv(oldHub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(login.code, 0, login.err)
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { hubUrl: string; token: string }
  assert.equal(saved.hubUrl, oldHub.url)
  assert.equal(saved.token, 'tok-old-hub')

  // HELM_HUB_URL 改指新 Hub：凭据中的旧 token 不随行（status 匿名可探，请求确实发出）
  const newEnvNoToken = makeCliEnv(newHub.url, dir, { HELM_TOKEN: undefined })
  const probe = await runCliCaptured(['status', '--json'], newEnvNoToken)
  assert.equal(probe.code, 0, probe.err)
  assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, '新 Hub 不得收到旧 Hub 的 token')
  const leakHit = newHub.recorded.hits.find((h) => h.path === '/api/auth/status')!
  assert.equal(leakHit.authorization, undefined, '不得把旧 Hub 的 token 发给新 Hub')

  // 需鉴权路径无 token 时显式 unauthorized（不静默裸奔、也不用旧 token 补位）
  const leaked = await runCliCaptured(['conversations', 'list', '--json'], newEnvNoToken)
  assert.equal(leaked.code, 1)
  assert.equal(parseCliError(leaked).code, 'unauthorized')

  // 显式 HELM_TOKEN 仍优先（用户自己保证它属于目标 Hub）
  const explicit = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(newHub.url, dir, { HELM_TOKEN: 'tok-new-hub' }))
  assert.equal(explicit.code, 0, explicit.err)
  assert.equal(newHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-new-hub')

  // 无 env URL 时沿用凭据文件的 hubUrl + token（同源一致）
  const sameHub = await runCliCaptured(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir })
  assert.equal(sameHub.code, 0, sameHub.err)
  assert.equal(oldHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-old-hub')
})

test('首次数据目录不存在时 setup 仍能落盘凭据（目录先建、锁后加）', { timeout: 60_000 }, async (t) => {
  const parentDir = useTempDir(t, 'helm-cli-fresh-')
  const dir = path.join(parentDir, 'nested-data') // 目录不存在
  const hub = await startMockHub({ 'POST /api/auth/setup': () => ({ body: { token: 'tok-fresh' } }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['setup', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 0, r.err)
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok-fresh')
  await assertPrivateCredentialFile(path.join(dir, 'cli-token'))
  // 锁与临时文件不残留
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('跨进程并发：真实子进程 CLI 写 cli-token 与 Hub CredentialService.set 写 credentials.json 互不干扰（连续 3 轮验证稳定）', { timeout: 60_000 }, async (t) => {
  const rootDir = useTempDir(t, 'helm-cli-race-')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const tsxCli = resolveTsxCli()
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts')

  // CLI 子进程：真实独立 Node 进程登录写 cli-token（Hub 换发 token）
  const hub = await startMockHub(
    {
      'POST /api/auth/login': (body) => ({ body: { token: `tok-cli-${(body as { password: string }).password}` } }),
    },
    { autoRegisterCleanup: t },
  )
  const runCliChild = (dataDir: string, password: string): Promise<{ code: number | null; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, 'login', '--password', password, '--json'], {
        env: { ...process.env, ...makeCliEnv(hub.url, dataDir, { HELM_TOKEN: '' }) },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, err }))
    })
  // 连续多轮（每轮全新 dataDir，目录不存在验证首次创建）：叠加锁竞争窗口，确保修复后 100% 稳定
  const ROUNDS = 3
  const { CredentialService } = await import('../../kernel/src/services/index.js')
  for (let round = 0; round < ROUNDS; round++) {
    const dataDir = path.join(rootDir, `round-${round}`)
    // 预置服务端键，随后 4 个真实 CLI 子进程（写 cli-token）与 4 次进程内 CredentialService.set（写 credentials.json）并发
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.writeFile(path.join(dataDir, 'credentials.json'), JSON.stringify({ providers: {}, pluginSecrets: {} }), { mode: 0o600 })
    const svc = new CredentialService(dataDir)
    await svc.set('base', 'sk-base-0123456789')

    const children: Promise<{ code: number | null; err: string }>[] = Array.from({ length: 4 }, (_, i) => runCliChild(dataDir, `pw-${i}`))
    const serverSets: Promise<void>[] = Array.from({ length: 4 }, (_, i) => svc.set(`provider-${i}`, `sk-value-${i}`))
    const childResults = await Promise.all(children)
    await Promise.all(serverSets)
    for (const r of childResults) {
      assert.equal(r.code, 0, `第 ${round + 1}/${ROUNDS} 轮 CLI 子进程失败: ${r.err}`)
    }

    // 模型密钥全部保留（credentials.json 不再承载 CLI 登录态）；cli-token 独立（最后一次子进程写入者）
    const final = JSON.parse(await fsp.readFile(path.join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown> & {
      providers: Record<string, { value: string }>
    }
    assert.equal(final['cli'], undefined, '登录态不得再写入 credentials.json')
    const finalToken = JSON.parse(await fsp.readFile(path.join(dataDir, 'cli-token'), 'utf8')) as { hubUrl: string; token: string }
    assert.equal(finalToken.hubUrl, hub.url)
    assert.match(finalToken.token, /^tok-cli-pw-[0-3]$/)
    const ids = await svc.list()
    assert.deepEqual(ids, ['base', 'provider-0', 'provider-1', 'provider-2', 'provider-3'])
    for (let i = 0; i < 4; i++) {
      assert.equal(final.providers[`provider-${i}`]?.value, `sk-value-${i}`)
    }
    // 0600 与无锁/临时文件残留（两个文件均验；Windows 无 POSIX mode 仅验存在）
    await assertPrivateCredentialFile(path.join(dataDir, 'credentials.json'))
    await assertPrivateCredentialFile(path.join(dataDir, 'cli-token'))
    const leftovers = (await fsp.readdir(dataDir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  }
})

test('origin 绑定：cli-token 记录的 token 仅发给同源 Hub，换 Hub 不携带', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/auth/login': () => ({ body: { token: 'tok-origin' } }),
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const login = await runCliCaptured(['login', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(login.code, 0, login.err)
  const tokenFile = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(tokenFile, { hubUrl: hub.url, token: 'tok-origin' })
  await assertPrivateCredentialFile(path.join(dir, 'cli-token'))
  // 同源请求携带 token
  const same = await runCliCaptured(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir, HELM_TOKEN: '' })
  assert.equal(same.code, 0, same.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-origin')

  // origin 绑定：HELM_HUB_URL 指向另一 Hub 时不携带记录的 token
  const otherHub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
    },
    { autoRegisterCleanup: t },
  )
  const probe = await runCliCaptured(['status', '--json'], makeCliEnv(otherHub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(probe.code, 0, probe.err)
  assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, '新 Hub 不得收到旧 Hub 的 token')
})

test('cli-token 文件损坏时显式报错；HELM_TOKEN 环境变量优先短路磁盘不读损坏文件', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken !!', { mode: 0o600 })

  // 无 env token：损坏显式报错（不静默当无凭据）
  const broken = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(broken.code, 1)
  assert.equal(parseCliError(broken).code, 'credentials_unreadable')

  // env token 优先：短路磁盘，损坏文件不被触碰，命令照常执行
  const bypass = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: 'env-tok' }))
  assert.equal(bypass.code, 0, bypass.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
  assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken !!')
})

// ---------------------------------------------------------------------------
// 工作流与核心接口对齐测试（原 cli-alignment 回填）
// ---------------------------------------------------------------------------

/** builtin:workflow 动作 manifest（与插件声明一致的最小契约形状）。 */
const WF_RUN_MANIFESTS = [
  {
    pluginId: 'builtin:workflow',
    id: 'run',
    description: '启动工作流运行',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        script: { type: 'string' },
        args: {},
        resumeFromRunId: { type: 'string' },
        conversationId: { type: 'number' },
        wait: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
    cli: {
      command: ['workflows', 'run'],
      positional: [{ field: 'name', readFileInto: 'script' }],
      timeoutMs: 0,
    },
  },
  {
    pluginId: 'builtin:workflow',
    id: 'runs',
    description: '列出工作流运行记录',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'number' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { runs: { type: 'array' } }, required: ['runs'], additionalProperties: false },
    cli: { command: ['workflows', 'runs'] },
  },
]

test('conversations entry：[id] <entryId>/--current 解析与校验', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7/entries/42': () => ({
        body: { id: '42', kind: 'pi.tool-result', model: [{ role: 'toolResult', content: [{ type: 'text', text: '全文' }] }] },
      }),
      'GET /api/conversations/9/entries/42': () => ({ body: { id: '42', kind: 'pi.assistant' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const envCurrent = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' })

  const explicit = await runCliCaptured(['conversations', 'entry', '7', '42', '--json'], env)
  assert.equal(explicit.code, 0, explicit.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7/entries/42')
  assert.equal(JSON.parse(explicit.out).id, '42')

  const current = await runCliCaptured(['conversations', 'entry', '--current', '42', '--json'], envCurrent)
  assert.equal(current.code, 0, current.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/9/entries/42')

  const currentFlag = await runCliCaptured(['conversations', 'entry', '--current', '42', '--json'], envCurrent)
  assert.equal(currentFlag.code, 0, currentFlag.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/9/entries/42')

  // 缺 entryId / 非法 entryId / 缺会话目标：显式报错（不发请求）
  const noEntry = await runCliCaptured(['conversations', 'entry', '7', '--json'], env)
  assert.equal(noEntry.code, 1)
  assert.equal(parseCliError(noEntry).code, 'missing_conversation_target')

  const badEntry = await runCliCaptured(['conversations', 'entry', '7', 'abc', '--json'], env)
  assert.equal(badEntry.code, 1)
  assert.equal(parseCliError(badEntry).code, 'invalid_id')

  const zero = await runCliCaptured(['conversations', 'entry', '7', '0', '--json'], env)
  assert.equal(zero.code, 1)
  assert.equal(parseCliError(zero).code, 'invalid_id')

  const extra = await runCliCaptured(['conversations', 'entry', '7', '42', 'x', '--json'], env)
  assert.equal(extra.code, 1)
})

test('conversations get：--limit/--cursor 映射 query；--current 读 env', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7': () => ({
        body: { id: 7, title: 'x', entries: [], nextCursor: '{"a":1}' },
      }),
      'GET /api/conversations/7?limit=10': () => ({ body: { id: 7, entries: [] } }),
      'GET /api/conversations/7?cursor=%7B%22a%22%3A1%7D': () => ({ body: { id: 7, entries: [] } }),
      'GET /api/conversations/7?limit=10&cursor=%7B%22a%22%3A1%7D': () => ({ body: { id: 7, entries: [] } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const plain = await runCliCaptured(['conversations', 'get', '7', '--json'], env)
  assert.equal(plain.code, 0, plain.err)
  assert.equal(JSON.parse(plain.out).id, 7)

  const limited = await runCliCaptured(['conversations', 'get', '7', '--limit', '10', '--json'], env)
  assert.equal(limited.code, 0, limited.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?limit=10')

  const cursor = await runCliCaptured(['conversations', 'get', '7', '--cursor', '{"a":1}', '--json'], env)
  assert.equal(cursor.code, 0, cursor.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?cursor=%7B%22a%22%3A1%7D')

  const both = await runCliCaptured(
    ['conversations', 'get', '--current', '--limit', '10', '--cursor', '{"a":1}', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' }),
  )
  assert.equal(both.code, 0, both.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?limit=10&cursor=%7B%22a%22%3A1%7D')

  // 非法 limit 显式报错（不发请求）
  const bad = await runCliCaptured(['conversations', 'get', '7', '--limit', '0', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('conversations list：--profile 映射 profileId、--status 校验枚举后入 query', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations': () => ({ body: [] }),
      'GET /api/conversations?profileId=worker': () => ({ body: [] }),
      'GET /api/conversations?status=idle': () => ({ body: [] }),
      'GET /api/conversations?profileId=worker&status=working': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const byProfile = await runCliCaptured(['conversations', 'list', '--profile', 'worker', '--json'], env)
  assert.equal(byProfile.code, 0, byProfile.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?profileId=worker')

  const byStatus = await runCliCaptured(['conversations', 'list', '--status', 'idle', '--json'], env)
  assert.equal(byStatus.code, 0, byStatus.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?status=idle')

  const both = await runCliCaptured(['conversations', 'list', '--profile', 'worker', '--status', 'working', '--json'], env)
  assert.equal(both.code, 0, both.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?profileId=worker&status=working')

  const bad = await runCliCaptured(['conversations', 'list', '--status', 'bogus', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('send --meta：JSON 对象入 body.meta；非对象 JSON 在 CLI 层显式拒绝', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/7/input': () => ({ status: 202, body: { submissionId: 'sub-9' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const ok = await runCliCaptured(['send', '7', '你好', '--meta', '{"source":"cron","n":1}', '--json'], env)
  assert.equal(ok.code, 0, ok.err)
  const hit = hub.hits.find((h) => h.path === '/api/conversations/7/input')!
  assert.deepEqual(hit.body, { text: '你好', meta: { source: 'cron', n: 1 } })

  const asArray = await runCliCaptured(['send', '7', 'x', '--meta', '[1]', '--json'], env)
  assert.equal(asArray.code, 1)
  assert.equal(parseCliError(asArray).code, 'invalid_flag_value')

  // 不提供 --meta 时 body 不含 meta 键（保留 -- 分隔符文本行为：
  // 全局 --json 在 -- 之前剥离，之后的 --json 作为待发送文本）
  const noMeta = await runCliCaptured(['send', '7', '--json', '--', '--json'], env)
  assert.equal(noMeta.code, 0, noMeta.err)
  assert.deepEqual((hub.hits.at(-1)?.body as { text: string }).text, '--json')
  assert.ok(!('meta' in (hub.hits.at(-1)?.body as Record<string, unknown>)))
})

test('send --wait：?wait=1；json 输出完整 result、人类模式直出回答文本', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const result = {
    conversationId: 7,
    submissionId: 'sub-9',
    text: '你好',
    entry: {
      id: 'e1',
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '回答正文' }] }],
    },
  }
  const hub = await startMockHub(
    {
      'POST /api/conversations/7/input?wait=1': () => ({ body: result }),
      'POST /api/conversations/7/input': () => ({ status: 202, body: { submissionId: 'sub-9' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['send', '7', '你好', '--wait', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), result)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7/input?wait=1')

  const human = await runCliCaptured(['send', '7', '你好', '--wait'], env)
  assert.equal(human.code, 0, human.err)
  assert.equal(human.out, '回答正文\n')

  // wait 失败（input_unanswered 409）→ 非零退出 + 错误信封
  const hub2 = await startMockHub(
    {
      'POST /api/conversations/7/input?wait=1': () => ({
        status: 409,
        body: { error: { code: 'input_unanswered', message: '输入未获回答（aborted）' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const failed = await runCliCaptured(['send', '7', 'x', '--wait', '--json'], makeCliEnv(hub2.url, dir))
  assert.equal(failed.code, 1)
  assert.equal(parseCliError(failed).code, 'input_unanswered')
})

test('workflows runs：列出全部；--current 过滤 conversationId；多余位置参数拒绝', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/runs': (body) => {
        const input = (body as { input?: { conversationId?: number } }).input ?? {}
        return {
          body:
            input.conversationId === 7
              ? { runs: [] }
              : { runs: [{ id: 'wf_1', name: 'demo', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 1 }] },
        }
      },
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const all = await runCliCaptured(['workflows', 'runs', '--json'], env)
  assert.equal(all.code, 0, all.err)
  assert.equal((JSON.parse(all.out) as { runs: Array<{ id: string }> }).runs[0]?.id, 'wf_1')
  assert.equal(hub.hits.at(-1)?.path, '/api/actions/builtin%3Aworkflow/runs')

  const filtered = await runCliCaptured(['workflows', 'runs', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
  assert.equal(filtered.code, 0, filtered.err)
  // --current 注入动作 conversationId 上下文（body.conversationId）；
  // 服务端 runs 动作以它作为过滤器（input.conversationId 优先）。
  const filteredBody = (hub.hits.at(-1) as { body?: { conversationId?: number } }).body
  assert.equal(filteredBody?.conversationId, 7)

  const stray = await runCliCaptured(['workflows', 'runs', 'wf_1', '--json'], env)
  assert.equal(stray.code, 1)
  assert.equal(parseCliError(stray).code, 'unexpected_positional')
})

test('workflows run --wait：终态成功输出 run/result；failed 非零退出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const workflowName = `saved-${path.basename(dir)}`
  const doneRun = {
    id: 'wf_w',
    name: workflowName,
    conversationId: 1,
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    result: { answer: 42 },
  }
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/run': (body) => {
        const input = (body as { input?: { wait?: boolean } }).input ?? {}
        if (input.wait === true) return { body: { run: doneRun } }
        return {
          status: 200,
          body: { run: { id: 'wf_w', name: workflowName, conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 } },
        }
      },
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['workflows', 'run', workflowName, '--wait', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual((JSON.parse(json.out) as { run: unknown }).run, doneRun)
  const waitBody = (hub.hits.at(-1) as { body?: { input?: { wait?: boolean; name?: string } } }).body
  assert.equal(waitBody?.input?.wait, true)
  assert.equal(waitBody?.input?.name, workflowName)

  const human = await runCliCaptured(['workflows', 'run', workflowName, '--wait'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /wf_w/)
  assert.match(human.out, /42/)

  // 不带 --wait 返回运行中 run
  const asyncRun = await runCliCaptured(['workflows', 'run', workflowName, '--json'], env)
  assert.equal(asyncRun.code, 0, asyncRun.err)
  assert.equal((JSON.parse(asyncRun.out) as { run: { status: string } }).run.status, 'running')

  // failed 终态：Hub 错误信封 → 非零退出（不把空 result 当成功）
  const hub2 = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/run': () => ({
        status: 500,
        body: { error: { code: 'workflow_failed', message: 'boom', details: { runId: 'wf_f', status: 'failed' } } },
      }),
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const failed = await runCliCaptured(['workflows', 'run', workflowName, '--wait', '--json'], makeCliEnv(hub2.url, dir))
  assert.equal(failed.code, 1)
  assert.equal(parseCliError(failed).code, 'workflow_failed')
})

test('workflows run：文件位置参数读入 script、名称写入 name、--resume-from-run-id 与 --args 透传', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const workflowName = `saved-${path.basename(dir)}`
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/run': () => ({ body: { run: { id: 'wf_x', status: 'running' } } }),
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const scriptPath = path.join(dir, 'demo.workflow.js')
  await fsp.writeFile(scriptPath, 'export const meta = { name: "f" }\nreturn 1\n', 'utf8')

  // 文件位置参数 -> readFileInto script
  const byFile = await runCliCaptured(['workflows', 'run', scriptPath, '--json'], env)
  assert.equal(byFile.code, 0, byFile.err)
  let body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.match(String(body?.input?.script), /name: "f"/)
  assert.equal(body?.input?.name, undefined)

  // ./ 前缀但文件不存在：显式报错（不猜含义）
  const missing = await runCliCaptured(['workflows', 'run', './nope.js', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'positional_file_not_found')

  // 名称（非路径形态）-> name 字段；--resume-from-run-id kebab 映射 camelCase
  const byName = await runCliCaptured(
    ['workflows', 'run', workflowName, '--args', JSON.stringify({ x: 1 }), '--resume-from-run-id', 'wf_prev', '--json'],
    env,
  )
  assert.equal(byName.code, 0, byName.err)
  body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.name, workflowName)
  assert.equal(body?.input?.script, undefined)
  assert.deepEqual(body?.input?.args, { x: 1 })
  assert.equal(body?.input?.resumeFromRunId, 'wf_prev')

  // 显式属性 flag 不经过 readFileInto，即使值指向真实目录也原样交给 Hub 校验。
  const explicitName = await runCliCaptured(['workflows', 'run', '--name', dir, '--json'], env)
  assert.equal(explicitName.code, 0, explicitName.err)
  body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.name, dir)
  assert.equal(body?.input?.script, undefined)
})

test('plugins doc：GET /api/plugins/:id/docs/:name；json 全量、人类模式直出值', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/plugins/builtin%3Astatusboard/docs/board': () => ({
        body: { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } },
      }),
      'GET /api/plugins/builtin%3Astatusboard/docs/notes': () => ({
        body: { pluginId: 'builtin:statusboard', name: 'notes', value: '纯文本文档' },
      }),
      'GET /api/plugins/builtin%3Astatusboard/docs/secret': () => ({
        status: 404,
        body: { error: { code: 'plugin_doc_not_found', message: '无公共文档' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'board', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } })

  const human = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'board'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /count/)
  assert.match(human.out, /42/)

  const textValue = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'notes'], env)
  assert.equal(textValue.code, 0, textValue.err)
  assert.equal(textValue.out, 'notes\n纯文本文档\n')

  const missing = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'secret', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'plugin_doc_not_found')

  const noArgs = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', '--json'], env)
  assert.equal(noArgs.code, 1)
  assert.equal(parseCliError(noArgs).code, 'missing_id')
})

// ---------------------------------------------------------------------------
// 凭据锁权限异常（原 credentials-lock-errors 回填）
// ---------------------------------------------------------------------------

test('读取持有中的凭据锁遇到权限错误时显式失败，并保留锁与凭据', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-lock-error-')
  const lockPath = path.join(dir, 'cli-token.lock')
  const tokenPath = path.join(dir, 'cli-token')
  const owner = `${process.pid} existing-owner\n`
  await fsp.writeFile(lockPath, owner)
  await fsp.writeFile(tokenPath, 'original')
  const readFile = fsp.readFile.bind(fsp)
  const stub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    if (String(args[0]) === lockPath) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    return readFile(...args)
  })
  try {
    await assert.rejects(updateCliCredentials(dir, { token: 'replacement' }), (error: unknown) =>
      error instanceof CliError && error.code === 'credentials_lock_failed')
    stub.mock.restore()
    assert.equal(await readFile(lockPath, 'utf8'), owner)
    assert.equal(await readFile(tokenPath, 'utf8'), 'original')
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['cli-token', 'cli-token.lock'])
  } finally {
    stub.mock.restore()
  }
})
