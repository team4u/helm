/**
 * LocalExecutionEnv win32 目标路径解析回归：
 *
 * - 统一复用 @helm/protocol normalizeTargetPath：/mnt/<盘符>/…（WSL 挂载视图）
 *   与 /<盘符>/…（Git Bash 盘符根视图）确定性转换为 <盘符>:\…，
 *   绝不再解析成 <盘符>:\mnt\<盘符>\…；
 * - 原生 Windows / UNC / 相对路径保持既有语义；
 * - 无盘符 POSIX 根（/home、/d/.. 等）显式结构化失败（code 'invalid'），
 *   零 access 候选猜测（错误不是 not_found 即证明未做探测回退）；
 * - file API 与 exec 共用同一解析原语（absolutePath / readFile / exec 行为一致）；
 * - exec 失败诊断同时保留原始 options.cwd 与解析后 cwd；
 * - posix 目标行为保持不变（/mnt/… 是真实路径，绝不反向转换）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalExecutionEnv, resolveTargetPath } from '../src/daemon/local-env.js';

const win32Env = (cwd: string): LocalExecutionEnv => new LocalExecutionEnv({ cwd, platform: 'win32' });

// ---------------------------------------------------------------------------
// resolveTargetPath 纯函数（win32 目标）
// ---------------------------------------------------------------------------

test('resolveTargetPath win32：/mnt/<盘符> WSL 挂载视图确定性转换（不再解析成 <盘符>:\\mnt\\…）', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/c/Users/alice', 'win32'), { ok: true, value: 'C:\\Users\\alice' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/z/', 'win32'), { ok: true, value: 'Z:\\' });
  // 词法归一先行：点段消解、重复分隔符折叠、结尾分隔符最终被 resolve 剥离。
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d//a/./b/', 'win32'), { ok: true, value: 'D:\\a\\b' });
});

test('resolveTargetPath win32：/<盘符> 盘符根视图（Git Bash / MSYS）确定性转换', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/d/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/C/x', 'win32'), { ok: true, value: 'C:\\x' });
});

test('resolveTargetPath win32：原生 Windows / UNC 形状保持既有语义（词法归一、盘符大写）', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', 'c:\\Users\\a\\.', 'win32'), { ok: true, value: 'C:\\Users\\a' });
  assert.deepEqual(resolveTargetPath('/home/proj', 'D:/proj/x.ts', 'win32'), { ok: true, value: 'D:\\proj\\x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '//srv/share/x', 'win32'), { ok: true, value: '\\\\srv\\share\\x' });
  assert.deepEqual(resolveTargetPath('/home/proj', '\\\\srv\\share\\x\\..\\y', 'win32'), { ok: true, value: '\\\\srv\\share\\y' });
});

test('resolveTargetPath win32：相对路径锚定到按同一规则规范化的会话 cwd', { timeout: 60_000 }, () => {
  // 会话 cwd 是 POSIX 视图：先转换为规范 Windows 形式再锚定。
  assert.deepEqual(resolveTargetPath('/mnt/d/proj', 'src/main.ts', 'win32'), { ok: true, value: 'D:\\proj\\src\\main.ts' });
  assert.deepEqual(resolveTargetPath('/d/proj', '../out/x', 'win32'), { ok: true, value: 'D:\\out\\x' });
  // 会话 cwd 已是原生 Windows 形式：直接锚定（既有语义）。
  assert.deepEqual(resolveTargetPath('D:\\proj', 'src\\main.ts', 'win32'), { ok: true, value: 'D:\\proj\\src\\main.ts' });
});

test('resolveTargetPath win32：无盘符 POSIX 根显式结构化失败（不做 access 猜测）', { timeout: 60_000 }, () => {
  for (const p of ['/home/user', '/tmp/x', '/', '/mnt', '/mnt/cd/x', '/d/..']) {
    const r = resolveTargetPath('/mnt/d/proj', p, 'win32');
    assert.equal(r.ok, false, `期望拒绝：${p}`);
    if (!r.ok) {
      assert.equal(r.error.code, 'invalid', `期望 invalid（而非探测产生的 not_found）：${p}`);
      assert.ok(r.error.message.includes(p), `失败原因须含原始路径：${p}`);
      assert.equal(r.error.path, p);
    }
  }
});

// ---------------------------------------------------------------------------
// resolveTargetPath 纯函数（posix 目标：行为保持不变）
// ---------------------------------------------------------------------------

test('resolveTargetPath posix：/mnt/… 是真实路径，绝不反向转换；相对路径按宿主 resolve 锚定', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetPath('/home/proj', '/mnt/d/proj/x.ts', 'posix'), { ok: true, value: '/mnt/d/proj/x.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/d/x', 'posix'), { ok: true, value: '/d/x' });
  assert.deepEqual(resolveTargetPath('/home/proj', 'src/main.ts', 'posix'), { ok: true, value: '/home/proj/src/main.ts' });
  assert.deepEqual(resolveTargetPath('/home/proj', '/home/user', 'posix'), { ok: true, value: '/home/user' });
});

// ---------------------------------------------------------------------------
// LocalExecutionEnv file API（win32 注入）
// ---------------------------------------------------------------------------

test('LocalExecutionEnv win32 file API：absolutePath 与 resolveTargetPath 同一原语、同一结果', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  assert.deepEqual(await env.absolutePath('/mnt/d/proj/src/x.ts'), { ok: true, value: 'D:\\proj\\src\\x.ts' });
  assert.deepEqual(await env.absolutePath('/d/x.ts'), { ok: true, value: 'D:\\x.ts' });
  assert.deepEqual(await env.absolutePath('c:\\Users\\a'), { ok: true, value: 'C:\\Users\\a' });
  assert.deepEqual(await env.absolutePath('rel/x.ts'), { ok: true, value: 'D:\\proj\\rel\\x.ts' });
  assert.deepEqual(await env.absolutePath('//srv/share/x'), { ok: true, value: '\\\\srv\\share\\x' });
});

test('LocalExecutionEnv win32 file API：无盘符 POSIX 根在入口显式失败，不做文件系统探测', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  // /home 下在 Linux 测试机上真实存在（/home/user 不一定）：错误必须是解析期
  // invalid 而非探测期 not_found / 成功——证明零 access 候选猜测。
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

test('LocalExecutionEnv 默认平台（posix 宿主）：行为保持不变', { timeout: 60_000 }, async () => {
  const env = new LocalExecutionEnv({ cwd: '/home/proj' });
  assert.deepEqual(await env.absolutePath('/mnt/d/proj/x.ts'), { ok: true, value: '/mnt/d/proj/x.ts' });
  assert.deepEqual(await env.absolutePath('src/main.ts'), { ok: true, value: '/home/proj/src/main.ts' });
  // posix 目标上 /home 是合法路径：解析成功（后续 fs 结果与解析无关）。
  const r = await env.absolutePath('/home/user/x');
  assert.deepEqual(r, { ok: true, value: '/home/user/x' });
});

// ---------------------------------------------------------------------------
// LocalExecutionEnv exec（win32 注入；解析失败发生在 spawn 之前，零副作用）
// ---------------------------------------------------------------------------

test('LocalExecutionEnv win32 exec：无盘符 POSIX 根 cwd 显式失败，诊断保留原始 options.cwd', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  const r = await env.exec('true', { cwd: '/home/user' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('/home/user'), '诊断须保留原始 options.cwd');
    assert.ok(r.error.message.includes('无法确定'), '诊断须携带 protocol 的 unmappable_posix_root 原因');
  }
});

test('LocalExecutionEnv win32 exec：/mnt/<盘符> cwd 经同一原语解析；不存在时诊断同时含解析后 cwd 与原始 options.cwd', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/d/proj');
  // /mnt/q/… 解析为 Q:\…（在 Linux 测试机上必然不存在）：access 失败路径上
  // 诊断必须同时携带解析后 cwd 与原始 options.cwd。
  const r = await env.exec('true', { cwd: '/mnt/q/definitely-missing' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('Q:\\definitely-missing'), '诊断须含解析后 cwd');
    assert.ok(r.error.message.includes('/mnt/q/definitely-missing'), '诊断须含原始 options.cwd');
  }
});

test('LocalExecutionEnv win32 exec：会话 cwd 本身是 POSIX 视图时经同一原语规范化（缺失即显式失败）', { timeout: 60_000 }, async () => {
  const env = win32Env('/mnt/q/definitely-missing');
  const r = await env.exec('true', undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'spawn_error');
    assert.ok(r.error.message.includes('Q:\\definitely-missing'));
    assert.ok(r.error.message.includes('/mnt/q/definitely-missing'));
  }
});
