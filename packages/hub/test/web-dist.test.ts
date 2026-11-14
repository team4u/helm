/**
 * Hub 产品层 Web 静态目录解析策略测试（默认探测自 kernel 迁入产品层后的落点）。
 *
 * 覆盖：
 * - payload 布局（<root>/hub/dist + <root>/web/dist/index.html）命中同级 web；
 * - 仓库布局（src 与 dist 同构，均上溯两级）同样命中；
 * - 无 index.html / 无 web 目录 → undefined（纯 API 形态，不伪装静态站点）；
 * - HELM_WEB_DIST_DIR：显式目录优先、'false'/'0'/'' 显式禁用、未设置走默认探测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHubWebDistDir, resolveWebDistOption } from '../src/web-dist.js';

test('payload 布局：hub/dist 入口探测到同级 web/dist（有 index.html）', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html><div id="root"></div>');
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), join(root, 'web', 'dist'));
    // src 与 dist 同构：hub/src 入口同样命中（仓库开发布局）。
    mkdirSync(join(root, 'hub', 'src'), { recursive: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'src')), join(root, 'web', 'dist'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无 index.html 或无 web 目录：undefined（纯 API，不伪装静态站点）', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-webdist-'));
  try {
    mkdirSync(join(root, 'hub', 'dist'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined, '缺 index.html 不得启用');
    rmSync(join(root, 'web'), { recursive: true, force: true });
    assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined, '缺 web 目录不得启用');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('默认目录探测遇到 I/O 故障显式失败，不降级为纯 API', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? '创建符号链接需 Windows 开发者模式或管理员权限' : false,
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

test('HELM_WEB_DIST_DIR：显式目录优先，禁用字面量显式关闭，未设置走默认探测', { timeout: 60_000 }, () => {
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
