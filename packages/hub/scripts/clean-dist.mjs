#!/usr/bin/env node
/**
 * 构建前置清理：删除本包 dist。
 *
 * Why：tsc 增量输出不清理陈旧文件，交付必须只含当前源码树的产物；
 * payload / 桌面组装按目录整体复制本包 dist，陈旧文件会被悄悄带走。
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(pkgRoot, 'dist'), { recursive: true, force: true });
