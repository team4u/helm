/**
 * sanitizedHostEnv 契约测试：锁定「宿主携带受管 HELM_* 变量时，测试子进程
 * 环境基底必须剥除全部受管变量、保留普通变量、且不改动 process.env」的
 * 语义。这是 packages/node 测试在 Helm 托管宿主环境（bash 等受管工具天然
 * 注入 HELM_* 执行环境）下稳定通过的前提。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { HOST_MANAGED_HELM_ENV_NAMES, sanitizedHostEnv } from './helpers/sanitized-env.js';

/** 在 process.env 上临时写入变量并在测试结束后精确还原（含原本未设的键）。 */
function withEnv(vars: Record<string, string>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('宿主持有全部受管 HELM_* 变量时，sanitizedHostEnv 剥除后不残留任何受管变量', { timeout: 60_000 }, () => {
  const fixture: Record<string, string> = {};
  for (const name of HOST_MANAGED_HELM_ENV_NAMES) fixture[name] = `host-managed-${name.toLowerCase()}`;
  let result: NodeJS.ProcessEnv | undefined;
  withEnv(fixture, () => {
    result = sanitizedHostEnv();
    // process.env 本身不被助手改动
    for (const name of HOST_MANAGED_HELM_ENV_NAMES) {
      assert.equal(process.env[name], fixture[name], `助手不得改动 process.env 的 ${name}`);
    }
  });
  assert.ok(result !== undefined);
  for (const name of HOST_MANAGED_HELM_ENV_NAMES) {
    assert.equal(name in result, false, `受管变量 ${name} 必须被剥除`);
    assert.equal(result[name], undefined, `受管变量 ${name} 不得残留值`);
  }
});

test('sanitizedHostEnv 保留普通变量（PATH 等本机工具链）且每次返回独立副本', { timeout: 60_000 }, () => {
  const a = sanitizedHostEnv();
  const b = sanitizedHostEnv();
  assert.notEqual(a, b, '每次调用返回独立副本，调用方可安全覆盖');
  assert.equal(a['PATH'] ?? a['Path'], process.env['PATH'] ?? process.env['Path'], 'PATH 必须保留');
  if (process.env['HOME'] !== undefined) assert.equal(a['HOME'], process.env['HOME'], 'HOME 必须保留');
  a['TEST_ONLY_MUTATION'] = 'x';
  assert.equal(b['TEST_ONLY_MUTATION'], undefined, '副本之间互不影响');
  delete a['TEST_ONLY_MUTATION'];
});

test('受管变量大小写变体同样剥除（Windows env 名大小写不敏感语义）', { timeout: 60_000 }, () => {
  // 仅设变体名，不与 canonical 名并用（Windows 上 process.env 大小写不敏感，
  // 同名变体本质是同一槽位；Linux 上为独立键，两种平台都必须被剥除）。
  const variants = { helm_token: 'lower-host-token', Helm_Hub_Url: 'mixed-host-url', helm_node_instance_id: 'lower-instance' };
  let result: NodeJS.ProcessEnv | undefined;
  withEnv(variants, () => {
    result = sanitizedHostEnv();
  });
  assert.ok(result !== undefined);
  for (const key of Object.keys(variants)) {
    assert.equal(key in result, false, `大小写变体 ${key} 必须被剥除`);
  }
});

test('测试显式覆盖优先：以 sanitizedHostEnv 为基底展开后覆盖受管变量按测试值生效', { timeout: 60_000 }, () => {
  const fixture = { HELM_HUB_URL: 'http://host-real-hub:3202', HELM_VERSION_OVERRIDE: 'host-9.9.9' };
  let composed: NodeJS.ProcessEnv | undefined;
  withEnv(fixture, () => {
    // 与测试内真实用法一致：基底展开之后覆盖 fixture 显式值
    composed = { ...sanitizedHostEnv(), HELM_HUB_URL: 'http://127.0.0.1:fixture', HELM_VERSION_OVERRIDE: '0.1.0' };
  });
  assert.ok(composed !== undefined);
  assert.equal(composed['HELM_HUB_URL'], 'http://127.0.0.1:fixture', '测试显式 HELM_HUB_URL 必须生效');
  assert.equal(composed['HELM_VERSION_OVERRIDE'], '0.1.0', '测试显式 HELM_VERSION_OVERRIDE 必须生效');
});
