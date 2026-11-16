/**
 * sanitizedHostEnv contract test: lock host carry managed HELM_* variable when, test child process
 * environment base bottom must strip except all managed variable, keep ordinary variable, and do not change process.env
 * semantics. this is packages/node test in Helm hosting host environment (bash etc. managed tool day however
 * inject HELM_* execute environment) under stable via before mention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { HOST_MANAGED_HELM_ENV_NAMES, sanitizedHostEnv } from './helpers/sanitized-env.js';

/** in process.env on temporary write variable and in test after end precise restore (contains originally not set key). */
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

test('host hold has all managed HELM_* variable when,sanitizedHostEnv strip except after leaves no residue any managed variable', { timeout: 60_000 }, () => {
  const fixture: Record<string, string> = {};
  for (const name of HOST_MANAGED_HELM_ENV_NAMES) fixture[name] = `host-managed-${name.toLowerCase()}`;
  let result: NodeJS.ProcessEnv | undefined;
  withEnv(fixture, () => {
    result = sanitizedHostEnv();
    // process.env itself do not by assist manually change
    for (const name of HOST_MANAGED_HELM_ENV_NAMES) {
      assert.equal(process.env[name], fixture[name], `assist manually must not change process.env  ${name}`);
    }
  });
  assert.ok(result !== undefined);
  for (const name of HOST_MANAGED_HELM_ENV_NAMES) {
    assert.equal(name in result, false, `managed variable ${name} must by strip except`);
    assert.equal(result[name], undefined, `managed variable ${name} must not leftover value`);
  }
});

test('sanitizedHostEnv keep ordinary variable (PATH etc. local machine tool chain) and each time return independent copy', { timeout: 60_000 }, () => {
  const a = sanitizedHostEnv();
  const b = sanitizedHostEnv();
  assert.notEqual(a, b, 'each time invoke return independent copy, caller can security override');
  assert.equal(a['PATH'] ?? a['Path'], process.env['PATH'] ?? process.env['Path'], 'PATH must keep');
  if (process.env['HOME'] !== undefined) assert.equal(a['HOME'], process.env['HOME'], 'HOME must keep');
  a['TEST_ONLY_MUTATION'] = 'x';
  assert.equal(b['TEST_ONLY_MUTATION'], undefined, 'copy between mutual does not affect');
  delete a['TEST_ONLY_MUTATION'];
});

test('managed variable large small write change body same strip except (Windows env name large small write do not sensitive semantics)', { timeout: 60_000 }, () => {
  // only set change body name, do not and canonical name and use (Windows on process.env large small write do not sensitive,
  // same name change body essence is the same slot;Linux on is independent key, two kinds of platform all must by strip except).
  const variants = { helm_token: 'lower-host-token', Helm_Hub_Url: 'mixed-host-url', helm_node_instance_id: 'lower-instance' };
  let result: NodeJS.ProcessEnv | undefined;
  withEnv(variants, () => {
    result = sanitizedHostEnv();
  });
  assert.ok(result !== undefined);
  for (const key of Object.keys(variants)) {
    assert.equal(key in result, false, `large small write change body ${key} must by strip except`);
  }
});

test('test explicit override takes precedence: with sanitizedHostEnv is base bottom expand after override managed variable by test value takes effect', { timeout: 60_000 }, () => {
  const fixture = { HELM_HUB_URL: 'http://host-real-hub:3202', HELM_VERSION_OVERRIDE: 'host-9.9.9' };
  let composed: NodeJS.ProcessEnv | undefined;
  withEnv(fixture, () => {
    // and test inside real use method consistent: base bottom expand after override fixture explicit value
    composed = { ...sanitizedHostEnv(), HELM_HUB_URL: 'http://127.0.0.1:fixture', HELM_VERSION_OVERRIDE: '0.1.0' };
  });
  assert.ok(composed !== undefined);
  assert.equal(composed['HELM_HUB_URL'], 'http://127.0.0.1:fixture', 'test explicit HELM_HUB_URL must takes effect');
  assert.equal(composed['HELM_VERSION_OVERRIDE'], '0.1.0', 'test explicit HELM_VERSION_OVERRIDE must takes effect');
});
