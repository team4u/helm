/**
 * 产物 kind 契约与 COMPOSER_DOCK_SLOT 协议常量锁定测试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARTIFACT_KINDS,
  COMPOSER_DOCK_SLOT,
  COMPOSER_STATUS_SLOT,
  isArtifactKind,
  type ArtifactKind,
  type ArtifactMetadata,
} from '../src/index.js'

test('COMPOSER_DOCK_SLOT 与 COMPOSER_STATUS_SLOT 导出且遵循 builtin:composer/* 命名空间', { timeout: 60_000 }, () => {
  assert.equal(COMPOSER_STATUS_SLOT, 'builtin:composer/status')
  assert.equal(COMPOSER_DOCK_SLOT, 'builtin:composer/dock')
})

test('ArtifactKind / isArtifactKind / ArtifactMetadata.kind 必填契约', { timeout: 60_000 }, () => {
  assert.deepEqual([...ARTIFACT_KINDS], ['upload', 'registered', 'spill'])
  for (const kind of ['upload', 'registered', 'spill'] as const satisfies readonly ArtifactKind[]) {
    assert.equal(isArtifactKind(kind), true)
  }
  for (const bad of [undefined, null, '', 'other', 'UPLOAD', 1, {}, '__proto__']) {
    assert.equal(isArtifactKind(bad), false, `非法 kind ${String(bad)} 必须拒绝`)
  }
  const meta: ArtifactMetadata = {
    id: 'art-1',
    conversationId: 1,
    kind: 'upload',
    name: 'demo.txt',
    path: 'artifacts/1/demo.txt',
    mimeType: 'text/plain',
    size: 5,
    createdAt: 1000,
  }
  assert.equal(meta.kind, 'upload')
  // @ts-expect-error kind 为必填字段，不可省略
  const missingKind: ArtifactMetadata = {
    id: 'art-2',
    conversationId: 1,
    name: 'demo.txt',
    path: 'artifacts/1/demo.txt',
    mimeType: 'text/plain',
    size: 5,
    createdAt: 1000,
  }
  assert.ok(missingKind)
})
