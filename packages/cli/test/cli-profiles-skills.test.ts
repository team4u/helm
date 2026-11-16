/**
 * profiles --skills/--all-skills CLI 测试：临时 HTTP server 模拟 Hub 契约。
 * 覆盖：create/update 白名单写入、[] 禁用、--all-skills 删键恢复全部、
 * 互斥与非法列表本地拒绝、合并基底保留 node/cwd/runtime/tags、
 * --input 整体替换与组合覆盖、--json 输出与 --help 帮助。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

/** 模拟 Hub 侧已有 Profile（含 runtime/tags/nodeId/cwd 与旧 skills 白名单）。 */
const EXISTING_WORKER = {
  id: 'worker',
  name: 'Worker',
  model: 'faux/model',
  thinkingLevel: 'medium',
  nodeId: 'node-a',
  cwd: '/srv/work',
  tags: ['ci'],
  runtime: { kind: 'herdr', agent: 'pi', nodeId: 'node-a', workspace: '/srv/work' },
  skills: ['git-commit', 'herdr'],
  system: '# SYSTEM',
}

test('profiles create --skills：白名单写入 body；[] 表示无技能', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['profiles', 'create', 'reviewer', '--name', '审查员', '--skills', '["git-commit"]', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST' && h.path === '/api/profiles')!
  assert.deepEqual(hit.body, { id: 'reviewer', name: '审查员', skills: ['git-commit'] })
  assert.deepEqual(JSON.parse(r.out), { id: 'reviewer', name: '审查员', skills: ['git-commit'] })

  // 空数组 = 显式禁用全部技能（键必须存在且为 []，不得被丢弃或转 undefined）
  const empty = await runCliCaptured(['profiles', 'create', 'minimal', '--skills', '[]', '--json'], env)
  assert.equal(empty.code, 0, empty.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { id: 'minimal', skills: [] })
})

test('profiles update --skills：GET 合并后仅替换 skills，nodeId/cwd/runtime/tags 全保留', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--skills', '["git-commit"]', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT' && h.path === '/api/profiles/worker')!
  assert.deepEqual(put.body, {
    id: 'worker',
    name: 'Worker',
    model: 'faux/model',
    thinkingLevel: 'medium',
    nodeId: 'node-a',
    cwd: '/srv/work',
    tags: ['ci'],
    runtime: EXISTING_WORKER.runtime,
    skills: ['git-commit'],
  })
  // GET 带回的 system 全文不回传（剥离规则不变；MEMORY.md 由 builtin:memory 管理）
  const body = put.body as Record<string, unknown>
  assert.equal('system' in body, false)
})

test('profiles update --skills "[]"：空数组透传（禁用全部，不丢键）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--skills', '[]', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual((put.body as Record<string, unknown>).skills, [])
  // 其余绑定字段仍在
  assert.equal((put.body as Record<string, unknown>).nodeId, 'node-a')
  assert.equal((put.body as Record<string, unknown>).cwd, '/srv/work')
})

test('profiles update --all-skills：删除合并后的 skills 键恢复全部可用技能', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--all-skills', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  const body = put.body as Record<string, unknown>
  assert.equal('skills' in body, false, 'skills 键必须被删除（undefined = 全部技能）')
  assert.equal(body.nodeId, 'node-a')
  assert.equal(body.cwd, '/srv/work')
  assert.deepEqual(body.runtime, EXISTING_WORKER.runtime)
  assert.deepEqual(body.tags, ['ci'])
})

test('--skills 与 --all-skills 互斥：create/update 均本地拒绝 conflicting_flags（不发请求）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const create = await runCliCaptured(['profiles', 'create', 'x', '--skills', '["a"]', '--all-skills', '--json'], env)
  assert.equal(create.code, 1)
  assert.equal(parseCliError(create).code, 'conflicting_flags')
  assert.equal(hub.hits.filter((h) => h.path === '/api/profiles').length, 0, '互斥错误必须在发请求前拒绝')

  const update = await runCliCaptured(['profiles', 'update', 'x', '--skills', '["a"]', '--all-skills', '--json'], env)
  assert.equal(update.code, 1)
  assert.equal(parseCliError(update).code, 'conflicting_flags')
})

test('非法 --skills 列表本地拒绝：非字符串数组 / 非数组 JSON', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const numbers = await runCliCaptured(['profiles', 'create', 'x', '--skills', '[1,2]', '--json'], env)
  assert.equal(numbers.code, 1)
  assert.equal(parseCliError(numbers).code, 'invalid_flag_value')

  const mixed = await runCliCaptured(['profiles', 'create', 'x', '--skills', '["a",1]', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'invalid_flag_value')

  const notArray = await runCliCaptured(['profiles', 'create', 'x', '--skills', '"git-commit"', '--json'], env)
  assert.equal(notArray.code, 1)
  assert.equal(parseCliError(notArray).code, 'invalid_flag_value')

  const update = await runCliCaptured(['profiles', 'update', 'x', '--skills', '{"a":1}', '--json'], env)
  assert.equal(update.code, 1)
  assert.equal(parseCliError(update).code, 'invalid_flag_value')
})

test('--input 整体替换语义保持：skills 键原样透传；与语义化 flag 组合时覆盖对应字段', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'PUT /api/profiles/solo': (body) => ({ body }) }, { autoRegisterCleanup: t })

  // --input 单独使用：全量替换，skills 原样（含 undefined 语义：不带 skills 键）
  const whole = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"name":"Solo","nodeId":"node-b","cwd":"/w"}', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(whole.code, 0, whole.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual(put.body, { name: 'Solo', nodeId: 'node-b', cwd: '/w', id: 'solo' })
  assert.equal(hub.hits.some((h) => h.method === 'GET'), false, '纯 --input 不触发 GET 合并')

  // --input 携带 skills 与 --skills 同给：语义化 flag 覆盖对应字段
  const hub2 = await startMockHub(
    {
      'GET /api/profiles/solo': () => ({ body: { id: 'solo', name: 'Solo', skills: ['old'] } }),
      'PUT /api/profiles/solo': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env2 = makeCliEnv(hub2.url, dir)
  const combined = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"name":"Solo","skills":["from-input"]}', '--skills', '["git-commit"]', '--json'],
    env2,
  )
  assert.equal(combined.code, 0, combined.err)
  const put2 = hub2.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual((put2.body as Record<string, unknown>).skills, ['git-commit'])

  // --input 携带 skills 与 --all-skills 同给：合并层先赋值、语义层删键，最终无 skills
  const withAll = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"skills":["from-input"]}', '--all-skills', '--json'],
    env2,
  )
  assert.equal(withAll.code, 0, withAll.err)
  const put3 = hub2.hits.filter((h) => h.method === 'PUT').at(-1)!
  assert.equal('skills' in (put3.body as Record<string, unknown>), false)
})

test('--help 与 --json 输出：帮助展示 --skills/--all-skills，JSON 输出 Hub 回显', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const createHelp = await runCliCaptured(['profiles', 'create', '--help'], env)
  assert.equal(createHelp.code, 0)
  assert.match(createHelp.out, /--skills <json>/)
  assert.match(createHelp.out, /--all-skills <boolean>/)
  assert.match(createHelp.out, /互斥/)

  const updateHelp = await runCliCaptured(['profiles', 'update', '--help'], env)
  assert.equal(updateHelp.code, 0)
  assert.match(updateHelp.out, /--skills <json>/)
  assert.match(updateHelp.out, /--all-skills <boolean>/)

  // --json 模式输出 Hub 响应原文（含 skills 字段）
  const r = await runCliCaptured(['profiles', 'create', 'bot', '--skills', '["git-commit","herdr"]', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { id: 'bot', skills: ['git-commit', 'herdr'] })
})
