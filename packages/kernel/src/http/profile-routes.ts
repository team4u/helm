/**
 * Profile 领域路由：/api/profiles CRUD。
 *
 * 托管元数据（managedByPlugin）只能由可信插件自举经 ProfileService 直写：
 * HTTP 创建不接受该字段，PUT 不得移除/改写，DELETE 拒绝删除托管 Profile。
 * 绑定禁用模型在落盘前预检（409 model_disabled）。
 */
import { HelmError, type Profile } from '@helm/protocol'
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import type { KernelRuntimeLike } from './contracts.js'
import { parseProfileBody, requireIdParam, ValidationError } from './validate.js'
import { methodNotAllowed, type RouteContext } from './route-context.js'

export async function handleProfilesDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const enrichProfile = async (profile: Profile): Promise<Profile> => {
    const system = await kernel.profiles.getSystem(profile.id)
    return { ...profile, system }
  }
  if (second === undefined) {
    if (method === 'GET') return jsonOk(redactor, await kernel.profiles.list())
    if (method === 'POST') {
      const body = await readJsonBody(ctx.request)
      const profile = parseProfileBody(body, { requireId: true })
      // 托管元数据仅可信插件自举可声明（ProfileService 直写）；HTTP 创建
      // 不接受 managedByPlugin，防止伪造托管身份或提前占位锁删除。
      if (profile.managedByPlugin !== undefined) {
        throw new HelmError(
          'profile_managed_by_plugin',
          'managedByPlugin 由插件自举声明，不可经 HTTP 创建时设置',
          403,
          { profileId: profile.id },
        )
      }
      const existing = await kernel.profiles.get(profile.id)
      if (existing?.managedByPlugin !== undefined) {
        throw new HelmError('profile_managed_by_plugin', `不可覆盖插件托管的 profile ${profile.id}`, 403)
      }
      // 保存前拒绝绑定禁用模型（409 model_disabled），避免保存成功后所有
      // 绑定会话在提交时才 409；仅 HTTP 边界，插件可信自举直写 ProfileService 不经此。
      assertProfileModelEnabled(kernel, profile)
      const saved = await kernel.profiles.save(profile)
      await kernel.alignProfileConversations?.(saved.id)
      return jsonOk(redactor, await enrichProfile(saved), { status: 201 })
    }
    return methodNotAllowed(redactor, method)
  }
  const profileId = requireIdParam(second, 'profileId')
  if (third === undefined) {
    if (method === 'GET') {
      const found = await kernel.profiles.get(profileId)
      if (found === undefined) throw new HelmError('not_found', `profile 不存在: ${profileId}`, 404)
      return jsonOk(redactor, await enrichProfile(found))
    }
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      const profile = parseProfileBody(body, { requireId: false })
      if (profile.id !== undefined && profile.id !== profileId) {
        throw new ValidationError('body.id（若提供）需与路径参数一致')
      }
      // 托管元数据不可篡改：既有 managedByPlugin 的 Profile，PUT 不得移除或
      // 改写该字段（可信插件自举走 ProfileService 直写不经 HTTP）。缺失字段
      // 视为移除（PUT 整体替换契约），显式拒绝而非静默接管。
      const existing = await kernel.profiles.get(profileId)
      if (existing === undefined) {
        throw new HelmError('not_found', `profile 不存在: ${profileId}`, 404)
      }
      if (profile.managedByPlugin !== existing.managedByPlugin) {
        throw new HelmError(
          'profile_managed_by_plugin',
          `profile ${profileId} 的托管元数据只能由插件声明，不可经 HTTP 设置、修改或移除`,
          403,
          { profileId, managedByPlugin: existing.managedByPlugin },
        )
      }
      // 与 POST 同规：绑定禁用模型在落盘前拒绝（PUT 整体替换，缺失 model = 清除，不触发预检）。
      assertProfileModelEnabled(kernel, profile)
      const saved = await kernel.profiles.save({ ...profile, id: profileId })
      await kernel.alignProfileConversations?.(saved.id)
      return jsonOk(redactor, await enrichProfile(saved))
    }
    if (method === 'DELETE') {
      // 仍被任何会话绑定的 profile 拒绝删除：否则下一轮 before_turn 找
      // 不到文件，会话将带病运行。assistant 默认服务同理受锁保护（403）。
      // 此处为快速路径；服务层 delete 内部落盘前兑底复核（同一检查），
      // 双向复验闭环：创建/PATCH 绑定侧亦验 profile 存在
      // （conversation-service resolveProfileForCreate/updateConfiguration），
      // 残余窗口仅为复核 await 到 rm 之间的微任务级交错，可接受。
      const inUse = (await kernel.listConversations()).some((c) => c.profileId === profileId)
      if (inUse) {
        throw new HelmError('profile_in_use', `profile ${profileId} 仍被会话绑定，先解绑再删除`, 409)
      }
      // 插件托管 Profile（managedByPlugin 非空）拒绝删除：防止绕过 UI 直接
      // 调 HTTP 删除插件自举资产；内核默认 profile 保护由 ProfileService 承担。
      const target = await kernel.profiles.get(profileId)
      if (target?.managedByPlugin !== undefined) {
        throw new HelmError(
          'profile_managed_by_plugin',
          `profile ${profileId} 由插件 ${target.managedByPlugin} 托管，不可删除`,
          403,
          { profileId, managedByPlugin: target.managedByPlugin },
        )
      }
      await kernel.profiles.delete(profileId, {
        isProfileInUse: async (pid) =>
          (await kernel.listConversations()).some((c) => c.profileId === pid),
      })
      return jsonOk(redactor, { ok: true })
    }
    return methodNotAllowed(redactor, method)
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

/** profile.model 禁用预检：解析出 provider/model 后调用可选端口（409 model_disabled）。 */
function assertProfileModelEnabled(kernel: KernelRuntimeLike, profile: Profile): void {
  if (profile.model === undefined || kernel.assertModelEnabled === undefined) return
  const slash = profile.model.indexOf('/')
  kernel.assertModelEnabled(profile.model.slice(0, slash), profile.model.slice(slash + 1))
}
