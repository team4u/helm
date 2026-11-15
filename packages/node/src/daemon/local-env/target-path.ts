/**
 * 统一目标路径解析原语（local-env 子模块）：file API 与 exec 共用，
 * 零探测、零猜测；行为契约由 test/node-local-env-win32-path.test.ts 钉住。
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTargetPath, type TargetPlatform } from '@helm/protocol';
import { FileError, err, ok, type Result } from './errors.js';

/** 条目拼接按目标平台词法规则（真实宿主上与 node:path 宿主行为一致，注入测试下保持同一视角）。 */
export function joinTargetPath(platform: TargetPlatform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

/** 父目录提取按目标平台词法规则（输入已是本原语解析后的规范路径）。 */
export function parentTargetPath(platform: TargetPlatform, p: string): string {
  return platform === 'win32' ? win32.dirname(p) : posix.resolve(p, '..');
}

/**
 * 统一目标路径解析原语（file API 与 exec 共用，零探测、零猜测）：
 *
 * - posix 目标：按 node:path posix 规则解析（/mnt/… 是真实路径绝不反向转换，
 *   且与宿主 OS 无关——Windows 宿主注入测试下同样保持纯 POSIX 语义）；
 * - win32 目标：先做 `~` / `file://` 展开，再经 @helm/protocol 的
 *   normalizeTargetPath 统一规范化——/mnt/<盘符>/…（WSL 挂载视图）与
 *   /<盘符>/…（Git Bash / MSYS 盘符根视图）确定性转换为 <大写盘符>:\…
 *   （而非宿主 resolve 误锚出的 <盘符>:\mnt\<盘符>\…），原生 Windows /
 *   UNC / 相对路径仅做词法归一，无盘符 POSIX 根（/home、/tmp、裸 / 等）
 *   显式结构化失败（code 'invalid'），绝不做 access 候选猜测；
 *   相对路径锚定到按同一规则规范化后的会话 cwd（会话 cwd 也可能是
 *   /mnt/<盘符>/… 视图）。
 */
export function resolveTargetPath(cwd: string, path: string, platform: TargetPlatform): Result<string> {
  let normalized = path;
  if (normalized === '~') {
    normalized = homedir();
  } else if (
    normalized.startsWith('~/') ||
    (platform === 'win32' && normalized.startsWith('~\\'))
  ) {
    normalized = joinTargetPath(platform, homedir(), normalized.slice(2));
  } else if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized, { windows: platform === 'win32' });
    } catch {
      // 畸形 URL 保留原样作为普通路径，文件方法维持不抛异常的契约。
    }
  }
  if (platform !== 'win32') {
    // 先用 protocol 的纯 POSIX 规则做词法归一，再只用 posix.resolve 做
    // 目标 cwd 锚定；这样 Windows 宿主不会把盘符/反斜杠规则带入目标路径。
    const normalizedPath = normalizeTargetPath(normalized, 'posix')
    const normalizedCwd = normalizeTargetPath(cwd, 'posix')
    if (!normalizedPath.ok || !normalizedCwd.ok) {
      // normalizeTargetPath('posix') 当前不会失败；保留显式分支以守住
      // protocol 契约，避免未来扩展失败类型时静默继续。
      return err(new FileError('invalid', 'Invalid POSIX target path', path))
    }
    return ok(
      posix.isAbsolute(normalizedPath.path)
        ? posix.resolve(normalizedPath.path)
        : posix.resolve(normalizedCwd.path, normalizedPath.path),
    );
  }
  const normalizedWin = normalizeTargetPath(normalized, 'win32');
  if (!normalizedWin.ok) {
    return err(new FileError('invalid', normalizedWin.reason, path));
  }
  if (win32.isAbsolute(normalizedWin.path)) {
    return ok(win32.resolve(normalizedWin.path));
  }
  const base = normalizeTargetPath(cwd, 'win32');
  if (!base.ok) {
    return err(new FileError('invalid', `会话 cwd 无法解析：${base.reason}`, path));
  }
  return ok(win32.resolve(base.path, normalizedWin.path));
}
