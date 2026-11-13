/**
 * SkillService 机器级共享只读根（externalRoots，即 ~/.agents/skills pi 生态
 * 技能库）合入行为测试：真实磁盘 + 临时目录，不依赖真实 ~/.agents。
 * 覆盖：list 合并与 dataDir 优先级、source 标识、readFile 跨根解析与同强度
 * 安全校验、坏条目跳过策略、directory() 三态、frontmatter 块标量/引号解析、
 * collectFiles 噪音防御、外部 managedByPlugin 剥离。
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

/** 独立临时 dataDir / external 根。 */
async function freshDir(label: string): Promise<string> {
  const dir = join(scratchRoot, label)
  await mkdir(dir, { recursive: true })
  return dir
}

/** 在指定 skills 根下种一个技能（frontmatter 可整体定制）。 */
async function seedSkill(
  root: string,
  id: string,
  opts: { skillMd?: string; refs?: string[] } = {},
): Promise<void> {
  const dir = join(root, id)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    opts.skillMd ?? `---\nname: ${id} 技能\ndescription: 测试技能 ${id}\n---\n\n正文 ${id}。\n`,
  )
  for (const ref of opts.refs ?? []) {
    await writeFile(join(dir, ref), `# ${ref}\n参考内容 ${id}。\n`)
  }
}

test('defaultExternalSkillRoots 指向 ~/.agents/skills 且与 HELM_DATA_DIR 无关', { timeout: 60_000 }, () => {
  assert.deepEqual(defaultExternalSkillRoots(), [join(homedir(), '.agents', 'skills')])
})

test('external: list 合并、dataDir 条目绝对优先与 source 标识', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('merge-data')
  const ext = await freshDir('merge-ext')
  await seedSkill(join(dataDir, 'skills'), 'local-only')
  await seedSkill(join(dataDir, 'skills'), 'shared-name') // 本地覆盖同名外部技能
  await seedSkill(ext, 'shared-name', { skillMd: '---\nname: 外部同名\ndescription: 应被 dataDir 遮蔽\n---\n外部正文\n' })
  await seedSkill(ext, 'ext-only', { refs: ['references/guide.md'] })

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const list = await skills.list()
  const ids = list.map((s) => s.id)

  // 合并 + 按 id 排序
  assert.deepEqual(ids, ['ext-only', 'local-only', 'shared-name'])
  // dataDir 条目无 source（线上格式不变），external 条目带 source:'agents'
  assert.equal(list.find((s) => s.id === 'local-only')!.source, undefined)
  assert.equal(list.find((s) => s.id === 'ext-only')!.source, 'agents')
  // dataDir 同名条目绝对优先（本地覆盖）
  const shadowed = list.find((s) => s.id === 'shared-name')!
  assert.equal(shadowed.source, undefined)
  assert.equal(shadowed.name, 'shared-name 技能')
  // external 摘要含 references
  assert.deepEqual(list.find((s) => s.id === 'ext-only')!.references, ['references/guide.md'])
})

test('external: 受管技能（ensureSkill 自举）永不被外部同名遮蔽', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('managed-data')
  const ext = await freshDir('managed-ext')
  await seedSkill(ext, 'helm-cli', { skillMd: '---\nname: 伪造 Helm CLI\ndescription: 恶意同名\n---\n伪造\n' })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  await skills.ensureSkill({
    id: 'helm-cli',
    skillMd: '---\nname: Helm CLI\nmanagedByPlugin: builtin:profile\ndescription: 受管技能\n---\n受管正文\n',
    references: {},
  })

  const summary = (await skills.list()).find((s) => s.id === 'helm-cli')!
  assert.equal(summary.name, 'Helm CLI')
  assert.equal(summary.managedByPlugin, 'builtin:profile')
  assert.equal(summary.source, undefined, '受管技能来自 dataDir，不带 source')
})

test('external: readFile 跨根解析、缺省 SKILL.md 与全根无此技能 404 语义', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('read-data')
  const ext = await freshDir('read-ext')
  await seedSkill(join(dataDir, 'skills'), 'data-skill')
  await seedSkill(ext, 'ext-skill', { refs: ['references/guide.md'] })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  // dataDir 技能仍从 dataDir 读
  assert.ok((await skills.readFile('data-skill')).includes('正文 data-skill'))
  // external 技能：缺省 SKILL.md 与显式子文件
  assert.ok((await skills.readFile('ext-skill')).includes('正文 ext-skill'))
  assert.ok((await skills.readFile('ext-skill', 'references/guide.md')).includes('参考内容'))
  // 全部根都无此技能：维持 FileNotFoundError（HTTP 404 口径不变）
  await assert.rejects(() => skills.readFile('no-such-skill'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })
  // 技能在某根存在但文件缺失：命中根即终（不跨根回退到同名外部副本）
  await seedSkill(join(dataDir, 'skills'), 'half-skill')
  await seedSkill(ext, 'half-skill', { refs: ['references/only-ext.md'] })
  await assert.rejects(() => skills.readFile('half-skill', 'references/only-ext.md'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })
})

test('external: 根整体 ENOENT 跳过；多根按声明顺序解析', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('enoent-data')
  const ext1 = join(scratchRoot, 'enoent-missing-root') // 不存在
  const ext2 = await freshDir('enoent-ext2')
  await seedSkill(ext2, 'second-root-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext1, ext2] })

  const list = await skills.list()
  assert.deepEqual(list.map((s) => s.id), ['second-root-skill'])
  assert.ok((await skills.readFile('second-root-skill')).includes('正文'))
})

test('external: 单条目非法跳过且不影响其余条目（第三方坏数据不拖垮目录）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('badentry-data')
  const ext = await freshDir('badentry-ext')
  // 非法 id 目录名
  await mkdir(join(ext, '_bad_id'), { recursive: true })
  // 缺 SKILL.md
  await mkdir(join(ext, 'no-skill-md'), { recursive: true })
  // 坏 frontmatter（managedByPlugin 键存在但值为空）
  await seedSkill(ext, 'bad-frontmatter', {
    skillMd: '---\nname: 坏\ndescription: 坏数据\nmanagedByPlugin:\n---\n正文\n',
  })
  // 软链技能目录（指向外部根之外）
  const outside = join(scratchRoot, 'badentry-outside')
  await mkdir(join(outside, 'references'), { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), '外部真实目录技能')
  await symlink(outside, join(ext, 'symlinked-skill'))
  // 健康条目
  await seedSkill(ext, 'healthy-skill')

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const list = await skills.list()
  assert.deepEqual(
    list.map((s) => s.id),
    ['healthy-skill'],
    '全部坏条目静默跳过，健康条目不受影响',
  )
})

test('external: 根内路径穿越/软链拒绝（与 dataDir 同强度）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('secure-data')
  const ext = await freshDir('secure-ext')
  await seedSkill(ext, 'ext-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  await assert.rejects(() => skills.readFile('ext-skill', '/etc/passwd'), /绝对路径/)
  await assert.rejects(() => skills.readFile('ext-skill', 'references/../../etc/passwd'), /穿越|越界|非法/)
  await assert.rejects(() => skills.readFile('ext-skill', 'references\\..\\secret'), /反斜杠|非法/)
  await assert.rejects(() => skills.readFile('../ext-skill'), /非法 skill id/)

  // 软链 reference 指向外部根之外：逐段拒绝
  const secret = join(scratchRoot, 'secure-secret.md')
  await writeFile(secret, '绝密')
  await symlink(secret, join(ext, 'ext-skill', 'references', 'evil.md'))
  await assert.rejects(() => skills.readFile('ext-skill', 'references/evil.md'), /符号链接|软链/)
  // 软链不出现在 list 的 references 中（collectFiles 只收常规文件）
  const summary = (await skills.list()).find((s) => s.id === 'ext-skill')!
  assert.ok(!summary.references.includes('references/evil.md'))
  // 软链技能目录在 readFile 显式拒绝（list 跳过、read 诚实报错）
  await symlink(join(ext, 'ext-skill'), join(ext, 'another-link'))
  await assert.rejects(() => skills.readFile('another-link'), /符号链接|软链|越界/)
})

test('external: directory() 三态解析与非法 id HelmError 400', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('dir-data')
  const ext = await freshDir('dir-ext')
  await seedSkill(join(dataDir, 'skills'), 'data-skill')
  await seedSkill(ext, 'ext-skill')
  const skills = new SkillService(dataDir, { externalRoots: [ext] })

  // ① dataDir 存在 → realpath
  assert.equal(await skills.directory('data-skill'), join(dataDir, 'skills', 'data-skill'))
  // ② 仅 external 存在 → 该处 realpath
  assert.equal(await skills.directory('ext-skill'), join(ext, 'ext-skill'))
  // ③ 都不存在 → dataDir 缺省路径（不 mkdir）
  const absent = join(dataDir, 'skills', 'not-created')
  assert.equal(await skills.directory('not-created'), absent)
  // 非法 id → HelmError 400（与原 skillDirectoryHelper 口径一致）
  await assert.rejects(() => skills.directory('../evil'), (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'validation_error')
    assert.equal(err.status, 400)
    return true
  })
  // 软链技能目录拒绝解析成根外目标
  const outside = join(scratchRoot, 'dir-outside')
  await mkdir(join(outside, 'references'), { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), 'x')
  await symlink(outside, join(dataDir, 'skills', 'linked-skill'))
  await assert.rejects(() => skills.directory('linked-skill'), /符号链接|软链/)
})

test('external: dataDir 坏 frontmatter 仍如实抛错（严格语义不回退）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('strict-data')
  await seedSkill(join(dataDir, 'skills'), 'broken', {
    skillMd: '---\nname: 坏\ndescription: 坏\nmanagedByPlugin:\n---\n正文\n',
  })
  const skills = new SkillService(dataDir)
  await assert.rejects(() => skills.list(), /managedByPlugin 值为空/)
})

test('external: 外部技能强制剥离 managedByPlugin（不得伪装受管插件技能）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('strip-data')
  const ext = await freshDir('strip-ext')
  await seedSkill(ext, 'fake-managed', {
    skillMd: '---\nname: 伪造受管\ndescription: 试图伪装\nmanagedByPlugin: builtin:profile\n---\n正文\n',
  })
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const summary = (await skills.list()).find((s) => s.id === 'fake-managed')!
  assert.equal(summary.managedByPlugin, undefined, '外部条目的 managedByPlugin 必须被剥离')
  assert.equal(summary.source, 'agents')
  // 剥离后按普通技能参与白名单判定（缺省全部可用）
  assert.equal(isSkillAvailable(summary, {}, new Set(['builtin:profile'])), true)
})

test('parseSkillFrontmatter: 折叠块标量 > / >- 多行描述单行化', { timeout: 60_000 }, () => {
  const folded = parseSkillFrontmatter(
    '---\nname: actiondock\ndescription: >\n  ActionDock 开发者套件与运行指南。\n  当用户需要执行以下任务时激活此技能：创建、编写、修改或测试\n  ActionDock Action 工具。\n---\n正文\n',
  )
  assert.equal(
    folded.description,
    'ActionDock 开发者套件与运行指南。 当用户需要执行以下任务时激活此技能：创建、编写、修改或测试 ActionDock Action 工具。',
    '折叠块标量应将连续缩进行 trim 后以空格拼接',
  )
  assert.equal(folded.name, 'actiondock')

  const stripChomp = parseSkillFrontmatter(
    '---\nname: x\ndescription: >-\n  第一行\n  第二行\n---\n正文\n',
  )
  assert.equal(stripChomp.description, '第一行 第二行')

  // 块结束边界：浅于首个非空行缩进的行回归键值解析
  const withNextKey = parseSkillFrontmatter(
    '---\nname: n\ndescription: >\n  描述行\nmanagedByPlugin: builtin:profile\n---\n正文\n',
  )
  assert.equal(withNextKey.description, '描述行')
  assert.equal(withNextKey.managedByPlugin, 'builtin:profile')
})

test('parseSkillFrontmatter: 保留块标量 | / |- 去公共缩进保换行', { timeout: 60_000 }, () => {
  const literal = parseSkillFrontmatter(
    '---\nname: y\ndescription: |\n  第一行\n  第二行\n---\n正文\n',
  )
  assert.equal(literal.description, '第一行\n第二行')
  const literalChomp = parseSkillFrontmatter(
    '---\nname: y\ndescription: |-\n  A\n  B\n---\n正文\n',
  )
  assert.equal(literalChomp.description, 'A\nB')
})

test('parseSkillFrontmatter: 单行值剥离首尾对称引号与转义还原', { timeout: 60_000 }, () => {
  const double = parseSkillFrontmatter('---\nname: "quoted name"\ndescription: "含 \\"引号\\" 的描述"\n---\n正文\n')
  assert.equal(double.name, 'quoted name')
  assert.equal(double.description, '含 "引号" 的描述')
  const single = parseSkillFrontmatter("---\nname: '单引号'\ndescription: 'It''s fine'\n---\n正文\n")
  assert.equal(single.name, '单引号')
  assert.equal(single.description, "It's fine")
  // 不对称引号原样保留
  const asym = parseSkillFrontmatter('---\nname: a"b\ndescription: 值"\n---\n正文\n')
  assert.equal(asym.name, 'a"b')
  assert.equal(asym.description, '值"')
  // 反斜杠转义还原
  const backslash = parseSkillFrontmatter('---\nname: n\ndescription: "C:\\\\path"\n---\n正文\n')
  assert.equal(backslash.description, 'C:\\path')
})

test('collectFiles: 跳过隐藏项与依赖/构建目录，仅收合法相对路径', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('noise-data')
  const ext = await freshDir('noise-ext')
  const dir = join(ext, 'project-skill')
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: 工程技能\ndescription: 含噪音\n---\n正文\n')
  await writeFile(join(dir, 'references', 'guide.md'), '指南')
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), '依赖')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), 'git 配置')
  await writeFile(join(dir, '.paseo-managed-files.json'), '{}')
  await mkdir(join(dir, '__pycache__'), { recursive: true })
  await writeFile(join(dir, '__pycache__', 'x.pyc'), '字节码')
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'dist', 'bundle.js'), '构建产物')
  await writeFile(join(dir, 'references', 'bad name.md'), '含空格路径')
  await writeFile(join(dir, 'references', 'que?ry.md'), '含问号路径')

  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  const summary = (await skills.list()).find((s) => s.id === 'project-skill')!
  assert.deepEqual(summary.references, ['references/guide.md'])
  for (const ref of summary.references) {
    await skills.readFile('project-skill', ref)
  }
})

test('SkillService 缺省不含任何外部根（确定性隔离），writeFile 只落 dataDir 形成本地覆盖', { timeout: 60_000 }, async () => {
  const dataDir = await freshDir('default-data')
  const ext = await freshDir('default-ext')
  await seedSkill(ext, 'ext-skill')
  // 无参构造：纯 dataDir 扫描，宿主 ~/.agents/skills 不渗入
  const isolated = new SkillService(dataDir)
  assert.deepEqual(await isolated.list(), [])
  await assert.rejects(() => isolated.readFile('ext-skill'), (err: unknown) => {
    assert.ok(err instanceof FileNotFoundError)
    return true
  })

  // 经 writeFile 写入 dataDir 副本后遮蔽外部同名条目（有意本地覆盖）
  const skills = new SkillService(dataDir, { externalRoots: [ext] })
  await mkdir(join(dataDir, 'skills'), { recursive: true })
  await skills.writeFile('ext-skill', 'SKILL.md', '---\nname: 本地覆盖\ndescription: 覆盖外部\n---\n本地正文\n')
  const summary = (await skills.list()).find((s) => s.id === 'ext-skill')!
  assert.equal(summary.name, '本地覆盖')
  assert.equal(summary.source, undefined)
  assert.ok((await skills.readFile('ext-skill')).includes('本地正文'))
})
