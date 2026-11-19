/**
 * Hub 集成测试共享环境与 fixture 辅助，复用 `@helmx/test-kit` 原语。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  makeConversationSummary,
  sleep,
  waitFor,
} from '@helmx/test-kit'
import { createGitTemplate, type GitTemplate } from '@helmx/test-kit/git'
import { cleanupDir, makeTempDir, useTempDir } from '@helmx/test-kit/node'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubHandler, startHub } from '../../../kernel/src/http/index.js'
import type { PluginConfigStore, PluginDocStore } from '../../../kernel/src/plugins/index.js'
import { createHelmx, type HelmxOptions } from '../../src/app.js'

export {
  cleanupDir,
  createGitTemplate,
  makeConversationSummary,
  makeTempDir,
  sleep,
  useTempDir,
  waitFor,
}
export type { GitTemplate }

export type FauxProviderOptions = Parameters<typeof fauxProvider>[0]
export type FauxProviderHandle = ReturnType<typeof fauxProvider>
export type ModelsRegistry = ReturnType<typeof createModels>

/** 创建并返回官方 faux provider 句柄（`KernelRuntimeOptions.providers`）。 */
export function makeFauxProvider(options?: FauxProviderOptions): FauxProviderHandle {
  return fauxProvider(options)
}

/** 创建并注册官方 faux provider 的 Models 实例。 */
export function makeFauxModels(options?: FauxProviderOptions): {
  models: ModelsRegistry
  faux: FauxProviderHandle
} {
  const faux = fauxProvider(options)
  const models = createModels()
  models.setProvider(faux.provider)
  return { models, faux }
}

export type HubTestApp = Awaited<ReturnType<typeof createHelmx>>

export interface CreateHubTestAppOptions extends HelmxOptions {
  fauxOptions?: FauxProviderOptions
}

/** 启动挂载 faux provider 的真实 `createHelmx` 实例（默认使用 `providers`，传 `models` 时回退外部 Models 实例）。 */
export async function createHubTestApp(options: CreateHubTestAppOptions = {}): Promise<{
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  models?: ModelsRegistry
}> {
  const { fauxOptions, models: providedModels, providers: providedProviders, buildProvider, model, ...rest } = options
  const faux = makeFauxProvider(fauxOptions)
  const app = await createHelmx({
    buildProvider: buildProvider ?? createPluginBuildProvider(),
    model: model ?? 'faux/faux-1',
    ...(providedModels !== undefined
      ? { models: providedModels }
      : { providers: providedProviders ?? [faux.provider] }),
    ...(providedModels !== undefined && providedProviders !== undefined ? { providers: providedProviders } : {}),
    ...rest,
  })
  return {
    app,
    kernel: app.kernel,
    faux,
    ...(providedModels !== undefined ? { models: providedModels as ModelsRegistry } : {}),
  }
}

export interface HubTestEnv {
  dataDir: string
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  models?: ModelsRegistry
  close: () => Promise<void>
}

export interface OpenHubTestEnvOptions extends CreateHubTestAppOptions {
  /** 临时目录前缀（仅在未传 dataDir 时生效）。 */
  prefix?: string
  /** 是否忽略 app.close() 异常（少数测试在已有已知底座关闭缺陷痕迹时显式开启）。 */
  swallowCloseError?: boolean
}

/**
 * 创建自带临时 `dataDir`（若未显式提供）的真实 `createHelmx` 环境。
 * 仅当目录由本函数自建时，`close` 才会递归清理该目录。
 */
export async function openHubTestEnv(options: OpenHubTestEnvOptions = {}): Promise<HubTestEnv> {
  const {
    prefix = 'helmx-hub-test-',
    dataDir: givenDataDir,
    cwd,
    swallowCloseError = false,
    ...appOpts
  } = options
  const ownsDir = givenDataDir === undefined
  const dataDir = givenDataDir ?? mkdtempSync(join(tmpdir(), prefix))
  try {
    const { app, kernel, faux, models } = await createHubTestApp({
      dataDir,
      cwd: cwd ?? dataDir,
      ...appOpts,
    })
    return {
      dataDir,
      app,
      kernel,
      faux,
      ...(models !== undefined ? { models } : {}),
      async close() {
        try {
          if (swallowCloseError) {
            await app.close().catch(() => {})
          } else {
            await app.close()
          }
        } finally {
          if (ownsDir) rmSync(dataDir, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    if (ownsDir) rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

export interface HttpCallOptions {
  auth?: boolean
  token?: string
  rawBody?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface HttpCallResult<T = any> {
  status: number
  body: T
  raw: string
  headers: Headers
}

async function parseHttpResponse<T = any>(response: Response): Promise<HttpCallResult<T>> {
  const raw = await response.text()
  let parsed: any = null
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
  }
  return { status: response.status, body: parsed as T, raw, headers: response.headers }
}

export interface HubHandlerTestEnv extends HubTestEnv {
  handler: (req: Request) => Promise<Response>
  token: string
  call: <T = any>(method: string, path: string, body?: unknown, opts?: HttpCallOptions) => Promise<HttpCallResult<T>>
}

/**
 * 内存级 `createHubHandler` 集成环境（免 TCP 监听开销，默认使用 `createProcessToken` 免 scrypt 开销）。
 */
export async function openHubHandlerEnv(
  options: OpenHubTestEnvOptions & { password?: string } = {},
): Promise<HubHandlerTestEnv> {
  const { password, ...baseOpts } = options
  const env = await openHubTestEnv(baseOpts)
  try {
    const handler = createHubHandler(env.kernel as never)
    let token: string
    let disposeProcessToken: (() => void) | undefined
    if (password !== undefined) {
      const setup = await handler(
        new Request('http://127.0.0.1:3202/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        }),
      )
      assert.equal(setup.status, 200, `auth setup failed: ${setup.status}`)
      token = ((await setup.json()) as { token: string }).token
    } else {
      const managed = env.kernel.auth.createProcessToken()
      token = managed.token
      disposeProcessToken = () => managed.dispose()
    }
    return {
      ...env,
      handler,
      token,
      async call<T = any>(method: string, path: string, body?: unknown, opts?: HttpCallOptions) {
        const useToken = opts?.auth === false ? undefined : (opts?.token ?? token)
        const payload = opts?.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined)
        const response = await handler(
          new Request(`http://127.0.0.1:3202${path}`, {
            method,
            headers: {
              ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(useToken !== undefined ? { authorization: `Bearer ${useToken}` } : {}),
              ...(opts?.headers ?? {}),
            },
            ...(payload !== undefined ? { body: payload } : {}),
            ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
          }),
        )
        return parseHttpResponse<T>(response)
      },
      async close() {
        disposeProcessToken?.()
        await env.close()
      },
    }
  } catch (error) {
    await env.close()
    throw error
  }
}

export interface HubHttpTestEnv extends HubTestEnv {
  hub: Awaited<ReturnType<typeof startHub>>
  hubUrl: string
  token: string
  call: <T = any>(method: string, path: string, body?: unknown, opts?: HttpCallOptions) => Promise<HttpCallResult<T>>
}

/**
 * 真实 `startHub(port: 0)` HTTP/WS 集成环境（默认使用 `createProcessToken` 免 scrypt 开销）。
 */
export async function openHubHttpEnv(
  options: OpenHubTestEnvOptions & { password?: string } = {},
): Promise<HubHttpTestEnv> {
  const { password, ...baseOpts } = options
  const env = await openHubTestEnv(baseOpts)
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let disposeProcessToken: (() => void) | undefined
  try {
    hub = await startHub({ kernel: env.kernel as never, port: 0 })
    let token: string
    if (password !== undefined) {
      const setup = await fetch(`${hub.url}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      assert.equal(setup.status, 200, `auth setup failed: ${setup.status}`)
      token = ((await setup.json()) as { token: string }).token
    } else {
      const managed = env.kernel.auth.createProcessToken()
      token = managed.token
      disposeProcessToken = () => managed.dispose()
    }
    const hubInstance = hub
    return {
      ...env,
      hub: hubInstance,
      hubUrl: hubInstance.url,
      token,
      async call<T = any>(method: string, path: string, body?: unknown, opts?: HttpCallOptions) {
        const useToken = opts?.auth === false ? undefined : (opts?.token ?? token)
        const payload = opts?.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined)
        const response = await fetch(`${hubInstance.url}${path}`, {
          method,
          headers: {
            ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(useToken !== undefined ? { authorization: `Bearer ${useToken}` } : {}),
            ...(opts?.headers ?? {}),
          },
          ...(payload !== undefined ? { body: payload } : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        })
        return parseHttpResponse<T>(response)
      },
      async close() {
        try {
          await hubInstance.close().catch(() => {})
        } finally {
          disposeProcessToken?.()
          await env.close()
        }
      },
    }
  } catch (error) {
    await hub?.close().catch(() => {})
    disposeProcessToken?.()
    await env.close()
    throw error
  }
}

export interface SdkTurnEntrySummary {
  id: number
  kind: string
  text: string
  data?: unknown
}

/** 提取模型消息列表中全部文本块（供 context / provider transcript 断言共用）。 */
export function messageTextsOf(messages: ReadonlyArray<{ role: string; content: unknown }>): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<{ type?: string; text?: string }>) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out
}

/** 读取 SDK 底层会话的原始 entries 摘要（验证 rewind 逻辑隐藏而非物理删除等契约）。 */
export async function sdkEntrySummaries(
  kernel: HubTestApp['kernel'],
  convId: number,
): Promise<SdkTurnEntrySummary[]> {
  const harness = (kernel as unknown as { harness: Harness }).harness
  const conv = await harness.conversation(convId as never, BACKGROUND_CONTEXT)
  assert.ok(conv)
  const out: SdkTurnEntrySummary[] = []
  let cursor: unknown = undefined
  for (;;) {
    const page = await conv.entries({ order: 'ascending' }, 100, cursor as never, BACKGROUND_CONTEXT)
    for (const raw of page.items as never as Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>) {
      let text = ''
      const model = raw.model as Array<{ content?: unknown }> | undefined
      const content = model?.[0]?.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = (content as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
      }
      if (raw.kind === 'helmx.input') {
        const data = raw.data as { text?: unknown } | undefined
        if (typeof data?.text === 'string') text = data.text
      }
      out.push({ id: Number(raw.id), kind: raw.kind, text, data: raw.data })
    }
    if (!page.next) break
    cursor = page.next
  }
  return out
}

/** 内存插件文档存储桩（供无 SQLite 的 PluginHost 治理单测使用）。 */
export class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

/** 内存插件配置存储桩（支持 null 删除语义，与 `HelmxPluginConfigStore` 一致）。 */
export class MemoryConfigStore implements PluginConfigStore {
  store = new Map<string, Record<string, unknown>>()
  get(pluginId: string): Record<string, unknown> {
    return { ...(this.store.get(pluginId) ?? {}) }
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    const current = this.store.get(pluginId) ?? {}
    const next = { ...current }
    for (const [key, v] of Object.entries(value)) {
      if (v === null) delete next[key]
      else next[key] = v
    }
    if (Object.keys(next).length === 0) this.store.delete(pluginId)
    else this.store.set(pluginId, next)
  }
}
