#!/usr/bin/env node
/**
 * Pre-build cleanup: incrementally prunes stale artifacts in this package's dist that no longer have
 * matching source files, while preserving <plugin>/client/** assets that still exist.
 * Supports --force / HELM_CLEAN_DIST=1 for a full wipe.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanDistCli } from '../../../scripts/lib/prune-dist.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
runCleanDistCli(pkgRoot, process.argv.slice(2), { preserveClients: true });
