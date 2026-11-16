import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { useTempDir } from '@helm/test-kit/node'
import { getNodeServiceStatus, renderServiceSpec } from '../src/daemon/service.js'

test('systemd parameter respectively escaping quotes,specifier and environment expand', { timeout: 60_000 }, () => {
  const spec = renderServiceSpec({
    platform: 'linux', nodePath: '/usr/bin/node', cliEntryPath: '/opt/helm/cli.js',
    dataDir: '/tmp/Chinese %h $HOME "quoted"', serviceHome: '/tmp/home',
  })
  assert.ok(spec.content.includes('%%h'), 'hundred number cannot trigger systemd specifier')
  assert.ok(spec.content.includes('$$HOME'), 'dollar symbol cannot trigger systemd environment expand')
  assert.ok(spec.content.includes('\\"quoted\\"'), 'parameter inside quotes must escaping')
  assert.throws(() => renderServiceSpec({ platform: 'linux', cliEntryPath: '/tmp/cli.js', dataDir: 'bad\nExecStart=/evil' }), /control character/)
})

test('Windows register use task plan XML, parameter without going through cmd expand', { timeout: 60_000 }, () => {
  const spec = renderServiceSpec({
    platform: 'win32', nodePath: 'C:\\Program Files\\node.exe', cliEntryPath: 'C:\\helm\\cli.js',
    dataDir: 'C:\\Chinese %USERPROFILE% & $x\\', serviceHome: '/tmp/home',
  })
  assert.deepEqual(spec.installCmd, ['schtasks', '/Create', '/F', '/TN', 'HelmNode', '/XML', spec.targetPath])
  assert.match(spec.content, /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/)
  assert.match(spec.content, /<LogonType>InteractiveToken<\/LogonType>/)
  assert.match(spec.content, /<Command>C:\\Program Files\\node\.exe<\/Command>/)
  assert.ok(spec.content.includes('%USERPROFILE% &amp; $x'))
  assert.match(spec.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.equal(spec.installCmd.includes('/TR'), false)
})

test('Windows install state with platform task query is allow, query failed explicit is unknown', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-service-proof-')
  const options = { platform: 'win32' as const, serviceHome: join(dir, 'home') }
  const actual = await getNodeServiceStatus('/tmp/cli.js', dir, { ...options, execCommand: { run: async () => ({ code: 0, stdout: '"HelmNode","Running"', stderr: '' }) } })
  assert.equal(actual.installed, true, 'no local XML copy also can has registered platform task')
  assert.equal(actual.running, 'running')
  const failure = await getNodeServiceStatus('/tmp/cli.js', dir, { ...options, execCommand: { run: async () => ({ code: 1, stdout: '', stderr: 'Access is denied' }) } })
  assert.equal(failure.installed, null)
  assert.equal(failure.running, 'unknown')
  assert.match(failure.detail ?? '', /state query command failed/)
})

test('launchctl single task dictionary in PID means real run state', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-launchctl-proof-')
  const status = await getNodeServiceStatus('/tmp/cli.js', dir, {
    platform: 'darwin', serviceHome: dir,
    execCommand: { run: async () => ({ code: 0, stdout: '{\n "Label" = "ai.helm.node";\n "PID" = 1234;\n}', stderr: '' }) },
  })
  assert.equal(status.installed, true)
  assert.equal(status.running, 'running')
})
