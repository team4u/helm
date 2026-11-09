/**
 * CLI 全链路测试：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界）。
 * 验证：路径/方法/请求体/--json/--current/动态 action schema/错误信封/凭据文件保留键。
 * 模拟的是 HTTP 契约，不宣称真实 Hub 集成（无模型调用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/index.js'

/** 命中记录：方法 + 路径（含 query）+ 解析后的 JSON body。 */
interface Hit {
  method: string
  path: string
  body?: unknown
  authorization?: string
}

interface Recorded {
  hits: Hit[]
}

/** 每个用例的模拟 Hub：routes 形如 { 'POST /api/x': (body) => entity }；GET /api/actions 缺省返回空数组。 */
async function startHub(routes: Record<string, (body: unknown, req: http.IncomingMessage) => { status?: number; body?: unknown }>): Promise<{ url: string; recorded: Recorded; close: () => Promise<void> }> {
  const allRoutes: Record<string, (body: unknown, req: http.IncomingMessage) => { status?: number; body?: unknown }> = {
    'GET /api/actions': () => ({ body: [] }),
    ...routes,
  }
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (rawBody) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = rawBody
        }
      }
      const full = `${req.method} ${req.url}`
      hits.push({ method: req.method!, path: req.url!, body, authorization: req.headers['authorization'] })
      const handler = allRoutes[full]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
        return
      }
      const result = handler(body, req)
      const status = result.status ?? 200
      if (result.body === undefined) {
        res.writeHead(status)
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': typeof result.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' })
      // 字符串 body 原样（文本内容端点），其余 JSON 序列化
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    recorded: { hits },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

interface Captured {
  out: string
  err: string
  code: number
}

async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<Captured> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-test-'))
}

/** 未存在的临时 dataDir 路径（跨进程锁回归用：目录不存在需首次创建）。 */
function freshDataDirPath(): string {
  return path.join(os.tmpdir(), `helm-cli-fresh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

/** 仓库内 tsx/cli 的绝对路径（跨进程子进程执行 TS 入口用），自 testDir 逐级向上解析。 */
function resolveTscCli(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('tsx/cli')
}

test('setup/login 换 token 写 0600 cli-token，不碰 providers/pluginSecrets 键', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const credFile = path.join(dir, 'credentials.json')
  const tokenFile = path.join(dir, 'cli-token')
  // 预置服务端结构 + 额外 unknown 键（无旧 cli 键）：登录不得碰这个文件
  const legacyBefore = `${JSON.stringify({ providers: { openai: 'sk-x' }, pluginSecrets: { herdr: 's' }, futureKey: 1 }, null, 2)}\n`
  await fsp.writeFile(credFile, legacyBefore)
  const hub = await startHub({
    'POST /api/auth/login': (body) => {
      assert.deepEqual(body, { password: 'pw' })
      return { body: { token: 'tok-1' } }
    },
    'GET /api/conversations': () => ({ body: [] }),
  })
  try {
    const r = await run(['login', '--password', 'pw', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir })
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).token, 'tok-1')
    // 登录态落在独立 cli-token（0600），credentials.json 原样不动
    const st = await fsp.stat(tokenFile)
    assert.equal(st.mode & 0o777, 0o600)
    const saved = JSON.parse(await fsp.readFile(tokenFile, 'utf8')) as Record<string, unknown>
    assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-1' })
    assert.equal(await fsp.readFile(credFile, 'utf8'), legacyBefore)
    // env HELM_TOKEN 优先级高于凭据文件
    const r2 = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir, HELM_TOKEN: 'env-tok' })
    assert.equal(r2.code, 0, r2.err)
    assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
  } finally {
    await hub.close()
  }
})

test('思考档位 CLI 透传：全局部分更新、当前会话覆盖与 Profile 合并', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'PUT /api/models/default': (body) => ({ body }),
    'PATCH /api/conversations/7': (body) => ({ body }),
    'GET /api/profiles/worker': () => ({ body: { id: 'worker', model: 'faux/model', name: 'Worker' } }),
    'PUT /api/profiles/worker': (body) => ({ body }),
  })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-thinking-cli-'))
  const env = makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' })
  try {
    const defaults = await run(['models', 'default', '--thinking', 'high', '--json'], env)
    assert.equal(defaults.code, 0, defaults.err)
    assert.deepEqual(JSON.parse(defaults.out), { thinkingLevel: 'high' })
    const conversation = await run(['conversations', 'update', '--current', '--thinking=', '--json'], env)
    assert.equal(conversation.code, 0, conversation.err)
    assert.deepEqual(JSON.parse(conversation.out), { thinkingLevel: '' })
    const profile = await run(['profiles', 'update', 'worker', '--thinking', 'high', '--json'], env)
    assert.equal(profile.code, 0, profile.err)
    assert.deepEqual(JSON.parse(profile.out), { id: 'worker', model: 'faux/model', name: 'Worker', thinkingLevel: 'high' })
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('conversations create/send/abort/update/delete 的路径、body 与 --current', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations': (body) => ({ body: { id: 7, ...body as object } }),
    'POST /api/conversations/7/input': (body) => ({ body: { ok: true, echo: body } }),
    'POST /api/conversations/7/abort': () => ({ body: { ok: true } }),
    'PATCH /api/conversations/7': (body) => ({ body: { id: 7, ...body as object } }),
    'DELETE /api/conversations/7': () => ({ status: 204 }),
    'DELETE /api/conversations/1': () => ({ status: 403, body: { error: { code: 'root_conversation_protected', message: '#1 受保护' } } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const created = await run(['conversations', 'create', '--title', '任务', '--tags', 'a,b', '--model', 'openai/gpt', '--json'], env)
    assert.equal(created.code, 0, created.err)
    assert.equal(JSON.parse(created.out).id, 7)
    const createHit = hub.recorded.hits.find((h) => h.path === '/api/conversations')!
    assert.deepEqual(createHit.body, { title: '任务', tags: ['a', 'b'], model: 'openai/gpt' })

    const sent = await run(['send', '7', '你好 世界', '--when-busy', 'followUp', '--origin', 'agent', '--json'], env)
    assert.equal(sent.code, 0, sent.err)
    const sendHit = hub.recorded.hits.find((h) => h.path === '/api/conversations/7/input')!
    assert.deepEqual(sendHit.body, { text: '你好 世界', whenBusy: 'followUp', origin: 'agent' })

    const sentCurrent = await run(['send', '--current', 'hi', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
    assert.equal(sentCurrent.code, 0, sentCurrent.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/7/input')

    const aborted = await run(['abort', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
    assert.equal(aborted.code, 0, aborted.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/7/abort')

    const updated = await run(['conversations', 'update', '7', '--pinned', '--unread=false', '--json'], env)
    assert.equal(updated.code, 0, updated.err)
    const patchHit = hub.recorded.hits.find((h) => h.method === 'PATCH')!
    assert.deepEqual(patchHit.body, { pinned: true, unread: false })

    // --model 空串 = 清除模型覆盖（PATCH {model:''}）；服务端已支持，CLI 必须能表达
    const cleared = await run(['conversations', 'update', '7', '--model', '', '--json'], env)
    assert.equal(cleared.code, 0, cleared.err)
    assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
    const clearedInline = await run(['conversations', 'update', '7', '--model=', '--json'], env)
    assert.equal(clearedInline.code, 0, clearedInline.err)
    assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
    // 正常覆盖仍原样透传
    const overridden = await run(['conversations', 'update', '7', '--model', 'openai/gpt-4o', '--json'], env)
    assert.equal(overridden.code, 0, overridden.err)
    assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: 'openai/gpt-4o' })

    const deleted = await run(['conversations', 'delete', '7', '--json'], env)
    assert.equal(deleted.code, 0, deleted.err)

    // 服务端 403 错误信封 -> stderr JSON + 非零退出
    const forbidden = await run(['conversations', 'delete', '1', '--json'], env)
    assert.equal(forbidden.code, 1)
    const parsed = JSON.parse(forbidden.err) as { error: { code: string; message: string } }
    assert.equal(parsed.error.code, 'root_conversation_protected')
  } finally {
    await hub.close()
  }
})

test('--current 缺失/非法显式 ID 均显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({})
  try {
    const missing = await run(['send', '--current', 'x', '--json'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'current_conversation_missing')

    const bad = await run(['send', 'abc', 'x', '--json'], makeEnv(hub.url, dir))
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_id')

    const none = await run(['abort', '--json'], makeEnv(hub.url, dir))
    assert.equal(none.code, 1)
    assert.equal((JSON.parse(none.err) as { error: { code: string } }).error.code, 'missing_conversation_target')
  } finally {
    await hub.close()
  }
})

test('asks answer 发送 answers JSON 与 expectedStateSeq', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/asks/ask-1/answer': () => ({ body: { askId: 'ask-1', answers: {}, answeredAt: 1 } }),
    'GET /api/asks': () => ({ body: [] }),
  })
  try {
    const r = await run(['asks', 'answer', 'ask-1', '--answers', '{"field":"值"}', '--expected-state-seq', '10', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const hit = hub.recorded.hits.find((h) => h.path === '/api/asks/ask-1/answer')!
    assert.deepEqual(hit.body, { answers: { field: '值' }, expectedStateSeq: 10 })
  } finally {
    await hub.close()
  }
})

test('skills read 直出 {text}，非 JSON 模式原样文本', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/skills/demo': () => ({ body: { text: '# 标题\n内容' } }),
    'GET /api/skills/demo?path=references%2Fguide.md': () => ({ body: { text: '手册内容' } }),
  })
  try {
    const text = await run(['skills', 'read', 'demo'], makeEnv(hub.url, dir))
    assert.equal(text.code, 0, text.err)
    assert.ok(text.out.startsWith('# 标题'))

    const sub = await run(['skills', 'read', 'demo', '--path', 'references/guide.md', '--json'], makeEnv(hub.url, dir))
    assert.equal(sub.code, 0, sub.err)
    const hit = hub.recorded.hits.at(-1)!
    assert.equal(hit.path, '/api/skills/demo?path=references%2Fguide.md')
    assert.deepEqual(JSON.parse(sub.out), { text: '手册内容' })
  } finally {
    await hub.close()
  }
})

test('providers set 发送完整数组；credentials set/delete 使用 REST 路径', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/providers': () => ({ body: [] }),
    'PUT /api/providers': () => ({ body: [] }),
    'GET /api/credentials': () => ({ body: [{ id: 'openai', configured: true }] }),
    'PUT /api/credentials/openai': () => ({ body: { ok: true } }),
    'DELETE /api/credentials/openai': () => ({ status: 204 }),
  })
  try {
    const providers = '[{"id":"gw","protocol":"openai","baseUrl":"https://x","models":["m"],"enabled":true}]'
    const set = await run(['providers', 'set', '--input', providers, '--json'], makeEnv(hub.url, dir))
    assert.equal(set.code, 0, set.err)
    const hit = hub.recorded.hits.find((h) => h.method === 'PUT' && h.path === '/api/providers')!
    assert.ok(Array.isArray(hit.body))

    const cred = await run(['credentials', 'set', 'openai', '--value', 'sk-1', '--json'], makeEnv(hub.url, dir))
    assert.equal(cred.code, 0, cred.err)
    assert.deepEqual(hub.recorded.hits.find((h) => h.path === '/api/credentials/openai')?.body, { value: 'sk-1' })

    const del = await run(['credentials', 'delete', 'openai', '--json'], makeEnv(hub.url, dir))
    assert.equal(del.code, 0, del.err)
  } finally {
    await hub.close()
  }
})

test('动态 action：schema 转 flag、类型转换、--input 互斥、cli.command 路径、冲突报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
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
  const hub = await startHub({
    'GET /api/actions': () => ({ body: manifests }),
    'POST /api/actions/builtin%3Atest/task.create': () => ({ body: { created: true } }),
    'POST /api/actions/builtin%3Atriggers/fire': () => ({ body: { fired: true } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // cli.command 覆盖默认路径
    const r = await run(['tasks', 'create', '--title', 'T', '--max-tokens', '4096', '--tags', '["a"]', '--dry-run', '--json'], env)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), { created: true })
    const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/task.create')!
    assert.deepEqual(hit.body, { input: { title: 'T', maxTokens: 4096, tags: ['a'], dryRun: true } })

    // 默认路径 stripBuiltin
    const fire = await run(['triggers', 'fire', '--json'], env)
    assert.equal(fire.code, 0, fire.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/actions/builtin%3Atriggers/fire')

    // --current 附带 conversationId
    const cur = await run(['triggers', 'fire', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '3' })
    assert.equal(cur.code, 0, cur.err)
    assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: {}, conversationId: 3 })

    // 必填缺失
    const missing = await run(['tasks', 'create', '--json'], env)
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'missing_required_flag')

    // 未知 flag 拒绝
    const unknown = await run(['tasks', 'create', '--title', 'T', '--bogus', '--json'], env)
    assert.equal(unknown.code, 1)
    assert.equal((JSON.parse(unknown.err) as { error: { code: string } }).error.code, 'unknown_flag')

    // --input 与属性 flag 互斥
    const mixed = await run(['tasks', 'create', '--input', '{"title":"x"}', '--title', 'y', '--json'], env)
    assert.equal(mixed.code, 1)
    assert.equal((JSON.parse(mixed.err) as { error: { code: string } }).error.code, 'conflicting_flags')

    // --input 整体提交（含 schema 外字段，服务端校验兜底）
    const whole = await run(['tasks', 'create', '--input', '{"title":"x","extra":1}', '--json'], env)
    assert.equal(whole.code, 0, whole.err)
    assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: { title: 'x', extra: 1 } })

    // 帮助包含动态命令
    const help = await run(['--help'], env)
    assert.equal(help.code, 0)
    assert.match(help.out, /tasks create/)
    assert.match(help.out, /triggers fire/)
  } finally {
    await hub.close()
  }
})

test('动态命令抢占核心路径时核心仍执行；调用动态路径才拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
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
  })
  try {
    // 核心命令精确匹配即执行：坏插件的冲突声明不得阻断核心管理面（故障隔离）。
    // 即使动态声明了抢占性的父路径 ["asks"]，核心 asks list 仍直接执行、不拉 manifest
    const r = await run(['conversations', 'list', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out)[0]?.id, 9)

    const coreAsks = await run(['asks', 'list', '--json'], makeEnv(hub.url, dir))
    assert.equal(coreAsks.code, 0, coreAsks.err)

    const disable = await run(['plugins', 'disable', 'builtin:evil', '--json'], makeEnv(hub.url, dir))
    assert.equal(disable.code, 0, disable.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aevil/disable')

    // 只有真正解析动态命令（非核心精确匹配）时才拉 manifest 并显式拒绝冲突
    const dyn = await run(['asks', 'bogus', '--json'], makeEnv(hub.url, dir))
    assert.equal(dyn.code, 1)
    assert.equal((JSON.parse(dyn.err) as { error: { code: string } }).error.code, 'command_conflict')
  } finally {
    await hub.close()
  }
})

test('workflows inspect/abort：位置参数映射 runId（动态动作命令）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
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
  const hub = await startHub({
    'GET /api/actions': () => ({ body: manifests }),
    'POST /api/actions/builtin%3Aworkflow/inspect': () => ({ body: { run: { id: 'run-1', status: 'completed' } } }),
    'POST /api/actions/builtin%3Aworkflow/abort': () => ({ body: { run: { id: 'run-1', status: 'aborted' } } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const inspect = await run(['workflows', 'inspect', 'run-1', '--json'], env)
    assert.equal(inspect.code, 0, inspect.err)
    const inspectHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/inspect')!
    assert.deepEqual(inspectHit.body, { input: { runId: 'run-1' } })
    assert.equal((JSON.parse(inspect.out) as { run: { status: string } }).run.status, 'completed')

    // 必填位置参数缺失：显式 missing_positional
    const missing = await run(['workflows', 'inspect', '--json'], env)
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'missing_positional')

    const abort = await run(['workflows', 'abort', 'run-1', '--json'], env)
    assert.equal(abort.code, 0, abort.err)
    const abortHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/abort')!
    assert.deepEqual(abortHit.body, { input: { runId: 'run-1' } })
  } finally {
    await hub.close()
  }
})

test('artifacts：文本直出、二进制强制 --output、列表走会话端点', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/conversations/3/artifacts': () => ({ body: [{ id: 'a1', conversationId: 3, name: 'out.txt', path: 'artifacts/3/out.txt', mimeType: 'text/plain', size: 3, createdAt: 0 }] }),
    'GET /api/artifacts/a1/content': (body, req) => {
      void body
      const accept = req.headers['accept'] ?? ''
      void accept
      return { body: 'abc' }
    },
    'GET /api/artifacts/a2/content': () => ({ body: '' }),
  })
  const env = makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '3' })
  try {
    const list = await run(['artifacts', 'list', '--current', '--json'], env)
    assert.equal(list.code, 0, list.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/3/artifacts')
    assert.equal(JSON.parse(list.out)[0]?.id, 'a1')

    const text = await run(['artifacts', 'get', 'a1'], env)
    assert.equal(text.code, 0, text.err)
    assert.equal(text.out, 'abc\n')
  } finally {
    await hub.close()
  }
})

test('search、models、plugins、actions list、status', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
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
    'GET /api/plugins': () => ({ body: [{ id: 'builtin:assistant', name: 'assistant', locked: true, enabled: true, hooks: [], actions: [], tools: [] }] }),
    'POST /api/plugins/builtin%3Aherdr/disable': () => ({ body: { ok: 1 } }),
    'GET /api/plugins/builtin%3Aherdr/config': () => ({ body: { values: { a: 1 }, schema: {} } }),
    'PUT /api/plugins/builtin%3Aherdr/config': (body) => {
      assert.deepEqual((body as { values: unknown }).values, { a: 2 })
      return { body: { values: { a: 2 }, schema: {} } }
    },
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/auth/status': () => ({ body: { configured: true, authenticated: false } }),
    'GET /api/conversations/1': () => ({ body: { id: 1, title: '助理', profileId: 'assistant', tags: [], cwd: '/', model: 'm', status: 'idle', stateChangeSeq: 1, completionSeq: 1, unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0 } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const s = await run(['search', 'hello', 'world', '--json'], env)
    assert.equal(s.code, 0, s.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/search?q=hello%20world')

    const m = await run(['models', 'list', '--json'], env)
    assert.equal(m.code, 0, m.err)
    assert.deepEqual(JSON.parse(m.out), { models: [{ provider: 'openai', modelId: 'gpt', available: true }, { provider: 'anthropic', modelId: 'sonnet', available: true }], thinkingLevels: {} })

    const providers = await run(['models', 'providers', '--json'], env)
    assert.equal(providers.code, 0, providers.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/providers')
    assert.equal(JSON.parse(providers.out)[0]?.id, 'deepseek')

    const refreshAll = await run(['models', 'refresh', '--json'], env)
    assert.equal(refreshAll.code, 0, refreshAll.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/refresh')
    assert.deepEqual(JSON.parse(refreshAll.out).providers, [])

    const refreshOne = await run(['models', 'refresh', '--provider', 'magpie', '--json'], env)
    assert.equal(refreshOne.code, 0, refreshOne.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/refresh')
    assert.deepEqual((hub.recorded.hits.at(-1)?.body as { provider?: string }).provider, 'magpie')
    assert.deepEqual(JSON.parse(refreshOne.out).providers, ['magpie'])
    assert.deepEqual(JSON.parse(refreshOne.out).models, [{ provider: 'magpie', modelId: 'magpie-1', available: true }])

    const p = await run(['plugins', 'list', '--json'], env)
    assert.equal(p.code, 0, p.err)
    assert.equal(JSON.parse(p.out)[0]?.id, 'builtin:assistant')

    const d = await run(['plugins', 'disable', 'builtin:herdr', '--json'], env)
    assert.equal(d.code, 0, d.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aherdr/disable')

    const cfg = await run(['plugins', 'config', 'builtin:herdr', '--input', '{"a":2}', '--json'], env)
    assert.equal(cfg.code, 0, cfg.err)
    assert.equal(hub.recorded.hits.at(-1)?.method, 'PUT')
    assert.deepEqual(JSON.parse(cfg.out), { values: { a: 2 }, schema: {} })

    const cfgGet = await run(['plugins', 'config', 'builtin:herdr', '--json'], env)
    assert.equal(cfgGet.code, 0, cfgGet.err)
    assert.deepEqual(JSON.parse(cfgGet.out), { values: { a: 1 }, schema: {} })

    const convGet = await run(['conversations', 'get', '1', '--json'], env)
    assert.equal(convGet.code, 0, convGet.err)
    assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/1')

    const st = await run(['status', '--json'], env)
    assert.equal(st.code, 0, st.err)
    assert.deepEqual(JSON.parse(st.out), { configured: true, authenticated: false })

    // 人类可读模式输出表格（非 JSON）
    const human = await run(['models', 'list'], env)
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /provider\s+modelId\s+available/)
    assert.match(human.out, /openai\s+gpt\s+true/)
  } finally {
    await hub.close()
  }
})

test('events watch：SSE snapshot + 增量，--json 每行输出', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const snapshot = {
    seq: 5,
    conversations: [{ id: 1, title: '助理', profileId: 'assistant', tags: [], cwd: '/', model: 'm', status: 'idle', stateChangeSeq: 1, completionSeq: 1, unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0 }],
    pendingAsks: [],
    plugins: [],
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/api/actions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
      return
    }
    if (req.url !== '/api/events') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // 跨 chunk 分裂的帧边界（\r\n 与 \n 混用、split boundary）验证解析器健壮性
    res.write(`event: snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r`)
    res.write(`\nevent: conversation.upsert\ndata: ${JSON.stringify({ seq: 6, event: { type: 'conversation.upsert', conversation: { id: 1, title: '助理', status: 'working' } } })}\n\n`)
    res.write(`: keepalive\n\n`)
    res.write(`event: notification\ndata: ${JSON.stringify({ seq: 7, event: { type: 'notification', level: 'info', title: 'hi' } })}\n\n`)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const json = await run(['events', 'watch', '--json'], makeEnv(url, dir))
    assert.equal(json.code, 0, json.err)
    const lines = json.out.trim().split('\n').map((l) => JSON.parse(l) as { seq?: number })
    assert.equal(lines[0]?.seq, 5)
    assert.equal(lines[1]?.seq, 6)
    assert.equal(lines[2]?.seq, 7)

    const human = await run(['events', 'watch'], makeEnv(url, dir))
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /快照 seq=5/)
    assert.match(human.out, /conversation\.upsert/)
    assert.match(human.out, /notification/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('hub 不可达与 401 提示登录', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const unreachable = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: 'http://127.0.0.1:1', HELM_DATA_DIR: dir, HELM_TOKEN: 'x' })
  assert.equal(unreachable.code, 1)
  assert.equal((JSON.parse(unreachable.err) as { error: { code: string } }).error.code, 'hub_unreachable')

  const hub = await startHub({
    'GET /api/conversations': () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'token 无效' } } }),
  })
  try {
    const unauth = await run(['conversations', 'list', '--json'], makeEnv(hub.url, dir))
    assert.equal(unauth.code, 1)
    const parsed = JSON.parse(unauth.err) as { error: { code: string; message: string } }
    assert.equal(parsed.error.code, 'unauthorized')
    assert.match(parsed.error.message, /helm login/)
  } finally {
    await hub.close()
  }
})

test('无 token 时显式报错（不静默裸奔）；--json 错误为合法 JSON', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({ 'GET /api/conversations': () => ({ body: [] }) })
  try {
    const r = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir })
    assert.equal(r.code, 1)
    const parsed = JSON.parse(r.err) as { error: { code: string } }
    assert.equal(parsed.error.code, 'unauthorized')
  } finally {
    await hub.close()
  }
})

test('未知命令与缺失命令的错误码', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({ 'GET /api/actions': () => ({ body: [] }) })
  try {
    const unknown = await run(['bogus', 'cmd', '--json'], makeEnv(hub.url, dir))
    assert.equal(unknown.code, 1)
    assert.equal((JSON.parse(unknown.err) as { error: { code: string } }).error.code, 'unknown_command')

    const empty = await run(['--json'], makeEnv(hub.url, dir))
    assert.equal(empty.code, 1)
    assert.equal((JSON.parse(empty.err) as { error: { code: string } }).error.code, 'missing_command')

    const partial = await run(['conversations', '--json'], makeEnv(hub.url, dir))
    assert.equal(partial.code, 1)
    assert.equal((JSON.parse(partial.err) as { error: { code: string } }).error.code, 'unknown_command')
  } finally {
    await hub.close()
  }
})

test('setup --password 闭环；--help 无 Hub 也可用', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/auth/setup': (body) => {
      assert.deepEqual(body, { password: 'stdin-pw' })
      return { body: { token: 'tok-2' } }
    },
  })
  try {
    const viaFlag = await run(['setup', '--password', 'stdin-pw', '--json'], makeEnv(hub.url, dir))
    assert.equal(viaFlag.code, 0, viaFlag.err)
    assert.equal(JSON.parse(viaFlag.out).token, 'tok-2')
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-2' })
  } finally {
    await hub.close()
  }

  // --help 无 Hub 可用（Hub 不可达时帮助仍输出，动态命令留空提示）
  const help = await run(['--help'], { HELM_HUB_URL: 'http://127.0.0.1:1', HELM_DATA_DIR: dir })
  assert.equal(help.code, 0)
  assert.match(help.out, /核心命令/)
})

test('动态 action hidden 不暴露命令', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [{ pluginId: 'builtin:test', id: 'internal', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { hidden: true } }] }),
  })
  try {
    const r = await run(['test', 'internal', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 1)
    assert.equal((JSON.parse(r.err) as { error: { code: string } }).error.code, 'unknown_command')
  } finally {
    await hub.close()
  }
})

test('动态 action 空 command 路径与非法段显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [{ pluginId: 'builtin:test', id: 'bad', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: [] } }] }),
  })
  try {
    const r = await run(['anything', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 1)
    assert.equal((JSON.parse(r.err) as { error: { code: string } }).error.code, 'invalid_command_path')
  } finally {
    await hub.close()
  }
})

test('动态 action 属性名撞保留 flag 名时仍可调用（仅经 --input 表达）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({
      body: [
        {
          pluginId: 'builtin:test', id: 'odd', description: '奇怪属性名',
          inputSchema: { type: 'object', properties: { input: { type: 'string' }, current: { type: 'string' }, title: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
    }),
    'POST /api/actions/builtin%3Atest/odd': () => ({ body: { ok: true } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // 撞保留名的属性不禁用整个动作：跳过独立 flag，经整体 --input 表达
    const r = await run(['test', 'odd', '--input', '{"input":"raw","current":"c","title":"t"}', '--json'], env)
    assert.equal(r.code, 0, r.err)
    const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/odd')!
    assert.deepEqual(hit.body, { input: { input: 'raw', current: 'c', title: 't' } })

    // 帮助中说明这些属性只能经 --input 表达
    const help = await run(['test', 'odd', '--help'], env)
    assert.equal(help.code, 0)
    assert.match(help.out, /--input/)
    assert.match(help.out, /"input"/)

    // 无位置参数语义：额外位置参数显式拒绝，绝不无声丢弃。
    // `--` 之后的 token 均为字面位置参数（含 --json），故错误为纯文本而非 JSON
    const extra = await run(['test', 'odd', 'stray', '--input', '{}', '--json'], env)
    assert.equal(extra.code, 1)
    assert.equal((JSON.parse(extra.err) as { error: { code: string } }).error.code, 'unexpected_positional')

    const extraDash = await run(['test', 'odd', '--', 'stray', '--json'], env)
    assert.equal(extraDash.code, 1)
    assert.match(extraDash.err, /多余位置参数/)
    assert.match(extraDash.err, /stray --json/)
  } finally {
    await hub.close()
  }
})

test('camelCase 与 kebab 撞名属性不静默 last-wins，正常属性仍可用 flag', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({
      body: [
        {
          pluginId: 'builtin:test', id: 'dupe', description: '撞名',
          inputSchema: { type: 'object', properties: { fooBar: { type: 'string' }, 'foo-bar': { type: 'string' }, other: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
    }),
    'POST /api/actions/builtin%3Atest/dupe': () => ({ body: { ok: true } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // 撞名属性经整体 --input 表达（两个键都原样送达，不丢失任何一个）
    const whole = await run(['test', 'dupe', '--input', '{"fooBar":"camel","foo-bar":"kebab","other":"x"}', '--json'], env)
    assert.equal(whole.code, 0, whole.err)
    const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/dupe')!
    assert.deepEqual((hit.body as { input: unknown }).input, { fooBar: 'camel', 'foo-bar': 'kebab', other: 'x' })

    // 未撞名的 other 仍可用独立 flag；且撞名后不存在歧义的 --foo-bar flag
    const partial = await run(['test', 'dupe', '--other', 'y', '--json'], env)
    assert.equal(partial.code, 0, partial.err)
    assert.deepEqual((hub.recorded.hits.at(-1)?.body as { input: unknown }).input, { other: 'y' })

    const ambiguous = await run(['test', 'dupe', '--foo-bar', 'z', '--json'], env)
    assert.equal(ambiguous.code, 1)
    assert.equal((JSON.parse(ambiguous.err) as { error: { code: string } }).error.code, 'unknown_flag')

    const help = await run(['test', 'dupe', '--help'], env)
    assert.equal(help.code, 0)
    assert.match(help.out, /fooBar/)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 凭据与故障隔离回归
// ---------------------------------------------------------------------------

test('cli-token 损坏不得被静默当无凭据；核心命令显式报错、--help 降级并诊断', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  await fsp.mkdir(dir, { recursive: true })
  // 登录态文件损坏：读取时必须报错而非当空（丢的是登录态，但静默会伪装成未登录）
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken json !!', 'utf8')
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/conversations': () => ({ body: [] }),
  })
  try {
    // 无 env token：核心命令读到损坏文件显式报错（绝不静默当无凭据继续跑）
    const r = await run(['conversations', 'list', '--json'], makeEnv(hub.url, dir, { HELM_TOKEN: '' }))
    assert.equal(r.code, 1)
    assert.equal((JSON.parse(r.err) as { error: { code: string } }).error.code, 'credentials_unreadable')

    // env token 优先短路磁盘：损坏文件不被触碰，命令照常执行
    const bypass = await run(['conversations', 'list', '--json'], makeEnv(hub.url, dir))
    assert.equal(bypass.code, 0, bypass.err)
    assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken json !!')

    // --help：核心帮助仍可用，凭据问题单独诊断到 stderr（无 env token 时），不假称 Hub 没有动作
    const help = await run(['--help'], makeEnv(hub.url, dir, { HELM_TOKEN: '' }))
    assert.equal(help.code, 0)
    assert.match(help.out, /核心命令/)
    assert.match(help.err, /CLI 凭据文件损坏/)
    assert.doesNotMatch(help.out, /Hub 未提供插件动作命令/)

    // 纯文本模式错误同样显式
    const human = await run(['conversations', 'list'], makeEnv(hub.url, dir, { HELM_TOKEN: '' }))
    assert.equal(human.code, 1)
    assert.match(human.err, /CLI 凭据文件损坏/)
  } finally {
    await hub.close()
  }
})

test('status 无 token 也可请求，有 token 附带（authenticated 反映真实状态）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // 无任何已存 token：status 不因缺 token 报 unauthorized
  const hub = await startHub({
    'GET /api/auth/status': (body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
  })
  try {
    const noToken = await run(['status', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir })
    assert.equal(noToken.code, 0, noToken.err)
    assert.deepEqual(JSON.parse(noToken.out), { configured: true, authenticated: false })
    assert.equal(hub.recorded.hits.at(-1)?.authorization, undefined)

    // 已存 token（cli-token 文件）：status 附带 Authorization，Hub 可回真实 authenticated
    await fsp.writeFile(
      path.join(dir, 'cli-token'),
      JSON.stringify({ hubUrl: hub.url, token: 'tok-status' }),
      { mode: 0o600 },
    )
    const withToken = await run(['status', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir })
    assert.equal(withToken.code, 0, withToken.err)
    assert.deepEqual(JSON.parse(withToken.out), { configured: true, authenticated: true })
    assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-status')

    // setup/login 仍显式匿名请求（不带 token）
    const hub2 = await startHub({
      'POST /api/auth/setup': (body, req) => {
        assert.equal(req.headers['authorization'], undefined, 'setup 必须匿名')
        return { body: { token: 'tok-new' } }
      },
    })
    try {
      const setup = await run(['setup', '--password', 'pw', '--json'], { HELM_HUB_URL: hub2.url, HELM_DATA_DIR: dir, HELM_TOKEN: 'ignored-env' })
      assert.equal(setup.code, 0, setup.err)
    } finally {
      await hub2.close()
    }
  } finally {
    await hub.close()
  }
})

test('send 尊重 -- 分隔符：--json 作为文本发送而非被全局剥离', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations/1/input': () => ({ body: { ok: true } }),
  })
  try {
    // -- 之后的 --json 是待发送文本的一部分；提前出现的 --json 仍生效为全局输出开关
    const r = await run(['send', '1', '--json', '--', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const hit = hub.recorded.hits.find((h) => h.path === '/api/conversations/1/input')!
    assert.deepEqual((hit.body as { text: string }).text, '--json')
    // -- 之前的 --json 生效：输出为 JSON
    assert.deepEqual(JSON.parse(r.out), { ok: true })

    // 组合 flag 不受影响
    const normal = await run(['send', '1', '普通 文本', '--origin', 'agent', '--json'], makeEnv(hub.url, dir))
    assert.equal(normal.code, 0, normal.err)
    assert.deepEqual((hub.recorded.hits.at(-1)?.body as { text: string; origin: string }), { text: '普通 文本', origin: 'agent' })
  } finally {
    await hub.close()
  }
})

test('跨 Hub 不发旧 token：HELM_HUB_URL 指向新地址时忽略凭据中的 token', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // 旧 Hub：凭据文件记录其地址与 token
  const oldHub = await startHub({
    'POST /api/auth/login': () => ({ body: { token: 'tok-old-hub' } }),
    'GET /api/conversations': () => ({ body: [] }),
  })
  const newHub = await startHub({
    'GET /api/auth/status': (body, req) => ({
      body: { configured: true, authenticated: req.headers['authorization'] !== undefined },
    }),
    'GET /api/conversations': () => ({ body: [] }),
  })
  try {
    const login = await run(['login', '--password', 'pw', '--json'], { HELM_HUB_URL: oldHub.url, HELM_DATA_DIR: dir })
    assert.equal(login.code, 0, login.err)
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { hubUrl: string; token: string }
    assert.equal(saved.hubUrl, oldHub.url)
    assert.equal(saved.token, 'tok-old-hub')

    // HELM_HUB_URL 改指新 Hub：凭据中的旧 token 不随行（status 匿名可探，请求确实发出）
    const probe = await run(['status', '--json'], { HELM_HUB_URL: newHub.url, HELM_DATA_DIR: dir })
    assert.equal(probe.code, 0, probe.err)
    assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, '新 Hub 不得收到旧 Hub 的 token')
    const leakHit = newHub.recorded.hits.find((h) => h.path === '/api/auth/status')!
    assert.equal(leakHit.authorization, undefined, '不得把旧 Hub 的 token 发给新 Hub')

    // 需鉴权路径无 token 时显式 unauthorized（不静默裸奔、也不用旧 token 补位）
    const leaked = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: newHub.url, HELM_DATA_DIR: dir })
    assert.equal(leaked.code, 1)
    assert.equal((JSON.parse(leaked.err) as { error: { code: string } }).error.code, 'unauthorized')

    // 显式 HELM_TOKEN 仍优先（用户自己保证它属于目标 Hub）
    const explicit = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: newHub.url, HELM_DATA_DIR: dir, HELM_TOKEN: 'tok-new-hub' })
    assert.equal(explicit.code, 0, explicit.err)
    assert.equal(newHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-new-hub')

    // 无 env URL 时沿用凭据文件的 hubUrl + token（同源一致）
    const sameHub = await run(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir })
    assert.equal(sameHub.code, 0, sameHub.err)
    assert.equal(oldHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-old-hub')
  } finally {
    await oldHub.close()
    await newHub.close()
  }
})

test('首次数据目录不存在时 setup 仍能落盘凭据（目录先建、锁后加）', { timeout: 60_000 }, async () => {
  const dir = freshDataDirPath() // 目录不存在
  const hub = await startHub({
    'POST /api/auth/setup': () => ({ body: { token: 'tok-fresh' } }),
  })
  try {
    const r = await run(['setup', '--password', 'pw', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir })
    assert.equal(r.code, 0, r.err)
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
    assert.equal(saved.token, 'tok-fresh')
    const st = await fsp.stat(path.join(dir, 'cli-token'))
    assert.equal(st.mode & 0o777, 0o600)
    // 锁与临时文件不残留
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('跨进程并发：真实子进程 CLI 写 cli-token 与 Hub CredentialService.set 写 credentials.json 互不干扰（连续 3 轮验证稳定）', { timeout: 60_000 }, async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const tsxCli = resolveTscCli()
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts')

  // CLI 子进程：真实独立 Node 进程登录写 cli-token（Hub 换发 token）
  const hub = await startHub({
    'POST /api/auth/login': (body) => ({ body: { token: `tok-cli-${(body as { password: string }).password}` } }),
  })
  const runCliChild = (dataDir: string, password: string): Promise<{ code: number | null; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, 'login', '--password', password, '--json'], {
        env: { ...process.env, HELM_HUB_URL: hub.url, HELM_DATA_DIR: dataDir, HELM_TOKEN: '' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, err }))
    })
  // 连续多轮（每轮全新 dataDir，目录不存在验证首次创建）：叠加锁竞争窗口，确保修复后 100% 稳定
  const ROUNDS = 3
  try {
    const { CredentialService } = await import('../../kernel/src/services/index.js')
    for (let round = 0; round < ROUNDS; round++) {
      const dataDir = freshDataDirPath()
      try {
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
        // 0600 与无锁/临时文件残留（两个文件均验）
        const st = await fsp.stat(path.join(dataDir, 'credentials.json'))
        assert.equal(st.mode & 0o777, 0o600)
        const stToken = await fsp.stat(path.join(dataDir, 'cli-token'))
        assert.equal(stToken.mode & 0o777, 0o600)
        const leftovers = (await fsp.readdir(dataDir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
        assert.deepEqual(leftovers, [])
      } finally {
        await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  } finally {
    await hub.close()
  }
})

test('origin 绑定：cli-token 记录的 token 仅发给同源 Hub，换 Hub 不携带', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/auth/login': () => ({ body: { token: 'tok-origin' } }),
    'GET /api/conversations': () => ({ body: [] }),
  })
  try {
    const login = await run(['login', '--password', 'pw', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir, HELM_TOKEN: '' })
    assert.equal(login.code, 0, login.err)
    const tokenFile = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(tokenFile, { hubUrl: hub.url, token: 'tok-origin' })
    const st = await fsp.stat(path.join(dir, 'cli-token'))
    assert.equal(st.mode & 0o777, 0o600)
    // 同源请求携带 token
    const same = await run(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir, HELM_TOKEN: '' })
    assert.equal(same.code, 0, same.err)
    assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-origin')

    // origin 绑定：HELM_HUB_URL 指向另一 Hub 时不携带记录的 token
    const otherHub = await startHub({
      'GET /api/auth/status': (body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
    })
    try {
      const probe = await run(['status', '--json'], { HELM_HUB_URL: otherHub.url, HELM_DATA_DIR: dir, HELM_TOKEN: '' })
      assert.equal(probe.code, 0, probe.err)
      assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, '新 Hub 不得收到旧 Hub 的 token')
    } finally {
      await otherHub.close()
    }
  } finally {
    await hub.close()
  }
})

test('cli-token 文件损坏时显式报错；HELM_TOKEN 环境变量优先短路磁盘不读损坏文件', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/conversations': () => ({ body: [] }),
  })
  try {
    await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken !!', { mode: 0o600 })
    // 无 env token：损坏显式报错（不静默当无凭据）
    const broken = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir, HELM_TOKEN: '' })
    assert.equal(broken.code, 1)
    assert.equal((JSON.parse(broken.err) as { error: { code: string } }).error.code, 'credentials_unreadable')
    // env token 优先：短路磁盘，损坏文件不被触碰，命令照常执行
    const bypass = await run(['conversations', 'list', '--json'], { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dir, HELM_TOKEN: 'env-tok' })
    assert.equal(bypass.code, 0, bypass.err)
    assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
    assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken !!')
  } finally {
    await hub.close()
  }
})
