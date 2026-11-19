/**
 * Contract tests for `sanitizedHostEnv`: ensures that when the host carries
 * managed `HELMX_*` variables, the test child-process baseline strips every managed
 * variable, preserves ordinary variables, and never mutates `process.env`.
 * This keeps `packages/node` tests stable even inside a Helmx-managed host shell.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { HOST_MANAGED_HELMX_ENV_NAMES, sanitizedHostEnv } from './helpers/sanitized-env.js';

/** Temporarily set keys on `process.env` and restore exact prior values (including unset keys) afterward. */
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

test('sanitizedHostEnv leaves no managed HELMX_* variables when host defines all of them', { timeout: 60_000 }, () => {
  const fixture: Record<string, string> = {};
  for (const name of HOST_MANAGED_HELMX_ENV_NAMES) fixture[name] = `host-managed-${name.toLowerCase()}`;
  let result: NodeJS.ProcessEnv | undefined;
  withEnv(fixture, () => {
    result = sanitizedHostEnv();
    // Helper must not mutate process.env itself
    for (const name of HOST_MANAGED_HELMX_ENV_NAMES) {
      assert.equal(process.env[name], fixture[name], `helper must not mutate process.env.${name}`);
    }
  });
  assert.ok(result !== undefined);
  for (const name of HOST_MANAGED_HELMX_ENV_NAMES) {
    assert.equal(name in result, false, `managed variable ${name} must be stripped`);
    assert.equal(result[name], undefined, `managed variable ${name} must have no remaining value`);
  }
});

test('sanitizedHostEnv preserves ordinary variables like PATH and returns an independent copy each call', { timeout: 60_000 }, () => {
  const a = sanitizedHostEnv();
  const b = sanitizedHostEnv();
  assert.notEqual(a, b, 'each call should return an independent copy safe for callers to mutate');
  assert.equal(a['PATH'] ?? a['Path'], process.env['PATH'] ?? process.env['Path'], 'PATH must be preserved');
  if (process.env['HOME'] !== undefined) assert.equal(a['HOME'], process.env['HOME'], 'HOME must be preserved');
  a['TEST_ONLY_MUTATION'] = 'x';
  assert.equal(b['TEST_ONLY_MUTATION'], undefined, 'mutations must not leak across copies');
  delete a['TEST_ONLY_MUTATION'];
});

test('sanitizedHostEnv strips case variants of managed variables (Windows case-insensitive env semantics)', { timeout: 60_000 }, () => {
  // Set only variant names without canonical names (on Windows process.env is case-insensitive,
  // whereas on Linux they are distinct keys; both platforms must strip them).
  const variants = { helmx_token: 'lower-host-token', Helmx_Hub_Url: 'mixed-host-url', helmx_node_instance_id: 'lower-instance' };
  let result: NodeJS.ProcessEnv | undefined;
  withEnv(variants, () => {
    result = sanitizedHostEnv();
  });
  assert.ok(result !== undefined);
  for (const key of Object.keys(variants)) {
    assert.equal(key in result, false, `case variant ${key} must be stripped`);
  }
});

test('explicit test overrides take precedence over sanitizedHostEnv baseline', { timeout: 60_000 }, () => {
  const fixture = { HELMX_HUB_URL: 'http://host-real-hub:3202', HELMX_VERSION_OVERRIDE: 'host-9.9.9' };
  let composed: NodeJS.ProcessEnv | undefined;
  withEnv(fixture, () => {
    // Spread sanitizedHostEnv baseline first, then apply explicit test overrides
    composed = { ...sanitizedHostEnv(), HELMX_HUB_URL: 'http://127.0.0.1:fixture', HELMX_VERSION_OVERRIDE: '0.1.0' };
  });
  assert.ok(composed !== undefined);
  assert.equal(composed['HELMX_HUB_URL'], 'http://127.0.0.1:fixture', 'explicit test HELMX_HUB_URL must take effect');
  assert.equal(composed['HELMX_VERSION_OVERRIDE'], '0.1.0', 'explicit test HELMX_VERSION_OVERRIDE must take effect');
});
