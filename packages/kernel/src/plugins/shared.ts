/**
 * 插件宿主内部通用工具与校验函数。
 */
import { HelmError } from '@helm/protocol';
import { redactJsonValue } from '../redact.js';

/**
 * JSON-safe 深拷贝：复用 redact.ts 的结构检查（拒循环/undefined/非纯对象/
 * NaN/稀疏数组），identity 直通。边界显式拒绝，绝不留给 JSON.stringify 悄悄丢数据。
 */
export function jsonClone<T>(value: T): T {
  return redactJsonValue(value, (s) => s) as T;
}

export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 严格纯对象判定（原型须为 Object.prototype 或 null）：Map/类实例一律拒绝。 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isJsonObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 通用 id 字符集校验。 */
export function assertValidId(kind: string, id: string): void {
  if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new HelmError('invalid_identifier', `插件声明 ${kind} id 非法：${String(id)}`, 400);
  }
}

/**
 * 注册边界校验 ConversationScope：只允许纯对象，字段只允许
 * conversationIds / tags / profileIds / modelProviders；数组元素为正整数会话 ID 或非空字符串。
 * 非法 scope（Map、未知字段、元素类型不符等）在此显式拒绝——否则
 * matchesConversationScope 会把读不到的字段当「不限」，静默变成全放行。
 */
export function assertConversationScope(pluginId: string, what: string, scope: unknown): void {
  if (scope === undefined) return;
  if (!isPlainObject(scope)) {
    throw new HelmError('invalid_plugin_scope', `${what} 的 scope 必须是纯对象（拒绝 null/数组/Map 等）`, 400, {
      pluginId,
    });
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'conversationIds' && key !== 'tags' && key !== 'profileIds' && key !== 'modelProviders') {
      throw new HelmError('invalid_plugin_scope', `${what} 的 scope 仅允许 conversationIds/tags/profileIds/modelProviders，收到未知字段 ${key}`, 400, {
        pluginId,
        field: key,
      });
    }
  }
  const checkList = (key: string, kind: 'id' | 'text'): void => {
    const value = scope[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new HelmError('invalid_plugin_scope', `${what} 的 scope.${key} 必须是数组`, 400, {
        pluginId,
        field: key,
      });
    }
    for (const item of value) {
      if (kind === 'id') {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
          throw new HelmError('invalid_plugin_scope', `${what} 的 scope.${key} 元素必须是正整数会话 ID`, 400, {
            pluginId,
            field: key,
            item,
          });
        }
      } else if (typeof item !== 'string' || item.length === 0) {
        throw new HelmError('invalid_plugin_scope', `${what} 的 scope.${key} 元素必须是非空字符串`, 400, {
          pluginId,
          field: key,
          item,
        });
      }
    }
  };
  checkList('conversationIds', 'id');
  checkList('tags', 'text');
  checkList('profileIds', 'text');
  checkList('modelProviders', 'text');
}

/** 幂等化一个释放句柄：重复调用只生效一次（插件提前释放 + 停用清理双保险）。 */
export function idempotentRelease(release: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

/**
 * 错误诊断的 JSON-safe 归一形态：出站错误信封严格拒绝 Error/类实例，
 * 原始异常必须在产生处规范化，保留 name/message 与 HelmError code/status。
 */
export interface JsonSafeErrorInfo {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

export function toJsonSafeError(err: unknown): JsonSafeErrorInfo {
  if (err instanceof HelmError) {
    return { name: err.name, message: err.message, code: err.code, status: err.status };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: String(err) };
}

/**
 * 跨平台绝对路径：POSIX `/`、Windows 盘符 `^[a-zA-Z]:[\\/]` 与 UNC `^\\\\[^\\]+\\[^\\]+`。
 */
export function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

/**
 * 严格解码单个路径段：非法百分号序列直接抛错（注册边界显式拒绝）。
 */
export function decodeSegmentStrict(seg: string): string {
  if (!seg.includes('%')) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HelmError(
      'invalid_route_path',
      `路由路径段包含非法百分号编码：${seg}（如需字面 % 请编码为 %25）`,
      400,
      { segment: seg },
    );
  }
}
