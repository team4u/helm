import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactService, InMemoryArtifactRepository, ensureDataDir } from '../src/services/index.js';

test('产物读取拒绝跨会话元数据和软链越界，保持二进制字节', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-artifact-boundary-'));
  try {
    await ensureDataDir(root);
    const repository = new InMemoryArtifactRepository();
    const artifacts = new ArtifactService(root, repository);
    const source = join(root, 'example.png');
    const bytes = Uint8Array.from([0, 255, 128, 10]);
    await writeFile(source, bytes);
    const original = await artifacts.register(1, source);
    assert.deepEqual([...await artifacts.readBuffer(original.id)], [...bytes]);
    repository.put({ ...original, id: 'other-conversation', conversationId: 2 });
    await assert.rejects(artifacts.readBuffer('other-conversation'), /拒绝读取/);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside-boundary-example');
    const linkPath = join(root, 'artifacts', '1', 'outside-link.txt');
    await symlink(outside, linkPath);
    repository.put({ ...original, id: 'link', path: 'artifacts/1/outside-link.txt' });
    await assert.rejects(artifacts.readContent('link'), /拒绝读取/);
    await assert.rejects(artifacts.spill(-1, 'call', 'text'), /conversationId/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
