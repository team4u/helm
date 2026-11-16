/**
 * LocalExecutionEnv win32 target path parse regression:
 *
 * - unify re- use @helm/protocol normalizeTargetPath:/mnt/<symbol>/... (WSL mount view)
 *   and /<symbol>/... (Git Bash symbol view) determinism convert is <symbol>:\...,
 *   never again parse into <symbol>:\mnt\<symbol>\...;
 * - original generate Windows / UNC / relative path keep since has semantics;
 * - without symbol POSIX (/home,/d/.. etc.) explicit structure failed (code 'invalid'),
 *   zero access choose guess (error is not not_found i.e. verify not do probe fall back);
 * - file API and exec shared use the same parse original language (absolutePath / readFile / exec behavior consistent);
 * - exec failed diagnose also keep original options.cwd and parse after cwd;
 * - posix target use host without closure POSIX term method semantics (/mnt/... is real path, never reverse convert).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalExecutionEnv, resolveTargetPath } from '../src/daemon/local-env.js';

const win32Env = (cwd: string): LocalExecutionEnv => new LocalExecutionEnv({ cwd, platform: 'win32' });

// ---------------------------------------------------------------------------
// resolveTargetPath pure function (win32 target)
// ---------------------------------------------------------------------------

test('resolveTargetPath win32:/mnt/<symbol> WSL mount view determinism convert (no longer parse into <symbol>:\\mnt\\...)', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/c/Users/alice', 'win32'), { ok: true, value: 'C:\\Users\\alice' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/z/', 'win32'), { ok: true, value: 'Z:\\' });
  // term method archive one first row: point segment consume solve, duplicate isolate symbol collapse, tail isolate symbol eventually by resolve strip.
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d//a/./b/', 'win32'), { ok: true, value: 'D:\\a\\b' });
});

test('resolveTargetPath win32:/<symbol> symbol view (Git Bash / MSYS) determinism convert', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/d/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/C/x', 'win32'), { ok: true, value: 'C:\\x' });
});

test('resolveTargetPath win32: original generate Windows / UNC shape keep since has semantics (term method archive one, symbol large write)', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', 'c:\\Users\\a\\.', 'win32'), { ok: true, value: 'C:\\Users\\a' });
  assert.deepEqual(resolveTargetPath('/home/proj', 'D:/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '//srv/share/x', 'win32'), { ok: true, value: '\\\\srv\\share\\x' });
  assert.deepEqual(resolveTargetPath('/home/proj', '\\\\srv\\share\\x\\..\\y', 'win32'), { ok: true, value: '\\\\srv\\share\\y' });
});

test('resolveTargetPath win32: relative path anchor set to by the same rule specification conversation cwd', { timeout: 60_000 }, () => {
  // conversation cwd is POSIX view: first convert is specification Windows form again anchor set.
  assert.deepEqual(resolveTargetPath('/mnt/d/proj', 'src/main.ts', 'win32'), { ok: true, value: 'D:\\proj\\src\\main.ts' });
  assert.deepEqual(resolveTargetPath('/d/proj', '../out/x', 'win32'), { ok: true, value: 'D:\\out\\x' });
  // conversation cwd already is original generate Windows form: directly anchor set (since has semantics).
  assert.deepEqual(resolveTargetPath('D:\\proj', 'src\\main.ts', 'win32'), { ok: true, value: 'D:\\proj\\src\\main.ts' });
});

test('resolveTargetPath win32: without symbol POSIX explicit structure failed (does not access guess)', { timeout: 60_000 }, () => {
  for (const p of ['/home/user', '/tmp/x', '/', '/mnt', '/mnt/cd/x', '/d/..']) {
    const r = resolveTargetPath('/mnt/d/proj', p, 'win32');
    assert.equal(r.ok, false, `expectation reject:${p}`);
    if (!r.ok) {
      assert.equal(r.error.code, 'invalid', `expectation invalid(while non- probe produce not_found):${p}`);
      assert.ok(r.error.message.includes(p), `failed reason must contains original path:${p}`);
      assert.equal(r.error.path, p);
    }
  }
});

// ---------------------------------------------------------------------------
// resolveTargetPath pure function (posix target: behavior keep do not change)
// ---------------------------------------------------------------------------

test('resolveTargetPath posix:/mnt/... is real path, never reverse convert; relative path by POSIX rule anchor set', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d/proj/x.ts', 'posix'), { ok: true, value: '/mnt/d/proj/x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/d/x', 'posix'), { ok: true, value: '/d/x' });
  assert.deepEqual(resolveTargetPath('/home/proj', 'src/main.ts', 'posix'), { ok: true, value: '/home/proj/src/main.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/home/user', 'posix'), { ok: true, value: '/home/user' });
});

// ---------------------------------------------------------------------------
// LocalExecutionEnv file API(win32 inject)
// ---------------------------------------------------------------------------

test('LocalExecutionEnv win32 file API:absolutePath and resolveTargetPath the same original language, the same result', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  assert.deepEqual(await env.absolutePath('/mnt/d/proj/src/x.ts'), { ok: true, value: 'D:\\proj\\src\\x.ts' });
  assert.deepEqual(await env.absolutePath('/d/x.ts'), { ok: true, value: 'D:\\x.ts' });
  assert.deepEqual(await env.absolutePath('c:\\Users\\a'), { ok: true, value: 'C:\\Users\\a' });
  assert.deepEqual(await env.absolutePath('rel/x.ts'), { ok: true, value: 'D:\\proj\\rel\\x.ts' });
  assert.deepEqual(await env.absolutePath('//srv/share/x'), { ok: true, value: '\\\\srv\\share\\x' });
});

test('LocalExecutionEnv win32 file API: without symbol POSIX in entry explicit failed, does not file system probe', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  // /home under in Linux test machine on real store in (/home/user do not definitely): error must be parse phase
  // invalid while non- probe phase not_found / succeeded - - verify zero access choose guess.
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

test('LocalExecutionEnv explicit POSIX platform: host without closure ground keep POSIX semantics', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: '/home/proj', platform: 'posix' });
  assert.deepEqual(await env.absolutePath('/mnt/d/proj/x.ts'), { ok: true, value: '/mnt/d/proj/x.ts' });
  assert.deepEqual(await env.absolutePath('src/main.ts'), { ok: true, value: '/home/proj/src/main.ts' });
  // posix target on /home is legal path: parse succeeded (after continue fs result and parse without closure).
  const r = await env.absolutePath('/home/user/x');
  assert.deepEqual(r, { ok: true, value: '/home/user/x' });
});

// ---------------------------------------------------------------------------
// LocalExecutionEnv exec(win32 inject; failed to parse occur in spawn before, zero side effect)
// ---------------------------------------------------------------------------

test('LocalExecutionEnv win32 exec: without symbol POSIX  cwd explicit failed, diagnose keep original options.cwd', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  const r = await env.exec('true', { cwd: '/home/user' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('/home/user'), 'diagnose must keep original options.cwd');
    assert.ok(r.error.message.includes('cannot determine a Windows drive correspondence'), 'diagnose must carry protocol unmappable_posix_root reason');
  }
});

test('LocalExecutionEnv win32 exec:/mnt/<symbol> cwd via the same original language parse; missing when diagnose also contains parse after cwd and original options.cwd', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  // /mnt/q/... parse is Q:\... (in Linux test machine on must however missing):access failed path on
  // diagnose must also carry parse after cwd and original options.cwd.
  const r = await env.exec('true', { cwd: '/mnt/q/definitely-missing' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('Q:\\definitely-missing'), 'diagnose must contains parse after cwd');
    assert.ok(r.error.message.includes('/mnt/q/definitely-missing'), 'diagnose must contains original options.cwd');
  }
});

test('LocalExecutionEnv win32 exec: conversation cwd itself is POSIX view when via the same original language specification (missing i.e. explicit failed)', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/q/definitely-missing');
  const r = await env.exec('true', undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('Q:\\definitely-missing'));
    assert.ok(r.error.message.includes('/mnt/q/definitely-missing'));
  }
});
