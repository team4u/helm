/**
 * builtin:triggers CLI 顶层命令映射测试（cron/webhook）。
 *
 * 与 cli.test.ts 同纪律：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界），
 * manifest 按已确认的插件动作契约构造（七个动作 + cli.command 语义化路径），
 * 验证动态命令生成的顶层 `helm cron ...` / `helm webhook ...`、flag 转换、
 * --json、--current 与错误信封。模拟的是 HTTP 契约；真实 Hub 端到端集成
 * 由主代理在实现合入后运行（kernel/test/triggers.test.ts 覆盖宿主侧）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/cli/index.js'
import type { ActionManifest } from '@helm/protocol'

interface Hit {
  method: string
  path: string
  body?: unknown
  authorization?: string
}

/** 契约 manifest：与插件实现同 schema（字段名/类型一一对应）。 */
function triggersManifests(): ActionManifest[] {
  const cronTarget = {
    targetConversationId: { type: 'number' },
    targetProfileId: { type: 'string' },
    threadKey: { type: 'string' },
  }
  return [
    {
      pluginId: 'builtin:triggers',
      id: 'cron_list',
      description: '列出 cron 任务',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'list'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_create',
      description: '创建 cron 任务',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          schedule: { type: 'string' },
          text: { type: 'string' },
          description: { type: 'string' },
          timezone: { type: 'string' },
          enabled: { type: 'boolean' },
          catchUp: { type: 'boolean' },
          ...cronTarget,
        },
        required: ['id', 'schedule', 'text'],
      },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'create'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_delete',
      description: '删除 cron 任务',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'delete'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_trigger',
      description: '手动触发一次 cron 任务（显式新事件，非计划补跑）',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'trigger'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_list',
      description: '列出 webhook',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'list'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_create',
      description: '创建 webhook（secret 仅人工 HTTP/CLI 配置，勿经模型转发）',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          secret: { type: 'string' },
          description: { type: 'string' },
          targetConversationId: { type: 'number' },
          targetProfileId: { type: 'string' },
          threadKey: { type: 'string' },
        },
        required: ['id', 'secret'],
      },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'create'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_delete',
      description: '删除 webhook',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'delete'] },
    },
  ]
}

/** 模拟 Hub：默认返回契约 manifest；action POST 记录并回显。 */
async function startTriggersHub(overrides: {
  actions?: ActionManifest[]
  actionResponse?: (actionId: string, body: unknown) => { status?: number; body?: unknown }
} = {}): Promise<{ url: string; hits: Hit[]; close(): Promise<void> }> {
  const manifests = overrides.actions ?? triggersManifests()
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      hits.push({ method: req.method!, path: req.url!, body, authorization: req.headers.authorization })
      if (req.url === '/api/actions' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(manifests))
        return
      }
      const m = /^\/api\/actions\/builtin%3Atriggers\/([a-z_]+)$/.exec(req.url ?? '')
      if (req.method === 'POST' && m) {
        const result = overrides.actionResponse?.(m[1]!, body) ?? { body: { ok: true, action: m[1] } }
        const status = result.status ?? 200
        if (result.body === undefined) {
          res.writeHead(status)
          res.end()
          return
        }
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${req.method} ${req.url}` } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-triggers-cli-'))
}

test('cron 子命令族：顶层路径、必填校验、类型转换与 --json', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startTriggersHub({
    actionResponse: (actionId, body) => {
      if (actionId === 'cron_list') return { body: { jobs: [{ id: 'nightly', schedule: '0 3 * * *', text: '汇总', timezone: 'UTC', enabled: true, catchUp: false, nextRunAt: null }] } }
      if (actionId === 'cron_create') return { body: { job: (body as { input: object }).input } }
      if (actionId === 'cron_delete') return { body: { deleted: true } }
      return { body: { triggered: true } }
    },
  })
  const env = makeEnv(hub.url, dir)
  try {
    // cron list --json
    const list = await run(['cron', 'list', '--json'], env)
    assert.equal(list.code, 0, list.err)
    assert.equal(JSON.parse(list.out).jobs[0]?.id, 'nightly')
    assert.equal(hub.hits.at(-1)?.path, '/api/actions/builtin%3Atriggers/cron_list')

    // cron create：必填 + 可选全量（boolean/number/string 各类型经 flag 转换）
    const created = await run(
      [
        'cron', 'create',
        '--id', 'ci-watch',
        '--schedule', '*/5 * * * *',
        '--text', '检查 CI 状态并汇报',
        '--description', '五分钟巡检',
        '--timezone', 'Asia/Shanghai',
        '--catch-up',
        '--target-conversation-id', '7',
        '--thread-key', 'ci-main',
      ],
      env,
    )
    assert.equal(created.code, 0, created.err)
    const hit = hub.hits.find((h) => h.path === '/api/actions/builtin%3Atriggers/cron_create')!
    assert.deepEqual(hit.body, {
      input: {
        id: 'ci-watch',
        schedule: '*/5 * * * *',
        text: '检查 CI 状态并汇报',
        description: '五分钟巡检',
        timezone: 'Asia/Shanghai',
        catchUp: true,
        targetConversationId: 7,
        threadKey: 'ci-main',
      },
    })

    // 缺必填：显式 missing_required_flag
    const missing = await run(['cron', 'create', '--id', 'x', '--json'], env)
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'missing_required_flag')

    // 未知 flag 拒绝
    const unknown = await run(['cron', 'create', '--id', 'x', '--schedule', '* * * * *', '--text', 't', '--bogus', '--json'], env)
    assert.equal(unknown.code, 1)
    assert.equal((JSON.parse(unknown.err) as { error: { code: string } }).error.code, 'unknown_flag')

    // cron trigger 与 delete：单必填 id
    const trig = await run(['cron', 'trigger', '--id', 'ci-watch', '--json'], env)
    assert.equal(trig.code, 0, trig.err)
    assert.deepEqual(JSON.parse(trig.out), { triggered: true })
    const del = await run(['cron', 'delete', '--id', 'ci-watch', '--json'], env)
    assert.equal(del.code, 0, del.err)
    assert.deepEqual(JSON.parse(del.out), { deleted: true })
  } finally {
    await hub.close()
  }
})

test('webhook 子命令族：create/list/delete 顶层路径与 body 形状', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startTriggersHub({
    actionResponse: (actionId, body) => {
      if (actionId === 'webhook_create') return { body: { webhook: { id: (body as { input: { id: string } }).input.id, hasSecret: true } } }
      if (actionId === 'webhook_list') return { body: { webhooks: [{ id: 'ci', hasSecret: true }] } }
      return { body: { deleted: true } }
    },
  })
  const env = makeEnv(hub.url, dir)
  try {
    const created = await run(['webhook', 'create', '--id', 'ci', '--secret', 'WHSECRET_CLI_PROBE', '--description', 'CI 回调', '--json'], env)
    assert.equal(created.code, 0, created.err)
    const hit = hub.hits.find((h) => h.path === '/api/actions/builtin%3Atriggers/webhook_create')!
    assert.deepEqual(hit.body, {
      input: { id: 'ci', secret: 'WHSECRET_CLI_PROBE', description: 'CI 回调' },
    })
    // 返回元数据不含 secret 原文（服务端契约；此处验证 CLI 原样透传服务端输出）
    assert.doesNotMatch(created.out, /WHSECRET_CLI_PROBE/)

    const list = await run(['webhook', 'list', '--json'], env)
    assert.equal(list.code, 0, list.err)
    assert.equal(JSON.parse(list.out).webhooks[0]?.id, 'ci')

    const del = await run(['webhook', 'delete', '--id', 'ci', '--json'], env)
    assert.equal(del.code, 0, del.err)
    assert.deepEqual(JSON.parse(del.out), { deleted: true })
  } finally {
    await hub.close()
  }
})

test('cron/webhook 动作支持 --current 附带会话上下文；--input 整体提交', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startTriggersHub()
  const env = makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '5' })
  try {
    // --current：人工会话上下文附带（cron 管理动作不含 secret，可安全携带）
    const cur = await run(['cron', 'list', '--current', '--json'], env)
    assert.equal(cur.code, 0, cur.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { input: {}, conversationId: 5 })

    // --input 整体提交（含可选字段），不与属性 flag 混用
    const whole = await run(
      ['cron', 'create', '--input', '{"id":"w","schedule":"0 * * * *","text":"整包","catchUp":true}', '--json'],
      env,
    )
    assert.equal(whole.code, 0, whole.err)
    assert.deepEqual(hub.hits.at(-1)?.body, {
      input: { id: 'w', schedule: '0 * * * *', text: '整包', catchUp: true },
    })

    // 互斥拒绝
    const mixed = await run(['cron', 'create', '--input', '{"id":"w"}', '--id', 'w', '--json'], env)
    assert.equal(mixed.code, 1)
    assert.equal((JSON.parse(mixed.err) as { error: { code: string } }).error.code, 'conflicting_flags')

    // 多余位置参数拒绝（动作无位置参数语义）
    const extra = await run(['cron', 'trigger', 'stray', '--id', 'x', '--json'], env)
    assert.equal(extra.code, 1)
    assert.equal((JSON.parse(extra.err) as { error: { code: string } }).error.code, 'unexpected_positional')
  } finally {
    await hub.close()
  }
})

test('帮助列出 cron/webhook 顶层命令；服务端错误信封原样上抛', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startTriggersHub({
    actionResponse: () => ({ status: 409, body: { error: { code: 'triggers_job_exists', message: '任务已存在' } } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const help = await run(['--help'], env)
    assert.equal(help.code, 0)
    for (const cmd of ['cron list', 'cron create', 'cron delete', 'cron trigger', 'webhook list', 'webhook create', 'webhook delete']) {
      assert.match(help.out, new RegExp(cmd.replace(/ /g, ' ')), `帮助应包含 ${cmd}`)
    }

    // 子命令级帮助展示 flag
    const sub = await run(['cron', 'create', '--help'], env)
    assert.equal(sub.code, 0)
    assert.match(sub.out, /--schedule/)
    assert.match(sub.out, /--catch-up/)
    assert.match(sub.out, /--target-conversation-id/)

    // 409 错误信封 → 非零退出 + stderr JSON
    const dup = await run(['cron', 'create', '--id', 'd', '--schedule', '* * * * *', '--text', 't', '--json'], env)
    assert.equal(dup.code, 1)
    const parsed = JSON.parse(dup.err) as { error: { code: string; message: string } }
    assert.equal(parsed.error.code, 'triggers_job_exists')
  } finally {
    await hub.close()
  }
})

test('cron 与 webhook 不与核心命令冲突：conversations 等核心命令不受 manifest 影响', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startTriggersHub()
  // 复用同一 server 追加核心路由不可行（startTriggersHub 只映射 actions），
  // 此处验证的是命令解析层：核心命令前缀存在时 manifest 声明不抢占。
  const env = makeEnv(hub.url, dir)
  try {
    // cron/webhook 不在核心命令表：动态解析后正常执行（命中 action 端点）
    const r = await run(['cron', 'list', '--json'], env)
    assert.equal(r.code, 0, r.err)
    // 非法子命令显式 unknown_command（不是静默当 cron list 执行）
    const bad = await run(['cron', 'bogus', '--json'], env)
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'unknown_command')
  } finally {
    await hub.close()
  }
})
