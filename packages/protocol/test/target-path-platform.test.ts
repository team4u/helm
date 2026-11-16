/**
 * normalizeTargetPath target-platform path normalization tests (pure,
 * deterministic, zero probing):
 *
 * - win32 target: lexical normalization of native drive / UNC / mixed-separator
 *   shapes (drives unified to the canonical uppercase spelling), deterministic
 *   conversion of the /mnt/<drive> WSL mount view and the /<drive> drive-root
 *   view (trailing separator preserved, '.'/'..' resolved, empty tail landing on
 *   the drive root), the exactly-two-leading-slashes UNC view, and explicit
 *   structured failure (unmappable_posix_root) for drive-less POSIX roots
 *   (/home, /tmp, /mnt, /mnt/<non-single-letter>, '..' escaping the drive root)
 *   — never silent guessing;
 * - posix target: POSIX semantics kept as-is (lexical normalization only, never
 *   a reverse conversion of /mnt/<drive>).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTargetPath, targetPlatformOf } from '@helm/protocol'

describe('normalizeTargetPath win32 target: native Windows shape lexical normalization', () => {
  it('drive-absolute (including mixed separators and dot segments) normalizes to the backslash canonical form', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('C:\\a\\b', 'win32'), { ok: true, path: 'C:\\a\\b', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('C:/a\\b/./c', 'win32'), { ok: true, path: 'C:\\a\\b\\c', view: 'win32' })
  })

  it('drive-letter casing normalized: output is uniformly uppercase (Windows drive letters are case-insensitive)', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('c:\\x', 'win32'), { ok: true, path: 'C:\\x', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('c:/x', 'win32'), { ok: true, path: 'C:\\x', view: 'win32' })
  })

  it('root and trailing separator: drive root gains a backslash; a single trailing separator is preserved', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('C:/', 'win32'), { ok: true, path: 'C:\\', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('C:\\', 'win32'), { ok: true, path: 'C:\\', view: 'win32' })
    assert.deepEqual(normalizeTargetPath('C:/a/b/', 'win32'), { ok: true, path: 'C:\\a\\b\\', view: 'win32' })
  })

  it("UNC normalization: '..' does not escape the share root; input casing preserved", { timeout: 60_000 }, () => {
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

  it('relative paths (including drive-relative) get lexical normalization only, never absolutization', { timeout: 60_000 }, () => {
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

describe('normalizeTargetPath win32 target: exactly-two-leading-slashes UNC view', () => {
  it('//server/share/… normalized by the UNC lexical rules', { timeout: 60_000 }, () => {
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

  it('ambiguity resolution: //c/x is UNC (server=c share=x), diverging from the /c/x drive view', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//c/x', 'win32'), { ok: true, path: '\\\\c\\x\\', view: 'unc' })
    // Two leading slashes take UNC precedence even when the shape resembles a mount view (//mnt/c/x is not C:\x).
    assert.deepEqual(normalizeTargetPath('//mnt/c/x', 'win32'), {
      ok: true,
      path: '\\\\mnt\\c\\x',
      view: 'unc',
    })
  })

  it('incomplete UNC (no share) degrades to a root backslash (node:path win32 semantics)', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//server', 'win32'), { ok: true, path: '\\server', view: 'unc' })
  })

  it('three or more leading slashes are not a UNC view: first collapse to a single root, then drive detection', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('///mnt/c/x', 'win32'), {
      ok: true,
      path: 'C:\\x',
      view: 'wsl-mount',
    })
  })
})

describe('normalizeTargetPath win32 target: /mnt/<drive> WSL mount view', () => {
  it('deterministically converts to <uppercase drive>:\\…', { timeout: 60_000 }, () => {
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

  it('empty tail: the root of a drive view is <drive>:\\ (never a bare drive-relative <drive>:)', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c', 'win32'), { ok: true, path: 'C:\\', view: 'wsl-mount' })
    assert.deepEqual(normalizeTargetPath('/mnt/c/', 'win32'), { ok: true, path: 'C:\\', view: 'wsl-mount' })
  })

  it('lexical normalization first: repeated separators collapse, dot segments resolve, single trailing separator preserved', { timeout: 60_000 }, () => {
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

  it("'..' can move between drive roots (/mnt/c/../../mnt/d/x → D:\\x)", { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c/../../mnt/d/x', 'win32'), {
      ok: true,
      path: 'D:\\x',
      view: 'wsl-mount',
    })
  })

  it('escaping the drive root falls back to a drive-less POSIX root: explicit failure (/mnt/c/.. normalizes to /mnt)', { timeout: 60_000 }, () => {
    const r = normalizeTargetPath('/mnt/c/..', 'win32')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unmappable_posix_root')
  })
})

describe('normalizeTargetPath win32 target: /<drive> drive-root view (Git Bash / MSYS)', () => {
  it('deterministically converts to <uppercase drive>:\\… (including empty tails and trailing separators)', { timeout: 60_000 }, () => {
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

describe('normalizeTargetPath win32 target: drive-less POSIX roots fail explicitly in a structured way', () => {
  const rejects: string[] = [
    '/', '/home/user', '/tmp', '/var/log', '/usr', '/mnt', '/mnt/',
    '/mnt/cd/x', '/mnt/wslg/x', '/mnt/一/x', '/MNT/c/x', '/c/..', '/c/a/../..',
    // Backslashes mixed into the POSIX view: a backslash is an ordinary filename character, never guessed into a Windows separator.
    '/mnt/c\\a', '/c\\a',
  ]

  it('common Linux roots / non-single-letter segments / uppercase mount points / root escapes / mixed backslashes all rejected', { timeout: 60_000 }, () => {
    for (const p of rejects) {
      const r = normalizeTargetPath(p, 'win32')
      assert.equal(r.ok, false, `expected rejection: ${p}`)
      if (!r.ok) {
        assert.equal(r.code, 'unmappable_posix_root', `expected unmappable_posix_root: ${p}`)
        assert.ok(r.reason.length > 0, `failure must carry a readable reason: ${p}`)
        assert.ok(r.reason.includes(p), `failure reason must include the original path: ${p}`)
      }
    }
  })
})

describe('normalizeTargetPath win32 target: multiple spellings of one directory converge to one canonical form', () => {
  it('/c/x, /mnt/c/x, c:/x, C:\\x converge equivalently (removing the WSL/Windows cwd dual-view ambiguity)', { timeout: 60_000 }, () => {
    for (const p of ['/c/x', '/C/x', '/mnt/c/x', '/mnt/C/x', 'c:/x', 'C:/x', 'C:\\x', 'c:\\x']) {
      const r = normalizeTargetPath(p, 'win32')
      assert.ok(r.ok, `expected success: ${p}`)
      if (r.ok) assert.equal(r.path, 'C:\\x', `expected convergence to C:\\x: ${p}`)
    }
  })
})

describe('normalizeTargetPath posix target: POSIX semantics kept as-is', () => {
  it('the POSIX view is the real path: never a reverse conversion of /mnt/<drive> or /<drive>', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/mnt/c/Users/x', 'posix'), {
      ok: true,
      path: '/mnt/c/Users/x',
      view: 'posix',
    })
    assert.deepEqual(normalizeTargetPath('/c/x', 'posix'), { ok: true, path: '/c/x', view: 'posix' })
  })

  it('/home etc. are legal paths on a POSIX target and do not fail', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/home/user', 'posix'), {
      ok: true,
      path: '/home/user',
      view: 'posix',
    })
  })

  it('lexical normalization matches node:path posix (dot resolution, root-escape clamping, trailing separator, empty string)', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('/a/../..', 'posix'), { ok: true, path: '/', view: 'posix' })
    assert.deepEqual(normalizeTargetPath('/a/b/', 'posix'), { ok: true, path: '/a/b/', view: 'posix' })
    assert.deepEqual(normalizeTargetPath('', 'posix'), { ok: true, path: '.', view: 'posix' })
  })

  it('two leading slashes collapse to a single root per node posix semantics (diverging from the win32-target UNC view)', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('//srv/share/x', 'posix'), {
      ok: true,
      path: '/srv/share/x',
      view: 'posix',
    })
  })

  it('win32-shaped input is processed by POSIX rules on a POSIX target (backslash is an ordinary character)', { timeout: 60_000 }, () => {
    assert.deepEqual(normalizeTargetPath('C:\\x', 'posix'), { ok: true, path: 'C:\\x', view: 'posix' })
  })
})

describe('targetPlatformOf host platform normalization', () => {
  it('only win32 is special-cased; everything else is POSIX', { timeout: 60_000 }, () => {
    assert.equal(targetPlatformOf('win32'), 'win32')
    assert.equal(targetPlatformOf('linux'), 'posix')
    assert.equal(targetPlatformOf('darwin'), 'posix')
    assert.equal(targetPlatformOf(''), 'posix')
  })
})
