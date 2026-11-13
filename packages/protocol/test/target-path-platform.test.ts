/**
 * normalizeTargetPath 目标平台路径规范化测试（纯函数、确定性、零探测）：
 *
 * - win32 目标：原生盘符 / UNC / 混合分隔符词法归一（盘符统一大写规范拼写）、
 *   /mnt/<盘符> WSL 挂载视图与 /<盘符> 盘符根视图的确定性转换（结尾分隔符
 *   保留、'.'/'..' 消解、空尾落到盘符根）、恰两前导斜杠的 UNC 视图、无盘符
 *   POSIX 根（/home、/tmp、/mnt、/mnt/<非单字母>、越出盘符根的 '..'）显式
 *   结构化失败（unmappable_posix_root），绝不静默猜测；
 * - posix 目标：POSIX 语义原样保持（仅词法归一，绝不反向转换 /mnt/<盘符>）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTargetPath, targetPlatformOf } from '@helm/protocol'

describe('normalizeTargetPath win32 目标：原生 Windows 形状词法归一', () => {
  it('盘符绝对（含混合分隔符与点段）归一为反斜杠规范形', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('C:\\a\\b', 'win32'), { ok: true, path: 'C:\\a\\b', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('C:/a\\b/./c', 'win32'), { ok: true, path: 'C:\\a\\b\\c', view: 'win32' })
  })

  it('盘符大小写规范化：输出统一大写（Windows 盘符大小写不敏感）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('c:\\x', 'win32'), { ok: true, path: 'C:\\x', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('c:/x', 'win32'), { ok: true, path: 'C:\\x', view: 'win32' })
  })

  it('根与结尾分隔符：盘符根补反斜杠、单个结尾分隔符保留', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('C:/', 'win32'), { ok: true, path: 'C:\\', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('C:\\', 'win32'), { ok: true, path: 'C:\\', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('C:/a/b/', 'win32'), { ok: true, path: 'C:\\a\\b\\', view: 'win32' })
  })

  it("UNC 归一：'..' 不越 share 根、保留输入大小写", { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('\\\\Srv\\Share\\x', 'win32'), {
      ok: true,
      path: '\\\\Srv\\Share\\x',
      view: 'win32',
    })
    assert.deepEqual(normalizeTargetPath('\\\\srv\\share\\..\\a', 'win32'), {
      ok: true,
      path: '\\\\srv\\share\\a',
      view: 'win32',
    })
  })

  it('相对路径（含盘符相对）只做词法归一，不绝对化', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('a/b/./c', 'win32'), { ok: true, path: 'a\\b\\c', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('', 'win32'), { ok: true, path: '.', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('..', 'win32'), { ok: true, path: '..', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('c:relative/./x', 'win32'), {
      ok: true,
      path: 'C:relative\\x',
      view: 'win32',
    })
    assert.deepEqual(normalizeTargetPath('C:', 'win32'), { ok: true, path: 'C:.', view: 'win32' })
  })
})

describe('normalizeTargetPath win32 目标：恰两前导斜杠的 UNC 视图', () => {
  it('//server/share/… 按 UNC 词法归一', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//srv/share/x', 'win32'), {
      ok: true,
      path: '\\\\srv\\share\\x',
      view: 'unc',
    })
    assert.deepEqual(normalizeTargetPath('//srv/share', 'win32'), {
      ok: true,
      path: '\\\\srv\\share\\',
      view: 'unc',
    })
  })

  it('歧义消解：//c/x 按 UNC（server=c share=x），与 /c/x 盘符视图分道', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//c/x', 'win32'), { ok: true, path: '\\\\c\\x\\', view: 'unc' })
    // 两前导斜杠优先按 UNC，即使形状酷似挂载视图（//mnt/c/x 不是 C:\x）。
    assert.deepEqual(normalizeTargetPath('//mnt/c/x', 'win32'), {
      ok: true,
      path: '\\\\mnt\\c\\x',
      view: 'unc',
    })
  })

  it('不完整 UNC（无 share）退化为根反斜杠（node:path win32 语义）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//server', 'win32'), { ok: true, path: '\\server', view: 'unc' })
  })

  it('三斜杠及以上不是 UNC 视图：先归一为单根再走盘符判定', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('///mnt/c/x', 'win32'), {
      ok: true,
      path: 'C:\\x',
      view: 'wsl-mount',
    })
  })
})

describe('normalizeTargetPath win32 目标：/mnt/<盘符> WSL 挂载视图', () => {
  it('确定性转换为 <大写盘符>:\\…', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c/Users/alice/p', 'win32'), {
      ok: true,
      path: 'C:\\Users\\alice\\p',
      view: 'wsl-mount',
    })
    assert.deepEqual(normalizeTargetPath('/mnt/z/tmp', 'win32'), {
      ok: true,
      path: 'Z:\\tmp',
      view: 'wsl-mount',
    })
    assert.deepEqual(normalizeTargetPath('/mnt/C/x', 'win32'), {
      ok: true,
      path: 'C:\\x',
      view: 'wsl-mount',
    })
  })

  it('空尾：盘符视图的根是 <盘符>:\\（绝不产出盘符相对的裸 <盘符>:）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c', 'win32'), { ok: true, path: 'C:\\', view: 'wsl-mount' })
    assert.deepEqual(normalizeTargetPath('/mnt/c/', 'win32'), { ok: true, path: 'C:\\', view: 'wsl-mount' })
  })

  it('词法归一先行：重复分隔符折叠、点段消解、单个结尾分隔符保留', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c//x//', 'win32'), {
      ok: true,
      path: 'C:\\x\\',
      view: 'wsl-mount',
    })
    assert.deepEqual(normalizeTargetPath('/mnt/c/./x/../y', 'win32'), {
      ok: true,
      path: 'C:\\y',
      view: 'wsl-mount',
    })
    assert.deepEqual(normalizeTargetPath('/mnt/c/Users/x/', 'win32'), {
      ok: true,
      path: 'C:\\Users\\x\\',
      view: 'wsl-mount',
    })
  })

  it("'..' 可在盘符根之间移动（/mnt/c/../../mnt/d/x → D:\\x）", { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c/../../mnt/d/x', 'win32'), {
      ok: true,
      path: 'D:\\x',
      view: 'wsl-mount',
    })
  })

  it('越出盘符根落回无盘符 POSIX 根：显式失败（/mnt/c/.. 归一为 /mnt）', { timeout: 60_000 }, () => {
    const r = normalizeTargetPath('/mnt/c/..', 'win32')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unmappable_posix_root')
  })
})

describe('normalizeTargetPath win32 目标：/<盘符> 盘符根视图（Git Bash / MSYS）', () => {
  it('确定性转换为 <大写盘符>:\\…（含空尾与结尾分隔符）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/c', 'win32'), { ok: true, path: 'C:\\', view: 'drive' })
    assert.deepEqual(normalizeTargetPath('/c/', 'win32'), { ok: true, path: 'C:\\', view: 'drive' })
    assert.deepEqual(normalizeTargetPath('/c/Users/x', 'win32'), {
      ok: true,
      path: 'C:\\Users\\x',
      view: 'drive',
    })
    assert.deepEqual(normalizeTargetPath('/C/x', 'win32'), { ok: true, path: 'C:\\x', view: 'drive' })
    assert.deepEqual(normalizeTargetPath('/q', 'win32'), { ok: true, path: 'Q:\\', view: 'drive' })
  })
})

describe('normalizeTargetPath win32 目标：无盘符 POSIX 根显式结构化失败', () => {
  const rejects: string[] = [
    '/', '/home/user', '/tmp', '/var/log', '/usr', '/mnt', '/mnt/',
    '/mnt/cd/x', '/mnt/wslg/x', '/mnt/一/x', '/MNT/c/x', '/c/..', '/c/a/../..',
    // POSIX 视图内混入反斜杠：反斜杠是普通文件名字符，绝不猜测成 Windows 分隔符。
    '/mnt/c\\a', '/c\\a',
  ]

  it('常见 Linux 根 / 非单字母段 / 大写挂载点 / 越根 / 混入反斜杠均拒绝', { timeout: 60_000 }, () => {
    for (const p of rejects) {
      const r = normalizeTargetPath(p, 'win32')
      assert.equal(r.ok, false, `期望拒绝：${p}`)
      if (!r.ok) {
        assert.equal(r.code, 'unmappable_posix_root', `期望 unmappable_posix_root：${p}`)
        assert.ok(r.reason.length > 0, `失败必须携带可读原因：${p}`)
        assert.ok(r.reason.includes(p), `失败原因须含原始路径：${p}`)
      }
    }
  })
})

describe('normalizeTargetPath win32 目标：同一目录的多种拼写到同一规范形', () => {
  it('/c/x、/mnt/c/x、c:/x、C:\\x 等价收敛（消除 WSL/Windows cwd 双视图歧义）', { timeout: 60_000 }, () => {
    for (const p of ['/c/x', '/C/x', '/mnt/c/x', '/mnt/C/x', 'c:/x', 'C:/x', 'C:\\x', 'c:\\x']) {
      const r = normalizeTargetPath(p, 'win32')
      assert.ok(r.ok, `期望成功：${p}`)
      if (r.ok) assert.equal(r.path, 'C:\\x', `期望收敛到 C:\\x：${p}`)
    }
  })
})

describe('normalizeTargetPath posix 目标：POSIX 语义原样保持', () => {
  it('POSIX 视图是真实路径：绝不反向转换 /mnt/<盘符> 与 /<盘符>', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c/Users/x', 'posix'), {
      ok: true,
      path: '/mnt/c/Users/x',
      view: 'posix',
    })
    assert.deepEqual(normalizeTargetPath('/c/x', 'posix'), { ok: true, path: '/c/x', view: 'posix' })
  })

  it('/home 等在 POSIX 目标上是合法路径，不失败', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/home/user', 'posix'), {
      ok: true,
      path: '/home/user',
      view: 'posix',
    })
  })

  it('词法归一与 node:path posix 一致（点段消解、越根钳制、结尾分隔符保留、空串）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/a/../..', 'posix'), { ok: true, path: '/', view: 'posix' })
    assert.deepEqual(normalizeTargetPath('/a/b/', 'posix'), { ok: true, path: '/a/b/', view: 'posix' })
    assert.deepEqual(normalizeTargetPath('', 'posix'), { ok: true, path: '.', view: 'posix' })
  })

  it('双前导斜杠按 node posix 语义折叠为单根（与 win32 目标的 UNC 视图分道）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//srv/share/x', 'posix'), {
      ok: true,
      path: '/srv/share/x',
      view: 'posix',
    })
  })

  it('win32 形状输入在 POSIX 目标上按 POSIX 规则处理（反斜杠是普通字符）', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('C:\\x', 'posix'), { ok: true, path: 'C:\\x', view: 'posix' })
  })
})

describe('targetPlatformOf 宿主平台归一', () => {
  it('仅 win32 特判，其余一切按 POSIX', { timeout: 60_000 }, () => {
    assert.equal(targetPlatformOf('win32'), 'win32')
    assert.equal(targetPlatformOf('linux'), 'posix')
    assert.equal(targetPlatformOf('darwin'), 'posix')
    assert.equal(targetPlatformOf(''), 'posix')
  })
})
