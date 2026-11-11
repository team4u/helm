import { join } from 'node:path'
import { HelmError, type HelmHostApi } from '@helm/protocol'
import { atomicWriteFile, FileNotFoundError } from '../../src/services/atomic-file.js'
import { withFileLock } from '../../src/services/file-lock.js'
import {
  assertProfileId,
  assertSkillId,
  ProfileService,
  SkillService,
} from '../../src/services/profiles-skills.js'

function validateId(id: string): void {
  try {
    assertProfileId(id)
  } catch (error) {
    throw new HelmError('validation_error', error instanceof Error ? error.message : String(error), 400, { profileId: id })
  }
}

/** skill id 边界归一（镜像 kernel skillDirectory：非法 id -> HelmError 400）。 */
function validateSkillId(id: string): void {
  try {
    assertSkillId(id)
  } catch (error) {
    throw new HelmError('validation_error', `Skill id 非法：${error instanceof Error ? error.message : String(error)}`, 400, { skillId: id })
  }
}

/** 真文件服务适配公共插件端口；测试不向插件工厂注入内核私有对象。 */
export function createProfileFileHost(
  dataDir: string,
  profiles = new ProfileService(dataDir),
): Pick<HelmHostApi, 'profiles' | 'skills' | 'atomicWriteFile' | 'withFileLock'> {
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
            throw new HelmError('not_found', error.message, 404)
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
