/**
 * Artifact kind contract and host-reserved slot protocol constant lock tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARTIFACT_KINDS,
  COMPOSER_DOCK_SLOT,
  COMPOSER_STATUS_SLOT,
  OVERVIEW_CARD_META_SLOT,
  isArtifactKind,
  type ArtifactKind,
  type ArtifactMetadata,
} from '../src/index.js'

test('COMPOSER_DOCK_SLOT and COMPOSER_STATUS_SLOT are exported and follow the builtin:composer/* namespace', { timeout: 60_000 }, () => {
  assert.equal(COMPOSER_STATUS_SLOT, 'builtin:composer/status')
  assert.equal(COMPOSER_DOCK_SLOT, 'builtin:composer/dock')
})

test('OVERVIEW_CARD_META_SLOT is exported and follows the builtin:overview/* namespace', { timeout: 60_000 }, () => {
  assert.equal(OVERVIEW_CARD_META_SLOT, 'builtin:overview/card-meta')
})

test('ArtifactKind / isArtifactKind / ArtifactMetadata.kind required-field contract', { timeout: 60_000 }, () => {
  assert.deepEqual([...ARTIFACT_KINDS], ['upload', 'registered', 'spill'])
  for (const kind of ['upload', 'registered', 'spill'] as const satisfies readonly ArtifactKind[]) {
    assert.equal(isArtifactKind(kind), true)
  }
  for (const bad of [undefined, null, '', 'other', 'UPLOAD', 1, {}, '__proto__']) {
    assert.equal(isArtifactKind(bad), false, `invalid kind ${String(bad)} must be rejected`)
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
  // @ts-expect-error kind is a required field and cannot be omitted
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
