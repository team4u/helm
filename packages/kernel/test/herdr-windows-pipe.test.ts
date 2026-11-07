/**
 * Windows 本机 Herdr 直连 Named Pipe 换算回归（返修缺陷确定性复现）。
 *
 * 缺陷：transport.callLocal / subscribeLocal 直接 net.connect(socketPath)——
 * Windows 上该路径是 marker 文件而非 Unix socket，必定连接失败；
 * LocalNodeChannel.ipcCall 硬编码 'unix-socket' 同样忽略 pipe 形态。
 *
 * 修复契约：
 * - Windows 形状路径（盘符/UNC）先确认 marker 文件存在（缺失 herdr_unreachable），
 *   再换算 `\\.\pipe\` 命名管道连接（绝不 connect marker 文件本身）；
 * - 纯路径形状判定（isWindowsShapedPath / endpointKindOf），不依赖进程平台；
 * - LocalNodeChannel.ipcCall 按 endpoint 形态自动选择 named-pipe / unix-socket；
 * - POSIX 路径行为不变（仍直连 UDS）。
 *
 * Linux 测试环境无法真实连接 Windows Named Pipe，验证边界为：
 * 换算函数纯逻辑 + marker 缺失显式报错 + POSIX 路径不受影响。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHerdrTransport,
  isWindowsShapedPath,
  HerdrTransportError,
} from '../src/builtin-plugins/herdr/transport.js'
import { endpointKindOf, windowsPipeNameOf } from '../src/builtin-plugins/herdr/local-node-channel.js'

// ---------------------------------------------------------------------------
// 纯函数：路径形态与 pipe 名换算
// ---------------------------------------------------------------------------

test('windowsPipeNameOf：marker 路径换算为 \\.\pipe\ 前缀（冒号/斜杠原样保留）', { timeout: 60_000 }, () => {
  assert.equal(windowsPipeNameOf('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock'), '\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock')
  // 正斜杠统一为反斜杠（herdr 路径展示可能带正斜杠）
  assert.equal(
    windowsPipeNameOf('C:/Users/me/AppData/Roaming/herdr/herdr.sock'),
    '\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock',
  )
  // UNC 形态 marker
  assert.equal(windowsPipeNameOf('\\\\srv\\share\\herdr\\herdr.sock'), '\\\\.\\pipe\\\\\\srv\\share\\herdr\\herdr.sock'.replaceAll('\\\\\\\\', '\\\\'))
  // 已是完整 pipe 路径原样返回
  assert.equal(windowsPipeNameOf('\\\\.\\pipe\\herdr-test'), '\\\\.\\pipe\\herdr-test')
  assert.equal(windowsPipeNameOf('\\\\HOST\\pipe\\herdr'), '\\\\HOST\\pipe\\herdr')
})

test('endpointKindOf：Windows 形状与完整 pipe 路径判 named-pipe，POSIX 判 unix-socket', { timeout: 60_000 }, () => {
  assert.equal(endpointKindOf('C:\\Users\\me\\herdr.sock'), 'named-pipe')
  assert.equal(endpointKindOf('C:/herdr.sock'), 'named-pipe')
  assert.equal(endpointKindOf('\\\\srv\\share\\herdr.sock'), 'named-pipe')
  assert.equal(endpointKindOf('\\\\.\\pipe\\herdr'), 'named-pipe')
  assert.equal(endpointKindOf('\\\\HOST\\pipe\\herdr'), 'named-pipe')
  assert.equal(endpointKindOf('/tmp/herdr.sock'), 'unix-socket')
  assert.equal(endpointKindOf('/home/u/.config/herdr/herdr.sock'), 'unix-socket')
  assert.equal(endpointKindOf('relative/herdr.sock'), 'unix-socket')
})

test('isWindowsShapedPath：盘符/UNC 判 true，POSIX 判 false', { timeout: 60_000 }, () => {
  assert.equal(isWindowsShapedPath('C:\\a'), true)
  assert.equal(isWindowsShapedPath('D:/a'), true)
  assert.equal(isWindowsShapedPath('\\\\srv\\share'), true)
  assert.equal(isWindowsShapedPath('/posix'), false)
  assert.equal(isWindowsShapedPath('posix'), false)
})

// ---------------------------------------------------------------------------
// transport：Windows marker 缺失显式 herdr_unreachable（不 connect marker 文件）
// ---------------------------------------------------------------------------

test('callLocal：Windows 形状路径 marker 缺失显式 herdr_unreachable（绝不 connect marker 文件）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-winpipe-'))
  try {
    const transport = createHerdrTransport()
    // 不存在 marker 文件：Linux 进程下 connect(Windows路径) 会产生奇怪错误；
    // 修复后应在 stat 阶段显式 herdr_unreachable，错误信息含 marker 路径。
    await assert.rejects(
      transport.call(
        { socketPath: `C:\\Users\\helm-test\\nonexistent\\herdr\\herdr.sock` },
        'session.snapshot',
        {},
        { timeoutMs: 2_000 },
      ),
      (err: unknown) => {
        assert.ok(err instanceof HerdrTransportError, `应为 HerdrTransportError（实际 ${typeof err}）`)
        assert.equal(err.code, 'herdr_unreachable')
        assert.ok(err.message.includes('herdr.sock'), '错误信息应含 marker 路径')
        return true
      },
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('callLocal：Windows 形状路径 marker 存在时走 pipe 连接（Linux 上连接失败但仍不 connect 文件）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-winpipe-'))
  try {
    // marker 文件存在（内容不限）：修复后应尝试连接 \\.\pipe\...（Linux 上
    // 必然 ENOENT 失败），错误是 socket/连接层错误而非把 marker 当 socket
    // 成功连接（marker 是普通文件，connect 会得到 ECONNREFUSED 类错误）。
    const markerPath = join(dataDir, 'C-marker.tmp')
    writeFileSync(markerPath, 'pid:1234')
    // 用正斜杠 Windows 形状（Linux 进程也能 stat）
    const windowsShaped = `C:${markerPath.slice(1)}`.replaceAll('/', '\\')
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.call({ socketPath: windowsShaped }, 'session.snapshot', {}, { timeoutMs: 2_000 }),
      (err: unknown) => {
        // 连接失败（Linux 无 named pipe）：不应是 herdr_unreachable（marker 存在），
        // 也不应把 marker 文件连接成功当作协议响应。
        assert.ok(err instanceof HerdrTransportError, `应为 HerdrTransportError（实际 ${typeof err}）`)
        assert.notEqual(err.code, 'herdr_unreachable')
        assert.ok(
          err.code === 'herdr_socket' || err.code === 'herdr_timeout' || err.code === 'herdr_disconnected',
          `连接层错误码（实际 ${err.code}）`,
        )
        return true
      },
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('subscribeLocal：Windows 形状路径 marker 缺失显式 herdr_unreachable', { timeout: 60_000 }, async () => {
  const transport = createHerdrTransport()
  await assert.rejects(
    transport.subscribe(
      { socketPath: 'Z:\\definitely\\missing\\herdr.sock' },
      () => {},
      () => {},
      {},
    ),
    (err: unknown) => {
      assert.ok(err instanceof HerdrTransportError)
      assert.equal(err.code, 'herdr_unreachable')
      return true
    },
  )
})

test('POSIX 路径行为不变：UDS 不存在仍是连接层错误（非 herdr_unreachable）', { timeout: 60_000 }, async () => {
  const transport = createHerdrTransport()
  await assert.rejects(
    transport.call({ socketPath: '/tmp/helm-nonexistent-test/herdr.sock' }, 'session.snapshot', {}, { timeoutMs: 2_000 }),
    (err: unknown) => {
      assert.ok(err instanceof HerdrTransportError)
      assert.notEqual(err.code, 'herdr_unreachable')
      return true
    },
  )
})
