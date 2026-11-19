/**
 * Regression tests for `LocalExecutionEnv` win32 target path resolution:
 *
 * - Reuses `@helmx/protocol`'s `normalizeTargetPath`: `/mnt/<drive>/...` (WSL mount view)
 *   and `/<drive>/...` (Git Bash drive root view) deterministically convert to `<DRIVE>:\...`
 *   and never resolve to `<DRIVE>:\mnt\<drive>\...`;
 * - Native Windows / UNC / relative paths preserve existing semantics;
 * - Drive-less POSIX roots (`/home`, `/d/..`, etc.) fail structurally with `'invalid'`
 *   without guessing via `access` fallback (errors are not `not_found`);
 * - File APIs and `exec` share the exact same resolution primitive (`absolutePath` / `readFile` / `exec`);
 * - `exec` failure diagnostics preserve both the original `options.cwd` and the resolved `cwd`;
 * - Explicit `posix` targets preserve host-independent POSIX lexical semantics (`/mnt/...` is literal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalExecutionEnv, resolveTargetPath } from '../src/daemon/local-env.js';

const win32Env = (cwd: string): LocalExecutionEnv => new LocalExecutionEnv({ cwd, platform: 'win32' });

// ---------------------------------------------------------------------------
// resolveTargetPath pure function (win32 target)
// ---------------------------------------------------------------------------

test('resolveTargetPath win32: deterministically converts /mnt/<drive> WSL mount paths without /mnt prefix duplication', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/c/Users/alice', 'win32'), { ok: true, value: 'C:\\Users\\alice' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/z/', 'win32'), { ok: true, value: 'Z:\\' });
  // Lexical normalization first: dot segments resolved, repeated separators collapsed, trailing slash stripped by resolve.
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d//a/./b/', 'win32'), { ok: true, value: 'D:\\a\\b' });
});

test('resolveTargetPath win32: deterministically converts /<drive> drive-root paths (Git Bash / MSYS)', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/d/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/C/x', 'win32'), { ok: true, value: 'C:\\x' });
});

test('resolveTargetPath win32: native Windows / UNC paths preserve lexical normalization and uppercase drive letters', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', 'c:\\Users\\a\\.', 'win32'), { ok: true, value: 'C:\\Users\\a' });
  assert.deepEqual(resolveTargetPath('/home/proj', 'D:/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '//srv/share/x', 'win32'), { ok: true, value: '\\\\srv\\share\\x' });
  assert.deepEqual(resolveTargetPath('/home/proj', '\\\\srv\\share\\x\\..\\y', 'win32'), { ok: true, value: '\\\\srv\\share\\y' });
});

test('resolveTargetPath win32: relative paths anchor to the session cwd normalized under the same rules', { timeout: 60_000 }, () => {
  // Session cwd is a POSIX view: convert to canonical Windows form before anchoring.
  assert.deepEqual(resolveTargetPath('/mnt/d/proj', 'src/main.ts', 'win32'), { ok: true, value: 'D:\\proj\\src\\main.ts' });
  assert.deepEqual(resolveTargetPath('/d/proj', '../out/x', 'win32'), { ok: true, value: 'D:\\out\\x' });
  // Session cwd is already native Windows form: anchor directly.
  assert.deepEqual(resolveTargetPath('D:\\proj', 'src\\main.ts', 'win32'), { ok: true, value: 'D:\\proj\\src\\main.ts' });
});

test('resolveTargetPath win32: drive-less POSIX roots fail explicitly without access fallback', { timeout: 60_000 }, () => {
  for (const p of ['/home/user', '/tmp/x', '/', '/mnt', '/mnt/cd/x', '/d/..']) {
    const r = resolveTargetPath('/mnt/d/proj', p, 'win32');
    assert.equal(r.ok, false, `expected rejection for: ${p}`);
    if (!r.ok) {
      assert.equal(r.error.code, 'invalid', `expected invalid (not probe not_found) for: ${p}`);
      assert.ok(r.error.message.includes(p), `failure reason must include original path: ${p}`);
      assert.equal(r.error.path, p);
    }
  }
});

// ---------------------------------------------------------------------------
// resolveTargetPath pure function (posix target: unchanged semantics)
// ---------------------------------------------------------------------------

test('resolveTargetPath posix: treats /mnt/... as a literal path and anchors relative paths with POSIX rules', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d/proj/x.ts', 'posix'), { ok: true, value: '/mnt/d/proj/x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/d/x', 'posix'), { ok: true, value: '/d/x' });
  assert.deepEqual(resolveTargetPath('/home/proj', 'src/main.ts', 'posix'), { ok: true, value: '/home/proj/src/main.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/home/user', 'posix'), { ok: true, value: '/home/user' });
});

// ---------------------------------------------------------------------------
// LocalExecutionEnv file API (win32 injected)
// ---------------------------------------------------------------------------

test('LocalExecutionEnv win32 file API: absolutePath shares resolveTargetPath primitive and results', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  assert.deepEqual(await env.absolutePath('/mnt/d/proj/src/x.ts'), { ok: true, value: 'D:\\proj\\src\\x.ts' });
  assert.deepEqual(await env.absolutePath('/d/x.ts'), { ok: true, value: 'D:\\x.ts' });
  assert.deepEqual(await env.absolutePath('c:\\Users\\a'), { ok: true, value: 'C:\\Users\\a' });
  assert.deepEqual(await env.absolutePath('rel/x.ts'), { ok: true, value: 'D:\\proj\\rel\\x.ts' });
  assert.deepEqual(await env.absolutePath('//srv/share/x'), { ok: true, value: '\\\\srv\\share\\x' });
});

test('LocalExecutionEnv win32 file API: rejects drive-less POSIX roots upfront without filesystem probing', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  // /home exists on Linux test hosts (/home/user may not): error must be parse-phase `invalid`
  // rather than probe-phase `not_found`, proving zero access fallback guessing.
  const r = await env.readTextFile('/home/user/secret.txt');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'invalid');
    assert.notEqual(r.error.code, 'not_found');
    assert.ok(r.error.message.includes('/home/user/secret.txt'));
  }
  const info = await env.fileInfo('/tmp');
  assert.equal(info.ok, false);
  if (!info.ok) assert.equal(info.error.code, 'invalid');
});

test('LocalExecutionEnv explicit POSIX platform: keeps POSIX semantics regardless of host OS', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: '/home/proj', platform: 'posix' });
  assert.deepEqual(await env.absolutePath('/mnt/d/proj/x.ts'), { ok: true, value: '/mnt/d/proj/x.ts' });
  assert.deepEqual(await env.absolutePath('src/main.ts'), { ok: true, value: '/home/proj/src/main.ts' });
  // On a posix target /home is valid and resolves lexically.
  const r = await env.absolutePath('/home/user/x');
  assert.deepEqual(r, { ok: true, value: '/home/user/x' });
});

// ---------------------------------------------------------------------------
// LocalExecutionEnv exec (win32 injected; resolution failure precedes spawn with zero side effects)
// ---------------------------------------------------------------------------

test('LocalExecutionEnv win32 exec: rejects drive-less POSIX root cwd and preserves raw options.cwd in diagnostics', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  const r = await env.exec('true', { cwd: '/home/user' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('/home/user'), 'diagnostics must preserve original options.cwd');
    assert.ok(r.error.message.includes('cannot determine a Windows drive correspondence'), 'diagnostics must include protocol unmappable_posix_root reason');
  }
});

test('LocalExecutionEnv win32 exec: resolves /mnt/<drive> cwd via shared primitive and logs both resolved and raw cwd on missing dir', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  // /mnt/q/... resolves to Q:\... (missing on Linux hosts): diagnostics on access failure
  // must preserve both the resolved cwd and raw options.cwd.
  const r = await env.exec('true', { cwd: '/mnt/q/definitely-missing' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('Q:\\definitely-missing'), 'diagnostics must include resolved cwd');
    assert.ok(r.error.message.includes('/mnt/q/definitely-missing'), 'diagnostics must include original options.cwd');
  }
});

test('LocalExecutionEnv win32 exec: normalizes session cwd POSIX views via the same primitive (fails if missing)', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/q/definitely-missing');
  const r = await env.exec('true', undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('Q:\\definitely-missing'));
    assert.ok(r.error.message.includes('/mnt/q/definitely-missing'));
  }
});
