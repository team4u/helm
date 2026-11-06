import { HelmError } from '@helm/protocol';

/** 先处理 JSON 字符串值再序列化，避免引号、换行转义导致漏脱敏。 */
export function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  const visiting = new WeakSet<object>();
  function visit(current: unknown): unknown {
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') return redact(current);
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current !== 'object' || visiting.has(current)) {
      throw new HelmError('invalid_json_value', '输出必须是无循环、无未定义值的 JSON 数据', 500);
    }
    visiting.add(current);
    try {
      if (Array.isArray(current)) {
        const result: unknown[] = [];
        for (let i = 0; i < current.length; i++) {
          if (!Object.hasOwn(current, i)) throw new HelmError('invalid_json_value', '输出不得包含稀疏数组', 500);
          result.push(visit(current[i]));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new HelmError('invalid_json_value', '输出不得包含非 JSON 对象', 500);
      }
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item)]));
    } finally {
      visiting.delete(current);
    }
  }
  return visit(value);
}
