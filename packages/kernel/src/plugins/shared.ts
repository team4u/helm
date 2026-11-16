/**
 * plugin host internal through use tool and validate function.
 */
import { HelmError } from '@helm/protocol';
import { redactJsonValue } from '../redact.js';

/**
 * JSON-safe deep copy: re- use redact.ts structure check (refuse loop/undefined/non- pure object/
 * NaN/sparse array),identity direct through. boundary explicit reject, never to JSON.stringify silently lose data.
 */
export function jsonClone<T>(value: T): T {
  return redactJsonValue(value, (s) => s) as T;
}

export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** strictly pure object decide (prototype must is Object.prototype or null):Map/class instance one rule reject. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isJsonObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** through use id character collection validate. */
export function assertValidId(kind: string, id: string): void {
  if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new HelmError('invalid_identifier', `plugin declaration ${kind} id illegal:${String(id)}`, 400);
  }
}

/**
 * register boundary validate ConversationScope: only allows pure object, field only allows
 * conversationIds / tags / profileIds / modelProviders; array element is positive integer conversation ID or non-empty string.
 * illegal scope(Map, unknown field, element type do not symbol etc.) in this explicit reject - - otherwise
 * matchesConversationScope will read fewer than field when do not limit, static default becomes all let through.
 */
export function assertConversationScope(pluginId: string, what: string, scope: unknown): void {
  if (scope === undefined) return;
  if (!isPlainObject(scope)) {
    throw new HelmError('invalid_plugin_scope', `${what}  scope must be pure object (reject null/array/Map etc.)`, 400, {
      pluginId,
    });
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'conversationIds' && key !== 'tags' && key !== 'profileIds' && key !== 'modelProviders') {
      throw new HelmError('invalid_plugin_scope', `${what}  scope only allows conversationIds/tags/profileIds/modelProviders, receives unknown field ${key}`, 400, {
        pluginId,
        field: key,
      });
    }
  }
  const checkList = (key: string, kind: 'id' | 'text'): void => {
    const value = scope[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new HelmError('invalid_plugin_scope', `${what}  scope.${key} must be array`, 400, {
        pluginId,
        field: key,
      });
    }
    for (const item of value) {
      if (kind === 'id') {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
          throw new HelmError('invalid_plugin_scope', `${what}  scope.${key} element must be positive integer conversation ID`, 400, {
            pluginId,
            field: key,
            item,
          });
        }
      } else if (typeof item !== 'string' || item.length === 0) {
        throw new HelmError('invalid_plugin_scope', `${what}  scope.${key} element must be non-empty string`, 400, {
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

/** idempotent a release handle: duplicate invoke only takes effect once (plugin mention before release + deactivate clean up double keep risk). */
export function idempotentRelease(release: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

/**
 * error diagnose JSON-safe archive one form: out station error message seal strictly reject Error/class instance,
 * original exception must in produce where specification, keep name/message and HelmError code/status.
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
 * across platform absolute path:POSIX `/`,Windows symbol `^[a-zA-Z]:[\\/]` and UNC `^\\\\[^\\]+\\[^\\]+`.
 */
export function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

/**
 * strictly decode single path segment: illegal hundred number sequence directly throws (register boundary explicit reject).
 */
export function decodeSegmentStrict(seg: string): string {
  if (!seg.includes('%')) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HelmError(
      'invalid_route_path',
      `routing path segment contains illegal hundred number encode:${seg}(such as must literal % please encode is %25)`,
      400,
      { segment: seg },
    );
  }
}
