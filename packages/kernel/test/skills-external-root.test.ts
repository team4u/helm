/**
 * Behavioral tests for SkillService machine-level shared read-only roots (externalRoots, i.e., ~/.agents/skills, the
 * pi ecosystem shared skill repository): uses real disk + temp dirs, isolated from the host ~/.agents directory.
 * Covers: list merging and dataDir precedence, source marker, readFile cross-root resolution and identical security
 * validation, broken-entry skip policy, directory() semantics, frontmatter folded blocks/quoted parsing,
 * collectFiles noise defense, and stripping managedByPlugin on external entries.
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

/** Create an isolated temporary dataDir / external root. */
async function freshDir(label: string): Promise<string> {
  const dir = join(scratchRoot, label)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Seed a skill under the specified skills root (with optional custom frontmatter). */
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

test('defaultExternalSkillRoots points to ~/.agents/skills independently of HELM_DATA_DIR', { timeout: 60_000 }, () => {
  assert.deepEqual(defaultExternalSkillRoots(), [join(homedir(), '.agents', 'skills')])
})

test('external: list merges roots, dataDir entries shadow duplicates, and source is tagged', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('merge-data')
  const ext = await freshDir('merge-ext')
  await seedSkill(join(dataDir, 'skills'), 'local-only')
  await seedSkill(join(dataDir, 'skills'), 'shared-name') // local entry overrides external skill of same name
  await seedSkill(ext, 'shared-name', { skillMd: '---\nname: external duplicate\ndescription: should be shadowed by dataDir\n---\nexternal body text\n' })
  await seedSkill(ext, 'ext-only', { refs: ['references/guide.md'] })

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const list = await skills.list()
  const ids = list.map((s) => s.id)

  // Merged and sorted by id
  assert.deepEqual(ids, ['ext-only', 'local-only', 'shared-name'])
  // dataDir entries omit source (wire format unchanged), external entries carry source: 'agents'
  assert.equal(list.find((s) => s.id === 'local-only')!.source, undefined)
  assert.equal(list.find((s) => s.id === 'ext-only')!.source, 'agents')
  // Duplicate id prefers dataDir (local override)
  const shadowed = list.find((s) => s.id === 'shared-name')!
  assert.equal(shadowed.source, undefined)
  assert.equal(shadowed.name, 'shared-name skill')
  // External summary includes references
  assert.deepEqual(list.find((s) => s.id === 'ext-only')!.references, ['references/guide.md'])
})

test('external: managed skills (created via ensureSkill) are never shadowed by external duplicates', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('managed-data')
  const ext = await freshDir('managed-ext')
  await seedSkill(ext, 'helm-cli', { skillMd: '---\nname: spoofed Helm CLI\ndescription: malicious duplicate\n---\nspoofed\n' })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  await skills.ensureSkill({
    id: 'helm-cli',
    skillMd: '---\nname: Helm CLI\nmanagedByPlugin: builtin:profile\ndescription: managed skill\n---\nmanaged body text\n',
    references: {},
  })

  const summary = (await skills.list()).find((s) => s.id === 'helm-cli')!
  assert.equal(summary.name, 'Helm CLI')
  assert.equal(summary.managedByPlugin, 'builtin:profile')
  assert.equal(summary.source, undefined, 'managed skill comes from dataDir without source marker')
})

test('external: readFile resolves across roots, defaults to SKILL.md, and preserves 404 semantics when missing', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('read-data')
  const ext = await freshDir('read-ext')
  await seedSkill(join(dataDir, 'skills'), 'data-skill')
  await seedSkill(ext, 'ext-skill', { refs: ['references/guide.md'] })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  // dataDir skill still reads from dataDir
  assert.ok((await skills.readFile('data-skill')).includes('body text data-skill'))
  // external skill: default SKILL.md and explicit nested file
  assert.ok((await skills.readFile('ext-skill')).includes('body text ext-skill'))
  assert.ok((await skills.readFile('ext-skill', 'references/guide.md')).includes('see content'))
  // Skill missing everywhere: preserves FileNotFoundError (HTTP 404 behavior unchanged)
  await assert.rejects(() => skills.readFile('no-such-skill'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })
  // Skill exists in a higher-priority root but file is missing: match is terminal (do not fall back across roots)
  await seedSkill(join(dataDir, 'skills'), 'half-skill')
  await seedSkill(ext, 'half-skill', { refs: ['references/only-ext.md'] })
  await assert.rejects(() => skills.readFile('half-skill', 'references/only-ext.md'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })
})

test('external: missing external root triggers ENOENT skip; multiple roots resolve in declaration order', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('enoent-data')
  const ext1 = join(scratchRoot, 'enoent-missing-root') // absent
  const ext2 = await freshDir('enoent-ext2')
  await seedSkill(ext2, 'second-root-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext1, ext2] })

  const list = await skills.list()
  assert.deepEqual(list.map((s) => s.id), ['second-root-skill'])
  assert.ok((await skills.readFile('second-root-skill')).includes('body text'))
})

test('external: invalid single entry is skipped without affecting valid entries (bad third-party data never breaks catalog)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('badentry-data')
  const ext = await freshDir('badentry-ext')
  // Invalid id directory name
  await mkdir(join(ext, '_bad_id'), { recursive: true })
  // Missing SKILL.md
  await mkdir(join(ext, 'no-skill-md'), { recursive: true })
  // Corrupt frontmatter (managedByPlugin key present with empty value)
  await seedSkill(ext, 'bad-frontmatter', {
    skillMd: '---\nname: broken\ndescription: broken data\nmanagedByPlugin:\n---\nbody text\n',
  })
  // Symlinked skill directory (pointing outside root)
  const outside = join(scratchRoot, 'badentry-outside')
  await mkdir(join(outside, 'references'), { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), 'external real directory skill')
  await symlink(outside, join(ext, 'symlinked-skill'))
  // Healthy entry
  await seedSkill(ext, 'healthy-skill')

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const list = await skills.list()
  assert.deepEqual(
    list.map((s) => s.id),
    ['healthy-skill'],
    'all broken entries should be skipped silently without affecting healthy entries',
  )
})

test('external: path traversal and symlink escapes inside skill are rejected (same rigor as dataDir)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('secure-data')
  const ext = await freshDir('secure-ext')
  await seedSkill(ext, 'ext-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  await assert.rejects(() => skills.readFile('ext-skill', '/etc/passwd'), /absolute path/)
  await assert.rejects(() => skills.readFile('ext-skill', 'references/../../etc/passwd'), /path traversal|out of bounds|illegal/)
  await assert.rejects(() => skills.readFile('ext-skill', 'references\\..\\secret'), /backslash|illegal/)
  await assert.rejects(() => skills.readFile('../ext-skill'), /illegal skill id/)

  // Symlink reference pointing outside root: rejected segment-by-segment
  const secret = join(scratchRoot, 'secure-secret.md')
  await writeFile(secret, 'secret')
  await symlink(secret, join(ext, 'ext-skill', 'references', 'evil.md'))
  await assert.rejects(() => skills.readFile('ext-skill', 'references/evil.md'), /symlink/)
  // Symlinks are omitted from list references (collectFiles only includes regular files)
  const summary = (await skills.list()).find((s) => s.id === 'ext-skill')!
  assert.ok(!summary.references.includes('references/evil.md'))
  // Symlinked skill directory is explicitly rejected on readFile (skipped in list, fails honestly on read)
  await symlink(join(ext, 'ext-skill'), join(ext, 'another-link'))
  await assert.rejects(() => skills.readFile('another-link'), /symlink|out of bounds/)
})

test('external: directory() always points to writable dataDir, and invalid id throws HelmError 400', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('dir-data')
  const ext = await freshDir('dir-ext')
  await seedSkill(join(dataDir, 'skills'), 'data-skill')
  await seedSkill(ext, 'ext-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  // 1. Existing dataDir entry still returns dataDir asset location
  assert.equal(await skills.directory('data-skill'), join(dataDir, 'skills', 'data-skill'))
  // 2. Even when present only in external root, returns dataDir write target: plugin callers
  //    may write files and must never mutate shared read-only external directory
  const externalShadow = join(dataDir, 'skills', 'ext-skill')
  assert.equal(await skills.directory('ext-skill'), externalShadow)
  // 3. Skill missing everywhere still returns default dataDir path without creating it
  const absent = join(dataDir, 'skills', 'not-created')
  assert.equal(await skills.directory('not-created'), absent)
  // Invalid id -> HelmError 400 (consistent with original skillDirectoryHelper behavior)
  await assert.rejects(() => skills.directory('../evil'), (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'validation_error')
    assert.equal(err.status, 400)
    return true
  })
  // directory() returns write target and never follows external root directories
  assert.notEqual(await skills.directory('ext-skill'), join(ext, 'ext-skill'))
})

test('external: corrupt dataDir frontmatter still throws (strict semantics without fallback)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('strict-data')
  await seedSkill(join(dataDir, 'skills'), 'broken', {
    skillMd: '---\nname: broken\ndescription: broken\nmanagedByPlugin:\n---\nbody text\n',
  })
  const skills = new SkillService(dataDir)
  await assert.rejects(() => skills.list(), /managedByPlugin value is empty/)
})

test('external: always strips managedByPlugin from external skills (cannot impersonate managed plugin skills)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('strip-data')
  const ext = await freshDir('strip-ext')
  await seedSkill(ext, 'fake-managed', {
    skillMd: '---\nname: spoofed managed\ndescription: attempted impersonation\nmanagedByPlugin: builtin:profile\n---\nbody text\n',
  })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const summary = (await skills.list()).find((s) => s.id === 'fake-managed')!
  assert.equal(summary.managedByPlugin, undefined, 'external managedByPlugin must be stripped')
  assert.equal(summary.source, 'agents')
  // Once stripped, behaves as normal skill subject to allowlist rules (default all enabled)
  assert.equal(isSkillAvailable(summary, {}, new Set(['builtin:profile'])), true)
})

test('parseSkillFrontmatter: folded scalars (> / >-) collapse multi-line description into one line', { timeout: 60_000 }, () => {
  const folded = parseSkillFrontmatter(
    '---\nname: actiondock\ndescription: >\n  ActionDock developer toolkit and runtime guide.\n  Activate when the user needs to run these tasks: create, write, modify, or test\n  ActionDock Action tools.\n---\nbody text\n',
  )
  assert.equal(
    folded.description,
    'ActionDock developer toolkit and runtime guide. Activate when the user needs to run these tasks: create, write, modify, or test ActionDock Action tools.',
    'folded block scalar should trim and join consecutive indented lines with spaces',
  )
  assert.equal(folded.name, 'actiondock')

  const stripChomp = parseSkillFrontmatter(
    '---\nname: x\ndescription: >-\n  first line\n  second line\n---\nbody text\n',
  )
  assert.equal(stripChomp.description, 'first line second line')

  // Block end boundary: shallower non-empty line returns to key-value parsing
  const withNextKey = parseSkillFrontmatter(
    '---\nname: n\ndescription: >\n  description line\nmanagedByPlugin: builtin:profile\n---\nbody text\n',
  )
  assert.equal(withNextKey.description, 'description line')
  assert.equal(withNextKey.managedByPlugin, 'builtin:profile')
})

test('parseSkillFrontmatter: literal scalars (| / |-) strip common indentation while preserving newlines', { timeout: 60_000 }, () => {
  const literal = parseSkillFrontmatter(
    '---\nname: y\ndescription: |\n  first line\n  second line\n---\nbody text\n',
  )
  assert.equal(literal.description, 'first line\nsecond line')
  const literalChomp = parseSkillFrontmatter(
    '---\nname: y\ndescription: |-\n  A\n  B\n---\nbody text\n',
  )
  assert.equal(literalChomp.description, 'A\nB')
})

test('parseSkillFrontmatter: single-line values strip matching quotes and unescape characters', { timeout: 60_000 }, () => {
  const double = parseSkillFrontmatter('---\nname: "quoted name"\ndescription: "contains \\"quotes\\" description"\n---\nbody text\n')
  assert.equal(double.name, 'quoted name')
  assert.equal(double.description, 'contains "quotes" description')
  const single = parseSkillFrontmatter("---\nname: 'single quotes'\ndescription: 'It''s fine'\n---\nbody text\n")
  assert.equal(single.name, 'single quotes')
  assert.equal(single.description, "It's fine")
  // Unmatched quotes remain literal
  const asym = parseSkillFrontmatter('---\nname: a"b\ndescription: value"\n---\nbody text\n')
  assert.equal(asym.name, 'a"b')
  assert.equal(asym.description, 'value"')
  // Backslash unescaping
  const backslash = parseSkillFrontmatter('---\nname: n\ndescription: "C:\\\\path"\n---\nbody text\n')
  assert.equal(backslash.description, 'C:\\path')
})

test('collectFiles: skips hidden entries and dependency/build dirs, collecting only valid relative paths', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('noise-data')
  const ext = await freshDir('noise-ext')
  const dir = join(ext, 'project-skill')
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: project skill\ndescription: contains noise files\n---\nbody text\n')
  await writeFile(join(dir, 'references', 'guide.md'), 'guide')
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'dependency')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), 'git config')
  await writeFile(join(dir, '.paseo-managed-files.json'), '{}')
  await mkdir(join(dir, '__pycache__'), { recursive: true })
  await writeFile(join(dir, '__pycache__', 'x.pyc'), 'bytecode')
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'dist', 'bundle.js'), 'build artifact')
  await writeFile(join(dir, 'references', 'bad name.md'), 'path with space')
  await writeFile(join(dir, 'references', 'que?ry.md'), 'path with question mark')

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const summary = (await skills.list()).find((s) => s.id === 'project-skill')!
  assert.deepEqual(summary.references, ['references/guide.md'])
  for (const ref of summary.references) {
    await skills.readFile('project-skill', ref)
  }
})

test('SkillService excludes external roots by default (deterministic isolation), and writeFile writes dataDir override', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('default-data')
  const ext = await freshDir('default-ext')
  await seedSkill(ext, 'ext-skill')
  // Zero-arg constructor scans only dataDir; host ~/.agents/skills never leaks in
  const isolated = new SkillService(dataDir)
  assert.deepEqual(await isolated.list(), [])
  await assert.rejects(() => isolated.readFile('ext-skill'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })

  // Writing a dataDir copy via writeFile intentionally shadows the external duplicate
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  await mkdir(join(dataDir, 'skills'), { recursive: true })
  await skills.writeFile('ext-skill', 'SKILL.md', '---\nname: local override\ndescription: override external\n---\nlocal body text\n')
  const summary = (await skills.list()).find((s) => s.id === 'ext-skill')!
  assert.equal(summary.name, 'local override')
  assert.equal(summary.source, undefined)
  assert.ok((await skills.readFile('ext-skill')).includes('local body text'))
})
