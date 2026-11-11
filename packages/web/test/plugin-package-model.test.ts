/**
 * 插件包管理纯函数模型测试 (plugin-package-model)
 *
 * 覆盖：
 * 1. 安装来源识别：npm spec / git ref / HTTPS Git URL / 本地绝对与相对路径 / 未识别；
 * 2. 受管来源徽章与展示文本；
 * 3. doctor 结构化检查结果的条目化与结论文案；
 * 4. HTTP 错误诊断文案（409 在途任务、普通错误、非 Error 值）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginDoctorReport, PluginPackageSource } from '@helm/protocol'
import {
  buildDoctorCheckItems,
  buildDoctorConclusion,
  detectPluginSourceKind,
  extractDoctorReport,
  formatInstalledAt,
  isGitSource,
  isInstallSourceSubmittable,
  isLocalSource,
  isNpmSource,
  pluginPackageErrorText,
  pluginSourceBadgeLabel,
  pluginSourceDisplayText,
} from '../src/plugins/plugin-package-model.js'
import { ApiClientError } from '../src/lib/api.js'

// ---------------------------------------------------------------------------
// 1. 安装来源识别
// ---------------------------------------------------------------------------

test('detectPluginSourceKind：npm 说明符识别（scoped / 范围 / 精确版本）', { timeout: 60_000 }, () => {
  assert.deepEqual(detectPluginSourceKind('npm:@scope/pkg@1.0.0'), { kind: 'npm', label: 'npm 包' })
  assert.deepEqual(detectPluginSourceKind('npm:helm-plugin-foo@^1.2.0'), { kind: 'npm', label: 'npm 包' })
  assert.deepEqual(detectPluginSourceKind('  npm:plain-pkg  '), { kind: 'npm', label: 'npm 包' })
  assert.equal(isNpmSource('npm:pkg'), true)
  assert.equal(isNpmSource('npm:'), false, 'npm: 后无内容不识别')
  assert.equal(isNpmSource('npmx:pkg'), false, '前缀必须精确为 npm:')
})

test('detectPluginSourceKind：git 来源识别（git repo/ref 与 HTTPS Git URL）', { timeout: 60_000 }, () => {
  assert.deepEqual(detectPluginSourceKind('git:https://github.com/user/repo.git@dev'), { kind: 'git', label: 'Git 仓库' })
  assert.deepEqual(detectPluginSourceKind('https://github.com/user/helm-plugin-foo.git'), { kind: 'git', label: 'Git 仓库' })
  assert.deepEqual(detectPluginSourceKind('https://github.com/user/repo'), { kind: 'git', label: 'Git 仓库' })
  assert.deepEqual(detectPluginSourceKind('https://github.com/user/repo.git#v2.1.0'), { kind: 'git', label: 'Git 仓库' })
  assert.equal(isGitSource('git:user/repo@main'), true)
  assert.equal(isGitSource('git:user/repo'), true, 'git: 可省略 ref，使用远端默认分支')
  assert.equal(isGitSource('https://example.com/just-a-page'), true, 'HTTPS Git URL 可省略 .git 与 ref，由服务端校验仓库')
})

test('detectPluginSourceKind：本地路径识别（POSIX 绝对 / Windows / UNC / 相对）', { timeout: 60_000 }, () => {
  assert.deepEqual(detectPluginSourceKind('/root/plugins/foo'), { kind: 'local', label: '本地路径' })
  assert.deepEqual(detectPluginSourceKind('C:\\plugins\\foo'), { kind: 'local', label: '本地路径' })
  assert.deepEqual(detectPluginSourceKind('./relative/plugin'), { kind: 'local', label: '本地路径' })
  assert.deepEqual(detectPluginSourceKind('../sibling/plugin'), { kind: 'local', label: '本地路径' })
  assert.equal(isLocalSource('plugins/foo'), false, '裸相对名不识别（避免误判普通 npm 包名）')
})

test('detectPluginSourceKind：空串与未识别输入', { timeout: 60_000 }, () => {
  assert.deepEqual(detectPluginSourceKind(''), { kind: 'unknown', label: '' })
  assert.deepEqual(detectPluginSourceKind('not-a-source'), { kind: 'unknown', label: '无法识别' })
})

test('isInstallSourceSubmittable：仅三类已识别来源可提交', { timeout: 60_000 }, () => {
  assert.equal(isInstallSourceSubmittable('npm:pkg@1.0.0'), true)
  assert.equal(isInstallSourceSubmittable('git:https://x.git@main'), true)
  assert.equal(isInstallSourceSubmittable('/abs/path'), true)
  assert.equal(isInstallSourceSubmittable('garbage'), false)
  assert.equal(isInstallSourceSubmittable(''), false)
})

// ---------------------------------------------------------------------------
// 2. 受管来源展示推导
// ---------------------------------------------------------------------------

const npmSource: PluginPackageSource = { kind: 'npm', raw: 'npm:pkg@1.0.0', spec: 'pkg@1.0.0' }
const gitSource: PluginPackageSource = {
  kind: 'git',
  raw: 'git:https://github.com/u/r.git@dev',
  repo: 'https://github.com/u/r.git',
  ref: 'dev',
}
const localSource: PluginPackageSource = { kind: 'local', raw: '/abs/path', path: '/abs/path' }

test('pluginSourceBadgeLabel / pluginSourceDisplayText：徽章短标签与原文回显', { timeout: 60_000 }, () => {
  assert.equal(pluginSourceBadgeLabel(npmSource), 'npm')
  assert.equal(pluginSourceBadgeLabel(gitSource), 'git')
  assert.equal(pluginSourceBadgeLabel(localSource), '本地')
  assert.equal(pluginSourceDisplayText(npmSource), 'npm:pkg@1.0.0')
  assert.equal(pluginSourceDisplayText(gitSource), 'git:https://github.com/u/r.git@dev')
})

test('formatInstalledAt：合法 epoch 毫秒返回本地时间串，非法值回退空串', { timeout: 60_000 }, () => {
  assert.equal(formatInstalledAt(0), '')
  assert.equal(formatInstalledAt(Number.NaN), '')
  assert.equal(formatInstalledAt(-5), '')
  const text = formatInstalledAt(Date.UTC(2026, 0, 15, 8, 30, 0))
  assert.ok(text.length > 0, '合法时间戳必须生成非空时间文本')
  assert.match(text, /2026/)
})

// ---------------------------------------------------------------------------
// 3. doctor 结构化检查结果
// ---------------------------------------------------------------------------

const doctorReport: PluginDoctorReport = {
  dir: '/plugins/foo',
  requestedId: 'foo',
  ok: false,
  checks: [
    { id: 'manifest', label: '清单检查' },
    { id: 'backend', label: '后端加载', error: { code: 'entry_missing', message: 'dist/index.js 不存在' } },
    { id: 'register', label: '真实注册', error: { code: 'define_invalid', message: 'definePlugin 返回形状不合法' } },
  ],
}

test('buildDoctorCheckItems：逐项条目化并保持服务端顺序', { timeout: 60_000 }, () => {
  const items = buildDoctorCheckItems(doctorReport)
  assert.equal(items.length, 3)
  assert.deepEqual(
    items.map((i) => i.id),
    ['manifest', 'backend', 'register'],
  )
  assert.equal(items[0]?.ok, true)
  assert.equal(items[0]?.errorText, '')
  assert.equal(items[1]?.ok, false)
  assert.equal(items[1]?.errorText, 'entry_missing: dist/index.js 不存在')
})

test('buildDoctorConclusion：失败项汇总与全部通过文案', { timeout: 60_000 }, () => {
  const conclusion = buildDoctorConclusion(doctorReport)
  assert.match(conclusion, /2 项失败/)
  assert.match(conclusion, /entry_missing/)
  assert.match(conclusion, /define_invalid/)

  const okReport: PluginDoctorReport = {
    dir: '/plugins/foo',
    ok: true,
    checks: [{ id: 'manifest', label: '清单检查' }],
  }
  assert.equal(buildDoctorConclusion(okReport), '安装前自检通过')
})

// ---------------------------------------------------------------------------
// 4. HTTP 错误诊断文案
// ---------------------------------------------------------------------------

test('pluginPackageErrorText：409 在途任务给出明确指引', { timeout: 60_000 }, () => {
  const err = new ApiClientError('plugin_has_live_tasks', 'Plugin has live tasks', 409)
  const text = pluginPackageErrorText(err, '卸载')
  assert.match(text, /卸载失败/)
  assert.match(text, /plugin_has_live_tasks/)
  assert.match(text, /在途任务/)
})

test('pluginPackageErrorText：普通错误与非 Error 值如实回显', { timeout: 60_000 }, () => {
  assert.match(pluginPackageErrorText(new Error('boom'), '更新'), /更新失败：boom/)
  assert.match(pluginPackageErrorText('strange', '安装'), /安装失败/)
})

// ---------------------------------------------------------------------------
// 5. 安装失败时的 doctor 报告提取（真实 Hub 错误形状）
// ---------------------------------------------------------------------------

test('extractDoctorReport：从 ApiClientError.details.report 提取真实 Hub 422 形状报告', { timeout: 60_000 }, () => {
  // 真实 Hub：HelmError('plugin_package_doctor_failed', …, 422, { source, staging, report })
  // 经 HTTP 错误信封 { error: { code, message, details } } 到达 ApiClientError.details.report
  const err = new ApiClientError(
    'plugin_package_doctor_failed',
    '插件包安装预检失败（后端加载：dist/index.js 不存在），已放弃安装',
    422,
    {
      source: { kind: 'local', raw: '/plugins/foo', path: '/plugins/foo' },
      staging: '/data/plugins/.staging/xxx',
      report: {
        dir: '/data/plugins/.staging/xxx',
        requestedId: undefined,
        ok: false,
        checks: [
          { id: 'manifest', label: '清单检查' },
          { id: 'backend', label: '后端加载', error: { code: 'entry_missing', message: 'dist/index.js 不存在' } },
        ],
      },
    },
  )
  const report = extractDoctorReport(err)
  assert.ok(report, 'details.report 中存在合法报告时必须提取成功')
  assert.equal(report.ok, false)
  assert.equal(report.checks.length, 2)
  assert.equal(report.checks[1]?.error?.code, 'entry_missing')
})

test('extractDoctorReport：兼容 details.doctor 与 err.doctor 旧形状，均需形状合法', { timeout: 60_000 }, () => {
  const valid = { dir: '/p', ok: true, checks: [{ id: 'manifest', label: '清单检查' }] }
  const viaDetailsDoctor = new ApiClientError('x', 'x', 422, { doctor: valid })
  assert.ok(extractDoctorReport(viaDetailsDoctor))

  const plain = { doctor: valid } as unknown
  assert.ok(extractDoctorReport(plain))
})

test('extractDoctorReport：形状不合法时返回 null，绝不伪造', { timeout: 60_000 }, () => {
  // 缺 dir / ok 非布尔 / checks 非数组 / error 缺 code —— 全部拒绝
  assert.equal(extractDoctorReport(new ApiClientError('x', 'x', 422, { report: { ok: false } })), null)
  assert.equal(
    extractDoctorReport(new ApiClientError('x', 'x', 422, { report: { dir: '/p', ok: 'yes', checks: [] } })),
    null,
  )
  assert.equal(
    extractDoctorReport(new ApiClientError('x', 'x', 422, { report: { dir: '/p', ok: true, checks: 'nope' } })),
    null,
  )
  assert.equal(
    extractDoctorReport(
      new ApiClientError('x', 'x', 422, {
        report: { dir: '/p', ok: false, checks: [{ id: 'm', label: '清单', error: { code: 1, message: 'x' } }] },
      }),
    ),
    null,
  )
  // 无 details 的普通错误 / 非 ApiClientError 形状
  assert.equal(extractDoctorReport(new Error('plain')), null)
  assert.equal(extractDoctorReport(null), null)
  assert.equal(extractDoctorReport(undefined), null)
  // details.report 为数组或其他非对象值同样拒绝
  assert.equal(extractDoctorReport(new ApiClientError('x', 'x', 422, { report: [1, 2] })), null)
})
