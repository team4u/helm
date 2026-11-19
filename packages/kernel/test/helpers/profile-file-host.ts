import { join } from 'node:path'
import { HelmxError, assertProfileId, type HelmxHostApi } from '@helmx/protocol'
import { atomicWriteFile, FileNotFoundError } from '../../src/services/atomic-file.js'
import { withFileLock } from '../../src/services/file-lock.js'
import { assertSkillId, ProfileService, SkillService } from '../../src/services/profiles-skills.js'

function validateId(id: string): void {
  try {
    assertProfileId(id)
  } catch (error) {
    throw new HelmxError('validation_error', error instanceof Error ? error.message : String(error), 400, { profileId: id })
  }
}

/** Align skill id validation boundary (mirrors kernel skillDirectory: invalid id -> HelmxError 400). */
function validateSkillId(id: string): void {
  try {
    assertSkillId(id)
  } catch (error) {
    throw new HelmxError('validation_error', `Invalid skill id: ${error instanceof Error ? error.message : String(error)}`, 400, { skillId: id })
  }
}

/** Adapts the real file service to the public plugin port so tests never inject private kernel objects into plugins. */
export function createProfileFileHost(
  dataDir: string,
  profiles = new ProfileService(dataDir),
): Pick<HelmxHostApi, 'profiles' | 'skills' | 'atomicWriteFile' | 'withFileLock'> {
  const skills = new SkillService(dataDir)
  return {
    profiles: {
      list: () => profiles.list(),
      async get(id) {
        validateId(id)
        return profiles.get(id)
      },
      save: (profile) => profiles.save(profile),
      async getSystem(id) {
        try {
          return await profiles.getSystem(id)
        } catch (error) {
          if (error instanceof FileNotFoundError) {
            throw new HelmxError('not_found', error.message, 404)
          }
          throw error
        }
      },
      async directory(id) {
        validateId(id)
        return join(dataDir, 'profiles', id)
      },
    },
    skills: {
      list: () => skills.list(),
      readFile: (id, path) => skills.readFile(id, path),
      async directory(id) {
        validateSkillId(id)
        return join(dataDir, 'skills', id)
      },
      ensureSkill: (asset) => skills.ensureSkill(asset),
    },
    atomicWriteFile,
    withFileLock: (path, fn, opts) => withFileLock(path, () => {
      opts?.signal?.throwIfAborted()
      return fn()
    }),
  }
}
