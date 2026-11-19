import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { useTempDir } from '@helmx/test-kit/node'
import { getNodeServiceStatus, renderServiceSpec } from '../src/daemon/service.js'

test('systemd args individually escape quotes, specifiers, and env expansion', { timeout: 60_000 }, () => {
  const spec = renderServiceSpec({
    platform: 'linux', nodePath: '/usr/bin/node', cliEntryPath: '/opt/helmx/cli.js',
    dataDir: '/tmp/中文 %h $HOME "quoted"', serviceHome: '/tmp/home',
  })
  assert.ok(spec.content.includes('%%h'), 'percent sign must not trigger systemd specifier expansion')
  assert.ok(spec.content.includes('$$HOME'), 'dollar sign must not trigger systemd environment expansion')
  assert.ok(spec.content.includes('\\"quoted\\"'), 'quotes inside argument must be escaped')
  assert.throws(() => renderServiceSpec({ platform: 'linux', cliEntryPath: '/tmp/cli.js', dataDir: 'bad\nExecStart=/evil' }), /control character/)
})

test('Windows registration uses Task Scheduler XML so args skip cmd expansion', { timeout: 60_000 }, () => {
  const spec = renderServiceSpec({
    platform: 'win32', nodePath: 'C:\\Program Files\\node.exe', cliEntryPath: 'C:\\helmx\\cli.js',
    dataDir: 'C:\\中文 %USERPROFILE% & $x\\', serviceHome: '/tmp/home',
  })
  assert.deepEqual(spec.installCmd, ['schtasks', '/Create', '/F', '/TN', 'HelmxNode', '/XML', spec.targetPath])
  assert.match(spec.content, /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/)
  assert.match(spec.content, /<LogonType>InteractiveToken<\/LogonType>/)
  assert.match(spec.content, /<Command>C:\\Program Files\\node\.exe<\/Command>/)
  assert.ok(spec.content.includes('%USERPROFILE% &amp; $x'))
  assert.match(spec.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.equal(spec.installCmd.includes('/TR'), false)
})

test('Windows install status follows platform task query and reports unknown on query failure', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-service-proof-')
  const options = { platform: 'win32' as const, serviceHome: join(dir, 'home') }
  const actual = await getNodeServiceStatus('/tmp/cli.js', dir, { ...options, execCommand: { run: async () => ({ code: 0, stdout: '"HelmxNode","Running"', stderr: '' }) } })
  assert.equal(actual.installed, true, 'a registered platform task can exist without a local XML copy')
  assert.equal(actual.running, 'running')
  const failure = await getNodeServiceStatus('/tmp/cli.js', dir, { ...options, execCommand: { run: async () => ({ code: 1, stdout: '', stderr: 'Access is denied' }) } })
  assert.equal(failure.installed, null)
  assert.equal(failure.running, 'unknown')
  assert.match(failure.detail ?? '', /status query command failed/)
})

test('Windows service queries recognize localized status and missing-task messages', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-service-localized-')
  const cases = [
    { code: 0, stdout: '"HelmxNode","正在运行"', stderr: '', installed: true, running: 'running' },
    { code: 0, stdout: '"HelmxNode","就绪"', stderr: '', installed: true, running: 'stopped' },
    { code: 1, stdout: '', stderr: '错误: 系统找不到指定的文件。', installed: false, running: 'unknown' },
    { code: 1, stdout: '', stderr: '错误: 指定的任务不存在。', installed: false, running: 'unknown' },
  ] as const
  for (const sample of cases) {
    const status = await getNodeServiceStatus('/tmp/cli.js', dir, {
      platform: 'win32', serviceHome: dir,
      execCommand: { run: async () => ({ code: sample.code, stdout: sample.stdout, stderr: sample.stderr }) },
    })
    assert.equal(status.installed, sample.installed)
    assert.equal(status.running, sample.running)
  }
})

test('PID in launchctl single-task dictionary indicates actual running state', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-launchctl-proof-')
  const status = await getNodeServiceStatus('/tmp/cli.js', dir, {
    platform: 'darwin', serviceHome: dir,
    execCommand: { run: async () => ({ code: 0, stdout: '{\n "Label" = "ai.helmx.node";\n "PID" = 1234;\n}', stderr: '' }) },
  })
  assert.equal(status.installed, true)
  assert.equal(status.running, 'running')
})
