#!/usr/bin/env node
/**
 * 构建前置清理：删除本包 dist。
 *
 * Why：tsc 增量输出不清理陈旧文件；本包源码布局经历过拆包迁移
 * （builtin-plugins 与组合根迁出 @helm/kernel），残留旧输出会被
 * payload / 桌面组装整目录复制而悄悄交付。构建从干净 dist 开始，
 * 交付永远只含当前源码树的产物。
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(pkgRoot, 'dist'), { recursive: true, force: true });
