/**
 * Hub produce product layer Web static directory parse policy test (by default probe self kernel migrate produce product layer after point).
 *
 * override:
 * - payload layout (<root>/hub/dist + <root>/web/dist/index.html) hit same level web;
 * - repository layout (src and dist same construct, all on trace two level) same hit;
 * - without index.html / without web directory → undefined(pure API form, does not pretend to be static site);
 * - HELM_WEB_DIST_DIR: explicit directory takes precedence,'false'/'0'/'' explicit disable, not settings away by default probe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHubWebDistDir, resolveWebDistOption } from '../src/web-dist.js';

test('payload layout:hub/dist entry probe to same level web/dist(has index.html)', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html><div id="root"></div>');
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), join(root, 'web', 'dist'));
    // src and dist same construct:hub/src entry same hit (repository development layout).
    mkdirSync(join(root, 'hub', 'src'), { recursive: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'src')), join(root, 'web', 'dist'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without index.html or without web directory:undefined(pure API, does not pretend to be static site)', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined, 'missing index.html must not enable');
    rmSync(join(root, 'web'), { recursive: true, force: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined, 'missing web directory must not enable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('by default directory probe encounters I/O fault explicit failed, do not fall back is pure API', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? 'create symlink must Windows developer pattern or manage member permission' : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    symlinkSync('index.html', join(root, 'web', 'dist', 'index.html'));
    assert.throws(
      () => resolveHubWebDistDir(join(root, 'hub', 'dist')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ELOOP',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HELM_WEB_DIST_DIR: explicit directory takes precedence, disable literal explicit close, not settings away by default probe', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html>');
    const entry = join(root, 'hub', 'dist');
    assert.deepEqual(resolveWebDistOption('/custom/dist', entry), { webDistDir: '/custom/dist' });
    assert.deepEqual(resolveWebDistOption('false', entry), { webDistDir: false });
    assert.deepEqual(resolveWebDistOption('0', entry), { webDistDir: false });
    assert.deepEqual(resolveWebDistOption('', entry), { webDistDir: false });
    assert.deepEqual(resolveWebDistOption(undefined, entry), { webDistDir: join(root, 'web', 'dist') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
