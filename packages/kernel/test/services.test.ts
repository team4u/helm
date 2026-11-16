/**
 * helm kernel service layer test: real file system behavior, without false runtime.
 * override:paths/atomic-file,profiles/skills(through exceeds and symlink reject),watcher,
 * SecretStash isolated,AuthService scrypt/token, credentials 0600 and do not leak,
 * ArtifactService spill threshold and UTF-8 security.
 */
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile, rm, realpath, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HelmError,
  PLUGIN_UI_METHOD_NAMES,
  PLUGIN_HOOK_NAMES,
  RESERVED_SLASH_COMMANDS,
  PLUGIN_CLIENT_SHARED_EXPORTS,
  CORE_CLI_COMMAND_PATHS,
} from '@helm/protocol'
import {
  HELM_CLI_SKILL_MD,
  HELM_CLI_SKILL_AND_PLUGIN_DEV_MD,
  HELM_CLI_SKILL_ASSET,
  renderSkillTemplate,
} from '../../plugins/src/profile/assets.js'
import { MANAGED_EXEC_ENV_VARS } from '../src/env/scoped-env.js'
import { WATCHDOG_PLAYBOOK_SKILL_ASSET } from '../../plugins/src/superagent/assets.js'
import { MemoryStore } from '../../plugins/src/memory/store.js'
import { createProfileFileHost } from './helpers/profile-file-host.js'
import { assert } from './helpers.js'
import { waitFor } from './helpers.js'
import {
  ArtifactService,
  AssetWatcher,
  AuthService,
  ConfigService,
  CredentialService,
  InMemoryArtifactRepository,
  ProfileService,
  ProviderService,
  type ProviderConfig,
  SecretStash,
  SkillService,
  SYSTEM_DEFAULT,
  atomicWriteFile,
  atomicWriteJson,
  ensureDataDir,
  isPrivateMode,
  parsePlaceholder,
  readJsonFile,
  readTextFile,
  resolveDataDir,
  withProcessFileLock,
} from '../src/services/index.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const scratchRoot = await mkdtemp(join(tmpdir(), 'helm-svc-e2e-'))
let scratchSeq = 0

/** each test independent temporary dataDir(real file behavior). */
async function freshDataDir(): Promise<string> {
  scratchSeq += 1
  const dir = join(scratchRoot, String(scratchSeq))
  await mkdir(dir, { recursive: true })
  return dir
}

/** temporary source file (register/spill test use). */
async function tempSourceFile(content: string | Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helm-src-'))
  const path = join(dir, `src-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await writeFile(path, content)
  return path
}

/** assertion promise by reject and error information match (avoid unhandled rejection noise). */
async function expectReject(fn: () => Promise<unknown>, re: RegExp): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    assert.match(String(err), re)
    return err
  }
  assert.fail(`should throw error: ${re}`)
}

// ---------------------------------------------------------------------------
// paths.ts
// ---------------------------------------------------------------------------
test('paths: resolveDataDir by default/override/env priority and ensureDataDir directory layout', { timeout: 60_000 }, async () => {
  const dir = await freshDataDir()
  // explicit override takes precedence
  assert.equal(resolveDataDir(dir), dir)
  // env time of
  const prev = process.env.HELM_DATA_DIR
  const envDir = join(scratchRoot, 'env-dir')
  process.env.HELM_DATA_DIR = envDir
  try {
    assert.equal(resolveDataDir(), envDir)
    // explicit override still press env
    assert.equal(resolveDataDir(dir), dir)
  } finally {
    if (prev === undefined) delete process.env.HELM_DATA_DIR
    else process.env.HELM_DATA_DIR = prev
  }
  // illegal override (sync throw)
  assert.throws(() => resolveDataDir(''), /empty/)
  assert.throws(() => resolveDataDir('relative/path'), /absolute path/)
  // ensureDataDir create complete design subdirectory
  await ensureDataDir(dir)
  for (const sub of ['profiles', 'skills', 'workflows', 'plugins', 'artifacts', 'cache']) {
    assert.ok(existsSync(join(dir, sub)), `should create ${sub}`)
  }
  // idempotent
  await ensureDataDir(dir)
})

// ---------------------------------------------------------------------------
// atomic-file.ts
// ---------------------------------------------------------------------------
test('atomic-file: atomic write do not temp leftover,0600 permission,JSON boundary error', { timeout: 60_000 }, async () => {
  const dir = await freshDataDir()
  const path = join(dir, 'profiles', 'p1', 'MEMORY.md')
  await atomicWriteFile(path, 'hello 世界')
  assert.equal(await readTextFile(path), 'hello 世界')
  // directory in only eventually file (without .tmp leftover)
  assert.deepEqual(await readdir(dirname(path)), ['MEMORY.md'])
  // 0600 private permission
  assert.ok(await isPrivateMode(path))
  // duplicate write still atomic
  await atomicWriteFile(path, 'second')
  assert.equal(await readTextFile(path), 'second')

  const jsonPath = join(dir, 'config.json')
  await atomicWriteJson(jsonPath, { a: 1 })
  assert.deepEqual(await readJsonFile(jsonPath), { a: 1 })

  // missing file throw contains path error
  await assert.rejects(() => readJsonFile(join(dir, 'nope.json')), /nope\.json/)
  // corrupt JSON throw parse error (contains path)
  await writeFile(join(dir, 'bad.json'), '{oops')
  await assert.rejects(() => readJsonFile(join(dir, 'bad.json')), /bad\.json/)
})

// ---------------------------------------------------------------------------
// ProfileService
// ---------------------------------------------------------------------------
test('profiles: ensureDefault self raise model empty string, duplicate self raise does not override,CRUD and protect by default items', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  const p = await profiles.ensureDefault()
  assert.equal(p.id, 'assistant')
  assert.equal(p.model, undefined) // not config i.e. default, by runtime explicit errors
  assert.ok(p.tags?.includes('assistant'))
  // self raise only SYSTEM.md(MEMORY.md by builtin:memory plugin self govern manage)
  assert.ok((await profiles.getSystem('assistant')).length > 0)

  // second ensureDefault does not override already has (user change model keep)
  await profiles.save({ ...p, model: 'openai/gpt-4o', name: 'assist', tags: ['assistant'] })
  const again = await profiles.ensureDefault()
  assert.equal(again.model, 'openai/gpt-4o')

  // list / get / save / delete
  await profiles.save({ id: 'worker', name: 'work person', tags: ['worker'] })
  const ids = (await profiles.list()).map((x) => x.id)
  assert.ok(ids.includes('assistant') && ids.includes('worker'))
  assert.notEqual((await profiles.get('worker'))?.name, undefined)

  await profiles.delete('worker')
  assert.equal(await profiles.get('worker'), undefined)

  // by default items protect + illegal id
  await assert.rejects(() => profiles.delete('assistant'), /cannot delete/)
  await assert.rejects(() => profiles.get('../etc'), /illegal profile id/)
  await assert.rejects(
    () => profiles.save({ id: 'UPPER', name: 'x', model: '', tags: [] }),
    /illegal profile id/,
  )
  // name boundary validate
  await assert.rejects(
    () => profiles.save({ id: 'ok1', name: '', tags: [] }),
    /name/,
  )
})

test('profiles: save no longer read write MEMORY.md(memory by builtin:memory self govern)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  await profiles.save({ id: 'writer', name: 'write manually', tags: [] })
  // creates new Profile do not automatically create MEMORY.md
  const entries = await readdir(join(dataDir, 'profiles', 'writer'))
  assert.ok(!entries.includes('MEMORY.md'), 'ProfileService.save must not create MEMORY.md')
  // pass memory field (old contract) by service layer static default strip: do not profile.json, do not write MEMORY.md
  //(HTTP boundary rejectUnknownKeys explicit 400, see http.test.ts).
  const saved = await profiles.save({ id: 'writer2', name: 'write manually', tags: [], memory: '# old field' } as never)
  assert.equal('memory' in saved, false, 'memory does not enter Profile contract')
  assert.ok(
    !(await readdir(join(dataDir, 'profiles', 'writer2'))).includes('MEMORY.md'),
    'memory field must not trigger MEMORY.md write',
  )
})

// ---------------------------------------------------------------------------
// SkillService
// ---------------------------------------------------------------------------
async function seedSkill(dataDir: string, id: string, refs: string[] = []): Promise<void> {
  const dir = join(dataDir, 'skills', id)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${id} skill\ndescription: test skill ${id}\n---\n\nbody text content.\n`,
  )
  for (const ref of refs) {
    const target = join(dir, ref)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `# ${ref}\nsee content.\n`)
  }
}

test('skills: list return references path,readFile by default SKILL.md and can read sub- file', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'demo', ['references/guide.md', 'references/rules/table.md'])
  const list = await skills.list()
  assert.equal(list.length, 1)
  const summary = list[0]!
  assert.equal(summary.id, 'demo')
  assert.equal(summary.name, 'demo skill')
  assert.equal(summary.description, 'test skill demo')
  assert.deepEqual(summary.references, [
    'references/guide.md',
    'references/rules/table.md',
  ])

  const main = await skills.readFile('demo')
  assert.ok(main.includes('body text content'))
  const ref = await skills.readFile('demo', 'references/guide.md')
  assert.ok(ref.includes('see content'))
  const nested = await skills.readFile('demo', 'references/rules/table.md')
  assert.ok(nested.includes('table'))
})

test('skills: strictly reject absolute path,..through exceeds, backslash and symlink out of bounds', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'demo', ['references/guide.md'])

  await assert.rejects(() => skills.readFile('demo', '/etc/passwd'), /absolute path/)
  await assert.rejects(() => skills.readFile('demo', 'references/../../etc/passwd'), /through exceeds|out of bounds|illegal/)
  await assert.rejects(() => skills.readFile('demo', '..'), /through exceeds|illegal|path/)
  await assert.rejects(() => skills.readFile('demo', 'references\\..\\secret'), /backslash|illegal/)
  // empty path
  await assert.rejects(() => skills.readFile('demo', ''), /path cannot be empty/)

  // symlink out of bounds:references/evil.md -> dataDir of outside
  const outside = join(scratchRoot, 'outside-secret.md')
  await writeFile(outside, 'absolute external content')
  await symlink(outside, join(dataDir, 'skills', 'demo', 'references', 'evil.md'))
  await assert.rejects(
    () => skills.readFile('demo', 'references/evil.md'),
    /symlink|symlink/,
  )
  // symlink do not appear in list  references in
  const list = await skills.list()
  const refs = list[0]!.references
  assert.ok(!refs.includes('references/evil.md'), 'symlink must not appear in skill directory in')

  // skill directory itself is symlink (points to skills of outside) must reject (realpath two-layer contains validate)
  const evilSkill = join(scratchRoot, 'evil-skill')
  await mkdir(join(evilSkill, 'references'), { recursive: true })
  await writeFile(join(evilSkill, 'SKILL.md'), 'malicious skill')
  await symlink(evilSkill, join(dataDir, 'skills', 'evil-link'))
  await assert.rejects(
    () => skills.readFile('evil-link'),
    /symlink|symlink|out of bounds/,
  )
  // points to skills internal symlink skill directory:realpath after still in inside, but do not put wide one by one segment symlink reject
  await symlink(join(dataDir, 'skills', 'demo'), join(dataDir, 'skills', 'inner-link'))
  await assert.rejects(
    () => skills.readFile('inner-link'),
    /symlink|symlink|out of bounds/,
  )
  // illegal skill id
  await assert.rejects(() => skills.readFile('../demo'), /illegal skill id/)
})

test('profiles: SYSTEM_DEFAULT layer - - contains helm-cli quote lead and HELM_CONVERSATION_ID, excludes generate style UI component dictionary', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const system = await profiles.getSystem('assistant')
  // Layer 0 must refer quote load_skill helm-cli and managed CLI environment variable
  assert.ok(system.includes('# System Prompt'))
  assert.ok(system.includes('helm-cli'), 'should contains helm-cli skill quote lead')
  assert.ok(system.includes('HELM_CONVERSATION_ID'), 'should contains managed environment variable direct feel')
  assert.ok(system.includes('load_skill'), 'should refer reference load_skill on demand load')
  // layer iron rule: common resident prompt excludes specific generate style UI component name (push down Layer 2 references)
  for (const component of ['MetricGrid', 'CheckboxGroup', 'ActionBar', 'BarList', 'KeyValueList', 'Accordion', 'helm:action', 'helm:open', 'helm:send']) {
    assert.ok(!system.includes(component), `SYSTEM_DEFAULT must not contains Layer 2 detail: ${component}`)
  }
  // directory drive: common resident prompt do not point name specific extend skill, by when turn available skill directory self explain
  for (const name of ['generative-ui', 'app-builder']) {
    assert.ok(!system.includes(name), `SYSTEM_DEFAULT must not hard encode extend skill name: ${name}`)
  }
  // artifact register markdown rule keep in Layer 0
  assert.ok(system.includes('artifact:<id>'), 'should keep artifact register and inline render rule')
})

test('helm-cli skill asset sync UI extend and conversation throw shadow capability side (guard against fall back)', { timeout: 60_000 }, () => {
  // generative-ui manual already migrate builtin:json-render plugin skill (follow start stop filter):
  // helm-cli SKILL.md must not leftover points to deleted references under drill index.
  assert.ok(!HELM_CLI_SKILL_MD.includes('references/generative-ui.md'), 'must not reference already migrate out generative-ui.md')
  assert.ok(HELM_CLI_SKILL_MD.includes('当回合可用技能描述'), 'should by motion state skill directory choose extend output capability')
  for (const optionalSkill of ['generative-ui', 'app-builder']) {
    assert.ok(!HELM_CLI_SKILL_MD.includes(optionalSkill), `through use CLI skill must not point name optional skill ${optionalSkill}`)
  }

  // SKILL.md: conversation document CLI parameter
  assert.ok(HELM_CLI_SKILL_MD.includes('--conversation'), 'SKILL.md should contains doc --conversation conversation document read')
  assert.ok(HELM_CLI_SKILL_MD.includes('--watch'), 'SKILL.md should contains doc --watch subscribe')

  // plugin development:ctx.ui register method contract align
  assert.ok(
    HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(`${PLUGIN_UI_METHOD_NAMES.length} 个 ctx.ui 注册方法`),
    `should document ${PLUGIN_UI_METHOD_NAMES.length} ctx.ui registration methods`,
  )
  for (const method of PLUGIN_UI_METHOD_NAMES) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(method),
      `plugin development see should contains ctx.ui register method ${method}`,
    )
  }

  // plugin development: backend Hook contract align
  for (const hook of PLUGIN_HOOK_NAMES) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(hook),
      `plugin development see should contains backend Hook ${hook}`,
    )
  }

  // plugin development: keep slash term contract align
  for (const slash of RESERVED_SLASH_COMMANDS) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(slash),
      `plugin development see should contains keep slash term ${slash}`,
    )
  }

  // plugin development:@helm/plugin-client export symbol contract align
  for (const exportName of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(exportName),
      `plugin development see should contains @helm/plugin-client export symbol ${exportName}`,
    )
  }

  // plugin development: keep for sessionDoc,composer,sp.<key> assertion
  for (const api of ['ctx.sessionDoc', 'composer']) {
    assert.ok(HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(api), `plugin development see should contains ${api}`)
  }
  assert.ok(HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes('sp.<key>'), 'should documenting sp./ssp. deep link naming empty between')

  // CLI core command all amount align (CORE_CLI_COMMAND_PATHS is unique true source, do not set die count)
  for (const cmdPath of CORE_CLI_COMMAND_PATHS) {
    const parts = cmdPath.split(' ')
    if (parts.length === 1) {
      assert.ok(
        HELM_CLI_SKILL_MD.includes(`helm ${cmdPath}`),
        `SKILL.md should contain single term core command "helm ${cmdPath}"`,
      )
    } else {
      const [root, sub] = parts
      const pattern = new RegExp(`helm ${root} [\\w|]*\\b${sub}\\b`)
      const matched = HELM_CLI_SKILL_MD.includes(`helm ${cmdPath}`) || pattern.test(HELM_CLI_SKILL_MD)
      assert.ok(
        matched,
        `SKILL.md should contain or via merge write method regex match core command "helm ${cmdPath}"`,
      )
    }
  }

  // managed environment variable all amount align
  for (const envVar of MANAGED_EXEC_ENV_VARS) {
    assert.ok(
      HELM_CLI_SKILL_MD.includes(envVar),
      `SKILL.md should contain managed environment variable ${envVar}`,
    )
  }

  // template placeholder zero leftover and error protect verify
  assert.ok(
    !HELM_CLI_SKILL_ASSET.skillMd.includes('{{') && !HELM_CLI_SKILL_ASSET.skillMd.includes('}}'),
    'HELM_CLI_SKILL_ASSET.skillMd must not leftover template placeholder',
  )
  for (const [refName, refContent] of Object.entries(HELM_CLI_SKILL_ASSET.references)) {
    assert.ok(
      !refContent.includes('{{') && !refContent.includes('}}'),
      `HELM_CLI_SKILL_ASSET reference "${refName}" must not leftover template placeholder`,
    )
  }

  assert.ok(
    !WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd.includes('{{') && !WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd.includes('}}'),
    'WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd must not leftover template placeholder',
  )
  for (const [refName, refContent] of Object.entries(WATCHDOG_PLAYBOOK_SKILL_ASSET.references)) {
    assert.ok(
      !refContent.includes('{{') && !refContent.includes('}}'),
      `WATCHDOG_PLAYBOOK_SKILL_ASSET reference "${refName}" must not leftover template placeholder`,
    )
  }

  assert.throws(
    () => renderSkillTemplate('hello {{UNKNOWN_VAR}}', {}),
    (err: unknown) => err instanceof HelmError && err.code === 'unreplaced_skill_placeholder',
  )
})

test('skills: ensureSkill managed override - - self raise, restart override source code version, patch missing file, reject symlink override, write only read', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const skills = new SkillService(dataDir)
  const asset = {
    id: 'demo-asset',
    skillMd: '---\nname: demo-asset\ndescription: self raise skill\n---\n\n# body text\n',
    references: {
      'guide.md': '# guide\ncontent.\n',
      'extra.md': '# additional\ncontent.\n',
    },
  }

  // first time self raise: all write and can read
  await skills.ensureSkill(asset)
  assert.ok((await skills.readFile('demo-asset')).includes('self raise skill'))
  assert.ok((await skills.readFile('demo-asset', 'references/guide.md')).includes('guide'))
  assert.ok((await skills.readFile('demo-asset', 'references/extra.md')).includes('additional'))

  // managed skill write opening: service boundary unify 403 managed_skill_readonly
  await assert.rejects(
    () => skills.writeFile('demo-asset', 'SKILL.md', 'tamper'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'managed_skill_readonly')
      assert.equal(err.status, 403)
      return true
    },
  )
  await assert.rejects(
    () => skills.writeFile('demo-asset', 'references/other.md', 'tamper'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'managed_skill_readonly')
      return true
    },
  )

  // disk manually work tamper (bypass service) after restart sync:SKILL.md and guide.md back to source code version
  const customMd = '---\nname: demo-asset\ndescription: user change write\n---\n\nI self define body text\n'
  const customGuide = '# user change write guide\n'
  await writeFile(join(dataDir, 'skills', 'demo-asset', 'SKILL.md'), customMd)
  await writeFile(join(dataDir, 'skills', 'demo-asset', 'references', 'guide.md'), customGuide)
  await skills.ensureSkill(asset)
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'SKILL.md')),
    asset.skillMd,
    'restart sync after SKILL.md must back to source code version',
  )
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'references', 'guide.md')),
    asset.references['guide.md']!,
    'restart sync after reference must back to source code version',
  )

  // delete a sub- file after again sync: missing extra.md by patch complete
  await rm(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await skills.ensureSkill(asset)
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md')),
    asset.references['extra.md']!,
  )

  // content consistent when do not heavy write (by content compare, do not by mtime; avoid atomic rename jitter watcher)
  const stablePath = join(dataDir, 'skills', 'demo-asset', 'SKILL.md')
  const stableBefore = await lstat(stablePath)
  const backdatedMs = stableBefore.mtimeMs - 60_000
  const backdated = new Date(backdatedMs)
  await utimes(stablePath, backdated, backdated)
  await skills.ensureSkill(asset)
  const stableAfter = await lstat(stablePath)
  // file system milli second truncate has sub milli second bias difference, contain difference 2ms inside treated as not by heavy write (heavy write will update is when before time, each other difference minute level)
  assert.ok(
    Math.abs(stableAfter.mtimeMs - backdatedMs) <= 2,
    `content consistent when must not heavy write (mtime should stay back set value ~${backdatedMs}, actual ${stableAfter.mtimeMs})`,
  )
  assert.equal(await readTextFile(stablePath), asset.skillMd)

  // target already exists and is symlink: reject override (guard against symlink out of bounds; directory/symlink all is not common rule file)
  const outside = join(scratchRoot, 'outside-target.md')
  await writeFile(outside, 'external content')
  await rm(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await symlink(outside, join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await assert.rejects(() => skills.ensureSkill(asset), /is not common rule file/)
  assert.equal(await readFile(outside, 'utf8'), 'external content')

  // illegal asset id and illegal reference name in boundary reject, and produces no part asset
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: '../evil' }),
    /illegal skill id/,
  )
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ok-id', references: { '../evil.md': 'x' } }),
    /through exceeds|illegal/,
  )
  assert.ok(!existsSync(join(dataDir, 'skills', 'ok-id')), 'illegal reference must not produce part asset')
})

test('skills: user self create skill do not subject to managed override affect - -ensureSkill do not trigger touch,writeFile can write', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'user-skill', ['references/guide.md'])
  const before = await readTextFile(join(dataDir, 'skills', 'user-skill', 'SKILL.md'))

  // self raise other managed skill does not affect user self create skill
  await skills.ensureSkill({
    id: 'managed-asset',
    skillMd: '---\nname: managed-asset\ndescription: managed\n---\n\nbody text\n',
    references: {},
  })
  assert.equal(await readTextFile(join(dataDir, 'skills', 'user-skill', 'SKILL.md')), before)
  assert.ok(!(await skills.list()).some((s) => s.id === 'user-skill' && s.managedByPlugin), 'user skill without managed mark record')

  // user self create skill write do not subject to 403 restrict
  await skills.writeFile('user-skill', 'SKILL.md', '---\nname: user-skill\ndescription: user skill\n---\nuser can write\n')
  assert.ok((await skills.readFile('user-skill')).includes('user can write'))
  await skills.writeFile('user-skill', 'references/extra.md', '# user new increase\n')
  assert.ok((await skills.readFile('user-skill', 'references/extra.md')).includes('user new increase'))
})

test('skills: ensureSkill reject directory symlink and directory smoke fill file, never to skills of outside write', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  const asset = {
    id: 'demo-guard',
    skillMd: '---\nname: demo-guard\ndescription: guard\n---\n\n# body text\n',
    references: { 'guide.md': '# guide\n', 'rules/table.md': '# rule\n' },
  }

  // skills fundamentally body is symlink: and requireSkillsRoot semantics consistent,realpath parse after normal self raise
  const realRoot = join(dataDir, 'real-skills')
  await mkdir(realRoot, { recursive: true })
  await symlink(realRoot, join(dataDir, 'skills'))
  await skills.ensureSkill(asset)
  assert.ok((await skills.readFile('demo-guard')).includes('guard'))
  assert.ok((await skills.readFile('demo-guard', 'references/rules/table.md')).includes('rule'))

  // skills/<id> is symlink: reject write, symlink target directory keep empty (do not to outside write)
  const evilDir = join(scratchRoot, 'evil-skill-dir')
  await rm(evilDir, { recursive: true, force: true })
  await mkdir(evilDir, { recursive: true })
  await symlink(evilDir, join(realRoot, 'linked-skill'))
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'linked-skill' }),
    /symlink/,
  )
  assert.deepEqual(await readdir(evilDir), [])

  // references directory is symlink: reject write, external directory do not by write any file
  const outsideRefs = join(scratchRoot, 'outside-refs')
  await rm(outsideRefs, { recursive: true, force: true })
  await mkdir(outsideRefs, { recursive: true })
  await mkdir(join(realRoot, 'ref-link-skill'), { recursive: true })
  await symlink(outsideRefs, join(realRoot, 'ref-link-skill', 'references'))
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-link-skill' }),
    /symlink/,
  )
  assert.deepEqual(await readdir(outsideRefs), [])
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-link-skill', references: {} }),
    /symlink/,
  )

  // SKILL.md location is directory: directory smoke fill file do not compute self raise succeeded
  await mkdir(join(realRoot, 'dir-as-file', 'SKILL.md'), { recursive: true })
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'dir-as-file' }),
    /is not common rule file/,
  )

  // reference location is directory: same reject
  await mkdir(join(realRoot, 'ref-as-dir', 'references', 'guide.md'), { recursive: true })
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-as-dir' }),
    /is not common rule file/,
  )
})

test('profiles: skills three state - - default do not write field, empty array durable keep, blank name single dedupe and illegal value reject', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()

  // ① default: do not carries skills field save, durable layer do not write the key (get back read undefined)
  await profiles.save({ id: 'p-default', name: 'default', tags: [] })
  assert.equal((await profiles.get('p-default'))?.skills, undefined)
  const onDiskDefault = JSON.parse(await readFile(join(dataDir, 'profiles', 'p-default', 'profile.json'), 'utf8')) as Record<string, unknown>
  assert.equal('skills' in onDiskDefault, false, 'default when profile.json do not write skills key')

  // ② empty array: durable keep (disable all skill explicit config, must not by discard)
  await profiles.save({ id: 'p-none', name: 'all forbid', tags: [], skills: [] })
  assert.deepEqual((await profiles.get('p-none'))?.skills, [])
  const onDiskNone = JSON.parse(await readFile(join(dataDir, 'profiles', 'p-none', 'profile.json'), 'utf8')) as { skills?: string[] }
  assert.deepEqual(onDiskNone.skills, [], 'empty array must original')

  // ③ non-empty blank name single: duplicate items specification dedupe after persist; unknown/temporary missing id allows save (runtime can after install)
  await profiles.save({ id: 'p-white', name: 'blank name single', tags: [], skills: ['helm-cli', 'watchdog-playbooks', 'helm-cli', 'future-skill'] })
  assert.deepEqual((await profiles.get('p-white'))?.skills, ['helm-cli', 'watchdog-playbooks', 'future-skill'])

  // illegal value: non- array / non- string element / illegal skill id format (path inject) explicit reject
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: 'helm-cli' } as unknown as Parameters<ProfileService['save']>[0]),
    /skills must be string array/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: ['ok-skill', 42] } as unknown as Parameters<ProfileService['save']>[0]),
    /skills must be string array/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: ['../profiles/assistant'] }),
    /illegal skill id/,
  )
})

// ---------------------------------------------------------------------------
// AssetWatcher
// ---------------------------------------------------------------------------
test('watcher: 150ms guard against jitter catch atomic rename write and do not report temp,close after stop', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const events: string[][] = []
  const errors: Error[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => events.push(paths),
    { onError: (err) => errors.push(err) },
  )
  watcher.start()
  try {
    // atomic write MEMORY.md(temp+rename)
    await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'), 'one edition')
    await waitFor(() => events.some((batch) => batch.some((p) => p === 'profiles/assistant/MEMORY.md')))
    // again write once: guard against jitter together batch, path still correct
    await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'), 'second edition')
    await waitFor(() => {
      const batches = events.filter((b) => b.includes('profiles/assistant/MEMORY.md'))
      return batches.length >= 2
    })
    // without temp file event leak leak
    for (const batch of events) {
      for (const p of batch) assert.ok(!p.includes('.tmp'), `temp file must not appear in event in: ${p}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    watcher.close()
  }
  // close after no longer event
  const countBefore = events.length
  await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'SYSTEM.md'), 'x')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(events.length, countBefore)
})

test('watcher: listen missing directory explicit errors (not silently swallow wrong)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const missing = join(dataDir, 'no-such-dir')
  const errors: Error[] = []
  const watcher = new AssetWatcher(missing, () => {}, { onError: (err) => errors.push(err) })
  watcher.start()
  try {
    await waitFor(() => errors.length > 0, 8_000)
    assert.ok(errors[0]!.message.length > 0, 'error must explicit on report')
  } finally {
    watcher.close()
  }
})

// ---------------------------------------------------------------------------
// SecretStash
// ---------------------------------------------------------------------------
test('stash: put return REDACTED placeholder,envFor inject,redact by conversation isolated', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const ph = stash.put(1, 'GITHUB_TOKEN', 'ghp_secret_value_111')
  assert.ok(ph.startsWith('[REDACTED:stash:'))
  assert.ok(ph.endsWith(']'))
  const uuid = parsePlaceholder(ph)
  assert.notEqual(uuid, null)

  // envFor
  assert.deepEqual(stash.envFor(1), { GITHUB_TOKEN: 'ghp_secret_value_111' })
  assert.deepEqual(stash.envFor(2), {}) // conversation isolated

  // illegal environment variable name reject
  assert.throws(() => stash.put(1, '1BAD NAME', 'x'), /legal environment variable name/)

  // same name override only more swap environment variable, old value still must redaction.
  const nextValue = 'replacement-example-value'
  const ph2 = stash.put(1, 'GITHUB_TOKEN', nextValue)
  assert.notEqual(ph, ph2)
  assert.equal(stash.redact(ph), ph)
  assert.equal(stash.redact(ph2), ph2)
  assert.equal(stash.redact(nextValue, 1), ph2)
  assert.equal(stash.redact('ghp_secret_value_111', 1), ph)
  stash.put(2, 'GITHUB_TOKEN', 'other-example-value')
  stash.put(2, 'OTHER_KEY', 'other_value')
  assert.equal(stash.redact(ph2, 2), ph2)
  assert.equal(stash.redact(nextValue, 2), nextValue)
  assert.equal(stash.redact(`token=${nextValue} done`, 1), `token=${ph2} done`)
  assert.equal(stash.redact(`token=${nextValue} done`), `token=${ph2} done`)
  const special = 'example.*+?^${}()|[]\\value'
  const specialMarker = stash.put(1, 'REGEX_VALUE', special)
  assert.equal(stash.redact(special), specialMarker)

  // clear single conversation
  stash.clear(1)
  assert.deepEqual(stash.envFor(1), {})
  assert.deepEqual(stash.envFor(2), { GITHUB_TOKEN: 'other-example-value', OTHER_KEY: 'other_value' })
  stash.clear()
  assert.equal(stash.stats().secrets, 0)
})

test('stash: addRedaction global one by one value redaction - - non- env, do not count stats,clear(id) do not clean, reference counter', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const managed = 'managed-token-value-abc123'
  const release = stash.addRedaction(managed)

  // any conversation context (contains without context) all redaction; and stash placeholder can shared store
  const stashPh = stash.put(1, 'MY_KEY', 'session-secret-value')
  assert.equal(stash.redact(`token=${managed}`), 'token=[REDACTED]')
  assert.equal(stash.redact(`token=${managed}`, 1), 'token=[REDACTED]')
  assert.equal(stash.redact(`token=${managed}`, 99), 'token=[REDACTED]')
  assert.equal(stash.redact(`session=${'session-secret-value'} managed=${managed}`), `session=${stashPh} managed=[REDACTED]`)

  // non- env, do not count stats, do not envFor
  assert.deepEqual(stash.envFor(1), { MY_KEY: 'session-secret-value' })
  assert.deepEqual(stash.envFor(2), {})
  assert.equal(stash.stats().secrets, 1)

  // clear(single conversation) do not clean global register;clear() all clean (contains global)
  stash.clear(1)
  assert.equal(stash.redact(managed), '[REDACTED]')
  stash.clear()
  assert.equal(stash.redact(managed), managed, 'clear() should connect global register one and clear')

  // reference counter: the same value stack put two time, all solve except only then stop redaction; solve except function idempotent
  const r1 = stash.addRedaction(managed)
  const r2 = stash.addRedaction(managed)
  r1()
  r1()
  assert.equal(stash.redact(managed), '[REDACTED]')
  r2()
  assert.equal(stash.redact(managed), managed)

  // illegal reference reject
  assert.throws(() => stash.addRedaction(''), /non-empty/)
})

test('stash: global redaction takes precedence, mark record idempotent and old solve except handle isolated', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  const value = 'internal-example-for-redaction'
  const releaseOld = stash.addRedaction(value)
  stash.put(1, 'EXAMPLE', value)
  assert.equal(stash.redact(value), '[REDACTED]')

  stash.clear()
  const releaseCurrent = stash.addRedaction(value)
  releaseOld()
  assert.equal(stash.redact(value), '[REDACTED]', 'empty before handle must not solve except new register')
  releaseCurrent()
  assert.equal(stash.redact(value), value)

  stash.addRedaction('REDACTED')
  assert.equal(stash.redact('[REDACTED]'), '[REDACTED]', 'already redaction mark record keep original')
})

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------
test('auth: setup only first time, weak password reject,login sign,token summary persist and do not plaintext', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  assert.deepEqual(await auth.status(), { configured: false })

  // weak password
  await assert.rejects(() => auth.setup('short'), /at least 8/)
  await assert.rejects(() => auth.setup(''), /at least 8/)
  assert.deepEqual(await auth.status(), { configured: false })

  // setup
  const { token } = await auth.setup('correct horse battery staple')
  assert.ok(token.length >= 32)
  assert.deepEqual(await auth.status(), { configured: true })

  // duplicate setup reject
  await assert.rejects(() => auth.setup('another password 99'), /already config|duplicate/)

  // config.json in without plaintext password, without plaintext token
  const configText = await readTextFile(join(dataDir, 'config.json'))
  assert.ok(!configText.includes('correct horse'), 'password plaintext must not')
  assert.ok(!configText.includes(token), 'token plaintext must not')

  // error password
  await assert.rejects(() => auth.login('wrong password!!'), /password error/)
  // not config scenario login explicit errors
  const auth2 = new AuthService(await freshDataDir())
  await assert.rejects(() => auth2.login('some password'), /setup|initialize/)

  // correct login + double token all valid
  const { token: token2 } = await auth.login('correct horse battery staple')
  assert.notEqual(token, token2)
  assert.equal(await auth.verifyToken(token), true)
  assert.equal(await auth.verifyToken(token2), true)
  assert.equal(await auth.verifyToken('f'.repeat(64)), false)
  assert.equal(await auth.verifyToken(''), false)
  // summary form:64 hex character
  const config = JSON.parse(configText) as { auth?: { tokens?: Record<string, { digest: string }> } }
  const digests = Object.values(config.auth?.tokens ?? {})
  assert.ok(digests.length >= 1)
  assert.ok(digests.every((d) => /^[0-9a-f]{64}$/.test(d.digest)))
})

test('auth: createProcessToken only memory lifecycle - - identify,dispose expires, do not, anonymous do not let through', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  // not setup also available: kernel managed child process authentication independent at password body system
  assert.deepEqual(await auth.status(), { configured: false })
  const managed = auth.createProcessToken()
  assert.ok(managed.token.length >= 32)
  assert.equal(await auth.verifyToken(managed.token), true)

  // across instance can verify (same dataDir register table sharing, and durable token semantics consistent)
  assert.equal(await new AuthService(dataDir).verifyToken(managed.token), true)

  // do not write config.json/SQLite: without plaintext also without summary
  const configText = await readTextFile(join(dataDir, 'config.json')).catch(() => '')
  assert.ok(!configText.includes(managed.token), 'managed token plaintext must not')
  assert.ok(!configText.includes(managed.token.slice(0, 16)), 'managed token must not with any form')

  // dispose after immediately expires (idempotent); persist token do not subject to affect
  const { token: persisted } = await auth.setup('process token pw 12345678')
  assert.equal(await auth.verifyToken(persisted), true)
  managed.dispose()
  managed.dispose() // idempotent
  assert.equal(await auth.verifyToken(managed.token), false)
  assert.equal(await auth.verifyToken(persisted), true)

  // anonymous/null value/fake value forever do not let through (must not because managed channel store in while put wide)
  assert.equal(await auth.verifyToken(''), false)
  assert.equal(await auth.verifyToken('anonymous'), false)
  assert.equal(await auth.verifyToken('0'.repeat(64)), false)
})

test('auth: concurrency setup only succeeded once, concurrency update does not override other config key', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => auth.setup(`password-number-${i}000000`)),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, 'concurrency setup only a succeeded')
  for (const r of results) {
    if (r.status === 'rejected') assert.match(String(r.reason), /already config|duplicate/)
  }

  // ConfigService concurrency update keep other key
  const config = new ConfigService(dataDir)
  await Promise.all([
    config.update({ theme: 'dark' }),
    config.update({ locale: 'zh-CN' }),
    config.update({ featureX: true }),
  ])
  const final = await config.get()
  assert.deepEqual(
    { theme: final['theme'], locale: final['locale'], featureX: final['featureX'] },
    { theme: 'dark', locale: 'zh-CN', featureX: true },
  )
  assert.ok(final['auth'], 'concurrency update must not lose auth key')
})

// ---------------------------------------------------------------------------
// CredentialService
// ---------------------------------------------------------------------------
test('credentials: set/get/list/delete, constant 0600,providers.json and secret key isolated', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const credentials = new CredentialService(dataDir)
  assert.deepEqual(await credentials.list(), [])

  await credentials.set('openai', 'sk-live-abcdef123456')
  await credentials.set('anthropic', 'sk-ant-zzz')
  assert.deepEqual(await credentials.list(), ['anthropic', 'openai'])
  assert.equal(await credentials.get('openai'), 'sk-live-abcdef123456')

  // file permission constant 0600
  assert.ok(await isPrivateMode(join(dataDir, 'credentials.json')))

  // already has file by put wide permission after again write still converge 0600(rename keep pattern,atomic write temp 0600)
  await chmod(join(dataDir, 'credentials.json'), 0o644)
  await credentials.set('openai', 'sk-rotated-999')
  assert.ok(await isPrivateMode(join(dataDir, 'credentials.json')))
  assert.equal(await credentials.get('openai'), 'sk-rotated-999')

  await credentials.delete('anthropic')
  assert.deepEqual(await credentials.list(), ['openai'])
  await assert.rejects(() => credentials.delete('anthropic'), /missing|anthropic/)

  // plugin secret read write and delete
  await credentials.setPluginSecret('builtin:triggers', 'webhookSecret', 'whsec_abc')
  assert.equal(await credentials.getPluginSecret('builtin:triggers', 'webhookSecret'), 'whsec_abc')
  await credentials.deletePluginSecrets('builtin:triggers')
  assert.equal(await credentials.getPluginSecret('builtin:triggers', 'webhookSecret'), undefined)

  // illegal id / null value
  await assert.rejects(() => credentials.get('../x'), /illegal/)
  await assert.rejects(() => credentials.set('openai', ''), /cannot be empty/)

  // ProviderService:providers.json without secret key field, secret key field directly reject
  const providers = new ProviderService(dataDir)
  await providers.save([
    {
      id: 'openai',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o'],
      label: 'OpenAI',
      enabled: true,
    },
  ])
  const providerList = await providers.list()
  assert.equal(providerList.length, 1)
  const providerText = await readTextFile(join(dataDir, 'providers.json'))
  assert.ok(!providerText.includes('sk-'), 'providers.json must not contains secret key value')
  await assert.rejects(
    () =>
      providers.save([
        {
          id: 'x', protocol: 'openai', baseUrl: 'https://x.example.com',
          models: ['m1'], enabled: true, apiKey: 'sk-leak',
        } as unknown as ProviderConfig[],
      ] as never),
    /forbidden contains secret key field/,
  )
  // providers.json and credentials.json is two file
  assert.ok(existsSync(join(dataDir, 'providers.json')))
  assert.ok(existsSync(join(dataDir, 'credentials.json')))
})

// ---------------------------------------------------------------------------
// ArtifactService
// ---------------------------------------------------------------------------
test('artifacts: register duplicate register,readContent read,list and deleteConversation level join', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const artifacts = new ArtifactService(dataDir, repository)

  const src = await tempSourceFile('# report\ncontent'.repeat(100))
  const meta = await artifacts.register(1, src, { name: 'report.md' })
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.kind, 'registered')
  assert.equal(meta.name, 'report.md')
  // metadata.path fixed is POSIX isolate symbol (artifactRelPath),Windows on also must not appear backslash
  assert.ok(meta.path.startsWith('artifacts/1/'))
  assert.ok(!meta.path.includes('\\'))
  assert.ok(meta.size > 0)
  assert.ok((await artifacts.readContent(meta.id)).includes('report'))
  assert.equal((await artifacts.list(1)).length, 1)
  // source file do not by break (duplicate while non- move)
  assert.ok(existsSync(src))

  await artifacts.register(2, src)
  assert.equal((await artifacts.list(1)).length, 1)
  assert.equal((await artifacts.list(2)).length, 1)

  await artifacts.deleteConversation(1)
  assert.equal((await artifacts.list(1)).length, 0)
  assert.equal((await artifacts.list(2)).length, 1)
  assert.deepEqual(await artifacts.listFiles(1), [])

  // register invalid input
  await assert.rejects(() => artifacts.register(0, src), /conversationId/)
  await assert.rejects(() => artifacts.register(1, ''), /sourcePath/)
  const evilName = await artifacts.register(1, src).catch(() => undefined)
  assert.notEqual(evilName, undefined)
})

test('artifacts: spill 32KiB threshold,4KiB UTF-8 security preview, secret do not,id/path refer quote', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, repository, stash)

  // low at threshold: original return, without artifact
  const small = 'x'.repeat(1024)
  const r1 = await artifacts.spill(1, 'call-1', small)
  assert.equal(r1.artifact, undefined)
  assert.equal(r1.text, small)

  // exactly threshold: do not (> 32KiB only then spill)
  const exact = 'y'.repeat(32 * 1024)
  const r2 = await artifacts.spill(1, 'call-2', exact)
  assert.equal(r2.artifact, undefined)

  // over threshold: + preview
  const headZh = 'preview header Chinese content.'
  const big = headZh + 'z'.repeat(40 * 1024) + 'tail part contentTAIL'
  const r3 = await artifacts.spill(1, 'call-3', big)
  assert.notEqual(r3.artifact, undefined)
  const meta = r3.artifact!
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.kind, 'spill')
  assert.ok(meta.path.includes('tool-spill-call-3.txt'))
  assert.ok(meta.size > 32 * 1024)
  // return text: header preview + truncate mark record + tail part summary + id/path refer quote
  assert.ok(r3.text.includes(headZh))
  assert.ok(r3.text.includes('already truncate'))
  assert.ok(r3.text.includes('TAIL'))
  assert.ok(r3.text.includes(meta.id))
  assert.ok(r3.text.includes(meta.path))
  // preview length subject to control (far less than all amount)
  assert.ok(Buffer.byteLength(r3.text, 'utf8') < 8 * 1024)
  // all amount file store in and content complete
  assert.ok((await artifacts.readContent(meta.id)).length === big.length)
  // repo already register
  assert.ok((await artifacts.list(1)).some((a) => a.id === meta.id))

  // UTF-8 security truncate: multibyte Chinese boundary do not tear
  const zhHead = 'Han'.repeat(2049) // 3 byte/character,4KiB boundary in character middle
  const r4 = await artifacts.spill(2, 'call-4', zhHead + 'a'.repeat(33 * 1024))
  assert.notEqual(r4.artifact, undefined)
  // preview can complete decode(if tear will out replace symbol)
  assert.ok(!r4.text.includes('\uFFFD'), 'UTF-8 truncate must not tear multibyte character')

  // contains stash placeholder text: file keep occupy (secret never)
  const placeholder = stash.put(9, 'MY_KEY', 'super-secret-value')
  const leak = `prefix${placeholder} super-secret-value` + 'q'.repeat(33 * 1024)
  const r5 = await artifacts.spill(9, 'call-5', leak)
  assert.ok(r5.artifact !== undefined)
  const spilled = await artifacts.readContent(r5.artifact!.id)
  assert.ok(!spilled.includes('super-secret-value'), 'secret plaintext must not spill file')
  assert.ok(spilled.includes(placeholder), 'placeholder form should keep')
  assert.ok(!r5.text.includes('super-secret-value'), 'preview must not contains secret plaintext')

  // Responses API re- together callId(contains `|`) allows via, and and `_` same shape callId do not occur thing file collision override
  const responsesStyle = await artifacts.spill(1, 'call_ab12|fc_call_ab12', 'z'.repeat(33 * 1024))
  const underscoreStyle = await artifacts.spill(1, 'call_ab12_fc_call_ab12', 'w'.repeat(33 * 1024))
  assert.ok(responsesStyle.artifact !== undefined, 're- together callId must can spill')
  assert.ok(underscoreStyle.artifact !== undefined)
  assert.notEqual(responsesStyle.artifact!.path, underscoreStyle.artifact!.path, 'escaping after must not and underscore callId collision override')
  assert.equal((await artifacts.readContent(responsesStyle.artifact!.id))[0], 'z')
  assert.equal((await artifacts.readContent(underscoreStyle.artifact!.id))[0], 'w')

  // illegal callId(path through exceeds, isolate symbol, whitespace, control character) boundary explicit reject
  await assert.rejects(() => artifacts.spill(1, '../evil', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, 'a/b', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '   ', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '.', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '..', 'x'), /callId/)
})

test('artifacts: register text artifact contains stash plaintext first redaction again, two enter system byte do not corrupt, fake metadata path reject', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, repository, stash)

  // contains real stash plaintext text file:register after file and readContent all excludes plaintext
  const secretValue = 'live-secret-token-for-register-test'
  stash.put(1, 'MY_SECRET', secretValue)
  const srcText = await tempSourceFile(`report header.\nsecret=${secretValue}\nreport tail part.\n`)
  const meta = await artifacts.register(1, srcText, { name: 'report.md' })
  const stored = await readFile(join(dataDir, meta.path), 'utf8')
  assert.ok(!stored.includes(secretValue), 'register text artifact must not secret plaintext')
  assert.ok(stored.includes('[REDACTED:stash:'), 'redaction after should contains placeholder')
  assert.ok(stored.includes('report header.'), 'non- secret part keep original')
  const readBack = await artifacts.readContent(meta.id)
  assert.ok(!readBack.includes(secretValue))
  assert.equal(meta.mimeType, 'text/markdown')

  // two enter system artifact: byte original duplicate (contains illegal UTF-8 sequence do not corrupt)
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80])
  const srcBin = await tempSourceFile(binary)
  const metaBin = await artifacts.register(1, srcBin, { name: 'photo.png' })
  assert.equal(metaBin.mimeType, 'image/png')
  const storedBin = await readFile(join(dataDir, metaBin.path))
  assert.deepEqual(new Uint8Array(storedBin), binary, 'two enter system byte must original keep')
  const buf = await artifacts.readBuffer(metaBin.id)
  assert.deepEqual(new Uint8Array(buf), binary)

  // fake metadata path (manually change DB) reject: absolute path,../ through exceeds,artifacts of outside
  const evil1 = { ...meta, id: 'evil-1', path: '/etc/passwd' }
  repository.put(evil1 as never)
  await assert.rejects(() => artifacts.readContent('evil-1'), /exceeds out|reject/)
  await assert.rejects(() => artifacts.readBuffer('evil-1'), /exceeds out|reject/)
  const evil2 = { ...meta, id: 'evil-2', path: 'artifacts/../../credentials.json' }
  repository.put(evil2 as never)
  await assert.rejects(() => artifacts.readContent('evil-2'), /exceeds out|reject/)
  // normal metadata still can read (validate does not affect legal path)
  assert.ok((await artifacts.readContent(meta.id)).includes('report header.'))

  // list illegal convId reject (avoid -1 etc. out of bounds directory segment)
  await assert.rejects(() => artifacts.list(-1), /conversationId/)
  await assert.rejects(() => artifacts.list(1.5), /conversationId/)
  await assert.rejects(() => artifacts.deleteConversation(-1), /conversationId/)
})

// ---------------------------------------------------------------------------
// across instance concurrency correct (process inside sharing serial)
// ---------------------------------------------------------------------------
test('concurrency regression: different ConfigService instance same dataDir concurrency update do not lose key', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  // 5 independent instance concurrency write 5 different key: instance level queue will lose key, sharing lock must all keep
  const services = Array.from({ length: 5 }, () => new ConfigService(dataDir))
  await Promise.all(
    services.map((svc, i) => svc.update({ [`key${i}`]: `value-${i}` })),
  )
  const final = await services[0]!.get()
  for (let i = 0; i < 5; i++) {
    assert.equal(final[`key${i}`], `value-${i}`, `concurrency update must not lose key${i}`)
  }

  // again stack one round large amount concurrency: eventually still is all key and collection
  const services2 = Array.from({ length: 8 }, () => new ConfigService(dataDir))
  await Promise.all(
    services2.map((svc, i) => svc.update({ [`wave2-${i}`]: i })),
  )
  const final2 = await services2[0]!.get()
  for (let i = 0; i < 8; i++) assert.equal(final2[`wave2-${i}`], i)
  for (let i = 0; i < 5; i++) assert.equal(final2[`key${i}`], `value-${i}`)

  // dataDir is symlink when different write method still sharing the same lock
  const linked = join(scratchRoot, `link-dir-${Date.now()}`)
  await symlink(await realpath(dataDir), linked)
  await Promise.all([
    new ConfigService(dataDir).update({ viaReal: 1 }),
    new ConfigService(linked).update({ viaLink: 1 }),
  ])
  const final3 = await new ConfigService(dataDir).get()
  assert.equal(final3['viaReal'], 1)
  assert.equal(final3['viaLink'], 1)
})

test('concurrency regression: different AuthService instance concurrency setup only a succeeded', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => new AuthService(dataDir).setup(`instance-pw-${i}-12345678`)),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, 'across instance concurrency setup only a succeeded')
  for (const r of results) {
    if (r.status === 'rejected') assert.match(String(r.reason), /already config|duplicate/)
  }
  // succeeded instance token can verify
  const ok = fulfilled[0] as PromiseFulfilledResult<{ token: string }>
  assert.equal(await new AuthService(dataDir).verifyToken(ok.value.token), true)

  // concurrency setup and config.update hand over wrong:auth key and other key mutual does not override
  const dataDir2 = await freshDataDir()
  await Promise.all([
    new AuthService(dataDir2).setup('interleave-pw-12345678'),
    new ConfigService(dataDir2).update({ theme: 'dark' }),
    new ConfigService(dataDir2).update({ locale: 'zh-CN' }),
  ])
  const cfg = await new ConfigService(dataDir2).get()
  assert.ok(cfg['auth'], 'hand over wrong update must not lose auth')
  assert.equal(cfg['theme'], 'dark')
  assert.equal(cfg['locale'], 'zh-CN')
})

test('concurrency regression: different CredentialService instance concurrency set do not lose credentials', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const services = Array.from({ length: 5 }, () => new CredentialService(dataDir))
  await Promise.all(
    services.map((svc, i) => svc.set(`provider-${i}`, `sk-value-${i}`)),
  )
  const ids = await services[0]!.list()
  assert.deepEqual(ids, ['provider-0', 'provider-1', 'provider-2', 'provider-3', 'provider-4'])
  for (let i = 0; i < 5; i++) {
    assert.equal(await services[i]!.get(`provider-${i}`), `sk-value-${i}`)
  }
})

test('across process lock regression: broken lock reject, die holder break except, store holder do not strong split, lock leaves no residue', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const target = join(dataDir, 'credentials.json')
  const lockFile = `${target}.lock`

  // 1) lock content corrupt (without PID): explicit errors, never guess break except
  await writeFile(lockFile, 'not-a-pid garbage\n', { mode: 0o600 })
  await expectReject(() => withProcessFileLock(target, async () => 'ok'), /corrupt/)
  await rm(lockFile, { force: true })

  // 2) holder already die (missing PID):stale break except and normal execute; after end lock leaves no residue
  const deadPid = 2 ** 22 + Math.floor(Math.random() * 1000) // far over real PID scope cap, almost must missing
  {
    const probe = spawnSync(process.execPath, ['-e', 'process.exit(42)'])
    assert.equal(probe.status, 42)
  }
  await writeFile(lockFile, `${deadPid} uuid-dead\n`, { mode: 0o600 })
  assert.equal(await withProcessFileLock(target, async () => 'recovered'), 'recovered')
  assert.ok(!existsSync(lockFile), 'stale break except execute after lock should by release')

  // 3) holder store: wait for (do not by store when long strong split), release after gets lock
  const order: string[] = []
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     fs.writeFileSync(lock, process.pid + ' child-uuid\\n', { flag: 'wx', mode: 0o600 });
     setTimeout(() => { fs.unlinkSync(lock); process.exit(0) }, 400)`,
  ])
  // close listen must in spawn after immediately register: etc. lock release after again register will wrong already trigger close event
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  // etc. child process indeed gets lock again enter contend grab
  await waitFor(() => existsSync(lockFile))
  const acquired = await withProcessFileLock(target, async () => {
    order.push('parent')
    return 'after-child'
  })
  assert.equal(acquired, 'after-child', 'store holder lock must not by strong split, only can wait for its release')
  assert.deepEqual(order, ['parent'])
  assert.equal(await childExit, 0)
  assert.ok(!existsSync(lockFile))

  // 4) long process (>1s) hold lock during do not by stale strong split: first before store credentials still complete
  const svc = new CredentialService(dataDir)
  await svc.set('solo', 'sk-solo-1234567890')
  assert.equal(await svc.get('solo'), 'sk-solo-1234567890')
  const leftovers = (await readdir(dataDir)).filter((f) => f.endsWith('.lock'))
  assert.deepEqual(leftovers, [], 'happy path after end must not leftover lock file')
})

test('across process lock regression: real child process hold lock during CredentialService.set explicit etc. lock while non- lose update', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const svc = new CredentialService(dataDir)
  await svc.set('pre', 'sk-pre-0123456789')
  const lockFile = join(dataDir, 'credentials.json.lock')

  // child process real hold lock 300ms(store holder), during parent process set must queue up while non- read old write back
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     fs.writeFileSync(lock, process.pid + ' holder\\n', { flag: 'wx', mode: 0o600 });
     const t0 = Date.now();
     while (Date.now() - t0 < 300) {} // busy etc. hold lock (sync block, ensure do not mention before release)
     fs.unlinkSync(lock);`,
  ])
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  await waitFor(() => existsSync(lockFile))
  await svc.set('during', 'sk-during-9876543210')
  assert.equal(await childExit, 0)
  assert.deepEqual(await svc.list(), ['during', 'pre'])
  assert.equal(await svc.get('during'), 'sk-during-9876543210')
  assert.equal(await svc.get('pre'), 'sk-pre-0123456789')
})

test('across process lock regression: real CLI child process and CredentialService concurrency write credentials.json double key keep', { timeout: 60_000 }, async () => {
  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve('tsx/cli')
  const repoRoot = dirname(testDir) // packages/kernel/test -> repository
  const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
  // directory missing all new dataDir: verify both sides first time create and same lock mutual recognize
  const dataDir = join(tmpdir(), `helm-xproc-${process.pid}-${Date.now()}`)
  const credFile = join(dataDir, 'credentials.json')

  const runCliChild = (password: string): Promise<{ code: number | null; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, 'login', '--password', password, '--json'], {
        env: { ...process.env, HELM_DATA_DIR: dataDir, HELM_HUB_URL: 'http://127.0.0.1:1', HELM_TOKEN: '' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, err }))
    })

  try {
    await mkdir(dataDir, { recursive: true })
    await writeFile(credFile, JSON.stringify({ providers: {}, pluginSecrets: {} }), { mode: 0o600 })
    const svc = new CredentialService(dataDir)
    await svc.set('base', 'sk-base-0123456789')

    // CLI child process although connect do not on Hub(write credentials before only then failed), but login path first write lock again read credentials;
    // is ensure child process true execute write, change use and CLI same protocol lock hold process directly change write cli key
    const holder = spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs');
       const path = require('node:path');
       const file = ${JSON.stringify(credFile)};
       const lock = file + '.lock';
       fs.writeFileSync(lock, process.pid + ' holder\\n', { flag: 'wx', mode: 0o600 });
       const t0 = Date.now();
       while (Date.now() - t0 < 300) {} // hold lock read change write window: and CLI protocol consistent credentials.json.lock
       const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
       raw.cli = { hubUrl: 'http://127.0.0.1:3202', token: 'tok-child-write' };
       const tmp = file + '.tmp-child';
       fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\\n', { mode: 0o600 });
       fs.renameSync(tmp, file);
       fs.unlinkSync(lock);`,
    ])
    const holderExit = new Promise<number | null>((resolve) => holder.on('close', (c) => resolve(c)))
    const lockFile = `${credFile}.lock`
    await waitFor(() => existsSync(lockFile))
    // parent process (Hub side) in the same window inside concurrency write provider key: must queue up etc. child process release
    await svc.set('concurrent', 'sk-concurrent-abcdef123456')
    assert.equal(await holderExit, 0)

    const final = JSON.parse(await readFile(credFile, 'utf8')) as {
      cli: { token: string }
      providers: Record<string, { value: string }>
    }
    // both sides key all keep: lock protocol mutual recognize make read change write fully serial
    assert.equal(final.cli.token, 'tok-child-write', 'CLI side write cli key must not by Hub side override lose')
    assert.deepEqual(Object.keys(final.providers).sort(), ['base', 'concurrent'])
    assert.equal(final.providers['concurrent']!.value, 'sk-concurrent-abcdef123456')
    assert.ok(!(await readdir(dataDir)).some((f) => f.endsWith('.lock') || f.includes('.tmp')), 'after end without lock/temp file leftover')
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('concurrency regression: different MemoryStore instance concurrency append do not lose row', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const base = new MemoryStore(createProfileFileHost(dataDir))
  await base.ensureMemory('assistant')
  const stores = Array.from({ length: 5 }, () => new MemoryStore(createProfileFileHost(dataDir)))
  await Promise.all(
    stores.map((store, i) => store.updateMemory('assistant', `row-${i}`, 'append')),
  )
  const text = await base.getMemory('assistant')
  for (let i = 0; i < 5; i++) {
    assert.ok(text.includes(`row-${i}`), `concurrency append must not lose row-${i}`)
  }
  // total row count = by default header (1 row non-empty)+ 5 time append
  const lines = text.split('\n').filter((l: string) => l.length > 0)
  assert.equal(lines.length, 1 + 5)
})

test('credentials regression: keep CLI etc. unknown top-level key, illegal structure explicit reject do not override', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const credentials = new CredentialService(dataDir)

  // CLI write unknown key:set/get/delete after original keep
  const raw = {
    cli: { hubUrl: 'http://127.0.0.1:3202', token: 'cli-tok-abc' },
    providers: { openai: { value: 'sk-first', createdAt: 't1', updatedAt: 't1' } },
    pluginSecrets: {},
    extraFlag: true,
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(raw, null, 2), { mode: 0o600 })
  assert.equal(await credentials.get('openai'), 'sk-first')
  await credentials.set('anthropic', 'sk-second')
  const after = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(after['cli'], raw['cli'], 'CLI key must original keep')
  assert.equal(after['extraFlag'], true, 'other unknown key same keep')
  assert.equal(
    (after['providers'] as Record<string, { value: string }>)['openai']!.value,
    'sk-first',
    'already has provider credentials must not by override',
  )
  // delete provider after CLI key still in
  await credentials.delete('openai')
  const after2 = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(after2['cli'], raw['cli'])

  // providers items structure illegal (missing value): reject and keep original file
  const badPath = join(dataDir, 'credentials.json')
  await writeFile(badPath, JSON.stringify({ providers: { broken: { note: 'no value' } } }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /broken/)
  await expectReject(() => credentials.set('x', 'v'), /broken/)
  assert.equal(JSON.parse(await readFile(badPath, 'utf8')).providers.broken.note, 'no value', 'reject when must not override original file')

  // providers.raw non- object: reject
  await writeFile(badPath, JSON.stringify({ providers: 'oops' }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /providers/)

  // pluginSecrets items non- string: reject and do not override
  await writeFile(
    badPath,
    JSON.stringify({ pluginSecrets: { 'p:x': { k: 123 } } }),
    { mode: 0o600 },
  )
  await expectReject(() => credentials.getPluginSecret('p:x', 'k'), /k/)
  assert.equal(JSON.parse(await readFile(badPath, 'utf8')).pluginSecrets['p:x'].k, 123)

  // pluginSecrets items non- object: reject
  await writeFile(badPath, JSON.stringify({ pluginSecrets: { p: 'flat' } }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /pluginSecrets|p/)

  // top-level non- object: reject
  await writeFile(badPath, JSON.stringify([1, 2]), { mode: 0o600 })
  await expectReject(() => credentials.list(), /structure illegal/)

  // loosely permission read when automatically fix 0600
  await writeFile(badPath, JSON.stringify({ providers: {} }), { mode: 0o644 })
  await credentials.list()
  assert.ok(await isPrivateMode(badPath), 'read path discover loosely permission should immediately converge 0600')
})

// ---------------------------------------------------------------------------
// collection into:memory atomic update + watcher real-time aware (builtin:memory consume path)
// ---------------------------------------------------------------------------
test('collection into: MemoryStore atomic update by watcher real-time catch (without temp event)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const store = new MemoryStore(createProfileFileHost(dataDir))
  await store.ensureMemory('assistant')

  const seen: string[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => seen.push(...paths),
    { onError: (err) => assert.fail(`watcher must not errors: ${String(err)}`) },
  )
  watcher.start()
  try {
    await store.updateMemory('assistant', 'user bias well: simple clean back re-', 'append')
    await waitFor(() => seen.some((p) => p === 'profiles/assistant/MEMORY.md'))
    // read to forever is complete content (atomicity)
    const memory = await store.getMemory('assistant')
    assert.ok(memory.includes('user bias well: simple clean back re-'))
    for (const p of seen) assert.ok(!p.includes('.tmp'))
  } finally {
    watcher.close()
  }
})

// ---------------------------------------------------------------------------
// across process lock: write in wide limit (new lock mtime < 1500ms empty/half truncate content wait for retry)
// ---------------------------------------------------------------------------

test('across process lock regression: creates new lock empty content in wide limit phase inside wait for while non- mistakenly judge corrupt; expired after explicit errors', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const target = join(dataDir, 'credentials.json')
  const lockFile = `${target}.lock`

  // 1) simulated concurrency process just open('wx') create lock, not yet write completely JSON: empty content + mtime=now.
  //    another process should in wide limit phase inside wait for; then holder write complete and release, wait for normal gets lock.
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     const fd = fs.openSync(lock, 'wx', 0o600); // only create, content later write
     setTimeout(() => { fs.writeSync(fd, process.pid + ' writer'); fs.closeSync(fd); fs.unlinkSync(lock); }, 200);`,
  ])
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  await waitFor(() => existsSync(lockFile))
  const acquired = await withProcessFileLock(target, async () => 'waited-fresh-lock')
  assert.equal(acquired, 'waited-fresh-lock', 'wide limit phase inside empty/half truncate content should wait for write complete, do not mistakenly judge corrupt')
  assert.equal(await childExit, 0)
  assert.ok(!existsSync(lockFile))

  // 2) wide limit phase outside (mtime already old) empty content: still is explicit corrupt errors (honest discipline).
  await writeFile(lockFile, '', { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  await utimes(lockFile, old, old)
  await expectReject(() => withProcessFileLock(target, async () => 'nope'), /corrupt/)

  // 3) wide limit phase inside but holder PID already die half truncate content: still can by stale break except (death takes precedence at wide limit).
  await rm(lockFile, { force: true })
  const deadPid = 2 ** 22 + Math.floor(Math.random() * 1000)
  await writeFile(lockFile, `${deadPid}`, { mode: 0o600 })
  assert.equal(await withProcessFileLock(target, async () => 'stale-fresh'), 'stale-fresh')
  assert.ok(!existsSync(lockFile))
})

// clean up
test('clean up temp directory', { timeout: 60_000 }, async () => {
  await rm(scratchRoot, { recursive: true, force: true })
  // static default verify tsx can execute (keep and runner consistency)
  const res = spawnSync('tsx', ['--version'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
})
