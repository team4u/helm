/**
 * 动态插件命令边界测试（零业务特判）：
 * - manifest 外部输入校验：positional field 存在性、readFileInto 目标 string、
 *   required 连续性、重复 field/目标、timeoutMs 形状——CLI 侧显式报错，不依赖服务端。
 * - readFileInto 位置参数：路径形态跨平台识别（POSIX/win32/~/显式相对）、
 *   目录与权限等 IO 故障显式诊断（只把 ENOENT 且非路径形态当普通值）。
 * - 位置参数与同名属性 flag 冲突显式报错；--input 与 flags/positionals 互斥。
 * - positional 按 schema 类型转换（number 字段转数字、string 保持 string）。
 * - 真正通用的虚拟插件（非 workflow）：positional + readFileInto + timeoutMs 组合复用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

/** 模拟 Hub：manifests 注入 GET /api/actions；动作端点统一回显 body 便于断言透传。 */
async function startHub(
  manifests: readonly unknown[],
): Promise<{ url: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
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
      hits.push({ method: req.method!, path: req.url!, body })
      if (req.url === '/api/actions' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(manifests))
        return
      }
      if (req.url !== undefined && req.url.startsWith('/api/actions/') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ received: body }))
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
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-dyn-'))
}

function errorCode(result: { err: string }): string {
  return (JSON.parse(result.err) as { error: { code: string } }).error.code
}

/** --json 错误信封的 message 字段（断言文本时避免与 JSON 转义引号缠斗）。 */
function errorMessage(result: { err: string }): string {
  return (JSON.parse(result.err) as { error: { message: string } }).error.message
}

// ---------------------------------------------------------------------------
// manifest 校验（外部输入在 CLI 边界显式报错）
// ---------------------------------------------------------------------------

/** 构造最小动作 manifest（cli 可覆盖）。 */
function action(cli: unknown, properties: Record<string, unknown> = {}, required: string[] = []): unknown {
  return {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: '部署小工具',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli,
  }
}

test('manifest 校验：positional field 必须存在于 inputSchema.properties', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub([action({ command: ['gadget', 'deploy'], positional: [{ field: 'ghost' }] })])
  try {
    const r = await run(['gadget', 'deploy', 'x', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 1)
    assert.equal(errorCode(r), 'invalid_action_manifest')
    assert.match(errorMessage(r), /ghost/)
  } finally {
    await hub.close()
  }
})

test('manifest 校验：readFileInto 目标需存在且为 string 类型；重复 field/目标拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const cases: Array<{ cli: unknown; properties: Record<string, unknown>; match: RegExp }> = [
    {
      // 目标字段不存在
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'missing' }] },
      properties: { src: { type: 'string' } },
      match: /missing.*不在 inputSchema\.properties/,
    },
    {
      // 目标字段类型非 string（object）
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'payload' }] },
      properties: { src: { type: 'string' }, payload: { type: 'object' } },
      match: /需为 type: string 属性/,
    },
    {
      // 枚举数字形态（flagTypeOf 会当 string）：readFileInto 目标必须是真 type:'string'，枚举拒绝
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'mode' }] },
      properties: { src: { type: 'string' }, mode: { enum: ['a', 'b'] } },
      match: /需为 type: string 属性/,
    },
    {
      // field 重复
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src' }, { field: 'src' }] },
      properties: { src: { type: 'string' } },
      match: /重复写入字段 "src"/,
    },
    {
      // readFileInto 目标与另一 positional field 撞
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'payload' }, { field: 'payload' }] },
      properties: { src: { type: 'string' }, payload: { type: 'string' } },
      match: /重复写入字段 "payload"/,
    },
    {
      // 两个 positional 读入同一目标
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'a', readFileInto: 'payload' }, { field: 'b', readFileInto: 'payload' }] },
      properties: { a: { type: 'string' }, b: { type: 'string' }, payload: { type: 'string' } },
      match: /重复写入字段 "payload"/,
    },
  ]
  for (const c of cases) {
    const hub = await startHub([action(c.cli, c.properties)])
    try {
      const r = await run(['gadget', 'deploy', 'a', 'b', '--json'], makeEnv(hub.url, dir))
      assert.equal(r.code, 1)
      assert.equal(errorCode(r), 'invalid_action_manifest')
      assert.match(errorMessage(r), c.match)
    } finally {
      await hub.close()
    }
  }
})

test('manifest 校验：required positional 不得出现在 optional 之后；timeoutMs 形状', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const cases: Array<{ cli: unknown; match: RegExp }> = [
    {
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'opt' }, { field: 'req', required: true }] },
      match: /req.*出现在 optional 之后/,
    },
    { cli: { command: ['gadget', 'deploy'], timeoutMs: -1 }, match: /timeoutMs/ },
    { cli: { command: ['gadget', 'deploy'], timeoutMs: Number.POSITIVE_INFINITY }, match: /timeoutMs/ },
    { cli: { command: ['gadget', 'deploy'], timeoutMs: 'fast' }, match: /timeoutMs/ },
  ]
  for (const c of cases) {
    const hub = await startHub([action(c.cli, { opt: { type: 'string' }, req: { type: 'string' } })])
    try {
      const r = await run(['gadget', 'deploy', 'a', '--json'], makeEnv(hub.url, dir))
      assert.equal(r.code, 1)
      assert.equal(errorCode(r), 'invalid_action_manifest')
      assert.match(errorMessage(r), c.match)
    } finally {
      await hub.close()
    }
  }

  // 合法形状：timeoutMs=0（无超时）与正数均接受
  for (const timeoutMs of [0, 30_000]) {
    const hub = await startHub([action({ command: ['gadget', 'deploy'], timeoutMs }, { note: { type: 'string' } })])
    try {
      const r = await run(['gadget', 'deploy', '--note', 'x', '--json'], makeEnv(hub.url, dir))
      assert.equal(r.code, 0, r.err)
    } finally {
      await hub.close()
    }
  }
})

test('manifest 校验：positional field 撞保留 flag 名（input/current）拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub([
    action({ command: ['gadget', 'deploy'], positional: [{ field: 'current' }] }, { current: { type: 'string' } }),
  ])
  try {
    const r = await run(['gadget', 'deploy', 'x', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 1)
    assert.equal(errorCode(r), 'invalid_action_manifest')
    assert.match(errorMessage(r), /撞保留 flag 名/)
  } finally {
    await hub.close()
  }
})

test('manifest 校验：未知键与原型污染字段名拒绝；继承属性不算自有', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // field 声明为 toString：`in` 会放行（继承），hasOwn 拒绝
  const hubToString = await startHub([
    action({ command: ['gadget', 'deploy'], positional: [{ field: 'toString' }] }, {}),
  ])
  try {
    const r = await run(['gadget', 'deploy', 'x', '--json'], makeEnv(hubToString.url, dir))
    assert.equal(r.code, 1)
    assert.equal(errorCode(r), 'invalid_action_manifest')
    assert.match(errorMessage(r), /toString.*不在 inputSchema\.properties/)
  } finally {
    await hubToString.close()
  }

  // JSON 文本可携带自有 __proto__ 键：普通对象赋值会静默丢失/改原型，必须拒绝
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const hub = await startHub([
      action({ command: ['gadget', 'deploy'], positional: [{ field: bad }] }, {}),
    ])
    try {
      const r = await run(['gadget', 'deploy', 'x', '--json'], makeEnv(hub.url, dir))
      assert.equal(r.code, 1, bad)
      assert.equal(errorCode(r), 'invalid_action_manifest', bad)
      assert.match(errorMessage(r), /原型污染键/, bad)
    } finally {
      await hub.close()
    }
    // readFileInto 目标同理拒绝
    const hub2 = await startHub([
      action(
        { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: bad }] },
        { src: { type: 'string' } },
      ),
    ])
    try {
      const r = await run(['gadget', 'deploy', 'x', '--json'], makeEnv(hub2.url, dir))
      assert.equal(r.code, 1, bad)
      assert.equal(errorCode(r), 'invalid_action_manifest', bad)
    } finally {
      await hub2.close()
    }
  }

  // 未知键（拼写错误等）：拒绝而非静默忽略
  const hubUnknown = await startHub([
    action(
      { command: ['gadget', 'deploy'], positional: [{ field: 'src', dest: 'payload' }] },
      { src: { type: 'string' } },
    ),
  ])
  try {
    const r = await run(['gadget', 'deploy', 'x', '--json'], makeEnv(hubUnknown.url, dir))
    assert.equal(r.code, 1)
    assert.equal(errorCode(r), 'invalid_action_manifest')
    assert.match(errorMessage(r), /未知键 .?dest/)
  } finally {
    await hubUnknown.close()
  }
})

test('positional 类型转换：boolean 严格 true/false、json 按类型解析、string 原样', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const manifest = {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: '部署小工具',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dryRun: { type: 'boolean' },
        labels: { type: 'array', items: { type: 'string' } },
        spec: { type: 'object' },
        anything: {}, // 无 type 宽松 schema -> JSON 传递
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    cli: {
      command: ['gadget', 'deploy'],
      positional: [{ field: 'name' }, { field: 'dryRun' }, { field: 'labels' }, { field: 'spec' }, { field: 'anything' }],
    },
  }
  const hub = await startHub([manifest])
  const env = makeEnv(hub.url, dir)
  const inputOfLast = (): Record<string, unknown> =>
    ((hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } } | undefined)?.body as { input?: Record<string, unknown> })?.input ?? {}
  try {
    // string / boolean / array / object / 无 type 全链路转换
    const r = await run(
      ['gadget', 'deploy', 'demo', 'true', ' ["a","b"] ', '{"k":1}', '[1,2]'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    const input = inputOfLast()
    assert.equal(input.name, 'demo')
    assert.equal(input.dryRun, true)
    assert.deepEqual(input.labels, ['a', 'b'])
    assert.deepEqual(input.spec, { k: 1 })
    assert.deepEqual(input.anything, [1, 2])

    // boolean 非严格值：本地显式报错
    const badBool = await run(['gadget', 'deploy', 'demo', 'yes', '[]', '{}', 'null', '--json'], env)
    assert.equal(badBool.code, 1)
    assert.equal(errorCode(badBool), 'invalid_flag_value')
    assert.match(errorMessage(badBool), /dryRun.*true\/false/)

    // json 位置参数非法 JSON：本地显式报错（不发请求）
    const badJson = await run(['gadget', 'deploy', 'demo', 'true', 'not-json', '{}', 'null', '--json'], env)
    assert.equal(badJson.code, 1)
    assert.equal(errorCode(badJson), 'invalid_flag_value')
    assert.match(errorMessage(badJson), /labels.*JSON/)

    // 纯文本模式（无 --json）同样拦截
    const badJsonHuman = await run(['gadget', 'deploy', 'demo', 'true', 'not-json', '{}', 'null'], env)
    assert.equal(badJsonHuman.code, 1)
    assert.match(badJsonHuman.err, /位置参数/)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// readFileInto 位置参数：路径识别与 IO 诊断
// ---------------------------------------------------------------------------

/** 带 readFileInto 的 gadget manifest。 */
const READ_FILE_MANIFEST = {
  pluginId: 'builtin:gadget',
  id: 'deploy',
  description: '部署小工具',
  inputSchema: {
    type: 'object',
    properties: {
      src: { type: 'string' },
      payload: { type: 'string' },
      replicas: { type: 'number' },
    },
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  cli: {
    command: ['gadget', 'deploy'],
    positional: [{ field: 'src', readFileInto: 'payload' }, { field: 'replicas' }],
  },
}

test('readFileInto：文件读入目标字段；普通值按 schema 类型转换写入 field', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub([READ_FILE_MANIFEST])
  const env = makeEnv(hub.url, dir)
  try {
    const scriptPath = path.join(dir, 'site.workflow.js')
    await fsp.writeFile(scriptPath, 'export const meta = 1\n', 'utf8')

    // 文件 + 数字位置参数（replicas 为 number schema -> 转数字而非字符串）
    const r = await run(['gadget', 'deploy', scriptPath, '3', '--json'], env)
    assert.equal(r.code, 0, r.err)
    const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
    assert.equal(body?.input?.payload, 'export const meta = 1\n')
    assert.equal(body?.input?.replicas, 3)
    assert.equal(body?.input?.src, undefined)

    // 非路径形态 + ~/ 展开：~ 不存在文件时（路径形态）显式报错
    const byValue = await run(['gadget', 'deploy', 'saved-name', '2', '--json'], env)
    assert.equal(byValue.code, 0, byValue.err)
    const valueBody = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
    assert.equal(valueBody?.input?.src, 'saved-name')
    assert.equal(valueBody?.input?.replicas, 2)

    const tildeMissing = await run(['gadget', 'deploy', '~/definitely-missing-file.js', '2', '--json'], env)
    assert.equal(tildeMissing.code, 1)
    assert.equal(errorCode(tildeMissing), 'positional_file_not_found')

    // 路径形态但目标不存在：显式报错（不静默当名字）
    for (const p of ['./nope.js', '/definitely/not/here.js', 'C:\\nope\\f.js', '\\\\srv\\share\\f.js']) {
      const miss = await run(['gadget', 'deploy', p, '1', '--json'], env)
      assert.equal(miss.code, 1, `应报错：${p}`)
      assert.equal(errorCode(miss), 'positional_file_not_found', p)
    }

    // Windows 反斜杠显式相对与 ~ 形态：同样是路径，缺文件不得静默当名字
    for (const p of ['.\\nope.js', '..\\nope.js', '~\\nope.js']) {
      const miss = await run(['gadget', 'deploy', p, '1', '--json'], env)
      assert.equal(miss.code, 1, `应报错：${p}`)
      assert.equal(errorCode(miss), 'positional_file_not_found', p)
    }

    // number schema 位置参数非法值：显式报错
    const badNum = await run(['gadget', 'deploy', 'x', 'NaN-ish', '--json'], env)
    assert.equal(badNum.code, 1)
    assert.equal(errorCode(badNum), 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

test('readFileInto：目录不是普通文件；权限故障不静默当名字', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub([READ_FILE_MANIFEST])
  const env = makeEnv(hub.url, dir)
  try {
    // 已存在目录（哪怕不带 ./ 前缀）：不静默当 workflow 名，显式报错
    const sub = path.join(dir, 'sub')
    await fsp.mkdir(sub)
    const asDir = await run(['gadget', 'deploy', sub, '1', '--json'], env)
    assert.equal(asDir.code, 1)
    assert.equal(errorCode(asDir), 'positional_not_a_file')
    assert.match(errorMessage(asDir), /不是普通文件/)

    // ./ 前缀目录同样不静默当名字：相对 cwd 解析后不存在 -> 路径形态显式报错
    const asRelDir = await run(['gadget', 'deploy', './sub', '1', '--json'], env)
    assert.equal(asRelDir.code, 1)
    assert.equal(errorCode(asRelDir), 'positional_file_not_found')

    // ./ 前缀且真实存在（相对 cwd 构造）：目录同样拒绝
    const relDir = path.join(dir, 'rel-sub')
    await fsp.mkdir(relDir)
    const rel = path.relative(process.cwd(), relDir)
    const asRelExists = await run(['gadget', 'deploy', `./${rel}`, '1', '--json'], env)
    assert.equal(asRelExists.code, 1)
    assert.equal(errorCode(asRelExists), 'positional_not_a_file')

    // 无读权限文件：EACCES 显式诊断（不静默当名字、不静默跳过）。
    // root 可绕过文件权限（DAC override），此时读成功属真实内核行为，跳过断言。
    const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false
    if (process.platform !== 'win32' && !isRoot) {
      const locked = path.join(dir, 'locked.js')
      await fsp.writeFile(locked, 'secret\n', 'utf8')
      await fsp.chmod(locked, 0o000)
      try {
        const denied = await run(['gadget', 'deploy', locked, '1', '--json'], env)
        assert.equal(denied.code, 1)
        assert.equal(errorCode(denied), 'positional_file_unreadable')
      } finally {
        await fsp.chmod(locked, 0o644).catch(() => {})
      }
    }
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// positional 与 flag 冲突 / --input 互斥语义
// ---------------------------------------------------------------------------

test('positional 与同名属性 flag 冲突显式报错（不悄悄覆盖）；--input 仍整体保真', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub([READ_FILE_MANIFEST])
  const env = makeEnv(hub.url, dir)
  try {
    const scriptPath = path.join(dir, 'a.js')
    await fsp.writeFile(scriptPath, 'A\n', 'utf8')

    // --src flag 与位置参数同时给 src：冲突报错
    const clashField = await run(['gadget', 'deploy', 'saved', '1', '--src', 'x', '--json'], env)
    assert.equal(clashField.code, 1)
    assert.equal(errorCode(clashField), 'conflicting_positional')

    // 文件位置参数读入 payload，同时又 --payload：readFileInto 目标也冲突报错
    const clashTarget = await run(['gadget', 'deploy', scriptPath, '1', '--payload', 'inline', '--json'], env)
    assert.equal(clashTarget.code, 1)
    assert.equal(errorCode(clashTarget), 'conflicting_positional')

    // --input 整体与位置参数互斥（沿用 unexpected_positional 语义）
    const mixed = await run(['gadget', 'deploy', 'saved', '1', '--input', '{"src":"x"}', '--json'], env)
    assert.equal(mixed.code, 1)
    assert.equal(errorCode(mixed), 'unexpected_positional')

    // --input 原样保真（不与任何 positional/flag 组合）
    const whole = await run(['gadget', 'deploy', '--input', '{"src":"x","replicas":9}', '--json'], env)
    assert.equal(whole.code, 0, whole.err)
    const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
    assert.deepEqual(body?.input, { src: 'x', replicas: 9 })
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 通用虚拟插件复用：positional + readFileInto + timeoutMs 组合（非 workflow 域）
// ---------------------------------------------------------------------------

test('通用虚拟插件动态命令：positional+file+timeoutMs 完整链路复用（--current 仅注入上下文）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // 与 workflow 无关的域（报表导出）：证明扩展点通用可复用
  const manifest = {
    pluginId: 'builtin:reporter',
    id: 'render',
    description: '渲染报表',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string' },
        body: { type: 'string' },
        format: { type: 'string' },
        page: { type: 'number' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    cli: {
      command: ['reporter', 'render'],
      positional: [
        { field: 'template', required: true, readFileInto: 'body' },
        { field: 'page' },
      ],
      timeoutMs: 0,
    },
  }
  const hub = await startHub([manifest])
  try {
    const tpl = path.join(dir, 'tpl.md')
    await fsp.writeFile(tpl, '# 标题\n正文\n', 'utf8')
    const env = makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '5' })

    // 文件位置参数 + string flag + number positional；--current 只注入 body.conversationId
    const r = await run(['reporter', 'render', tpl, '2', '--format', 'pdf', '--current', '--json'], env)
    assert.equal(r.code, 0, r.err)
    const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown>; conversationId?: number } }).body
    assert.equal(body?.input?.body, '# 标题\n正文\n')
    assert.equal(body?.input?.template, undefined)
    assert.equal(body?.input?.format, 'pdf')
    assert.equal(body?.input?.page, 2)
    assert.equal(body?.conversationId, 5)

    // 人类模式：通用 key-value 输出（无业务识别；received 回显 body）
    const human = await run(['reporter', 'render', tpl, '2'], makeEnv(hub.url, dir))
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /received/)

    // 不带 --current：不伪造任何会话 ID
    const plain = await run(['reporter', 'render', tpl, '1', '--json'], makeEnv(hub.url, dir))
    assert.equal(plain.code, 0, plain.err)
    const plainBody = (hub.hits.at(-1) as { body?: { conversationId?: number } }).body
    assert.equal(plainBody?.conversationId, undefined)

    // required positional 缺失：missing_positional
    const missing = await run(['reporter', 'render', '--json'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.equal(errorCode(missing), 'missing_positional')

    // 帮助来自动态 manifest（含位置参数签名与 timeout 动作无特殊化文案）
    const help = await run(['reporter', 'render', '--help'], makeEnv(hub.url, dir))
    assert.equal(help.code, 0)
    assert.match(help.out, /<template> \[page\]/)
    assert.match(help.out, /--format <string>/)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// --wait 语义核查（timeoutMs=0 透传；failed 终态由服务端错误信封驱动非零退出）
// ---------------------------------------------------------------------------

test('--wait 失败终态：服务端 workflow_failed 信封 -> 非零退出；--json 保真错误 details', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // 复用读文件 manifest 但让服务端返回失败信封：验证 CLI 不把 HTTP 200/500 语义伪装成成功
  const failServer = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.url === '/api/actions' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([READ_FILE_MANIFEST]))
        return
      }
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'workflow_failed', message: 'boom', details: { runId: 'wf_9', status: 'failed' } } }))
    })
  })
  await new Promise<void>((resolve) => failServer.listen(0, '127.0.0.1', resolve))
  const addr = failServer.address() as { port: number }
  try {
    const env = makeEnv(`http://127.0.0.1:${addr.port}`, dir)
    const r = await run(['gadget', 'deploy', 'x', '1', '--json'], env)
    assert.equal(r.code, 1)
    const parsed = JSON.parse(r.err) as { error: { code: string; details?: { runId?: string } } }
    assert.equal(parsed.error.code, 'workflow_failed')
    assert.equal(parsed.error.details?.runId, 'wf_9')
  } finally {
    await new Promise<void>((resolve) => failServer.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// cli.timeoutMs 透传：小超时覆盖实例默认并真实生效；0 表示不施加超时
// ---------------------------------------------------------------------------

test('cli.timeoutMs 覆盖真实生效：300ms 慢响应按覆盖值超时且错误信息含真实毫秒', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const manifest = {
    pluginId: 'builtin:gadget', id: 'deploy', description: 'd',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli: { command: ['gadget', 'deploy'], timeoutMs: 300 },
  }
  const hub = await startHub([manifest])
  // 在 startHub 之上叠一层延迟：动作请求 5s 后才响应
  const slow = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.url === '/api/actions' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([manifest]))
        return
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ slow: true }))
      }, 5000)
    })
  })
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r))
  const slowUrl = `http://127.0.0.1:${(slow.address() as { port: number }).port}`
  try {
    const env = makeEnv(slowUrl, dir)
    const started = Date.now()
    const r = await run(['gadget', 'deploy', '--json'], env)
    const elapsed = Date.now() - started
    assert.equal(r.code, 1)
    assert.ok(elapsed < 3000, `应在覆盖的 300ms 超时而非 ${elapsed}ms`)
    const parsed = JSON.parse(r.err) as { error: { code: string; message: string } }
    assert.equal(parsed.error.code, 'timeout')
    assert.match(parsed.error.message, /300ms/, '错误信息需含真实覆盖毫秒数而非实例默认 30000ms')
  } finally {
    await hub.close()
    await new Promise<void>((r) => slow.close(() => r()))
  }
})

test('cli.timeoutMs=0：慢响应不施加请求超时（--wait 长等待可用）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const manifest = {
    pluginId: 'builtin:gadget', id: 'deploy', description: 'd',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli: { command: ['gadget', 'deploy'], timeoutMs: 0 },
  }
  const slow = http.createServer((req, res) => {
    if (req.url === '/api/actions' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([manifest]))
      return
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ done: true }))
    }, 1200)
  })
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r))
  try {
    const env = makeEnv(`http://127.0.0.1:${(slow.address() as { port: number }).port}`, dir)
    const r = await run(['gadget', 'deploy', '--json'], env)
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).done, true)
  } finally {
    await new Promise<void>((r) => slow.close(() => r()))
  }
})
