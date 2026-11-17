/**
 * Tests for the Hub product layer's Web static directory resolution policy.
 *
 * Covers:
 * - Payload layout (`<root>/hub/dist` + `<root>/web/dist/index.html`) resolves sibling `web/dist`;
 * - Repository layout (`src` and `dist` isomorphic, stepping two levels up) resolves likewise;
 * - Missing `index.html` or missing `web` directory -> `undefined` (API-only mode, never pretends to be a static site);
 * - `HELM_WEB_DIST_DIR`: explicit path takes precedence; `'false'` / `'0'` / `''` disables static hosting; unset falls back to default probing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHubWebDistDir, resolveWebDistOption } from '../src/web-dist.js';

test('payload layout: hub/dist probes sibling web/dist when index.html exists', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html><div id="root"></div>');
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), join(root, 'web', 'dist'));
    // Isomorphic src and dist: hub/src also hits the same web/dist (repo dev layout).
    mkdirSync(join(root, 'hub', 'src'), { recursive: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'src')), join(root, 'web', 'dist'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing index.html or web directory returns undefined (API-only, never poses as static site)', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined, 'missing index.html must not enable static hosting');
    rmSync(join(root, 'web'), { recursive: true, force: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined, 'missing web directory must not enable static hosting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default directory probe fails explicitly on I/O error instead of falling back to API-only', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? 'creating symlinks requires Windows Developer Mode or admin privileges' : false,
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

test('HELM_WEB_DIST_DIR: explicit path takes precedence, disable literals turn off static hosting, unset falls back to default probe', { timeout: 60_000 }, () => {
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
