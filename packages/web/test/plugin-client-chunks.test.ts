/**
 * 共享 Chunk 桥（__helm_import_chunk）行为测试：
 * - preload fetch 并发去重：同一 chunk 多次引用零重复网络请求；
 * - 模块求值按拓扑顺序（共享表依赖先于使用者求值）；
 * - fetch 失败不产生 unhandled rejection（全部已启动 Promise 均被安全消费）；
 * - evict/reset 后迟到的 chunk 不得回写 __helm_chunk_share 或成功返回旧模块
 *   （epoch 守卫，显式 client_module_invalidated）；evict/reset 后可重试；
 * - __helm_chunk_share 按 pluginId + moduleRef + contentHash + chunk 隔离：
 *   两插件同源同 hash 时停用一个不删另一个的共享条目；
 * - 浏览器 Blob import 真实错误显式上报（不回退 data URL 掩盖）。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  evictPluginClientCache,
  resetPluginClientCache,
  PluginClientError,
} from '../src/lib/plugin-client.js'

GlobalRegistrator.register()

type ImportChunk = (
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
  preloads?: string[],
) => Promise<Record<string, unknown>>

const importChunk: ImportChunk = (globalThis as Record<string, unknown>).__helm_import_chunk as ImportChunk
const originalFetch = globalThis.fetch
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalBlob = globalThis.Blob

const evalLogSlot = globalThis as unknown as { __chunkEvalLog?: string[] }

/** 与编译器一致的共享表 key（pluginId \0 moduleRef \0 contentHash \0 chunk）。 */
const shareKey = (pluginId: string, moduleRef: string, contentHash: string, chunk: string): string =>
  `${pluginId}\0${moduleRef}\0${contentHash}\0${chunk}`

/**
 * chunk 夹具：
 * - fetch 按 chunk 名返回注册源；并发 fetch 也不会串内容；
 * - Blob 替身为同步可读文本（Node 无法 import blob: URL，createObjectURL 返回
 *   data URL 让模块真实求值——与浏览器 ESM 求值语义一致）；
 * - 每个 chunk 源尾部追加与编译器一致的 __helm_chunk_share 注册语句，
 *   真实驱动共享表写入（隔离清理与 epoch 守卫测试依赖真实注册行为）。
 */
function makeChunkFixture() {
  const sources = new Map<string, string>()
  const fetchLog: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = String(input)
    fetchLog.push(raw)
    const pluginId = decodeURIComponent(/^\/api\/plugins\/([^/]+)\//.exec(raw)?.[1] ?? '')
    const m = /[?&]chunk=([^&]+)/.exec(raw)
    const name = m ? decodeURIComponent(m[1]!) : ''
    // key = pluginId + chunk 名：两插件同名 chunk（同源同 hash 场景）各自注册独立的源
    const code = sources.get(`${pluginId}\0${name}`) ?? sources.get(name)
    if (code === undefined) return new Response('not found', { status: 404 })
    return new Response(code, { status: 200, headers: { 'content-type': 'text/javascript' } })
  }) as typeof fetch

  class SyncTextBlob {
    readonly __text: string
    constructor(parts: Array<string | BlobPart>) {
      this.__text = parts.map((p) => String(p)).join('')
    }
    get size(): number {
      return this.__text.length
    }
    get type(): string {
      return 'text/javascript'
    }
    text(): Promise<string> {
      return Promise.resolve(this.__text)
    }
  }
  ;(globalThis as { Blob: unknown }).Blob = SyncTextBlob
  let seq = 0
  URL.createObjectURL = ((blob: Blob) => {
    const text = (blob as unknown as { __text: string }).__text
    return `data:text/javascript,${encodeURIComponent(text)}#eval-${++seq}`
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  return {
    fetchLog,
    /** 注册一个 chunk：求值时记录顺序标记、写入共享表注册语句；marker 默认 chunk 名。
     * 源按 (pluginId, chunk) 登记：两插件同名 chunk 各自独立。 */
    addChunk(pluginId: string, moduleRef: string, contentHash: string, name: string, marker?: string, extra = ''): void {
      const m = marker ?? name
      const reg = `;(globalThis.__helm_chunk_share ??= {})[${JSON.stringify(shareKey(pluginId, moduleRef, contentHash, name))}] = { v: ${JSON.stringify(m)} };\n`
      sources.set(
        `${pluginId}\0${name}`,
        `globalThis.__chunkEvalLog?.push(${JSON.stringify(m)});${extra}\nexport const v = ${JSON.stringify(m)};\n${reg}`,
      )
    },
    /** 注册原生源（不经注册语句包装，用于求值错误等特殊场景）。 */
    addRawChunk(name: string, code: string): void {
      sources.set(name, code)
    },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
  ;(globalThis as { Blob: unknown }).Blob = originalBlob
  delete evalLogSlot.__chunkEvalLog
  delete (globalThis as Record<string, unknown>).__helm_chunk_share
  resetPluginClientCache()
})

test('preload 并发去重：同一 chunk 多次引用零重复网络请求，缓存命中不再 fetch', { timeout: 60_000 }, async () => {
  const fx = makeChunkFixture()
  evalLogSlot.__chunkEvalLog = []
  fx.addChunk('p', 'index.tsx', 'h1', 'dep1.js')
  fx.addChunk('p', 'index.tsx', 'h1', 'dep2.js')
  fx.addChunk('p', 'index.tsx', 'h1', 'main.js')
  // 同一 import_chunk 调用中 preload 重复 + 与目标 chunk 同名去重
  const mod = await importChunk('p', 'index.tsx', 'h1', 'main.js', ['dep1.js', 'dep1.js', 'dep2.js'])
  assert.equal(mod.v, 'main.js')
  assert.equal(fx.fetchLog.length, 3, '每个 chunk 恰好一次 fetch')
  const names = fx.fetchLog.map((u) => decodeURIComponent(/[?&]chunk=([^&]+)/.exec(u)?.[1] ?? ''))
  assert.deepEqual([...new Set(names)].sort(), ['dep1.js', 'dep2.js', 'main.js'].sort())
  // 再次调用（同 key 缓存命中）：零新增网络请求
  await importChunk('p', 'index.tsx', 'h1', 'main.js', ['dep1.js', 'dep2.js'])
  assert.equal(fx.fetchLog.length, 3, '缓存命中不得重新 fetch')
})

test('模块求值按拓扑顺序：preload（依赖）先于目标 chunk 求值', { timeout: 60_000 }, async () => {
  const fx = makeChunkFixture()
  evalLogSlot.__chunkEvalLog = []
  fx.addChunk('p', 'index.tsx', 'h1', 'shared.js', 'shared')
  fx.addChunk('p', 'index.tsx', 'h1', 'mid.js', 'mid')
  fx.addChunk('p', 'index.tsx', 'h1', 'leaf.js', 'leaf')
  await importChunk('p', 'index.tsx', 'h1', 'leaf.js', ['shared.js', 'mid.js'])
  const all = evalLogSlot.__chunkEvalLog ?? []
  assert.deepEqual(all.slice(0, -1), ['shared', 'mid'], 'preload 必须按给定拓扑顺序求值（依赖在前）')
  assert.equal(all[all.length - 1], 'leaf', '目标 chunk 最后求值')
})

test('preload fetch 失败：不产生 unhandled rejection，错误显式抛出，修复后可重试', { timeout: 60_000 }, async () => {
  const fx = makeChunkFixture()
  evalLogSlot.__chunkEvalLog = []
  const unhandled: unknown[] = []
  const onUnhandled = (err: unknown) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    fx.addChunk('p', 'index.tsx', 'h1', 'dep1.js', 'dep1')
    // dep2 / dep3 未注册：fetch 404
    const failing = importChunk('p', 'index.tsx', 'h1', 'leaf.js', ['dep1.js', 'dep2.js', 'dep3.js'])
    await assert.rejects(
      failing,
      (err: unknown) => err instanceof PluginClientError,
      '任一 preload 失败必须显式拒绝',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(unhandled.length, 0, '并发启动的其余 fetch Promise 必须被安全消费，不得产生 unhandled rejection')
    // 修复源后同 key 可重试（失败不毒化缓存）
    fx.addChunk('p', 'index.tsx', 'h1', 'dep2.js', 'dep2')
    fx.addChunk('p', 'index.tsx', 'h1', 'dep3.js', 'dep3')
    fx.addChunk('p', 'index.tsx', 'h1', 'leaf.js', 'leaf')
    const mod = await importChunk('p', 'index.tsx', 'h1', 'leaf.js', ['dep1.js', 'dep2.js', 'dep3.js'])
    assert.equal(mod.v, 'leaf')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('evict 清除本插件共享表条目；同 key 可重新加载', { timeout: 60_000 }, async () => {
  const fx = makeChunkFixture()
  evalLogSlot.__chunkEvalLog = []
  fx.addChunk('p', 'index.tsx', 'h1', 'dep1.js')
  fx.addChunk('p', 'index.tsx', 'h1', 'leaf.js')
  await importChunk('p', 'index.tsx', 'h1', 'leaf.js', ['dep1.js'])
  const share = (globalThis as Record<string, unknown>).__helm_chunk_share as Record<string, unknown>
  assert.ok(
    Object.hasOwn(share, shareKey('p', 'index.tsx', 'h1', 'leaf.js')),
    '共享表必须按 pluginId\\0module\\0hash\\0chunk 隔离登记',
  )
  evictPluginClientCache('p')
  assert.equal(Object.keys(share).length, 0, 'evict 必须清掉本插件全部共享表条目')
  // evict 后重新触发同 key 加载：可成功重载（不毒化）
  const mod = await importChunk('p', 'index.tsx', 'h1', 'leaf.js', ['dep1.js'])
  assert.equal(mod.v, 'leaf.js')
  assert.ok(Object.hasOwn(share, shareKey('p', 'index.tsx', 'h1', 'leaf.js')), '重载后共享表重新登记')
})

test('evict 竞态：fetch 在途时 evict，放行后显式失效且绝不求值旧产物', { timeout: 60_000 }, async () => {
  makeChunkFixture()
  evalLogSlot.__chunkEvalLog = []
  // 挂起 fetch：直到测试显式放行
  let respondFetch!: (code: string) => void
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    respondFetch = (code: string) => resolve(new Response(code, { status: 200 }))
  })) as typeof fetch
  const pending = importChunk('p', 'index.tsx', 'h1', 'leaf.js', [])
  await new Promise((resolve) => setTimeout(resolve, 10))
  evictPluginClientCache('p')
  respondFetch('export const v = "stale"')
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_invalidated',
    'evict 后迟到的 fetch 结果必须显式失效，不得求值',
  )
  assert.deepEqual(evalLogSlot.__chunkEvalLog ?? [], [], '失效后绝不求值旧产物')
  const share = (globalThis as Record<string, unknown>).__helm_chunk_share as Record<string, unknown> | undefined
  assert.equal(share === undefined ? 0 : Object.keys(share).length, 0, '失效后不得回写共享表')
})

test('共享表隔离：两插件同源同 hash，停用 A 不删 B 的共享条目，B 的 chunk 仍可加载', { timeout: 60_000 }, async () => {
  const fx = makeChunkFixture()
  evalLogSlot.__chunkEvalLog = []
  fx.addChunk('pluginA', 'index.tsx', 'samehash', 'shared.js', 'shared')
  fx.addChunk('pluginA', 'index.tsx', 'samehash', 'leaf.js', 'leaf')
  fx.addChunk('pluginB', 'index.tsx', 'samehash', 'shared.js', 'shared')
  fx.addChunk('pluginB', 'index.tsx', 'samehash', 'leaf.js', 'leaf')
  await importChunk('pluginA', 'index.tsx', 'samehash', 'leaf.js', ['shared.js'])
  await importChunk('pluginB', 'index.tsx', 'samehash', 'leaf.js', ['shared.js'])
  const share = (globalThis as Record<string, unknown>).__helm_chunk_share as Record<string, unknown>
  const bKeys = Object.keys(share).filter((k) => k.startsWith('pluginB\0'))
  assert.ok(
    Object.keys(share).some((k) => k.startsWith('pluginA\0')) && bKeys.length > 0,
    '两插件各自登记共享表（同源同 hash 不共享条目）',
  )
  evictPluginClientCache('pluginA')
  const remaining = Object.keys(share)
  assert.equal(remaining.filter((k) => k.startsWith('pluginA\0')).length, 0, '停用 A 后 A 的条目被清除')
  assert.equal(remaining.filter((k) => k.startsWith('pluginB\0')).length, bKeys.length, '停用 A 不得删 B 的共享条目')
  // B 的 chunk 仍可加载（缓存命中路径）
  const mod = await importChunk('pluginB', 'index.tsx', 'samehash', 'leaf.js', ['shared.js'])
  assert.equal(mod.v, 'leaf')
  resetPluginClientCache()
  assert.equal(Object.keys(share).length, 0, 'reset 清空全部共享表')
})

test('浏览器 Blob import 真实错误：不回退 data URL，模块求值错误原样抛出', { timeout: 60_000 }, async () => {
  const fx = makeChunkFixture()
  fx.addRawChunk('bad.js', 'throw new Error("chunk 求值失败")\nexport const v = 1\n')
  await assert.rejects(
    importChunk('p', 'index.tsx', 'h1', 'bad.js', []),
    (err: unknown) => err instanceof Error && /chunk 求值失败/.test(err.message),
    'Blob import 的真实求值错误必须原样抛出（不得被 data URL 回退吞掉）',
  )
})
