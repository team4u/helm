import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getNodeServiceStatus, renderServiceSpec } from '../src/daemon/service.js'

test('systemd 参数分别转义引号、specifier 和环境展开', { timeout: 60_000 }, () => {
  const spec = renderServiceSpec({
    platform: 'linux', nodePath: '/usr/bin/node', cliEntryPath: '/opt/helm/cli.js',
    dataDir: '/tmp/中文 %h $HOME "quoted"', serviceHome: '/tmp/home',
  })
  assert.ok(spec.content.includes('%%h'), '百分号不能触发 systemd specifier')
  assert.ok(spec.content.includes('$$HOME'), '美元符号不能触发 systemd 环境展开')
  assert.ok(spec.content.includes('\\"quoted\\"'), '参数内引号必须转义')
  assert.throws(() => renderServiceSpec({ platform: 'linux', cliEntryPath: '/tmp/cli.js', dataDir: 'bad\nExecStart=/evil' }), /控制字符/)
})

test('Windows 注册使用任务计划 XML，参数不经过 cmd 展开', { timeout: 60_000 }, () => {
  const spec = renderServiceSpec({
    platform: 'win32', nodePath: 'C:\\Program Files\\node.exe', cliEntryPath: 'C:\\helm\\cli.js',
    dataDir: 'C:\\中文 %USERPROFILE% & $x\\', serviceHome: '/tmp/home',
  })
  assert.deepEqual(spec.installCmd, ['schtasks', '/Create', '/F', '/TN', 'HelmNode', '/XML', spec.targetPath])
  assert.match(spec.content, /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/)
  assert.match(spec.content, /<LogonType>InteractiveToken<\/LogonType>/)
  assert.match(spec.content, /<Command>C:\\Program Files\\node\.exe<\/Command>/)
  assert.ok(spec.content.includes('%USERPROFILE% &amp; $x'))
  assert.match(spec.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.equal(spec.installCmd.includes('/TR'), false)
})

test('Windows 安装状态以平台任务查询为准，查询失败明确为未知', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-service-proof-'))
  try {
    const options = { platform: 'win32' as const, serviceHome: join(dir, 'home') }
    const actual = await getNodeServiceStatus('/tmp/cli.js', dir, { ...options, execCommand: { run: async () => ({ code: 0, stdout: '"HelmNode","Running"', stderr: '' }) } })
    assert.equal(actual.installed, true, '没有本地 XML 副本也可有已注册的平台任务')
    assert.equal(actual.running, 'running')
    const failure = await getNodeServiceStatus('/tmp/cli.js', dir, { ...options, execCommand: { run: async () => ({ code: 1, stdout: '', stderr: 'Access is denied' }) } })
    assert.equal(failure.installed, null)
    assert.equal(failure.running, 'unknown')
    assert.match(failure.detail ?? '', /状态查询命令失败/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('launchctl 单任务字典中的 PID 表示真实运行状态', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-launchctl-proof-'))
  try {
    const status = await getNodeServiceStatus('/tmp/cli.js', dir, {
      platform: 'darwin', serviceHome: dir,
      execCommand: { run: async () => ({ code: 0, stdout: '{\n "Label" = "ai.helm.node";\n "PID" = 1234;\n}', stderr: '' }) },
    })
    assert.equal(status.installed, true)
    assert.equal(status.running, 'running')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
