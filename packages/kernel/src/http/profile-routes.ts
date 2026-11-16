/**
 * Profile domain routing:/api/profiles CRUD.
 *
 * hosting metadata (managedByPlugin) only can by can message plugin self raise via ProfileService direct write:
 * HTTP create do not accept the field,PUT must not remove/change write,DELETE reject delete hosting Profile.
 * bind set disable model in before preflight (409 model_disabled).
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
      // hosting metadata only can message plugin self raise can declaration (ProfileService direct write);HTTP create
      // do not accept managedByPlugin, guard against fabricate hosting identity or mention before occupy lock delete.
      if (profile.managedByPlugin !== undefined) {
        throw new HelmError(
          'profile_managed_by_plugin',
          'managedByPlugin by plugin self raise declaration, cannot via HTTP create when settings',
          403,
          { profileId: profile.id },
        )
      }
      const existing = await kernel.profiles.get(profile.id)
      if (existing?.managedByPlugin !== undefined) {
        throw new HelmError('profile_managed_by_plugin', `cannot override plugin hosting profile ${profile.id}`, 403)
      }
      // save before reject bind set disable model (409 model_disabled), avoid save after success all
      // bind set conversation in commit when only then 409; only HTTP boundary, plugin can message self raise direct write ProfileService do not via this.
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
      if (found === undefined) throw new HelmError('not_found', `profile missing: ${profileId}`, 404)
      return jsonOk(redactor, await enrichProfile(found))
    }
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      const profile = parseProfileBody(body, { requireId: false })
      if (profile.id !== undefined && profile.id !== profileId) {
        throw new ValidationError('body.id(if provide) must and path parameter consistent')
      }
      // hosting metadata cannot tamper: since has managedByPlugin  Profile,PUT must not remove or
      // change write the field (can message plugin self raise away ProfileService direct write do not via HTTP). missing field
      // treated as remove (PUT whole replace contract), explicit reject while non- static default take over.
      const existing = await kernel.profiles.get(profileId)
      if (existing === undefined) {
        throw new HelmError('not_found', `profile missing: ${profileId}`, 404)
      }
      if (profile.managedByPlugin !== existing.managedByPlugin) {
        throw new HelmError(
          'profile_managed_by_plugin',
          `profile ${profileId} hosting metadata only can by plugin declaration, cannot via HTTP settings, modify or remove`,
          403,
          { profileId, managedByPlugin: existing.managedByPlugin },
        )
      }
      // and POST same rule: bind set disable model in before reject (PUT whole replace, missing model = clear, does not trigger preflight).
      assertProfileModelEnabled(kernel, profile)
      const saved = await kernel.profiles.save({ ...profile, id: profileId })
      await kernel.alignProfileConversations?.(saved.id)
      return jsonOk(redactor, await enrichProfile(saved))
    }
    if (method === 'DELETE') {
      // still by any conversation bind set profile reject delete: otherwise under one round before_turn find
      // fewer than file, conversation carries illness run.assistant by default service same subject to lock protect (403).
      // this where is fast path; service layer delete internal before honor bottom re-check (the same check),
      // double to re- verify closed ring: create/PATCH bind set side also verify profile store in
      // (conversation-service resolveProfileForCreate/updateConfiguration),
      // leftover remaining window only is re-check await to rm between micro task level hand over wrong, can accept.
      const inUse = (await kernel.listConversations()).some((c) => c.profileId === profileId)
      if (inUse) {
        throw new HelmError('profile_in_use', `profile ${profileId} still by conversation bind set, first solve bind again delete`, 409)
      }
      // plugin hosting Profile(managedByPlugin non-empty) reject delete: guard against bypass UI directly
      // tune HTTP delete plugin self raise asset; kernel by default profile protect by ProfileService bear bear.
      const target = await kernel.profiles.get(profileId)
      if (target?.managedByPlugin !== undefined) {
        throw new HelmError(
          'profile_managed_by_plugin',
          `profile ${profileId} by plugin ${target.managedByPlugin} hosting, cannot delete`,
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
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

/** profile.model disable preflight: parse out provider/model after invoke optional port (409 model_disabled). */
function assertProfileModelEnabled(kernel: KernelRuntimeLike, profile: Profile): void {
  if (profile.model === undefined || kernel.assertModelEnabled === undefined) return
  const slash = profile.model.indexOf('/')
  kernel.assertModelEnabled(profile.model.slice(0, slash), profile.model.slice(slash + 1))
}
