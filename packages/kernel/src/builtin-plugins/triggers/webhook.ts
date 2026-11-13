/**
 * triggers/webhook.ts：入站 webhook 连接器。
 *
 * 契约（§4.4）：
 * - 公开路由 POST /webhook/:id（宿主完整路径 /api/plugins/builtin%3Atriggers/
 *   routes/webhook/:id；public:true 跳过 Token 鉴权，插件自行验签）；
 * - HMAC-SHA256：请求头 x-helm-signature: sha256=<hex>，签名覆盖原始 body
 *   字节；timingSafeEqual 常时比较；无/错签名 401，id 不存在 404，成功 202
 *   {accepted:true}；
 * - secret 只落 credentials.json pluginSecrets['builtin:triggers']
 *   ['webhook:<id>']（0600，经 ctx.host.secrets 已绑定本插件 ID）+
 *   secrets.addRedaction 全局脱敏；doc 只存元数据；
 * - webhook_create 拒绝带 conversationId 的调用上下文：raw secret 经
 *   run_action 参数已进入模型工具历史（handler 拒绝无法清理已入上下文的
 *   秘密）——secret 只允许人工 HTTP/CLI 配置，文档如实声明；
 * - create/delete 串行（mutationChain），secret 文件与 doc 无跨存储事务：
 *   create 先写 doc（含 hasSecret:true）并经 doc.flush() 真实冲刷，再写
 *   secret；secret 写失败即回滚移除 doc 条目；delete 先删 doc（幂等容错）
 *   再删 secret，secret 删除失败显式报错；两路径成功前均 await flush，
 *   绝不返回假持久；
 * - 成功投递走共享 dispatchTrigger helper（isClosing 检查在 helper 内），
 *   text 为原始 utf8 body、source 为 webhook:<id>；body 上限 256 KiB
 *   （复用 http readBody 流式限制，超限 cancel 并 413；验签基于原始字节，
 *   解码 fatal:true，坏 UTF8 显式 400）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type { HelmPluginContext, PluginActionContext } from '@helm/protocol'
import { BodyError, readBody } from '@helm/protocol'
import {
  MAX_DESCRIPTION,
  TRIGGERS_PLUGIN_ID,
  assertDescription,
  assertThreadKey,
  assertTriggerId,
  assertWebhookSecret,
  assertWebhooksDoc,
  webhookPublicMeta,
  webhookSecretKey,
  type WebhookMeta,
  type WebhooksDoc,
} from './contracts.js'
import type { DispatchTriggerHelper } from './delivery.js'

/** 公开 webhook 请求 body 上限（原始字节；超出 413 明确错误）。 */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

/**
 * stop 等待在途公开路由请求收敛的上限：慢客户端 body 读取无读超时
 * （protocol/src/http-body.ts 不归本插件改），无界等待会挂死 dispose；
 * 超时后如实记录未收敛请求数并继续停用（与 watchdog stop 的有界口径一致）。
 */
export const STOP_REQUEST_WAIT_MS = 10_000

const SIGNATURE_HEADER = 'x-helm-signature'
const SIGNATURE_PREFIX = 'sha256='

/** 404/401/413 统一 JSON 错误体（公开路由不携带内部细节）。 */
function webhookError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

const acceptedResponse = (): Response =>
  new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** hex 解码 + 常时比较：两侧均为 64 字符 hex 的 ASCII 字节（长度恒 64），
 * 正则格式检查保证等长后才 timingSafeEqual，不因长度分支泄漏时序。 */
export function verifySignature(secret: string, body: Uint8Array, header: string): boolean {
  if (!header.startsWith(SIGNATURE_PREFIX)) return false
  const hex = header.slice(SIGNATURE_PREFIX.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  const expectedHex = createHmac('sha256', secret).update(body).digest('hex')
  const provided = Buffer.from(hex.toLowerCase(), 'utf8')
  const expected = Buffer.from(expectedHex, 'utf8')
  return timingSafeEqual(provided, expected)
}

export interface RegisterWebhookResult {
  /** 动作 handler 复用（与 ctx.action 同一实现，五端一致）。 */
  createWebhook(input: CreateWebhookInput, context: PluginActionContext): Promise<{ webhook: WebhookMeta }>
  listWebhooks(): { webhooks: WebhookMeta[] }
  deleteWebhook(input: { id: string }): Promise<{ deleted: true }>
}

export interface CreateWebhookInput {
  id: string
  description?: string
  secret: string
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
}

/**
 * 注册 webhook 连接器：public doc 'webhooks'、公开路由与生命周期 actions。
 * secrets / profiles / isClosing 直接消费 ctx.host 公共端口（零参工厂，
 * 无注入式依赖）；返回 handler 复用面（测试/管理 UI 同一实现）。
 */
export function registerWebhook(
  ctx: HelmPluginContext,
  shared: { dispatch: DispatchTriggerHelper },
): RegisterWebhookResult {
  const host = ctx.host
  const doc = ctx.doc<WebhooksDoc>('webhooks', { webhooks: [] }, { public: true })

  const readDoc = (): WebhooksDoc => assertWebhooksDoc(doc.get())
  const writeDoc = (next: WebhooksDoc): void => {
    doc.set(assertWebhooksDoc(next))
  }

  /** 本启用周期的 secret 脱敏登记释放句柄（stop 统一解除）。 */
  let secretRedactions: Array<() => void> = []

  // ---- 服务活跃门禁：公开路由无宿主 tracker 包装，自行维护在途请求集合 ----
  // active=false 后：已进入 handler 的请求继续收敛（stop 等待），但 dispatch
  // 前再查 active 的请求不再投递；旧 handler（停用后残留调用）直接拒绝。
  let active = false
  const activeRequests = new Set<Promise<unknown>>()
  const idleWaiters: Array<() => void> = []

  const trackRequest = <T>(run: () => Promise<T>): Promise<T> => {
    let tracked!: Promise<T>
    tracked = (async () => {
      try {
        return await run()
      } finally {
        activeRequests.delete(tracked)
        if (!active && activeRequests.size === 0) {
          for (const notify of idleWaiters.splice(0)) notify()
        }
      }
    })()
    activeRequests.add(tracked)
    return tracked
  }

  /** 拒绝停用后残留调用（旧 handler 句柄仍可能被外部持住）。 */
  const assertActive = (): void => {
    if (!active) {
      throw new HelmError(
        'plugin_disabled',
        'builtin:triggers webhook 服务已停用，拒绝处理请求',
        409,
        { pluginId: TRIGGERS_PLUGIN_ID },
      )
    }
  }

  /** 现读 doc 单条（不存在抛 not_found）。 */
  const requireWebhook = (id: string): WebhookMeta => {
    const found = readDoc().webhooks.find((w) => w.id === id)
    if (found === undefined) {
      throw new HelmError('not_found', `webhook '${id}' 不存在`, 404, { id })
    }
    return found
  }

  /** 启动：读入 doc（损坏显式报错）、登记既有 secret 脱敏并开活跃门。 */
  async function start(): Promise<void> {
    readDoc()
    const metas = readDoc().webhooks
    for (const meta of metas) {
      const secret = await host.secrets.get(webhookSecretKey(meta.id))
      if (secret !== undefined) secretRedactions.push(host.secrets.addRedaction(secret))
    }
    active = true
  }

  /** 停用：先关门（新请求拒收/dispatch 前再拒），再有界等已进请求自然收敛；
   * 超时不硬拆请求（拆不得：响应已并往连接），如实记录后继续释放插件资源。 */
  async function stop(): Promise<void> {
    active = false
    if (activeRequests.size > 0) {
      let giveUpTimer: NodeJS.Timeout | undefined
      const idle = new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
      const deadline = new Promise<void>((resolve) => {
        giveUpTimer = setTimeout(resolve, STOP_REQUEST_WAIT_MS)
        giveUpTimer.unref?.()
      })
      await Promise.race([idle, deadline])
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer)
      if (activeRequests.size > 0) {
        // 如实记录（不伪装收敛）：残留请求自行收敛时 trackRequest 的 finally
        // 对已结束的等待者幂等 resolve，不影响任何后续周期。
        console.error(
          `[triggers] webhook 停用等待在途请求超过 ${STOP_REQUEST_WAIT_MS}ms，未收敛 ${activeRequests.size} 个（慢客户端可能仍在读 body），继续停用`,
        )
      }
    }
    for (const release of secretRedactions) release()
    secretRedactions = []
  }

  /** 停用闸门标签：正常 disable/unregister 凭此得 409 plugin_has_live_tasks；
   * dispose 强制 stop 时已 active=false，此处返回空放行拆毁。 */
  function liveTasks(): string[] {
    if (!active) return []
    const count = activeRequests.size
    return count > 0 ? [`webhook:inflight:${count}`] : []
  }

  /** create/delete 串行链：防 secret 文件与 doc 的并发读改写竞争。 */
  let mutationChain: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const task = mutationChain.then(run, run)
    mutationChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async function createWebhook(
    input: CreateWebhookInput,
    context: PluginActionContext,
  ): Promise<{ webhook: WebhookMeta }> {
    // 机密边界：带 conversationId 的调用（run_action / workflow）意味着 raw
    // secret 已进入该会话模型上下文——本 handler 无法清理，直接拒绝；
    // secret 仅允许人工 HTTP/CLI 配置（如文档如实声明）。
    if (context.conversationId !== undefined) {
      throw new HelmError(
        'webhook_secret_context_forbidden',
        'webhook_create 携带明文 secret，禁止在会话上下文（run_action/workflow）中调用；请使用人工 HTTP/CLI（helm webhook create）配置',
        403,
        { pluginId: TRIGGERS_PLUGIN_ID, conversationId: context.conversationId },
      )
    }
    const id = assertTriggerId('webhook', input.id)
    const secret = assertWebhookSecret(input.secret)
    const description = input.description === undefined ? undefined : assertDescription(input.description)
    if (input.targetConversationId !== undefined && input.targetProfileId !== undefined) {
      throw new HelmError('validation_error', 'targetConversationId 与 targetProfileId 不允许同时提供', 400, {})
    }
    if (input.targetConversationId !== undefined && (!Number.isInteger(input.targetConversationId) || input.targetConversationId <= 0)) {
      throw new HelmError('validation_error', `targetConversationId 非正整数（${String(input.targetConversationId)}）`, 400, {})
    }
    if (input.targetProfileId !== undefined && (typeof input.targetProfileId !== 'string' || input.targetProfileId.length === 0)) {
      throw new HelmError('validation_error', 'targetProfileId 非空字符串', 400, {})
    }
    const threadKey = input.threadKey === undefined ? undefined : assertThreadKey(input.threadKey)
    // targetProfileId 在创建时即校验存在（fail-fast：不创建指向不存在角色的
    // 死端点；投递制仍会现查，防创建后 Profile 被删）。
    if (input.targetProfileId !== undefined) {
      const profileId = input.targetProfileId
      if (await host.profiles.get(profileId) === undefined) {
        throw new HelmError(
          'validation_error',
          `targetProfileId 不存在：${profileId}（拒绝指向错误角色）`,
          400,
          { targetProfileId: profileId },
        )
      }
    }
    const meta: WebhookMeta = {
      id,
      hasSecret: true,
      ...(description !== undefined ? { description } : {}),
      ...(input.targetConversationId !== undefined ? { targetConversationId: input.targetConversationId } : {}),
      ...(input.targetProfileId !== undefined ? { targetProfileId: input.targetProfileId } : {}),
      ...(threadKey !== undefined ? { threadKey } : {}),
      createdAt: Date.now(),
    }
    return enqueueMutation(async () => {
      if (readDoc().webhooks.some((w) => w.id === id)) {
        throw new HelmError('webhook_exists', `webhook '${id}' 已存在`, 409, { id })
      }
      // 顺序：先写 doc（入口元数据）并冲刷，再写 secret；secret 写失败回滚
      // 移除 doc 条目并冲刷（入口未生效过）；回滚失败聚合显式上抛。
      try {
        writeDoc({ webhooks: [...readDoc().webhooks, meta] })
        await doc.flush()
        await host.secrets.set(webhookSecretKey(id), secret)
      } catch (secretError) {
        try {
          writeDoc({ webhooks: readDoc().webhooks.filter((w) => w.id !== id) })
          await doc.flush()
        } catch (rollbackError) {
          throw new HelmError(
            'webhook_create_rollback_failed',
            `webhook '${id}' secret 写入失败且回滚 doc 失败（doc 残留无 secret 条目，下次请求将显式报不一致，请人工核对）：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
            {
              id,
              secretError: secretError instanceof Error ? secretError.message : String(secretError),
            },
          )
        }
        throw secretError
      }
      const release = host.secrets.addRedaction(secret)
      secretRedactions.push(release)
      return { webhook: webhookPublicMeta(meta) }
    })
  }

  function listWebhooks(): { webhooks: WebhookMeta[] } {
    return { webhooks: readDoc().webhooks.map((w) => webhookPublicMeta(w)) }
  }

  async function deleteWebhook(input: { id: string }): Promise<{ deleted: true }> {
    const id = assertTriggerId('webhook', input.id)
    return enqueueMutation(async () => {
      const current = readDoc()
      const existing = current.webhooks.find((w) => w.id === id)
      if (existing === undefined) {
        throw new HelmError('not_found', `webhook '${id}' 不存在`, 404, { id })
      }
      // 顺序：先 doc（下线入口）后 secret；secret 删除失败显式报错（残留
      // secret 无入口不再可利用，人工可经 credentials.json 清理）。
      writeDoc({ webhooks: current.webhooks.filter((w) => w.id !== id) })
      try {
        await doc.flush()
        await host.secrets.delete(webhookSecretKey(id))
      } catch (err) {
        throw new HelmError(
          'webhook_delete_secret_failed',
          `webhook '${id}' 元数据已删除，但 secret 清理失败（残留于 credentials.json，无入口不可利用，请人工核对）：${err instanceof Error ? err.message : String(err)}`,
          500,
          { id },
        )
      }
      return { deleted: true }
    })
  }

  // ---- 公开路由：HMAC 验签 + 投递 ----
  ctx.route({
    method: 'POST',
    path: '/webhook/:id',
    public: true,
    handler(request) {
      return trackRequest(async () => handleWebhookRequest(request)).catch((err: unknown) => {
        if (err instanceof HelmError) {
          // doc 损坏与停用后残留调用均如实回传原码（不笼统 500 内部化）。
          if (err.code === 'triggers_doc_corrupt') {
            return webhookError(500, err.code, err.message)
          }
          if (err.code === 'plugin_disabled') {
            return webhookError(409, err.code, err.message)
          }
        }
        // 其余异常如实 500（不吞、不伪装成功）。
        return webhookError(500, 'webhook_internal_error', `webhook 处理失败：${err instanceof Error ? err.message : String(err)}`)
      })
    },
  })

  async function handleWebhookRequest(request: Request): Promise<Response> {
      assertActive()
      // 仅接受 POST（宿主路由层按 method 匹配，此处直接调用时同样校验）。
      if (request.method !== 'POST') {
        return webhookError(404, 'not_found', `webhook 路由仅支持 POST（收到 ${request.method}）`)
      }
      // 完整路径 /api/plugins/builtin%3Atriggers/routes/webhook/:id；
      // 路由层已做段解码匹配，此处从 URL 原始段提取末段并严格解码。
      const rawId = request.url.split('?')[0]!.split('/').filter(Boolean).pop()
      let id: string
      try {
        id = rawId === undefined ? '' : decodeURIComponent(rawId)
      } catch {
        return webhookError(400, 'invalid_path_encoding', 'webhook id 路径段编码非法')
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        return webhookError(404, 'not_found', `webhook 不存在: ${id || '(空)'}`)
      }
      const meta = readDoc().webhooks.find((w) => w.id === id)
      if (meta === undefined) {
        return webhookError(404, 'not_found', `webhook 不存在: ${id}`)
      }
      const secret = await host.secrets.get(webhookSecretKey(id))
      if (secret === undefined || secret === '') {
        // doc 有条目但 secret 缺失属持久层不一致：显式 500 诊断（诚实性纪律），
        // 绝不静默放行无签名请求。
        return webhookError(500, 'webhook_secret_missing', `webhook '${id}' 的 secret 缺失（credentials.json 与 doc 不一致，请人工核对）`)
      }
      const signature = request.headers.get(SIGNATURE_HEADER)
      if (signature === null) {
        return webhookError(401, 'unauthorized', `缺少 ${SIGNATURE_HEADER} 请求头`)
      }
      let body: Uint8Array
      try {
        // 复用 http 边界 readBody：content-length 预检 + 流式累计，超限立即
        // cancel reader（不吞完整 body 到内存）并抛 body_too_large 413。
        body = await readBody(request, MAX_WEBHOOK_BODY_BYTES)
      } catch (err) {
        if (err instanceof BodyError && err.code === 'body_too_large') {
          return webhookError(413, 'payload_too_large', `webhook body 超过上限（${MAX_WEBHOOK_BODY_BYTES} 字节）`)
        }
        return webhookError(400, 'invalid_body', `webhook body 读取失败：${err instanceof Error ? err.message : String(err)}`)
      }
      if (!verifySignature(secret, body, signature)) {
        return webhookError(401, 'unauthorized', '签名校验失败（期望 x-helm-signature: sha256=<hex>，签名覆盖原始 body 字节）')
      }
      // 先验签（基于原始字节）后解码：fatal:true 使坏 UTF8 抛出并显式 400，
      // 绝不静默替换字符（替换产物与原始字节语义不一致）。
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body)
      } catch {
        return webhookError(400, 'invalid_body', 'webhook body 不是合法 UTF-8')
      }
      // 请求体读取期间端点可能被删除或重建，拒绝用旧密钥投递到新配置。
      const secretAtDispatch = await host.secrets.get(webhookSecretKey(id))
      if (!active) {
        return webhookError(409, 'plugin_disabled', 'builtin:triggers webhook 服务已停用，拒绝投递')
      }
      const metaAtDispatch = readDoc().webhooks.find((w) => w.id === id)
      if (metaAtDispatch === undefined) {
        return webhookError(404, 'not_found', `webhook 不存在: ${id}`)
      }
      if (secretAtDispatch !== secret || metaAtDispatch.createdAt !== meta.createdAt) {
        return webhookError(409, 'webhook_changed', 'webhook 配置已变更，请按当前密钥重新发送请求')
      }
      try {
        await shared.dispatch(
          {
            id: `webhook:${id}:${randomUUID()}`,
            source: `webhook:${id}`,
            text,
            ...(metaAtDispatch.threadKey !== undefined ? { threadKey: metaAtDispatch.threadKey } : {}),
            ...(metaAtDispatch.targetConversationId !== undefined ? { targetConversationId: metaAtDispatch.targetConversationId } : {}),
            createdAt: Date.now(),
          },
          metaAtDispatch.targetProfileId,
        )
      } catch (err) {
        if (err instanceof HelmError && (err.code === 'runtime_closing' || err.code === 'not_found')) {
          return webhookError(err.status, err.code, err.message)
        }
        // 投递失败显式 500（不吞、绝不静默截取文本冒充成功）。
        return webhookError(500, 'webhook_dispatch_failed', `触发投递失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return acceptedResponse()
  }

  // ---- 生命周期动作（HTTP/CLI/工具五端同 schema 复用） ----
  ctx.action({
    id: 'webhook_create',
    description: '创建 webhook 入站端点（HMAC-SHA256 验签）；secret 仅允许人工 HTTP/CLI 配置，拒绝会话上下文调用',
    promptGuidelines: [
      'secret 只由人工配置：请用户自行执行 helm webhook create 或 HTTP 直调；不要在会话中生成、代填或回显 secret——会话上下文调用被服务端拒绝（403 webhook_secret_context_forbidden）',
      '创建后向用户交付端点 URL 与验签方式：x-helm-signature: sha256=<hex>，HMAC-SHA256 签名覆盖原始 body 字节',
    ],
    cli: { command: ['webhook', 'create'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        description: { type: 'string', maxLength: MAX_DESCRIPTION },
        secret: { type: 'string', minLength: 1, maxLength: 512 },
        targetConversationId: { type: 'integer', minimum: 1 },
        targetProfileId: { type: 'string', minLength: 1, maxLength: 64 },
        threadKey: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['id', 'secret'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: {
        webhook: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            hasSecret: { type: 'boolean' },
            createdAt: { type: 'number' },
          },
          required: ['id', 'hasSecret', 'createdAt'],
        },
      },
      required: ['webhook'],
      additionalProperties: false,
    } as never,
    handler: (input, context) => createWebhook(input as CreateWebhookInput, context),
  })

  ctx.action({
    id: 'webhook_list',
    description: '列出全部 webhook 端点元数据（不含 secret）',
    idempotent: true,
    cli: { command: ['webhook', 'list'] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as never,
    outputSchema: {
      type: 'object',
      properties: { webhooks: { type: 'array' } },
      required: ['webhooks'],
      additionalProperties: false,
    } as never,
    handler: () => listWebhooks(),
  })

  ctx.action({
    id: 'webhook_delete',
    description: '删除 webhook 端点（含 secret 清理）',
    cli: { command: ['webhook', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
      additionalProperties: false,
    } as never,
    handler: (input) => deleteWebhook(input as { id: string }),
  })

  // ---- 服务生命周期：doc 读入验证 + secret 脱敏登记随启停 + 在途请求门禁 ----
  ctx.service({
    id: 'triggers-webhooks',
    start,
    stop,
    liveTasks,
    /** 持久占用声明：已配置的 webhook 端点是停用预检（plugin_in_use）的占用项。 */
    inUse() {
      return readDoc().webhooks.map((w) => ({
        kind: 'webhook_endpoint',
        id: w.id,
        label: `Webhook 端点 "${w.id}"`,
      }))
    },
  })

  return { createWebhook, listWebhooks, deleteWebhook }
}