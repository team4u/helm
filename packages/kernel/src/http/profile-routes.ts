/**
 * Profile domain routes: /api/profiles CRUD.
 *
 * Hosting metadata (`managedByPlugin`) may only be written directly by trusted plugin bootstraps via
 * `ProfileService`: HTTP create rejects the field, PUT forbids removing or modifying it, and DELETE
 * forbids deleting plugin-managed Profiles. Disabled-model binding is preflighted before saving (`409 model_disabled`).
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
      // Hosting metadata may only be declared by trusted plugin bootstraps (direct ProfileService write);
      // HTTP create rejects `managedByPlugin` to prevent spoofing managed ownership or bypassing deletion locks.
      if (profile.managedByPlugin !== undefined) {
        throw new HelmError(
          'profile_managed_by_plugin',
          'managedByPlugin is declared by plugin bootstrap and cannot be set via HTTP create',
          403,
          { profileId: profile.id },
        )
      }
      const existing = await kernel.profiles.get(profile.id)
      if (existing?.managedByPlugin !== undefined) {
        throw new HelmError('profile_managed_by_plugin', `cannot overwrite plugin-managed profile ${profile.id}`, 403)
      }
      // Reject disabled model before saving so we never persist a binding that fails on the first turn (409);
      // HTTP boundary only—trusted plugin bootstraps writing ProfileService directly bypass this check.
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
      if (found === undefined) throw new HelmError('not_found', `profile not found: ${profileId}`, 404)
      return jsonOk(redactor, await enrichProfile(found))
    }
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      const profile = parseProfileBody(body, { requireId: false })
      if (profile.id !== undefined && profile.id !== profileId) {
        throw new ValidationError('body.id (when provided) must match the path parameter')
      }
      // Hosting metadata is immutable over HTTP: PUT must not remove or modify `managedByPlugin`
      // on an existing managed Profile (trusted plugin bootstraps write ProfileService directly).
      // Omitting the field counts as attempted removal (PUT full-replacement contract) and fails explicitly.
      const existing = await kernel.profiles.get(profileId)
      if (existing === undefined) {
        throw new HelmError('not_found', `profile not found: ${profileId}`, 404)
      }
      if (profile.managedByPlugin !== existing.managedByPlugin) {
        throw new HelmError(
          'profile_managed_by_plugin',
          `profile ${profileId} hosting metadata is declared by a plugin and cannot be set, modified, or removed via HTTP`,
          403,
          { profileId, managedByPlugin: existing.managedByPlugin },
        )
      }
      // Same rule as POST: reject disabled model before saving (PUT full replacement; omitted model clears override without preflight).
      assertProfileModelEnabled(kernel, profile)
      const saved = await kernel.profiles.save({ ...profile, id: profileId })
      await kernel.alignProfileConversations?.(saved.id)
      return jsonOk(redactor, await enrichProfile(saved))
    }
    if (method === 'DELETE') {
      // Refuse deletion while any conversation still binds the profile: otherwise the next `before_turn`
      // cannot find the file and the conversation runs degraded. The default `assistant` profile is also locked (403).
      // This is a fast path; ProfileService.delete repeats the same check right before writing, and creation/PATCH
      // verify profile existence (`resolveProfileForCreate`/`updateConfiguration`), leaving only a benign microtask
      // window between re-check and `rm`.
      const inUse = (await kernel.listConversations()).some((c) => c.profileId === profileId)
      if (inUse) {
        throw new HelmError('profile_in_use', `profile ${profileId} is still bound by conversations; unbind before deleting`, 409)
      }
      // Refuse deleting plugin-managed Profiles (`managedByPlugin` set): prevents bypassing UI to delete
      // bootstrapped plugin assets over HTTP; the built-in default profile is protected by ProfileService itself.
      const target = await kernel.profiles.get(profileId)
      if (target?.managedByPlugin !== undefined) {
        throw new HelmError(
          'profile_managed_by_plugin',
          `profile ${profileId} is managed by plugin ${target.managedByPlugin} and cannot be deleted`,
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
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

/** Disabled-model preflight for `profile.model`: extracts provider/model and invokes optional port (409 model_disabled). */
function assertProfileModelEnabled(kernel: KernelRuntimeLike, profile: Profile): void {
  if (profile.model === undefined || kernel.assertModelEnabled === undefined) return
  const slash = profile.model.indexOf('/')
  kernel.assertModelEnabled(profile.model.slice(0, slash), profile.model.slice(slash + 1))
}
