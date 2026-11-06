/**
 * helm 内核服务层测试：真实文件系统行为，无假 runtime。
 * 覆盖：paths/atomic-file、profiles/skills（穿越与软链拒绝）、watcher、
 * SecretStash 隔离、AuthService scrypt/token、凭据 0600 与不泄露、
 * ArtifactService spill 阈值与 UTF-8 安全。
 */
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  atomicWriteFile,
  atomicWriteJson,
  ensureDataDir,
  isPrivateMode,
  parsePlaceholder,
  readJsonFile,
  readTextFile,
  resolveDataDir,
} from '../src/services/index.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const scratchRoot = await mkdtemp(join(tmpdir(), 'helm-svc-e2e-'))
let scratchSeq = 0

/** 每个测试独立的临时 dataDir（真实文件行为）。 */
async function freshDataDir(): Promise<string> {
  scratchSeq += 1
  const dir = join(scratchRoot, String(scratchSeq))
  await mkdir(dir, { recursive: true })
  return dir
}

/** 临时来源文件（register/spill 测试用）。 */
async function tempSourceFile(content: string | Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helm-src-'))
  const path = join(dir, `src-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await writeFile(path, content)
  return path
}

// ---------------------------------------------------------------------------
// paths.ts
// ---------------------------------------------------------------------------
test('paths: resolveDataDir 默认/覆盖/env 优先级与 ensureDataDir 目录布局', { timeout: 60_000 }, async () => {
  const dir = await freshDataDir()
  // 显式覆盖优先
  assert.equal(resolveDataDir(dir), dir)
  // env 次之
  const prev = process.env.HELM_DATA_DIR
  const envDir = join(scratchRoot, 'env-dir')
  process.env.HELM_DATA_DIR = envDir
  try {
    assert.equal(resolveDataDir(), envDir)
    // 显式覆盖仍然压过 env
    assert.equal(resolveDataDir(dir), dir)
  } finally {
    if (prev === undefined) delete process.env.HELM_DATA_DIR
    else process.env.HELM_DATA_DIR = prev
  }
  // 非法覆盖（同步 throw）
  assert.throws(() => resolveDataDir(''), /空/)
  assert.throws(() => resolveDataDir('relative/path'), /绝对路径/)
  // ensureDataDir 建齐设计子目录
  await ensureDataDir(dir)
  for (const sub of ['profiles', 'skills', 'workflows', 'plugins', 'artifacts', 'cache']) {
    assert.ok(existsSync(join(dir, sub)), `应创建 ${sub}`)
  }
  // 幂等
  await ensureDataDir(dir)
})

// ---------------------------------------------------------------------------
// atomic-file.ts
// ---------------------------------------------------------------------------
test('atomic-file: 原子写不留 temp 残留、0600 权限、JSON 边界错误', { timeout: 60_000 }, async () => {
  const dir = await freshDataDir()
  const path = join(dir, 'profiles', 'p1', 'MEMORY.md')
  await atomicWriteFile(path, 'hello 世界')
  assert.equal(await readTextFile(path), 'hello 世界')
  // 目录中只有最终文件（无 .tmp 残留）
  assert.deepEqual(await readdir(dirname(path)), ['MEMORY.md'])
  // 0600 私有权限
  assert.ok(await isPrivateMode(path))
  // 重复写仍原子
  await atomicWriteFile(path, 'second')
  assert.equal(await readTextFile(path), 'second')

  const jsonPath = join(dir, 'config.json')
  await atomicWriteJson(jsonPath, { a: 1 })
  assert.deepEqual(await readJsonFile(jsonPath), { a: 1 })

  // 缺失文件抛含路径的错误
  await assert.rejects(() => readJsonFile(join(dir, 'nope.json')), /nope\.json/)
  // 损坏 JSON 抛解析错误（含路径）
  await writeFile(join(dir, 'bad.json'), '{oops')
  await assert.rejects(() => readJsonFile(join(dir, 'bad.json')), /bad\.json/)
})

// ---------------------------------------------------------------------------
// ProfileService
// ---------------------------------------------------------------------------
test('profiles: ensureDefault 自举 model 空串、重复自举不覆盖、CRUD 与保护默认项', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  const p = await profiles.ensureDefault()
  assert.equal(p.id, 'assistant')
  assert.equal(p.model, undefined) // 未配置即缺省，由 runtime 显式报错
  assert.ok(p.tags?.includes('assistant'))
  // 自举同时落 SYSTEM.md / MEMORY.md
  assert.ok((await profiles.getSystem('assistant')).length > 0)
  assert.ok((await profiles.getMemory('assistant')).length > 0)

  // 二次 ensureDefault 不覆盖已有（用户改过的 model 保留）
  await profiles.save({ ...p, model: 'openai/gpt-4o', name: '助理', tags: ['assistant'] })
  const again = await profiles.ensureDefault()
  assert.equal(again.model, 'openai/gpt-4o')

  // list / get / save / delete
  await profiles.save({ id: 'worker', name: '工人', tags: ['worker'] })
  const ids = (await profiles.list()).map((x) => x.id)
  assert.ok(ids.includes('assistant') && ids.includes('worker'))
  assert.notEqual((await profiles.get('worker'))?.name, undefined)

  await profiles.delete('worker')
  assert.equal(await profiles.get('worker'), undefined)

  // 默认项保护 + 非法 id
  await assert.rejects(() => profiles.delete('assistant'), /不可删除/)
  await assert.rejects(() => profiles.get('../etc'), /非法 profile id/)
  await assert.rejects(
    () => profiles.save({ id: 'UPPER', name: 'x', model: '', tags: [] }),
    /非法 profile id/,
  )
  // name 边界校验
  await assert.rejects(
    () => profiles.save({ id: 'ok1', name: '', tags: [] }),
    /name/,
  )
})

test('profiles: memory append/replace 原子更新且最终内容正确', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  await profiles.updateMemory('assistant', '第一行', 'replace')
  await profiles.updateMemory('assistant', '第二行', 'append')
  const text = await profiles.getMemory('assistant')
  assert.ok(text.includes('第一行') && text.includes('第二行'))
  // append 在无尾换行时补换行
  await profiles.updateMemory('assistant', '第三行', 'append')
  const text2 = await profiles.getMemory('assistant')
  assert.ok(text2.includes('第二行\n第三行'))
  // replace 整体替换
  await profiles.updateMemory('assistant', '全部重来', 'replace')
  assert.equal(await profiles.getMemory('assistant'), '全部重来')
})

// ---------------------------------------------------------------------------
// SkillService
// ---------------------------------------------------------------------------
async function seedSkill(dataDir: string, id: string, refs: string[] = []): Promise<void> {
  const dir = join(dataDir, 'skills', id)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${id} 技能\ndescription: 测试技能 ${id}\n---\n\n正文内容。\n`,
  )
  for (const ref of refs) {
    const target = join(dir, ref)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `# ${ref}\n参考内容。\n`)
  }
}

test('skills: list 返回 references 路径、readFile 默认 SKILL.md 且可读子文件', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'demo', ['references/guide.md', 'references/rules/table.md'])
  const list = await skills.list()
  assert.equal(list.length, 1)
  const summary = list[0]!
  assert.equal(summary.id, 'demo')
  assert.equal(summary.name, 'demo 技能')
  assert.equal(summary.description, '测试技能 demo')
  assert.deepEqual(summary.references, [
    'references/guide.md',
    'references/rules/table.md',
  ])

  const main = await skills.readFile('demo')
  assert.ok(main.includes('正文内容'))
  const ref = await skills.readFile('demo', 'references/guide.md')
  assert.ok(ref.includes('参考内容'))
  const nested = await skills.readFile('demo', 'references/rules/table.md')
  assert.ok(nested.includes('table'))
})

test('skills: 严格拒绝绝对路径、..穿越、反斜杠与软链越界', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'demo', ['references/guide.md'])

  await assert.rejects(() => skills.readFile('demo', '/etc/passwd'), /绝对路径/)
  await assert.rejects(() => skills.readFile('demo', 'references/../../etc/passwd'), /穿越|越界|非法/)
  await assert.rejects(() => skills.readFile('demo', '..'), /穿越|非法|路径/)
  await assert.rejects(() => skills.readFile('demo', 'references\\..\\secret'), /反斜杠|非法/)
  // 空路径
  await assert.rejects(() => skills.readFile('demo', ''), /路径不能为空/)

  // 软链越界：references/evil.md -> dataDir 之外
  const outside = join(scratchRoot, 'outside-secret.md')
  await writeFile(outside, '绝密外部内容')
  await symlink(outside, join(dataDir, 'skills', 'demo', 'references', 'evil.md'))
  await assert.rejects(
    () => skills.readFile('demo', 'references/evil.md'),
    /符号链接|软链/,
  )
  // 软链不出现在 list 的 references 中
  const list = await skills.list()
  const refs = list[0]!.references
  assert.ok(!refs.includes('references/evil.md'), '软链不得出现在技能目录中')

  // 技能目录本身是软链（指向 skills 根之外）必须拒绝（realpath 双层包含校验）
  const evilSkill = join(scratchRoot, 'evil-skill')
  await mkdir(join(evilSkill, 'references'), { recursive: true })
  await writeFile(join(evilSkill, 'SKILL.md'), '恶意技能')
  await symlink(evilSkill, join(dataDir, 'skills', 'evil-link'))
  await assert.rejects(
    () => skills.readFile('evil-link'),
    /符号链接|软链|越界/,
  )
  // 指向 skills 根内部的软链技能目录：realpath 后仍在根内，但不放宽逐段软链拒绝
  await symlink(join(dataDir, 'skills', 'demo'), join(dataDir, 'skills', 'inner-link'))
  await assert.rejects(
    () => skills.readFile('inner-link'),
    /符号链接|软链|越界/,
  )
  // 非法 skill id
  await assert.rejects(() => skills.readFile('../demo'), /非法 skill id/)
})

// ---------------------------------------------------------------------------
// AssetWatcher
// ---------------------------------------------------------------------------
test('watcher: 150ms 防抖捕获原子 rename 写入且不报 temp、close 后停止', { timeout: 60_000 }, async () => {
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
    // 原子写 MEMORY.md（temp+rename）
    await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'), '第一版')
    await waitFor(() => events.some((batch) => batch.some((p) => p === 'profiles/assistant/MEMORY.md')))
    // 再写一次：防抖合批、路径仍正确
    await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'), '第二版')
    await waitFor(() => {
      const batches = events.filter((b) => b.includes('profiles/assistant/MEMORY.md'))
      return batches.length >= 2
    })
    // 无 temp 文件事件泄漏
    for (const batch of events) {
      for (const p of batch) assert.ok(!p.includes('.tmp'), `temp 文件不应出现在事件中: ${p}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    watcher.close()
  }
  // close 后不再收事件
  const countBefore = events.length
  await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'SYSTEM.md'), 'x')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(events.length, countBefore)
})

test('watcher: 监听不存在的目录显式报错（不静默吞错）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const missing = join(dataDir, 'no-such-dir')
  const errors: Error[] = []
  const watcher = new AssetWatcher(missing, () => {}, { onError: (err) => errors.push(err) })
  watcher.start()
  try {
    await waitFor(() => errors.length > 0, 8_000)
    assert.ok(errors[0]!.message.length > 0, '错误必须显式上报')
  } finally {
    watcher.close()
  }
})

// ---------------------------------------------------------------------------
// SecretStash
// ---------------------------------------------------------------------------
test('stash: put 返回 REDACTED 占位符、envFor 注入、redact 按会话隔离', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const ph = stash.put(1, 'GITHUB_TOKEN', 'ghp_secret_value_111')
  assert.ok(ph.startsWith('[REDACTED:stash:'))
  assert.ok(ph.endsWith(']'))
  const uuid = parsePlaceholder(ph)
  assert.notEqual(uuid, null)

  // envFor
  assert.deepEqual(stash.envFor(1), { GITHUB_TOKEN: 'ghp_secret_value_111' })
  assert.deepEqual(stash.envFor(2), {}) // 会话隔离

  // 非法环境变量名拒绝
  assert.throws(() => stash.put(1, '1BAD NAME', 'x'), /合法环境变量名/)

  // 同名覆盖仅更换环境变量，旧值仍须脱敏。
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

  // clear 单会话
  stash.clear(1)
  assert.deepEqual(stash.envFor(1), {})
  assert.deepEqual(stash.envFor(2), { GITHUB_TOKEN: 'other-example-value', OTHER_KEY: 'other_value' })
  stash.clear()
  assert.equal(stash.stats().secrets, 0)
})

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------
test('auth: setup 仅首次、弱密码拒绝、login 签发、token 摘要持久化且不落明文', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  assert.deepEqual(await auth.status(), { configured: false })

  // 弱密码
  await assert.rejects(() => auth.setup('short'), /至少 8/)
  await assert.rejects(() => auth.setup(''), /至少 8/)
  assert.deepEqual(await auth.status(), { configured: false })

  // setup
  const { token } = await auth.setup('correct horse battery staple')
  assert.ok(token.length >= 32)
  assert.deepEqual(await auth.status(), { configured: true })

  // 重复 setup 拒绝
  await assert.rejects(() => auth.setup('another password 99'), /已配置|重复/)

  // config.json 中无明文密码、无明文 token
  const configText = await readTextFile(join(dataDir, 'config.json'))
  assert.ok(!configText.includes('correct horse'), '密码明文不得落盘')
  assert.ok(!configText.includes(token), 'token 明文不得落盘')

  // 错误密码
  await assert.rejects(() => auth.login('wrong password!!'), /密码错误/)
  // 未配置场景 login 显式报错
  const auth2 = new AuthService(await freshDataDir())
  await assert.rejects(() => auth2.login('some password'), /setup|初始化/)

  // 正确登录 + 双 token 均有效
  const { token: token2 } = await auth.login('correct horse battery staple')
  assert.notEqual(token, token2)
  assert.equal(await auth.verifyToken(token), true)
  assert.equal(await auth.verifyToken(token2), true)
  assert.equal(await auth.verifyToken('f'.repeat(64)), false)
  assert.equal(await auth.verifyToken(''), false)
  // 摘要形态：64 hex 字符
  const config = JSON.parse(configText) as { auth?: { tokens?: Record<string, { digest: string }> } }
  const digests = Object.values(config.auth?.tokens ?? {})
  assert.ok(digests.length >= 1)
  assert.ok(digests.every((d) => /^[0-9a-f]{64}$/.test(d.digest)))
})

test('auth: 并发 setup 只成功一次、并发 update 不覆盖其他配置键', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => auth.setup(`password-number-${i}000000`)),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, '并发 setup 仅一个成功')
  for (const r of results) {
    if (r.status === 'rejected') assert.match(String(r.reason), /已配置|重复/)
  }

  // ConfigService 并发 update 保留其他键
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
  assert.ok(final['auth'], '并发 update 不得丢失 auth 键')
})

// ---------------------------------------------------------------------------
// CredentialService
// ---------------------------------------------------------------------------
test('credentials: set/get/list/delete、恒 0600、providers.json 与密钥隔离', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const credentials = new CredentialService(dataDir)
  assert.deepEqual(await credentials.list(), [])

  await credentials.set('openai', 'sk-live-abcdef123456')
  await credentials.set('anthropic', 'sk-ant-zzz')
  assert.deepEqual(await credentials.list(), ['anthropic', 'openai'])
  assert.equal(await credentials.get('openai'), 'sk-live-abcdef123456')

  // 文件权限恒 0600
  assert.ok(await isPrivateMode(join(dataDir, 'credentials.json')))

  // 已有文件被放宽权限后再写仍收敛 0600（rename 保留模式，atomic 写 temp 0600）
  await chmod(join(dataDir, 'credentials.json'), 0o644)
  await credentials.set('openai', 'sk-rotated-999')
  assert.ok(await isPrivateMode(join(dataDir, 'credentials.json')))
  assert.equal(await credentials.get('openai'), 'sk-rotated-999')

  await credentials.delete('anthropic')
  assert.deepEqual(await credentials.list(), ['openai'])
  await assert.rejects(() => credentials.delete('anthropic'), /不存在|anthropic/)

  // 插件 secret 读写与删除
  await credentials.setPluginSecret('builtin:triggers', 'webhookSecret', 'whsec_abc')
  assert.equal(await credentials.getPluginSecret('builtin:triggers', 'webhookSecret'), 'whsec_abc')
  await credentials.deletePluginSecrets('builtin:triggers')
  assert.equal(await credentials.getPluginSecret('builtin:triggers', 'webhookSecret'), undefined)

  // 非法 id / 空值
  await assert.rejects(() => credentials.get('../x'), /非法/)
  await assert.rejects(() => credentials.set('openai', ''), /不能为空/)

  // ProviderService：providers.json 无密钥字段，密钥字段直接拒绝
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
  assert.ok(!providerText.includes('sk-'), 'providers.json 不得包含密钥值')
  await assert.rejects(
    () =>
      providers.save([
        {
          id: 'x', protocol: 'openai', baseUrl: 'https://x.example.com',
          models: ['m1'], enabled: true, apiKey: 'sk-leak',
        } as unknown as ProviderConfig[],
      ] as never),
    /禁止包含密钥字段/,
  )
  // providers.json 与 credentials.json 是两个文件
  assert.ok(existsSync(join(dataDir, 'providers.json')))
  assert.ok(existsSync(join(dataDir, 'credentials.json')))
})

// ---------------------------------------------------------------------------
// ArtifactService
// ---------------------------------------------------------------------------
test('artifacts: register 复制登记、readContent 读取、list 与 deleteConversation 级联', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const artifacts = new ArtifactService(dataDir, repository)

  const src = await tempSourceFile('# 报告\n内容'.repeat(100))
  const meta = await artifacts.register(1, src, { name: 'report.md' })
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.name, 'report.md')
  assert.ok(meta.path.startsWith(join('artifacts', '1')))
  assert.ok(meta.size > 0)
  assert.ok((await artifacts.readContent(meta.id)).includes('报告'))
  assert.equal((await artifacts.list(1)).length, 1)
  // 源文件不被破坏（复制而非移动）
  assert.ok(existsSync(src))

  await artifacts.register(2, src)
  assert.equal((await artifacts.list(1)).length, 1)
  assert.equal((await artifacts.list(2)).length, 1)

  await artifacts.deleteConversation(1)
  assert.equal((await artifacts.list(1)).length, 0)
  assert.equal((await artifacts.list(2)).length, 1)
  assert.deepEqual(await artifacts.listFiles(1), [])

  // register 非法输入
  await assert.rejects(() => artifacts.register(0, src), /conversationId/)
  await assert.rejects(() => artifacts.register(1, ''), /sourcePath/)
  const evilName = await artifacts.register(1, src).catch(() => undefined)
  assert.notEqual(evilName, undefined)
})

test('artifacts: spill 32KiB 阈值、4KiB UTF-8 安全预览、秘密不落盘、id/path 指引', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, repository, stash)

  // 低于阈值：原样返回、无 artifact
  const small = 'x'.repeat(1024)
  const r1 = await artifacts.spill(1, 'call-1', small)
  assert.equal(r1.artifact, undefined)
  assert.equal(r1.text, small)

  // 恰好阈值：不落盘（> 32KiB 才 spill）
  const exact = 'y'.repeat(32 * 1024)
  const r2 = await artifacts.spill(1, 'call-2', exact)
  assert.equal(r2.artifact, undefined)

  // 超阈值：落盘 + 预览
  const headZh = '预览头部中文内容。'
  const big = headZh + 'z'.repeat(40 * 1024) + '尾部内容TAIL'
  const r3 = await artifacts.spill(1, 'call-3', big)
  assert.notEqual(r3.artifact, undefined)
  const meta = r3.artifact!
  assert.equal(meta.conversationId, 1)
  assert.ok(meta.path.includes('tool-spill-call-3.txt'))
  assert.ok(meta.size > 32 * 1024)
  // 返回文本：头部预览 + 截断标记 + 尾部摘要 + id/path 指引
  assert.ok(r3.text.includes(headZh))
  assert.ok(r3.text.includes('已截断'))
  assert.ok(r3.text.includes('TAIL'))
  assert.ok(r3.text.includes(meta.id))
  assert.ok(r3.text.includes(meta.path))
  // 预览长度受控（远小于全量）
  assert.ok(Buffer.byteLength(r3.text, 'utf8') < 8 * 1024)
  // 全量文件存在且内容完整
  assert.ok((await artifacts.readContent(meta.id)).length === big.length)
  // repo 已登记
  assert.ok((await artifacts.list(1)).some((a) => a.id === meta.id))

  // UTF-8 安全截断：多字节中文边界不撕裂
  const zhHead = '汉'.repeat(2049) // 3 字节/字，4KiB 边界落在字符中间
  const r4 = await artifacts.spill(2, 'call-4', zhHead + 'a'.repeat(33 * 1024))
  assert.notEqual(r4.artifact, undefined)
  // 预览可完整 decode（若撕裂会出替换符）
  assert.ok(!r4.text.includes('\uFFFD'), 'UTF-8 截断不得撕裂多字节字符')

  // 含 stash 占位符的文本：落盘文件保持占位（秘密绝不落盘）
  const placeholder = stash.put(9, 'MY_KEY', 'super-secret-value')
  const leak = `前缀${placeholder} super-secret-value` + 'q'.repeat(33 * 1024)
  const r5 = await artifacts.spill(9, 'call-5', leak)
  assert.ok(r5.artifact !== undefined)
  const spilled = await artifacts.readContent(r5.artifact!.id)
  assert.ok(!spilled.includes('super-secret-value'), '秘密明文不得落入 spill 文件')
  assert.ok(spilled.includes(placeholder), '占位符形态应保留')
  assert.ok(!r5.text.includes('super-secret-value'), '预览不得含秘密明文')

  // 非法 callId
  await assert.rejects(() => artifacts.spill(1, '../evil', 'x'), /callId/)
})

// ---------------------------------------------------------------------------
// 集成：memory 原子更新 + watcher 实时感知（assistant 插件消费路径）
// ---------------------------------------------------------------------------
test('集成: update_memory 原子更新被 watcher 实时捕获（无 temp 事件）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()

  const seen: string[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => seen.push(...paths),
    { onError: (err) => assert.fail(`watcher 不应报错: ${String(err)}`) },
  )
  watcher.start()
  try {
    await profiles.updateMemory('assistant', '用户偏好：简洁回复', 'append')
    await waitFor(() => seen.some((p) => p === 'profiles/assistant/MEMORY.md'))
    // 读取到的永远是完整内容（原子性）
    const memory = await profiles.getMemory('assistant')
    assert.ok(memory.includes('用户偏好：简洁回复'))
    for (const p of seen) assert.ok(!p.includes('.tmp'))
  } finally {
    watcher.close()
  }
})

// 清理
test('清理临时目录', { timeout: 60_000 }, async () => {
  await rm(scratchRoot, { recursive: true, force: true })
  // 静默验证 tsx 可执行（保持与 runner 的一致性）
  const res = spawnSync('tsx', ['--version'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
})
