/**
 * Shared utilities and validation helpers for the plugin host.
 */
import { HelmError, isPlainObject } from '@helm/protocol';
import { redactJsonValue } from '../redact.js';

/**
 * JSON-safe deep clone reusing `redact.ts` structural validation (rejects cycles, `undefined`,
 * non-plain objects, `NaN`, and sparse arrays) instead of silently dropping values with `JSON.stringify`.
 */
export function jsonClone<T>(value: T): T {
  return redactJsonValue(value, (s) => s) as T;
}

/** Validates generic plugin resource identifiers (`[A-Za-z0-9._-]+`). */
export function assertValidId(kind: string, id: string): void {
  if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new HelmError('invalid_identifier', `Invalid plugin ${kind} identifier: ${String(id)}`, 400);
  }
}

/**
 * Validates `ConversationScope` at registration time: only plain objects with allowed keys
 * (`conversationIds` / `tags` / `profileIds` / `modelProviders`) containing positive integer IDs
 * or non-empty strings. Invalid scopes fail explicitly instead of silently acting as wildcards.
 */
export function assertConversationScope(pluginId: string, what: string, scope: unknown): void {
  if (scope === undefined) return;
  if (!isPlainObject(scope)) {
    throw new HelmError('invalid_plugin_scope', `${what} scope must be a plain object (null, arrays, and Map are rejected)`, 400, {
      pluginId,
    });
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'conversationIds' && key !== 'tags' && key !== 'profileIds' && key !== 'modelProviders') {
      throw new HelmError('invalid_plugin_scope', `${what} scope only allows conversationIds/tags/profileIds/modelProviders; got unknown field '${key}'`, 400, {
        pluginId,
        field: key,
      });
    }
  }
  const checkList = (key: string, kind: 'id' | 'text'): void => {
    const value = scope[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new HelmError('invalid_plugin_scope', `${what} scope.${key} must be an array`, 400, {
        pluginId,
        field: key,
      });
    }
    for (const item of value) {
      if (kind === 'id') {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
          throw new HelmError('invalid_plugin_scope', `${what} scope.${key} items must be positive integer conversation IDs`, 400, {
            pluginId,
            field: key,
            item,
          });
        }
      } else if (typeof item !== 'string' || item.length === 0) {
        throw new HelmError('invalid_plugin_scope', `${what} scope.${key} items must be non-empty strings`, 400, {
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

/** Makes a cleanup handle idempotent so early plugin release and disable-time teardown run it at most once. */
export function idempotentRelease(release: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

/** JSON-safe diagnostic summary normalized at the error source so class/Error instances never leak across boundaries. */
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

/** Cross-platform absolute path check: POSIX `/`, Windows drive `^[a-zA-Z]:[\\/]`, or UNC `^\\\\[^\\]+\\[^\\]+`. */
export function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

/** Strictly decodes a single URL path segment; invalid percent-encoding fails explicitly at registration. */
export function decodeSegmentStrict(seg: string): string {
  if (!seg.includes('%')) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HelmError(
      'invalid_route_path',
      `Route path segment contains invalid percent-encoding: ${seg} (encode literal '%' as '%25')`,
      400,
      { segment: seg },
    );
  }
}
