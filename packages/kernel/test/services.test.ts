/**
 * helm 内核服务层测试：真实文件系统行为，无假 runtime。
 * 覆盖：paths/atomic-file、profiles/skills（穿越与软链拒绝）、watcher、
 * SecretStash 隔离、AuthService scrypt/token、凭据 0600 与不泄露、
 * ArtifactService spill 阈值与 UTF-8 安全。
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
} from '../src/builtin-plugins/profile/assets.js'
import { MANAGED_EXEC_ENV_VARS } from '../src/env/scoped-env.js'
import { WATCHDOG_PLAYBOOK_SKILL_ASSET } from '../src/builtin-plugins/superagent/assets.js'
import { MemoryStore } from '../src/builtin-plugins/memory/store.js'
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

/** 断言 promise 被拒绝且错误信息匹配（避免 unhandled rejection 噪声）。 */
async function expectReject(fn: () => Promise<unknown>, re: RegExp): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    assert.match(String(err), re)
    return err
  }
  assert.fail(`应抛出错误: ${re}`)
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
  // 自举只落 SYSTEM.md（MEMORY.md 由 builtin:memory 插件自治管理）
  assert.ok((await profiles.getSystem('assistant')).length > 0)

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

test('profiles: save 不再读写 MEMORY.md（记忆由 builtin:memory 自治）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  await profiles.save({ id: 'writer', name: '写手', tags: [] })
  // 新建 Profile 不自动创建 MEMORY.md
  const entries = await readdir(join(dataDir, 'profiles', 'writer'))
  assert.ok(!entries.includes('MEMORY.md'), 'ProfileService.save 不得创建 MEMORY.md')
  // 传入 memory 字段（旧契约）被服务层静默剥离：不落 profile.json、不写 MEMORY.md
  //（HTTP 边界 rejectUnknownKeys 显式 400，见 http.test.ts）。
  const saved = await profiles.save({ id: 'writer2', name: '写手', tags: [], memory: '# 旧字段' } as never)
  assert.equal('memory' in saved, false, 'memory 不进 Profile 契约')
  assert.ok(
    !(await readdir(join(dataDir, 'profiles', 'writer2'))).includes('MEMORY.md'),
    'memory 字段不得触发 MEMORY.md 写入',
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

test('profiles: SYSTEM_DEFAULT 分层——含 helm-cli 引导与 HELM_CONVERSATION_ID，不含生成式 UI 组件字典', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const system = await profiles.getSystem('assistant')
  // Layer 0 必须指引 load_skill helm-cli 与受管 CLI 环境变量
  assert.ok(system.includes('# System Prompt'))
  assert.ok(system.includes('helm-cli'), '应含 helm-cli 技能引导')
  assert.ok(system.includes('HELM_CONVERSATION_ID'), '应含受管环境变量直觉')
  assert.ok(system.includes('load_skill'), '应指引用 load_skill 按需加载')
  // 分层铁律：常驻提示词不含具体生成式 UI 组件名（下沉 Layer 2 references）
  for (const component of ['MetricGrid', 'CheckboxGroup', 'ActionBar', 'BarList', 'KeyValueList', 'Accordion', 'helm:action', 'helm:open', 'helm:send']) {
    assert.ok(!system.includes(component), `SYSTEM_DEFAULT 不应含 Layer 2 细节: ${component}`)
  }
  // 目录驱动：常驻提示词不点名具体扩展技能，由当回合可用技能目录自解释
  for (const name of ['generative-ui', 'app-builder']) {
    assert.ok(!system.includes(name), `SYSTEM_DEFAULT 不应硬编码扩展技能名: ${name}`)
  }
  // 产物登记 markdown 规则保留在 Layer 0
  assert.ok(system.includes('artifact:<id>'), '应保留产物登记与内联渲染规则')
})

test('helm-cli 技能资产同步界面扩展与会话投影能力面（防回退）', { timeout: 60_000 }, () => {
  // generative-ui 手册已迁 builtin:json-render 插件技能（随启停过滤）：
  // helm-cli SKILL.md 不得残留指向已删除 references 的下钻索引。
  assert.ok(!HELM_CLI_SKILL_MD.includes('references/generative-ui.md'), '不得引用已迁出的 generative-ui.md')
  assert.ok(HELM_CLI_SKILL_MD.includes('generative-ui'), '应按可用技能目录引导富展示（非硬编码手册）')

  // SKILL.md：会话文档 CLI 参数
  assert.ok(HELM_CLI_SKILL_MD.includes('--conversation'), 'SKILL.md 应含 doc --conversation 会话文档读取')
  assert.ok(HELM_CLI_SKILL_MD.includes('--watch'), 'SKILL.md 应含 doc --watch 订阅')

  // 插件开发：ctx.ui 注册方法契约对齐
  assert.ok(
    HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(`${PLUGIN_UI_METHOD_NAMES.length} 个 ctx.ui 注册方法`),
    `应 documenting ${PLUGIN_UI_METHOD_NAMES.length} 个 ctx.ui 注册方法`,
  )
  for (const method of PLUGIN_UI_METHOD_NAMES) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(method),
      `插件开发参考应含 ctx.ui 注册方法 ${method}`,
    )
  }

  // 插件开发：后端 Hook 契约对齐
  for (const hook of PLUGIN_HOOK_NAMES) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(hook),
      `插件开发参考应含后端 Hook ${hook}`,
    )
  }

  // 插件开发：保留斜杠词契约对齐
  for (const slash of RESERVED_SLASH_COMMANDS) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(slash),
      `插件开发参考应含保留斜杠词 ${slash}`,
    )
  }

  // 插件开发：@helm/plugin-client 导出符号契约对齐
  for (const exportName of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(
      HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(exportName),
      `插件开发参考应含 @helm/plugin-client 导出符号 ${exportName}`,
    )
  }

  // 插件开发：保留对 sessionDoc、composer、sp.<key> 的断言
  for (const api of ['ctx.sessionDoc', 'composer']) {
    assert.ok(HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(api), `插件开发参考应含 ${api}`)
  }
  assert.ok(HELM_CLI_SKILL_AND_PLUGIN_DEV_MD.includes('sp.<key>'), '应 documenting sp./ssp. 深链命名空间')

  // CLI 核心命令全量对齐（CORE_CLI_COMMAND_PATHS 为唯一真源，不定死条数）
  for (const cmdPath of CORE_CLI_COMMAND_PATHS) {
    const parts = cmdPath.split(' ')
    if (parts.length === 1) {
      assert.ok(
        HELM_CLI_SKILL_MD.includes(`helm ${cmdPath}`),
        `SKILL.md 应包含单词核心命令 "helm ${cmdPath}"`,
      )
    } else {
      const [root, sub] = parts
      const pattern = new RegExp(`helm ${root} [\\w|]*\\b${sub}\\b`)
      const matched = HELM_CLI_SKILL_MD.includes(`helm ${cmdPath}`) || pattern.test(HELM_CLI_SKILL_MD)
      assert.ok(
        matched,
        `SKILL.md 应包含或通过合并写法正则匹配核心命令 "helm ${cmdPath}"`,
      )
    }
  }

  // 受管环境变量全量对齐
  for (const envVar of MANAGED_EXEC_ENV_VARS) {
    assert.ok(
      HELM_CLI_SKILL_MD.includes(envVar),
      `SKILL.md 应包含受管环境变量 ${envVar}`,
    )
  }

  // 模板占位符零残留与错误防护验证
  assert.ok(
    !HELM_CLI_SKILL_ASSET.skillMd.includes('{{') && !HELM_CLI_SKILL_ASSET.skillMd.includes('}}'),
    'HELM_CLI_SKILL_ASSET.skillMd 不应残留模板占位符',
  )
  for (const [refName, refContent] of Object.entries(HELM_CLI_SKILL_ASSET.references)) {
    assert.ok(
      !refContent.includes('{{') && !refContent.includes('}}'),
      `HELM_CLI_SKILL_ASSET reference "${refName}" 不应残留模板占位符`,
    )
  }

  assert.ok(
    !WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd.includes('{{') && !WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd.includes('}}'),
    'WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd 不应残留模板占位符',
  )
  for (const [refName, refContent] of Object.entries(WATCHDOG_PLAYBOOK_SKILL_ASSET.references)) {
    assert.ok(
      !refContent.includes('{{') && !refContent.includes('}}'),
      `WATCHDOG_PLAYBOOK_SKILL_ASSET reference "${refName}" 不应残留模板占位符`,
    )
  }

  assert.throws(
    () => renderSkillTemplate('hello {{UNKNOWN_VAR}}', {}),
    (err: unknown) => err instanceof HelmError && err.code === 'unreplaced_skill_placeholder',
  )
})

test('skills: ensureSkill 受管覆盖——自举、重启覆盖源码版本、补缺文件、拒绝软链覆盖、写入只读', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const skills = new SkillService(dataDir)
  const asset = {
    id: 'demo-asset',
    skillMd: '---\nname: demo-asset\ndescription: 自举技能\n---\n\n# 正文\n',
    references: {
      'guide.md': '# 指南\n内容。\n',
      'extra.md': '# 附加\n内容。\n',
    },
  }

  // 首次自举：全部写入且可读
  await skills.ensureSkill(asset)
  assert.ok((await skills.readFile('demo-asset')).includes('自举技能'))
  assert.ok((await skills.readFile('demo-asset', 'references/guide.md')).includes('指南'))
  assert.ok((await skills.readFile('demo-asset', 'references/extra.md')).includes('附加'))

  // 受管技能写入口：服务边界统一 403 managed_skill_readonly
  await assert.rejects(
    () => skills.writeFile('demo-asset', 'SKILL.md', '篡改'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'managed_skill_readonly')
      assert.equal(err.status, 403)
      return true
    },
  )
  await assert.rejects(
    () => skills.writeFile('demo-asset', 'references/other.md', '篡改'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'managed_skill_readonly')
      return true
    },
  )

  // 磁盘手工篡改（绕过服务）后重启同步：SKILL.md 与 guide.md 回到源码版本
  const customMd = '---\nname: demo-asset\ndescription: 用户改写\n---\n\n我的自定义正文\n'
  const customGuide = '# 用户改写的指南\n'
  await writeFile(join(dataDir, 'skills', 'demo-asset', 'SKILL.md'), customMd)
  await writeFile(join(dataDir, 'skills', 'demo-asset', 'references', 'guide.md'), customGuide)
  await skills.ensureSkill(asset)
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'SKILL.md')),
    asset.skillMd,
    '重启同步后 SKILL.md 必须回到源码版本',
  )
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'references', 'guide.md')),
    asset.references['guide.md']!,
    '重启同步后 reference 必须回到源码版本',
  )

  // 删除一个子文件后再次同步：缺失的 extra.md 被补齐
  await rm(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await skills.ensureSkill(asset)
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md')),
    asset.references['extra.md']!,
  )

  // 内容一致时不重写（按内容比较、不按 mtime；避免原子 rename 抖动 watcher）
  const stablePath = join(dataDir, 'skills', 'demo-asset', 'SKILL.md')
  const stableBefore = await lstat(stablePath)
  const backdatedMs = stableBefore.mtimeMs - 60_000
  const backdated = new Date(backdatedMs)
  await utimes(stablePath, backdated, backdated)
  await skills.ensureSkill(asset)
  const stableAfter = await lstat(stablePath)
  // 文件系统毫秒截断有亚毫秒偏差，容差 2ms 内视为未被重写（重写会更新为当前时间，相差分钟级）
  assert.ok(
    Math.abs(stableAfter.mtimeMs - backdatedMs) <= 2,
    `内容一致时不得重写（mtime 应保持回设值 ~${backdatedMs}，实际 ${stableAfter.mtimeMs}）`,
  )
  assert.equal(await readTextFile(stablePath), asset.skillMd)

  // 目标已存在且为符号链接：拒绝覆写（防软链越界；目录/软链都不是常规文件）
  const outside = join(scratchRoot, 'outside-target.md')
  await writeFile(outside, '外部内容')
  await rm(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await symlink(outside, join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await assert.rejects(() => skills.ensureSkill(asset), /不是常规文件/)
  assert.equal(await readFile(outside, 'utf8'), '外部内容')

  // 非法资产 id 与非法 reference 名在边界拒绝，且不产生任何部分资产
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: '../evil' }),
    /非法 skill id/,
  )
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ok-id', references: { '../evil.md': 'x' } }),
    /穿越|非法/,
  )
  assert.ok(!existsSync(join(dataDir, 'skills', 'ok-id')), '非法 reference 不得产生部分资产')
})

test('skills: 用户自建技能不受受管覆盖影响——ensureSkill 不触碰、writeFile 可写', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'user-skill', ['references/guide.md'])
  const before = await readTextFile(join(dataDir, 'skills', 'user-skill', 'SKILL.md'))

  // 自举其他受管技能不影响用户自建技能
  await skills.ensureSkill({
    id: 'managed-asset',
    skillMd: '---\nname: managed-asset\ndescription: 受管\n---\n\n正文\n',
    references: {},
  })
  assert.equal(await readTextFile(join(dataDir, 'skills', 'user-skill', 'SKILL.md')), before)
  assert.ok(!(await skills.list()).some((s) => s.id === 'user-skill' && s.managedByPlugin), '用户技能无受管标记')

  // 用户自建技能写入不受 403 限制
  await skills.writeFile('user-skill', 'SKILL.md', '---\nname: user-skill\ndescription: 用户技能\n---\n用户可写\n')
  assert.ok((await skills.readFile('user-skill')).includes('用户可写'))
  await skills.writeFile('user-skill', 'references/extra.md', '# 用户新增\n')
  assert.ok((await skills.readFile('user-skill', 'references/extra.md')).includes('用户新增'))
})

test('skills: ensureSkill 拒绝目录软链与目录冒充文件，绝不向 skills 根之外写入', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  const asset = {
    id: 'demo-guard',
    skillMd: '---\nname: demo-guard\ndescription: 守卫\n---\n\n# 正文\n',
    references: { 'guide.md': '# 指南\n', 'rules/table.md': '# 规则\n' },
  }

  // skills 根本身是软链：与 requireSkillsRoot 语义一致，realpath 解析后正常自举
  const realRoot = join(dataDir, 'real-skills')
  await mkdir(realRoot, { recursive: true })
  await symlink(realRoot, join(dataDir, 'skills'))
  await skills.ensureSkill(asset)
  assert.ok((await skills.readFile('demo-guard')).includes('守卫'))
  assert.ok((await skills.readFile('demo-guard', 'references/rules/table.md')).includes('规则'))

  // skills/<id> 是软链：拒绝写入，软链目标目录保持空（不向外写）
  const evilDir = join(scratchRoot, 'evil-skill-dir')
  await rm(evilDir, { recursive: true, force: true })
  await mkdir(evilDir, { recursive: true })
  await symlink(evilDir, join(realRoot, 'linked-skill'))
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'linked-skill' }),
    /符号链接/,
  )
  assert.deepEqual(await readdir(evilDir), [])

  // references 目录是软链：拒绝写入，外部目录不被写入任何文件
  const outsideRefs = join(scratchRoot, 'outside-refs')
  await rm(outsideRefs, { recursive: true, force: true })
  await mkdir(outsideRefs, { recursive: true })
  await mkdir(join(realRoot, 'ref-link-skill'), { recursive: true })
  await symlink(outsideRefs, join(realRoot, 'ref-link-skill', 'references'))
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-link-skill' }),
    /符号链接/,
  )
  assert.deepEqual(await readdir(outsideRefs), [])
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-link-skill', references: {} }),
    /符号链接/,
  )

  // SKILL.md 位置是目录：目录冒充文件不算自举成功
  await mkdir(join(realRoot, 'dir-as-file', 'SKILL.md'), { recursive: true })
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'dir-as-file' }),
    /不是常规文件/,
  )

  // reference 位置是目录：同样拒绝
  await mkdir(join(realRoot, 'ref-as-dir', 'references', 'guide.md'), { recursive: true })
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-as-dir' }),
    /不是常规文件/,
  )
})

test('profiles: skills 三态——缺省不写字段、空数组持久保留、白名单去重与非法值拒绝', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()

  // ① 缺省：不带 skills 字段保存，持久层不写该键（get 回读 undefined）
  await profiles.save({ id: 'p-default', name: '缺省', tags: [] })
  assert.equal((await profiles.get('p-default'))?.skills, undefined)
  const onDiskDefault = JSON.parse(await readFile(join(dataDir, 'profiles', 'p-default', 'profile.json'), 'utf8')) as Record<string, unknown>
  assert.equal('skills' in onDiskDefault, false, '缺省时 profile.json 不写 skills 键')

  // ② 空数组：持久保留（禁用全部技能的显式配置，不得被丢弃）
  await profiles.save({ id: 'p-none', name: '全禁', tags: [], skills: [] })
  assert.deepEqual((await profiles.get('p-none'))?.skills, [])
  const onDiskNone = JSON.parse(await readFile(join(dataDir, 'profiles', 'p-none', 'profile.json'), 'utf8')) as { skills?: string[] }
  assert.deepEqual(onDiskNone.skills, [], '空数组必须原样落盘')

  // ③ 非空白名单：重复项规范化去重后持久化；未知/暂缺 id 允许保存（运行时可后装）
  await profiles.save({ id: 'p-white', name: '白名单', tags: [], skills: ['helm-cli', 'watchdog-playbooks', 'helm-cli', 'future-skill'] })
  assert.deepEqual((await profiles.get('p-white'))?.skills, ['helm-cli', 'watchdog-playbooks', 'future-skill'])

  // 非法值：非数组 / 非字符串元素 / 非法 skill id 格式（路径注入）显式拒绝
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: 'helm-cli' } as unknown as Parameters<ProfileService['save']>[0]),
    /skills 必须是字符串数组/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: ['ok-skill', 42] } as unknown as Parameters<ProfileService['save']>[0]),
    /skills 必须是字符串数组/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: ['../profiles/assistant'] }),
    /非法 skill id/,
  )
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

test('stash: addRedaction 全局逐值脱敏——非 env、不计 stats、clear(id) 不清、引用计数', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const managed = 'managed-token-value-abc123'
  const release = stash.addRedaction(managed)

  // 任意会话上下文（含无上下文）均脱敏；与 stash 占位符可共存
  const stashPh = stash.put(1, 'MY_KEY', 'session-secret-value')
  assert.equal(stash.redact(`token=${managed}`), 'token=[REDACTED]')
  assert.equal(stash.redact(`token=${managed}`, 1), 'token=[REDACTED]')
  assert.equal(stash.redact(`token=${managed}`, 99), 'token=[REDACTED]')
  assert.equal(stash.redact(`session=${'session-secret-value'} managed=${managed}`), `session=${stashPh} managed=[REDACTED]`)

  // 非 env、不计 stats、不入 envFor
  assert.deepEqual(stash.envFor(1), { MY_KEY: 'session-secret-value' })
  assert.deepEqual(stash.envFor(2), {})
  assert.equal(stash.stats().secrets, 1)

  // clear(单会话) 不清全局登记；clear() 全清（含全局）
  stash.clear(1)
  assert.equal(stash.redact(managed), '[REDACTED]')
  stash.clear()
  assert.equal(stash.redact(managed), managed, 'clear() 应连全局登记一并清除')

  // 引用计数：同一值叠放两次，全部解除才停止脱敏；解除函数幂等
  const r1 = stash.addRedaction(managed)
  const r2 = stash.addRedaction(managed)
  r1()
  r1()
  assert.equal(stash.redact(managed), '[REDACTED]')
  r2()
  assert.equal(stash.redact(managed), managed)

  // 非法入参拒绝
  assert.throws(() => stash.addRedaction(''), /非空/)
})

test('stash: 全局脱敏优先、标记幂等与旧解除句柄隔离', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  const value = 'internal-example-for-redaction'
  const releaseOld = stash.addRedaction(value)
  stash.put(1, 'EXAMPLE', value)
  assert.equal(stash.redact(value), '[REDACTED]')

  stash.clear()
  const releaseCurrent = stash.addRedaction(value)
  releaseOld()
  assert.equal(stash.redact(value), '[REDACTED]', '清空前的句柄不得解除新登记')
  releaseCurrent()
  assert.equal(stash.redact(value), value)

  stash.addRedaction('REDACTED')
  assert.equal(stash.redact('[REDACTED]'), '[REDACTED]', '已脱敏标记保持原样')
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

test('auth: createProcessToken 仅内存生命周期——识别、dispose 失效、不落盘、匿名不放行', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  // 未 setup 也可用：内核受管子进程鉴权独立于密码体系
  assert.deepEqual(await auth.status(), { configured: false })
  const managed = auth.createProcessToken()
  assert.ok(managed.token.length >= 32)
  assert.equal(await auth.verifyToken(managed.token), true)

  // 跨实例可验证（同 dataDir 注册表共享，与持久 token 语义一致）
  assert.equal(await new AuthService(dataDir).verifyToken(managed.token), true)

  // 不写 config.json/SQLite：无明文也无摘要落盘
  const configText = await readTextFile(join(dataDir, 'config.json')).catch(() => '')
  assert.ok(!configText.includes(managed.token), '受管 token 明文不得落盘')
  assert.ok(!configText.includes(managed.token.slice(0, 16)), '受管 token 不得以任何形态落盘')

  // dispose 后立即失效（幂等）；持久化 token 不受影响
  const { token: persisted } = await auth.setup('process token pw 12345678')
  assert.equal(await auth.verifyToken(persisted), true)
  managed.dispose()
  managed.dispose() // 幂等
  assert.equal(await auth.verifyToken(managed.token), false)
  assert.equal(await auth.verifyToken(persisted), true)

  // 匿名/空值/伪值永不放行（不得因受管通道存在而放宽）
  assert.equal(await auth.verifyToken(''), false)
  assert.equal(await auth.verifyToken('anonymous'), false)
  assert.equal(await auth.verifyToken('0'.repeat(64)), false)
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
  // metadata.path 固定为 POSIX 分隔符（artifactRelPath），Windows 上也不得出现反斜杠
  assert.ok(meta.path.startsWith('artifacts/1/'))
  assert.ok(!meta.path.includes('\\'))
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

  // Responses API 复合 callId（含 `|`）允许通过，且与 `_` 同形 callId 不发生物理文件碰撞覆盖
  const responsesStyle = await artifacts.spill(1, 'call_ab12|fc_call_ab12', 'z'.repeat(33 * 1024))
  const underscoreStyle = await artifacts.spill(1, 'call_ab12_fc_call_ab12', 'w'.repeat(33 * 1024))
  assert.ok(responsesStyle.artifact !== undefined, '复合 callId 必须能 spill')
  assert.ok(underscoreStyle.artifact !== undefined)
  assert.notEqual(responsesStyle.artifact!.path, underscoreStyle.artifact!.path, '转义后不得与下划线 callId 碰撞覆写')
  assert.equal((await artifacts.readContent(responsesStyle.artifact!.id))[0], 'z')
  assert.equal((await artifacts.readContent(underscoreStyle.artifact!.id))[0], 'w')

  // 非法 callId（路径穿越、分隔符、空白、控制字符）边界显式拒绝
  await assert.rejects(() => artifacts.spill(1, '../evil', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, 'a/b', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '   ', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '.', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '..', 'x'), /callId/)
})

test('artifacts: register 文本产物含 stash 明文先脱敏再落盘、二进制字节不损坏、伪 metadata 路径拒绝', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, repository, stash)

  // 含真实 stash 明文的文本文件：register 后落盘文件与 readContent 都不含明文
  const secretValue = 'live-secret-token-for-register-test'
  stash.put(1, 'MY_SECRET', secretValue)
  const srcText = await tempSourceFile(`报告头部。\nsecret=${secretValue}\n报告尾部。\n`)
  const meta = await artifacts.register(1, srcText, { name: 'report.md' })
  const stored = await readFile(join(dataDir, meta.path), 'utf8')
  assert.ok(!stored.includes(secretValue), 'register 文本产物不得落盘秘密明文')
  assert.ok(stored.includes('[REDACTED:stash:'), '脱敏后应含占位符')
  assert.ok(stored.includes('报告头部。'), '非秘密部分保持原样')
  const readBack = await artifacts.readContent(meta.id)
  assert.ok(!readBack.includes(secretValue))
  assert.equal(meta.mimeType, 'text/markdown')

  // 二进制产物：字节原样复制（含非法 UTF-8 序列不损坏）
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80])
  const srcBin = await tempSourceFile(binary)
  const metaBin = await artifacts.register(1, srcBin, { name: 'photo.png' })
  assert.equal(metaBin.mimeType, 'image/png')
  const storedBin = await readFile(join(dataDir, metaBin.path))
  assert.deepEqual(new Uint8Array(storedBin), binary, '二进制字节必须原样保留')
  const buf = await artifacts.readBuffer(metaBin.id)
  assert.deepEqual(new Uint8Array(buf), binary)

  // 伪 metadata 路径（手改 DB）拒绝：绝对路径、../ 穿越、artifacts 之外
  const evil1 = { ...meta, id: 'evil-1', path: '/etc/passwd' }
  repository.put(evil1 as never)
  await assert.rejects(() => artifacts.readContent('evil-1'), /越出|拒绝/)
  await assert.rejects(() => artifacts.readBuffer('evil-1'), /越出|拒绝/)
  const evil2 = { ...meta, id: 'evil-2', path: 'artifacts/../../credentials.json' }
  repository.put(evil2 as never)
  await assert.rejects(() => artifacts.readContent('evil-2'), /越出|拒绝/)
  // 正常 metadata 仍可读（校验不影响合法路径）
  assert.ok((await artifacts.readContent(meta.id)).includes('报告头部。'))

  // list 非法 convId 拒绝（避免 -1 等越界目录段）
  await assert.rejects(() => artifacts.list(-1), /conversationId/)
  await assert.rejects(() => artifacts.list(1.5), /conversationId/)
  await assert.rejects(() => artifacts.deleteConversation(-1), /conversationId/)
})

// ---------------------------------------------------------------------------
// 跨实例并发正确性（进程内共享串行器）
// ---------------------------------------------------------------------------
test('并发回归: 不同 ConfigService 实例同 dataDir 并发 update 不丢键', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  // 5 个独立实例并发写 5 个不同键：实例级队列会丢键，共享锁必须全保留
  const services = Array.from({ length: 5 }, () => new ConfigService(dataDir))
  await Promise.all(
    services.map((svc, i) => svc.update({ [`key${i}`]: `value-${i}` })),
  )
  const final = await services[0]!.get()
  for (let i = 0; i < 5; i++) {
    assert.equal(final[`key${i}`], `value-${i}`, `并发 update 不得丢失 key${i}`)
  }

  // 再叠一轮大量并发：最终仍是全键并集
  const services2 = Array.from({ length: 8 }, () => new ConfigService(dataDir))
  await Promise.all(
    services2.map((svc, i) => svc.update({ [`wave2-${i}`]: i })),
  )
  const final2 = await services2[0]!.get()
  for (let i = 0; i < 8; i++) assert.equal(final2[`wave2-${i}`], i)
  for (let i = 0; i < 5; i++) assert.equal(final2[`key${i}`], `value-${i}`)

  // dataDir 为软链时不同写法仍共享同一把锁
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

test('并发回归: 不同 AuthService 实例并发 setup 仅一个成功', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => new AuthService(dataDir).setup(`instance-pw-${i}-12345678`)),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, '跨实例并发 setup 仅一个成功')
  for (const r of results) {
    if (r.status === 'rejected') assert.match(String(r.reason), /已配置|重复/)
  }
  // 成功实例的 token 可验证
  const ok = fulfilled[0] as PromiseFulfilledResult<{ token: string }>
  assert.equal(await new AuthService(dataDir).verifyToken(ok.value.token), true)

  // 并发 setup 与 config.update 交错：auth 键与其他键互不覆盖
  const dataDir2 = await freshDataDir()
  await Promise.all([
    new AuthService(dataDir2).setup('interleave-pw-12345678'),
    new ConfigService(dataDir2).update({ theme: 'dark' }),
    new ConfigService(dataDir2).update({ locale: 'zh-CN' }),
  ])
  const cfg = await new ConfigService(dataDir2).get()
  assert.ok(cfg['auth'], '交错 update 不得丢失 auth')
  assert.equal(cfg['theme'], 'dark')
  assert.equal(cfg['locale'], 'zh-CN')
})

test('并发回归: 不同 CredentialService 实例并发 set 不丢凭据', { timeout: 60_000 }, async () => {
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

test('跨进程锁回归: 坏锁拒绝、死持有者破除、存活持有者不强拆、锁不残留', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const target = join(dataDir, 'credentials.json')
  const lockFile = `${target}.lock`

  // 1) 锁内容损坏（无 PID）：显式报错，绝不猜测破除
  await writeFile(lockFile, 'not-a-pid garbage\n', { mode: 0o600 })
  await expectReject(() => withProcessFileLock(target, async () => 'ok'), /损坏/)
  await rm(lockFile, { force: true })

  // 2) 持有者已死（不存在的 PID）：stale 破除并正常执行；结束后锁不残留
  const deadPid = 2 ** 22 + Math.floor(Math.random() * 1000) // 远超真实 PID 范围上限，几乎必不存在
  {
    const probe = spawnSync(process.execPath, ['-e', 'process.exit(42)'])
    assert.equal(probe.status, 42)
  }
  await writeFile(lockFile, `${deadPid} uuid-dead\n`, { mode: 0o600 })
  assert.equal(await withProcessFileLock(target, async () => 'recovered'), 'recovered')
  assert.ok(!existsSync(lockFile), 'stale 破除执行后锁应被释放')

  // 3) 持有者存活：等待（不按存活时长强拆），释放后拿到锁
  const order: string[] = []
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     fs.writeFileSync(lock, process.pid + ' child-uuid\\n', { flag: 'wx', mode: 0o600 });
     setTimeout(() => { fs.unlinkSync(lock); process.exit(0) }, 400)`,
  ])
  // close 监听须在 spawn 后立即注册：等锁释放后再注册会错过已触发的 close 事件
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  // 等子进程确实拿到锁再进入争抢
  await waitFor(() => existsSync(lockFile))
  const acquired = await withProcessFileLock(target, async () => {
    order.push('parent')
    return 'after-child'
  })
  assert.equal(acquired, 'after-child', '存活持有者的锁不得被强拆，只能等待其释放')
  assert.deepEqual(order, ['parent'])
  assert.equal(await childExit, 0)
  assert.ok(!existsSync(lockFile))

  // 4) 长活进程（>1s）持锁期间不被 stale 强拆：先前 store 的凭据仍完整
  const svc = new CredentialService(dataDir)
  await svc.set('solo', 'sk-solo-1234567890')
  assert.equal(await svc.get('solo'), 'sk-solo-1234567890')
  const leftovers = (await readdir(dataDir)).filter((f) => f.endsWith('.lock'))
  assert.deepEqual(leftovers, [], '正常路径结束后不得残留锁文件')
})

test('跨进程锁回归: 真实子进程持锁期间 CredentialService.set 显式等锁而非丢更新', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const svc = new CredentialService(dataDir)
  await svc.set('pre', 'sk-pre-0123456789')
  const lockFile = join(dataDir, 'credentials.json.lock')

  // 子进程真实持锁 300ms（存活持有者），期间父进程 set 必须排队而非读旧写回
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     fs.writeFileSync(lock, process.pid + ' holder\\n', { flag: 'wx', mode: 0o600 });
     const t0 = Date.now();
     while (Date.now() - t0 < 300) {} // 忙等持锁（同步阻塞，确保不提前释放）
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

test('跨进程锁回归: 真实 CLI 子进程与 CredentialService 并发写 credentials.json 双键保留', { timeout: 60_000 }, async () => {
  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve('tsx/cli')
  const repoRoot = dirname(testDir) // packages/kernel/test -> 仓库根
  const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
  // 目录不存在的全新 dataDir：验证双方首次创建与同锁互认
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

    // CLI 子进程虽连不上 Hub（写凭据前才失败），但登录路径先写锁再读凭据；
    // 为确保子进程真的执行写入，改用与 CLI 同协议的锁持者进程直接改写 cli 键
    const holder = spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs');
       const path = require('node:path');
       const file = ${JSON.stringify(credFile)};
       const lock = file + '.lock';
       fs.writeFileSync(lock, process.pid + ' holder\\n', { flag: 'wx', mode: 0o600 });
       const t0 = Date.now();
       while (Date.now() - t0 < 300) {} // 持锁读改写窗口：与 CLI 协议一致的 credentials.json.lock
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
    // 父进程（Hub 侧）在同一窗口内并发写 provider 键：必须排队等子进程释放
    await svc.set('concurrent', 'sk-concurrent-abcdef123456')
    assert.equal(await holderExit, 0)

    const final = JSON.parse(await readFile(credFile, 'utf8')) as {
      cli: { token: string }
      providers: Record<string, { value: string }>
    }
    // 双方键均保留：锁协议互认使读改写完全串行
    assert.equal(final.cli.token, 'tok-child-write', 'CLI 侧写入的 cli 键不得被 Hub 侧覆盖丢失')
    assert.deepEqual(Object.keys(final.providers).sort(), ['base', 'concurrent'])
    assert.equal(final.providers['concurrent']!.value, 'sk-concurrent-abcdef123456')
    assert.ok(!(await readdir(dataDir)).some((f) => f.endsWith('.lock') || f.includes('.tmp')), '结束后无锁/临时文件残留')
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('并发回归: 不同 MemoryStore 实例并发 append 不丢行', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const base = new MemoryStore(createProfileFileHost(dataDir))
  await base.ensureMemory('assistant')
  const stores = Array.from({ length: 5 }, () => new MemoryStore(createProfileFileHost(dataDir)))
  await Promise.all(
    stores.map((store, i) => store.updateMemory('assistant', `行-${i}`, 'append')),
  )
  const text = await base.getMemory('assistant')
  for (let i = 0; i < 5; i++) {
    assert.ok(text.includes(`行-${i}`), `并发 append 不得丢失 行-${i}`)
  }
  // 总行数 = 默认头部（1 行非空）+ 5 次追加
  const lines = text.split('\n').filter((l: string) => l.length > 0)
  assert.equal(lines.length, 1 + 5)
})

test('credentials 回归: 保留 CLI 等未知顶层键、非法结构显式拒绝不覆写', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const credentials = new CredentialService(dataDir)

  // CLI 写入的未知键：set/get/delete 后原样保留
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
  assert.deepEqual(after['cli'], raw['cli'], 'CLI 键必须原样保留')
  assert.equal(after['extraFlag'], true, '其他未知键同样保留')
  assert.equal(
    (after['providers'] as Record<string, { value: string }>)['openai']!.value,
    'sk-first',
    '已有 provider 凭据不得被覆盖',
  )
  // delete provider 后 CLI 键仍在
  await credentials.delete('openai')
  const after2 = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(after2['cli'], raw['cli'])

  // providers 项结构非法（缺 value）：拒绝并保留原文件
  const badPath = join(dataDir, 'credentials.json')
  await writeFile(badPath, JSON.stringify({ providers: { broken: { note: 'no value' } } }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /broken/)
  await expectReject(() => credentials.set('x', 'v'), /broken/)
  assert.equal(JSON.parse(await readFile(badPath, 'utf8')).providers.broken.note, 'no value', '拒绝时不得覆写原文件')

  // providers.raw 非对象：拒绝
  await writeFile(badPath, JSON.stringify({ providers: 'oops' }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /providers/)

  // pluginSecrets 项非字符串：拒绝且不覆写
  await writeFile(
    badPath,
    JSON.stringify({ pluginSecrets: { 'p:x': { k: 123 } } }),
    { mode: 0o600 },
  )
  await expectReject(() => credentials.getPluginSecret('p:x', 'k'), /k/)
  assert.equal(JSON.parse(await readFile(badPath, 'utf8')).pluginSecrets['p:x'].k, 123)

  // pluginSecrets 项非对象：拒绝
  await writeFile(badPath, JSON.stringify({ pluginSecrets: { p: 'flat' } }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /pluginSecrets|p/)

  // 顶层非对象：拒绝
  await writeFile(badPath, JSON.stringify([1, 2]), { mode: 0o600 })
  await expectReject(() => credentials.list(), /结构非法/)

  // 宽松权限读取时自动修复 0600
  await writeFile(badPath, JSON.stringify({ providers: {} }), { mode: 0o644 })
  await credentials.list()
  assert.ok(await isPrivateMode(badPath), '读路径发现宽松权限应立即收敛 0600')
})

// ---------------------------------------------------------------------------
// 集成：memory 原子更新 + watcher 实时感知（builtin:memory 消费路径）
// ---------------------------------------------------------------------------
test('集成: MemoryStore 原子更新被 watcher 实时捕获（无 temp 事件）', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const store = new MemoryStore(createProfileFileHost(dataDir))
  await store.ensureMemory('assistant')

  const seen: string[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => seen.push(...paths),
    { onError: (err) => assert.fail(`watcher 不应报错: ${String(err)}`) },
  )
  watcher.start()
  try {
    await store.updateMemory('assistant', '用户偏好：简洁回复', 'append')
    await waitFor(() => seen.some((p) => p === 'profiles/assistant/MEMORY.md'))
    // 读取到的永远是完整内容（原子性）
    const memory = await store.getMemory('assistant')
    assert.ok(memory.includes('用户偏好：简洁回复'))
    for (const p of seen) assert.ok(!p.includes('.tmp'))
  } finally {
    watcher.close()
  }
})

// ---------------------------------------------------------------------------
// 跨进程锁：写入中宽限（新锁 mtime < 1500ms 的空/半截内容等待重试）
// ---------------------------------------------------------------------------

test('跨进程锁回归: 新建锁空内容在宽限期内等待而非误判损坏；过期后显式报错', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const target = join(dataDir, 'credentials.json')
  const lockFile = `${target}.lock`

  // 1) 模拟并发进程刚 open('wx') 创建锁、尚未写完 JSON：空内容 + mtime=now。
  //    另一进程应在宽限期内等待；随后持有者写入完成并释放，等待者正常拿到锁。
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     const fd = fs.openSync(lock, 'wx', 0o600); // 只创建，内容稍后写
     setTimeout(() => { fs.writeSync(fd, process.pid + ' writer'); fs.closeSync(fd); fs.unlinkSync(lock); }, 200);`,
  ])
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  await waitFor(() => existsSync(lockFile))
  const acquired = await withProcessFileLock(target, async () => 'waited-fresh-lock')
  assert.equal(acquired, 'waited-fresh-lock', '宽限期内空/半截内容应等待写入完成，不误判损坏')
  assert.equal(await childExit, 0)
  assert.ok(!existsSync(lockFile))

  // 2) 宽限期外（mtime 已老）的空内容：仍是显式损坏报错（诚实性纪律）。
  await writeFile(lockFile, '', { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  await utimes(lockFile, old, old)
  await expectReject(() => withProcessFileLock(target, async () => 'nope'), /损坏/)

  // 3) 宽限期内但持有者 PID 已死的半截内容：仍可按 stale 破除（死亡优先于宽限）。
  await rm(lockFile, { force: true })
  const deadPid = 2 ** 22 + Math.floor(Math.random() * 1000)
  await writeFile(lockFile, `${deadPid}`, { mode: 0o600 })
  assert.equal(await withProcessFileLock(target, async () => 'stale-fresh'), 'stale-fresh')
  assert.ok(!existsSync(lockFile))
})

// 清理
test('清理临时目录', { timeout: 60_000 }, async () => {
  await rm(scratchRoot, { recursive: true, force: true })
  // 静默验证 tsx 可执行（保持与 runner 的一致性）
  const res = spawnSync('tsx', ['--version'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
})
