/**
 * Profile.starters 全链路边界测试：
 * 1. ProfileService.validateProfileInput / save / get：合法持久化、[] 保留、
 *    label trim 规范化、prompt 保留原文、超限/形状非法显式拒绝；
 * 2. HTTP 边界 parseProfileBody 同规（POST /api/profiles + GET 回读），
 *    未知键 starters 形状错误 400（不静默丢弃）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ProfileService } from '../src/services/profiles-skills.js'
import { AuthService } from '../src/services/auth.js'
import { createHubHandler, type KernelRuntimeLike } from '../src/http/index.js'
import { PROFILE_STARTERS_MAX_ITEMS } from '@helm/protocol'
import { PluginHost, type PluginDocStore } from '../src/plugins/index.js'
import { createProfilePlugin } from '../src/builtin-plugins/profile.js'
import { createProfileFileHost } from './helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'helm-starters-'))
}

test('profiles starters：合法输入持久化、label trim、prompt 保留原文、空数组显式保留', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir()
  const profiles = new ProfileService(dataDir)

  const saved = await profiles.save({
    id: 'p1',
    name: '引导角色',
    starters: [
      { label: '  写周报  ', prompt: '请汇总本周的工作进展' },
      { label: '代码审查', prompt: '审查当前分支的改动\n\n保留换行与缩进' },
    ],
  })
  assert.deepEqual(saved.starters, [
    { label: '写周报', prompt: '请汇总本周的工作进展' },
    { label: '代码审查', prompt: '审查当前分支的改动\n\n保留换行与缩进' },
  ])

  // 磁盘原样可读（热重载同通道 get）
  const reread = await profiles.get('p1')
  assert.deepEqual(reread?.starters, saved.starters)
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'profiles', 'p1', 'profile.json'), 'utf8')) as {
    starters?: unknown
  }
  assert.ok(Array.isArray(onDisk.starters), 'starters 必须落盘')

  // 空数组显式保留（清空语义），不是删除键
  const cleared = await profiles.save({ id: 'p1', name: '引导角色', starters: [] })
  assert.deepEqual(cleared.starters, [])
  const clearedReread = await profiles.get('p1')
  assert.deepEqual(clearedReread?.starters, [])

  // 缺省不写键
  const noKey = await profiles.save({ id: 'p2', name: '无引导词' })
  assert.equal(noKey.starters, undefined)
})

test('profiles starters：非法形状显式拒绝（不静默丢弃/截断）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()

  const bad: Array<[unknown, RegExp]> = [
    [{ id: 'bad', starters: 'not-array' }, /starters 必须是/],
    [{ id: 'bad', starters: [{ label: 'x', prompt: 'y', extra: 1 }] }, /仅接受 label 与 prompt 字段/],
    [{ id: 'bad', starters: [['label', 'prompt']] }, /starters\[0\] 必须是 \{ label, prompt \} 对象/],
    [{ id: 'bad', starters: [{ label: '', prompt: 'y' }] }, /label 去除首尾空白后不能为空/],
    [{ id: 'bad', starters: [{ label: '   ', prompt: 'y' }] }, /label 去除首尾空白后不能为空/],
    [{ id: 'bad', starters: [{ label: 'x', prompt: '' }] }, /prompt 不能是纯空白/],
    [{ id: 'bad', starters: [{ label: 'x', prompt: ' \n\t ' }] }, /prompt 不能是纯空白/],
    [{ id: 'bad', starters: [{ label: 'x'.repeat(25), prompt: 'y' }] }, /label 最多 24/],
    [{ id: 'bad', starters: [{ label: 'x', prompt: 'y'.repeat(4001) }] }, /prompt 最多 4000/],
    [{ id: 'bad', starters: Array.from({ length: PROFILE_STARTERS_MAX_ITEMS + 1 }, (_, i) => ({ label: `s${i}`, prompt: 'p' })) }, /starters 最多 6 项/],
  ]
  for (const [input, pattern] of bad) {
    await assert.rejects(() => profiles.save(input), pattern)
  }

  // 代理对按 1 码点计：24 个 emoji 合法、25 个拒绝
  const emoji24 = '🎉'.repeat(24)
  const ok = await profiles.save({ id: 'emoji', starters: [{ label: emoji24, prompt: 'p' }] })
  assert.equal(ok.starters?.[0]?.label, emoji24)
  await assert.rejects(
    () => profiles.save({ id: 'emoji2', starters: [{ label: '🎉'.repeat(25), prompt: 'p' }] }),
    /label 最多 24/,
  )
})

// ---------------------------------------------------------------------------
// HTTP API 边界（真实 ProfileService + createHubHandler）
// ---------------------------------------------------------------------------

async function makeApiEnv(): Promise<{ handler: (req: Request) => Promise<Response>; token: string }> {
  const dataDir = await freshDir()
  const auth = new AuthService(dataDir)
  const { token } = await auth.setup('{{SECRET_qz8w4v2n}}')
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const events = { response: () => new Response(null, { status: 204 }) }
  const kernel = {
    dataDir,
    auth,
    events,
    profiles,
    plugins: { listRoutes: () => [] },
  } as unknown as KernelRuntimeLike
  return { handler: createHubHandler(kernel), token }
}

async function apiCall(
  handler: (req: Request) => Promise<Response>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await handler(
    new Request(`http://127.0.0.1:3202${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(body !== undefined ? {} : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null }
}

test('profiles starters HTTP：POST/GET 回读、PUT [] 清空、非法 400 不落盘', { timeout: 60_000 }, async () => {
  const { handler, token } = await makeApiEnv()

  // POST 带 starters：落盘 + 回读（label trim、prompt 原文）
  const created = await apiCall(handler, token, 'POST', '/api/profiles', {
    id: 'api-p1',
    name: 'API 角色',
    starters: [{ label: ' 整理 inbox ', prompt: '请整理我的收件箱' }],
  })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  assert.deepEqual(created.json.starters, [{ label: '整理 inbox', prompt: '请整理我的收件箱' }])

  const got = await apiCall(handler, token, 'GET', '/api/profiles/api-p1')
  assert.equal(got.status, 200)
  assert.deepEqual(got.json.starters, [{ label: '整理 inbox', prompt: '请整理我的收件箱' }])

  // PUT []：显式清空（回宿主默认提示），不是删除键
  const cleared = await apiCall(handler, token, 'PUT', '/api/profiles/api-p1', {
    id: 'api-p1',
    name: 'API 角色',
    starters: [],
  })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
  assert.deepEqual(cleared.json.starters, [])

  // 非法形状 400（服务不落盘、不静默丢弃）
  const bad = await apiCall(handler, token, 'PUT', '/api/profiles/api-p1', {
    id: 'api-p1',
    name: 'API 角色',
    starters: [{ label: 'x', prompt: '' }],
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'validation_error')
  assert.match(bad.json.error.message, /prompt 不能是纯空白/)
  // 拒绝后磁盘仍保留上一步的 []
  const after = await apiCall(handler, token, 'GET', '/api/profiles/api-p1')
  assert.deepEqual(after.json.starters, [])

  // 超上限 400
  const tooMany = await apiCall(handler, token, 'PUT', '/api/profiles/api-p1', {
    id: 'api-p1',
    starters: Array.from({ length: PROFILE_STARTERS_MAX_ITEMS + 1 }, (_, i) => ({ label: `s${i}`, prompt: 'p' })),
  })
  assert.equal(tooMany.status, 400)
  assert.match(tooMany.json.error.message, /最多 6 项/)
})

test('profile：自举补写默认 Profile 的 managedByPlugin（缺失显式补、已有原样保留）', { timeout: 60_000 }, async () => {
  // 场景 1：ensureDefault 创建的 Profile 无托管元数据（服务层不做归一化），
  // 插件 service.start 显式补写 managedByPlugin: builtin:profile。
  const dataDir = await freshDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  try {
    const before = await profiles.get('assistant')
    assert.equal(before?.managedByPlugin, undefined, 'ensureDefault 不写托管元数据（不兼容归一化红线）')

    class MemoryDocStore implements PluginDocStore {
      readonly store = new Map<string, unknown>()
      get<T>(key: string, initial: T): T { return this.store.has(key) ? (this.store.get(key) as T) : initial }
      set<T>(key: string, value: T): void { this.store.set(key, structuredClone(value)) }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
      async flush(): Promise<void> {}
    }

    const host = new PluginHost({
      dataDir,
      host: Object.assign(createPluginHostBackendFixture(), createProfileFileHost(dataDir, profiles), {
        emitEvent: async () => {},
      }),
      docs: new MemoryDocStore(),
    })
    await host.register(createProfilePlugin(), { enabled: true })

    const after = await profiles.get('assistant')
    assert.equal(after?.managedByPlugin, 'builtin:profile', '插件自举后默认 Profile 显式声明托管')
    // 其余字段原样保留（不覆盖用户改动）
    assert.equal(after?.name, before?.name)

    await host.dispose().catch(() => {})
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
