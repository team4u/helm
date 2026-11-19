#!/usr/bin/env node
/**
 * 构建前置清理：增量裁剪本包 dist 中已无对应源码的陈旧产物（--force / HELMX_CLEAN_DIST=1 全量清空）。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanDistCli } from '../../../scripts/lib/prune-dist.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
runCleanDistCli(pkgRoot, process.argv.slice(2), { preserveClients: false });
