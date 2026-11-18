/**
 * Tarball security and nested-dependency golden tests for the Hub launcher staging:
 *
 * - `unpackPayloadTarball` policy: only regular files/directories under `package/` are allowed;
 *   links, path escapes, absolute members, foreign roots, backslashes, empty archives, missing
 *   `package/package.json`, and corrupt archives are rejected explicitly (crafted raw ustar
 *   archives — node-tar's list mode happily emits escaping paths, so the launcher's own policy is
 *   the gate);
 * - golden staging with a REAL npm-pack payload that embeds its dependency closure as
 *   `file:./<dep>.tgz` (the #88 reproduction shape): the launcher unpacks first and the real
 *   `npm install` resolves the nested archive — through both the registry channel (fake registry
 *   metadata + real SHA512 verification) and the local `--tarball` channel.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import { unpackPayloadTarball } from '../src/tarball.js';
import { stageHubRelease } from '../src/staging.js';
import {
  captureIo,
  createFakeRegistry,
  fixtureTarballPacker,
  prepareNestedDepPayload,
  writeFakePayload,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

/** Craft a raw ustar header (hand-rolled so hostile members npm would never produce can be tested). */
function ustarHeader(name: string, typeFlag: string, options?: { linkname?: string; size?: number }): Buffer {
  const size = options?.size ?? 0;
  const block = Buffer.alloc(512, 0);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write('0000644\0', 100, 8, 'utf8');
  block.write('0000000\0', 108, 8, 'utf8');
  block.write('0000000\0', 116, 8, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  block.write('00000000000\0', 136, 12, 'utf8');
  block.write('        ', 148, 8, 'utf8'); // checksum placeholder while summing
  block.write(typeFlag, 156, 1, 'utf8');
  if (options?.linkname !== undefined) block.write(options.linkname.slice(0, 100), 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'utf8');
  block.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return block;
}

/** An uncompressed tar archive from raw members (files carry one padded content block). */
function rawTar(members: Buffer[]): Buffer {
  return Buffer.concat([...members, Buffer.alloc(1024, 0)]);
}

function fileMember(name: string, content = 'x'): Buffer[] {
  const body = Buffer.concat([Buffer.from(content, 'utf8'), Buffer.alloc(512, 0)]).subarray(0, 512);
  return [ustarHeader(name, '0', { size: 512 }), body];
}

test('a well-formed package/ archive unpacks to the destination root with the prefix stripped', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-untar-');
  const payloadDir = path.join(root, 'payload');
  await writeFakePayload({ dir: payloadDir, pkgName: PKG, version: '1.0.0' });
  const tgz = await fixtureTarballPacker()(payloadDir);

  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });
  await unpackPayloadTarball(tgz, dest);
  assert.ok(existsSync(path.join(dest, 'package.json')));
  assert.ok(existsSync(path.join(dest, 'start.mjs')));
  assert.ok(existsSync(path.join(dest, 'manifest.json')));
  assert.equal(JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).name, PKG);
});

test('unpack rejects links, escapes, foreign roots, and backslashes with explicit errors', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-untarevil-');
  const dest = path.join(root, 'dest');
  const write = async (name: string, members: Buffer[]): Promise<string> => {
    const file = path.join(root, name);
    await fsp.writeFile(file, rawTar(members));
    return file;
  };

  const good = fileMember('package/package.json', '{}');
  const cases: Array<{ name: string; members: Buffer[]; message: RegExp }> = [
    {
      name: 'symlink.tar',
      members: [...good, ustarHeader('package/evil-link', '2', { linkname: '/etc/passwd' })],
      message: /type SymbolicLink; only regular files and directories are allowed/,
    },
    {
      name: 'hardlink.tar',
      members: [...good, ustarHeader('package/evil-hard', '1', { linkname: 'package.json' })],
      message: /type Link; only regular files and directories are allowed/,
    },
    {
      name: 'escape.tar',
      members: [...good, ...fileMember('../escape.txt')],
      message: /entry "..\/escape\.txt" is outside the package\/ root/,
    },
    {
      name: 'absolute.tar',
      members: [...good, ...fileMember('/abs/file.txt')],
      message: /entry "\/abs\/file\.txt" is outside the package\/ root/,
    },
    {
      name: 'foreign-root.tar',
      members: [...good, ...fileMember('notpackage/file.txt')],
      message: /entry "notpackage\/file\.txt" is outside the package\/ root/,
    },
    {
      name: 'backslash.tar',
      members: [...good, ...fileMember('package/back\\slash.txt')],
      message: /entry "package\/back\\slash\.txt" contains a backslash/,
    },
    {
      name: 'dotdot-inside.tar',
      members: [...good, ...fileMember('package/sub/../../evil.txt')],
      message: /contains a forbidden path segment/,
    },
  ];
  for (const testCase of cases) {
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });
    await assert.rejects(
      unpackPayloadTarball(await write(testCase.name, testCase.members), dest),
      testCase.message,
      `${testCase.name} must be rejected`,
    );
  }
});

test('unpack rejects empty archives, directory-only archives, and missing package.json', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-untarempty-');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });

  // An end-of-archive-marker-only file: node-tar flags it TAR_BAD_ARCHIVE, which the launcher's
  // warnings-are-fatal gate refuses (an archive that cannot be fully parsed is never unpacked).
  const empty = path.join(root, 'empty.tar');
  await fsp.writeFile(empty, rawTar([]));
  await assert.rejects(unpackPayloadTarball(empty, dest), /refused|contains no entries/);

  const dirsOnly = path.join(root, 'dirs-only.tar');
  await fsp.writeFile(dirsOnly, rawTar([ustarHeader('package/', '5'), ustarHeader('package/sub/', '5')]));
  await assert.rejects(unpackPayloadTarball(dirsOnly, dest), /contains no regular files/);

  const noManifest = path.join(root, 'no-package-json.tar');
  await fsp.writeFile(noManifest, rawTar([...fileMember('package/start.mjs')]));
  await assert.rejects(unpackPayloadTarball(noManifest, dest), /has no package\/package\.json member/);
});

test('unpack refuses corrupt archives instead of partial extraction', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-untarcorrupt-');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });

  const garbage = path.join(root, 'garbage.tgz');
  await fsp.writeFile(garbage, Buffer.from('this is not a tarball at all, not even gzip\n'));
  await assert.rejects(unpackPayloadTarball(garbage, dest), /refused|unreadable/);

  // A valid gzip wrapper around corrupt tar content: parsing fails, nothing is unpacked.
  const payloadDir = path.join(root, 'payload');
  await writeFakePayload({ dir: payloadDir, pkgName: PKG, version: '1.0.0' });
  const tgz = await fixtureTarballPacker()(payloadDir);
  const bytes = Buffer.from(await fsp.readFile(tgz));
  const flipIndex = bytes.length - 200;
  bytes[flipIndex] = (bytes[flipIndex] ?? 0) ^ 0xff;
  const flipped = path.join(root, 'flipped.tgz');
  await fsp.writeFile(flipped, bytes);
  const before = await fsp.readdir(dest);
  await assert.rejects(unpackPayloadTarball(flipped, dest), /refused|unreadable|failed to extract/);
  assert.deepEqual(await fsp.readdir(dest), before, 'no partial extraction may land on disk');
});

test('golden: registry payload embedding file: tgz dependencies stages with a real npm install', { timeout: 120_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-goldennested-');
  const tarballPath = await prepareNestedDepPayload(root, '1.0.0', PKG);
  const registry = await createFakeRegistry(PKG, '1.0.0');
  await registry.serve('1.0.0', tarballPath);
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));

  const staged = await stageHubRelease({
    io,
    root,
    version: '1.0.0',
    pkgName: PKG,
    dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
    registryUrl: registry.registryUrl,
    fetchFn: registry.fetchImpl,
  });
  assert.equal(staged.version, '1.0.0');
  assert.match(path.relative(root, staged.entryPath), /^releases[/\\]1\.0\.0[/\\][^/]+[/\\]start\.mjs$/);
  // The nested file: dependency resolved through the real npm install (the #88 ENOENT shape).
  const depEntry = path.join(staged.releaseDir, 'node_modules', '@fake', 'dep', 'index.js');
  assert.ok(existsSync(depEntry), `nested dependency must be installed at ${depEntry}`);
  assert.match(readFileSync(depEntry, 'utf8'), /dep-of-1\.0\.0/);
  // The launcher-owned download copy is cleaned up after unpacking.
  assert.equal(existsSync(path.join(staged.releaseDir, '.downloads')), false);
});

test('golden: local --tarball payload embedding file: tgz dependencies installs and self-checks', { timeout: 120_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-goldennestedtgz-');
  const tarballPath = await prepareNestedDepPayload(root, '2.0.0', PKG);
  const { io } = captureIo(sanitizedHostEnv({ HELM_PAYLOAD_PACKAGE: PKG }));

  const staged = await stageHubRelease({
    io,
    root,
    version: '2.0.0',
    pkgName: PKG,
    dataDir: path.join(path.dirname(root), `${path.basename(root)}-user-data`),
    tarballPath,
  });
  assert.equal(staged.version, '2.0.0');
  assert.ok(existsSync(path.join(staged.releaseDir, 'node_modules', '@fake', 'dep', 'index.js')));
});
