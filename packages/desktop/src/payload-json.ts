/**
 * 原子 JSON 状态文件：写侧同目录 tmp + fsync + rename（POSIX 原子换名），
 * 读侧区分「缺失」（undefined）与「损坏」（显式抛 updater_state_corrupt，禁止静默当作空态）。
 *
 * 供 payload updater 的 current.json / blocked.json 使用；写入失败绝不影响既有文件。
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DesktopError } from './errors.js';

/** 原子写 JSON：tmp 文件 fsync 后 rename 到目标；任何一步失败原文件保持不变。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let fh: number;
  try {
    fh = openSync(tmp, 'w');
  } catch (error) {
    throw new DesktopError(
      'updater_state_write_failed',
      `状态文件无法写入: ${file}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  try {
    writeSync(fh, data, 0, data.length);
    fsyncSync(fh);
  } finally {
    closeSync(fh);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理尽力而为：tmp 残留不影响正确性
    }
    throw new DesktopError(
      'updater_state_write_failed',
      `状态文件原子换名失败: ${file}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

/**
 * 读取 JSON 状态：文件不存在返回 undefined；存在但非法 JSON 显式抛
 * updater_state_corrupt（调用方必须显式处理，不得当作空态继续）。
 */
export function readJsonState(file: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DesktopError(
      'updater_state_read_failed',
      `${what} 无法读取: ${file}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DesktopError('updater_state_corrupt', `${what} 已损坏（非法 JSON）: ${file}`, {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
