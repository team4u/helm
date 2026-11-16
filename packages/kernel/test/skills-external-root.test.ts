/**
 * SkillService machine level sharing only read (externalRoots, i.e. ~/.agents/skills pi generate state
 * skill store) together behavior test: real disk + temp directory, independent of real ~/.agents.
 * override:list merge and dataDir priority,source identifier,readFile across parse and same strong
 * security validate, broken item skip policy,directory() three state,frontmatter chunk mark amount/quotes parse,
 * collectFiles noise sound guard against defend, external managedByPlugin strip.
 */
import { test } from 'node:test'
import { homedir } from 'node:os'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, isSkillAvailable } from '@helm/protocol'
import { FileNotFoundError } from '../src/services/atomic-file.js'
import { assert } from './helpers.js'
import {
  defaultExternalSkillRoots,
  parseSkillFrontmatter,
  SkillService,
} from '../src/services/profiles-skills.js'

const scratchRoot = await mkdtemp(join(tmpdir(), 'helm-skills-ext-'))

/** independent temporary dataDir / external . */
async function freshDir(label: string): Promise<string> {
  const dir = join(scratchRoot, label)
  await mkdir(dir, { recursive: true })
  return dir
}

/** in designate skills under a skill (frontmatter can whole set system). */
async function seedSkill(
  root: string,
  id: string,
  opts: { skillMd?: string; refs?: string[] } = {},
): Promise<void> {
  const dir = join(root, id)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    opts.skillMd ?? `---\nname: ${id} skill\ndescription: test skill ${id}\n---\n\nbody text ${id}.\n`,
  )
  for (const ref of opts.refs ?? []) {
    await writeFile(join(dir, ref), `# ${ref}\nsee content ${id}.\n`)
  }
}

test('defaultExternalSkillRoots points to ~/.agents/skills and and HELM_DATA_DIR without closure', { timeout: 60_000 }, () => {
  assert.deepEqual(defaultExternalSkillRoots(), [join(homedir(), '.agents', 'skills')])
})

test('external: list merge,dataDir item absolute takes precedence and source identifier', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('merge-data')
  const ext = await freshDir('merge-ext')
  await seedSkill(join(dataDir, 'skills'), 'local-only')
  await seedSkill(join(dataDir, 'skills'), 'shared-name') // local override same name external skill
  await seedSkill(ext, 'shared-name', { skillMd: '---\nname: external same name\ndescription: should by dataDir obscure\n---\nexternal body text\n' })
  await seedSkill(ext, 'ext-only', { refs: ['references/guide.md'] })

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const list = await skills.list()
  const ids = list.map((s) => s.id)

  // merge + by id sort
  assert.deepEqual(ids, ['ext-only', 'local-only', 'shared-name'])
  // dataDir item without source(line on format do not change),external item carries source:'agents'
  assert.equal(list.find((s) => s.id === 'local-only')!.source, undefined)
  assert.equal(list.find((s) => s.id === 'ext-only')!.source, 'agents')
  // dataDir same name item absolute takes precedence (local override)
  const shadowed = list.find((s) => s.id === 'shared-name')!
  assert.equal(shadowed.source, undefined)
  assert.equal(shadowed.name, 'shared-name skill')
  // external summary contains references
  assert.deepEqual(list.find((s) => s.id === 'ext-only')!.references, ['references/guide.md'])
})

test('external: managed skill (ensureSkill self raise) forever do not by external same name obscure', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('managed-data')
  const ext = await freshDir('managed-ext')
  await seedSkill(ext, 'helm-cli', { skillMd: '---\nname: fabricate Helm CLI\ndescription: malicious same name\n---\nfabricate\n' })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  await skills.ensureSkill({
    id: 'helm-cli',
    skillMd: '---\nname: Helm CLI\nmanagedByPlugin: builtin:profile\ndescription: managed skill\n---\nmanaged body text\n',
    references: {},
  })

  const summary = (await skills.list()).find((s) => s.id === 'helm-cli')!
  assert.equal(summary.name, 'Helm CLI')
  assert.equal(summary.managedByPlugin, 'builtin:profile')
  assert.equal(summary.source, undefined, 'managed skill from dataDir, do not carries source')
})

test('external: readFile across parse, default SKILL.md and all without this skill 404 semantics', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('read-data')
  const ext = await freshDir('read-ext')
  await seedSkill(join(dataDir, 'skills'), 'data-skill')
  await seedSkill(ext, 'ext-skill', { refs: ['references/guide.md'] })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  // dataDir skill still from dataDir read
  assert.ok((await skills.readFile('data-skill')).includes('body text data-skill'))
  // external skill: default SKILL.md and explicit sub- file
  assert.ok((await skills.readFile('ext-skill')).includes('body text ext-skill'))
  assert.ok((await skills.readFile('ext-skill', 'references/guide.md')).includes('see content'))
  // all all without this skill: dimension hold FileNotFoundError(HTTP 404 opening path do not change)
  await assert.rejects(() => skills.readFile('no-such-skill'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })
  // skill in a certain store in but file missing: hit i.e. final (do not across fall back to same name external copy)
  await seedSkill(join(dataDir, 'skills'), 'half-skill')
  await seedSkill(ext, 'half-skill', { refs: ['references/only-ext.md'] })
  await assert.rejects(() => skills.readFile('half-skill', 'references/only-ext.md'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })
})

test('external: whole ENOENT skip; many by declaration order parse', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('enoent-data')
  const ext1 = join(scratchRoot, 'enoent-missing-root') // missing
  const ext2 = await freshDir('enoent-ext2')
  await seedSkill(ext2, 'second-root-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext1, ext2] })

  const list = await skills.list()
  assert.deepEqual(list.map((s) => s.id), ['second-root-skill'])
  assert.ok((await skills.readFile('second-root-skill')).includes('body text'))
})

test('external: single item illegal skip and does not affect the rest item (third way broken data do not drag collapse directory)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('badentry-data')
  const ext = await freshDir('badentry-ext')
  // illegal id directory name
  await mkdir(join(ext, '_bad_id'), { recursive: true })
  // missing SKILL.md
  await mkdir(join(ext, 'no-skill-md'), { recursive: true })
  // broken frontmatter(managedByPlugin key store in but value is empty)
  await seedSkill(ext, 'bad-frontmatter', {
    skillMd: '---\nname: broken\ndescription: broken data\nmanagedByPlugin:\n---\nbody text\n',
  })
  // symlink skill directory (points to external of outside)
  const outside = join(scratchRoot, 'badentry-outside')
  await mkdir(join(outside, 'references'), { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), 'external real directory skill')
  await symlink(outside, join(ext, 'symlinked-skill'))
  // health item
  await seedSkill(ext, 'healthy-skill')

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const list = await skills.list()
  assert.deepEqual(
    list.map((s) => s.id),
    ['healthy-skill'],
    'all broken item static default skip, health item do not subject to affect',
  )
})

test('external: inside path through exceeds/symlink reject (and dataDir same strong)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('secure-data')
  const ext = await freshDir('secure-ext')
  await seedSkill(ext, 'ext-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  await assert.rejects(() => skills.readFile('ext-skill', '/etc/passwd'), /absolute path/)
  await assert.rejects(() => skills.readFile('ext-skill', 'references/../../etc/passwd'), /through exceeds|out of bounds|illegal/)
  await assert.rejects(() => skills.readFile('ext-skill', 'references\\..\\secret'), /backslash|illegal/)
  await assert.rejects(() => skills.readFile('../ext-skill'), /illegal skill id/)

  // symlink reference points to external of outside: one by one segment reject
  const secret = join(scratchRoot, 'secure-secret.md')
  await writeFile(secret, 'absolute')
  await symlink(secret, join(ext, 'ext-skill', 'references', 'evil.md'))
  await assert.rejects(() => skills.readFile('ext-skill', 'references/evil.md'), /symlink|symlink/)
  // symlink do not appear in list  references in (collectFiles only common rule file)
  const summary = (await skills.list()).find((s) => s.id === 'ext-skill')!
  assert.ok(!summary.references.includes('references/evil.md'))
  // symlink skill directory in readFile explicit reject (list skip,read honest errors)
  await symlink(join(ext, 'ext-skill'), join(ext, 'another-link'))
  await assert.rejects(() => skills.readFile('another-link'), /symlink|symlink|out of bounds/)
})

test('external: directory() always points to can write dataDir and illegal id is HelmError 400', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('dir-data')
  const ext = await freshDir('dir-ext')
  await seedSkill(join(dataDir, 'skills'), 'data-skill')
  await seedSkill(ext, 'ext-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  // ① dataDir already exists when still return dataDir asset coordinates.
  assert.equal(await skills.directory('data-skill'), join(dataDir, 'skills', 'data-skill'))
  // ② even if only external store in, also must return dataDir write coordinates: plugin self raise caller
  // may write file, cannot sharing only read expose is directory coordinates.
  const externalShadow = join(dataDir, 'skills', 'ext-skill')
  assert.equal(await skills.directory('ext-skill'), externalShadow)
  // ③ skill all missing when still return dataDir default path (do not mkdir)
  const absent = join(dataDir, 'skills', 'not-created')
  assert.equal(await skills.directory('not-created'), absent)
  // illegal id → HelmError 400(and original skillDirectoryHelper opening path consistent)
  await assert.rejects(() => skills.directory('../evil'), (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'validation_error')
    assert.equal(err.status, 400)
    return true
  })
  // directory coordinates is write target, do not probe/with follow any external directory.
  assert.notEqual(await skills.directory('ext-skill'), join(ext, 'ext-skill'))
})

test('external: dataDir broken frontmatter still such as throws (strictly semantics does not fall back)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('strict-data')
  await seedSkill(join(dataDir, 'skills'), 'broken', {
    skillMd: '---\nname: broken\ndescription: broken\nmanagedByPlugin:\n---\nbody text\n',
  })
  const skills = new SkillService(dataDir)
  await assert.rejects(() => skills.list(), /managedByPlugin value is empty/)
})

test('external: external skill force strip managedByPlugin(must not disguise managed plugin skill)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('strip-data')
  const ext = await freshDir('strip-ext')
  await seedSkill(ext, 'fake-managed', {
    skillMd: '---\nname: fabricate managed\ndescription: attempt disguise\nmanagedByPlugin: builtin:profile\n---\nbody text\n',
  })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const summary = (await skills.list()).find((s) => s.id === 'fake-managed')!
  assert.equal(summary.managedByPlugin, undefined, 'external purpose managedByPlugin must by strip')
  assert.equal(summary.source, 'agents')
  // strip after by ordinary skill reference and blank name single decide (default all available)
  assert.equal(isSkillAvailable(summary, {}, new Set(['builtin:profile'])), true)
})

test('parseSkillFrontmatter: collapse chunk mark amount > / >- many row description single row', { timeout: 60_000 }, () => {
  const folded = parseSkillFrontmatter(
    '---\nname: actiondock\ndescription: >\n  ActionDock developer set piece and run guide.\n  when user need to execute or fewer task when activate this skill: create, write, modify or test\n  ActionDock Action tool.\n---\nbody text\n',
  )
  assert.equal(
    folded.description,
    'ActionDock developer set piece and run guide. when user need to execute or fewer task when activate this skill: create, write, modify or test ActionDock Action tool.',
    'collapse chunk mark amount should connect continue shrink enter row trim after with space concatenate',
  )
  assert.equal(folded.name, 'actiondock')

  const stripChomp = parseSkillFrontmatter(
    '---\nname: x\ndescription: >-\n  one row\n  second row\n---\nbody text\n',
  )
  assert.equal(stripChomp.description, 'one row second row')

  // chunk end boundary: shallow at first non-empty row shrink enter row regression key value parse
  const withNextKey = parseSkillFrontmatter(
    '---\nname: n\ndescription: >\n  description row\nmanagedByPlugin: builtin:profile\n---\nbody text\n',
  )
  assert.equal(withNextKey.description, 'description row')
  assert.equal(withNextKey.managedByPlugin, 'builtin:profile')
})

test('parseSkillFrontmatter: keep chunk mark amount | / |- remove public shrink enter keep newline', { timeout: 60_000 }, () => {
  const literal = parseSkillFrontmatter(
    '---\nname: y\ndescription: |\n  one row\n  second row\n---\nbody text\n',
  )
  assert.equal(literal.description, 'one row\nsecond row')
  const literalChomp = parseSkillFrontmatter(
    '---\nname: y\ndescription: |-\n  A\n  B\n---\nbody text\n',
  )
  assert.equal(literalChomp.description, 'A\nB')
})

test('parseSkillFrontmatter: single row value strip first tail for call quotes and escaping restore', { timeout: 60_000 }, () => {
  const double = parseSkillFrontmatter('---\nname: "quoted name"\ndescription: "contains \\"quotes\\" description"\n---\nbody text\n')
  assert.equal(double.name, 'quoted name')
  assert.equal(double.description, 'contains "quotes" description')
  const single = parseSkillFrontmatter("---\nname: 'single quotes'\ndescription: 'It''s fine'\n---\nbody text\n")
  assert.equal(single.name, 'single quotes')
  assert.equal(single.description, "It's fine")
  // do not for call quotes original keep
  const asym = parseSkillFrontmatter('---\nname: a"b\ndescription: value"\n---\nbody text\n')
  assert.equal(asym.name, 'a"b')
  assert.equal(asym.description, 'value"')
  // backslash escaping restore
  const backslash = parseSkillFrontmatter('---\nname: n\ndescription: "C:\\\\path"\n---\nbody text\n')
  assert.equal(backslash.description, 'C:\\path')
})

test('collectFiles: skip hide items and dependency/build directory, only legal relative path', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('noise-data')
  const ext = await freshDir('noise-ext')
  const dir = join(ext, 'project-skill')
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: project skill\ndescription: contains noise sound\n---\nbody text\n')
  await writeFile(join(dir, 'references', 'guide.md'), 'guide')
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'dependency')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), 'git config')
  await writeFile(join(dir, '.paseo-managed-files.json'), '{}')
  await mkdir(join(dir, '__pycache__'), { recursive: true })
  await writeFile(join(dir, '__pycache__', 'x.pyc'), 'byte code')
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'dist', 'bundle.js'), 'build artifact')
  await writeFile(join(dir, 'references', 'bad name.md'), 'contains space path')
  await writeFile(join(dir, 'references', 'que?ry.md'), 'contains question number path')

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const summary = (await skills.list()).find((s) => s.id === 'project-skill')!
  assert.deepEqual(summary.references, ['references/guide.md'])
  for (const ref of summary.references) {
    await skills.readFile('project-skill', ref)
  }
})

test('SkillService default excludes any external (determinism isolated),writeFile only dataDir shape cost ground override', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('default-data')
  const ext = await freshDir('default-ext')
  await seedSkill(ext, 'ext-skill')
  // without reference construct: pure dataDir scan, host ~/.agents/skills do not seep
  const isolated = new SkillService(dataDir)
  assert.deepEqual(await isolated.list(), [])
  await assert.rejects(() => isolated.readFile('ext-skill'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })

  // via writeFile write dataDir copy after obscure external same name item (has intent local override)
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  await mkdir(join(dataDir, 'skills'), { recursive: true })
  await skills.writeFile('ext-skill', 'SKILL.md', '---\nname: local override\ndescription: override external\n---\nlocal body text\n')
  const summary = (await skills.list()).find((s) => s.id === 'ext-skill')!
  assert.equal(summary.name, 'local override')
  assert.equal(summary.source, undefined)
  assert.ok((await skills.readFile('ext-skill')).includes('local body text'))
})
