/**
 * 1ms zero memory assertion guard against explode Preload(Node inside placement module zero external dependency).
 *
 * is what store in:happy-dom / React DOM test in if directly for Element / Window / Event /
 * React Fiber node invoke assert.equal(el, null) etc. assertion, on failure Node original generate
 * AssertionError will invoke util.inspect(actual) recursion iterate the whole DOM + Fiber loop tree,
 * instant between soar to >1.5GB memory and card die/OOM.
 *
 * this module via NODE_OPTIONS=--import=... in test code load before inject (also can directly import):
 * - for equal/strictEqual/notEqual/notStrictEqual away O(1) Object.is fast path;
 * - only in assertion i.e. failed (or deepEqual/deepStrictEqual probe to danger object) when do shallow probe
 *   and compact summary, ordinary value 100% pass-through original generate assertion keep complete diff experience.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';

const MAX_PROBE_DEPTH = 2;
const MAX_PROBE_NODES = 512;
const MAX_KEYS_PER_NODE = 128;
const MAX_LABEL_LEN = 120;

function truncateLabel(label, maxLen = MAX_LABEL_LEN) {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 3) + '...';
}

function isWindowObject(val) {
  return (
    (typeof globalThis.window === 'object' && globalThis.window !== null && val === globalThis.window) ||
    (typeof val.document === 'object' && val.document !== null && val.window === val)
  );
}

function isDirectToxic(val) {
  if (typeof val !== 'object' || val === null) return false;
  try {
    // 1. DOM Node / Element / Document
    if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') return true;
    // 2. Window
    if (isWindowObject(val)) return true;
    // 3. DOM Event
    if (typeof val.preventDefault === 'function' && 'target' in val && 'currentTarget' in val) {
      return true;
    }
    // 4. React Fiber node itself or mount React Fiber host node
    if ('stateNode' in val && 'memoizedProps' in val && 'return' in val) return true;
    if (!Array.isArray(val)) {
      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        if (
          k.startsWith('__reactFiber$') ||
          k.startsWith('__reactProps$') ||
          k.startsWith('__reactContainer$')
        ) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * iterate shallow probe (at most top-level + 2 layer object property, forbidden deep recursion guard against itself card die).
 * @param {unknown} val
 * @returns {boolean}
 */
export function isToxicForInspect(val) {
  if (typeof val !== 'object' || val === null) return false;
  if (isDirectToxic(val)) return true;

  const visited = new Set([val]);
  const queue = [{ value: val, depth: 0 }];
  let head = 0;

  while (head < queue.length && visited.size < MAX_PROBE_NODES) {
    const { value, depth } = queue[head++];
    if (depth >= MAX_PROBE_DEPTH) continue;

    try {
      if (Array.isArray(value)) {
        const limit = Math.min(value.length, MAX_KEYS_PER_NODE);
        for (let i = 0; i < limit; i += 1) {
          const child = value[i];
          if (typeof child !== 'object' || child === null || visited.has(child)) continue;
          if (isDirectToxic(child)) return true;
          visited.add(child);
          if (visited.size >= MAX_PROBE_NODES) break;
          if (depth + 1 < MAX_PROBE_DEPTH) queue.push({ value: child, depth: depth + 1 });
        }
      } else {
        const keys = Object.keys(value);
        const limit = Math.min(keys.length, MAX_KEYS_PER_NODE);
        for (let i = 0; i < limit; i += 1) {
          const child = value[keys[i]];
          if (typeof child !== 'object' || child === null || visited.has(child)) continue;
          if (isDirectToxic(child)) return true;
          visited.add(child);
          if (visited.size >= MAX_PROBE_NODES) break;
          if (depth + 1 < MAX_PROBE_DEPTH) queue.push({ value: child, depth: depth + 1 });
        }
      }
    } catch {
      // ignore proxy/getter throws
    }
  }
  return false;
}

function summarizeToxicDirect(val) {
  try {
    if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') {
      const tag = String(val.nodeName).toLowerCase();
      const id = typeof val.id === 'string' && val.id ? `#${val.id}` : '';
      let cls = '';
      if (typeof val.className === 'string') {
        const trimmed = val.className.trim();
        if (trimmed) cls = `.${trimmed.split(/\s+/).join('.')}`;
      }
      const innerMax = MAX_LABEL_LEN - '[DOM <>]'.length;
      const inner = truncateLabel(`${tag}${id}${cls}`, innerMax);
      return `[DOM <${inner}>]`;
    }
    if (isWindowObject(val)) return '[Window]';
    if (typeof val.preventDefault === 'function' && 'target' in val && 'currentTarget' in val) {
      const type = typeof val.type === 'string' && val.type ? ` ${val.type}` : '';
      return truncateLabel(`[Event${type}]`);
    }
    if ('stateNode' in val && 'memoizedProps' in val && 'return' in val) {
      const typeName =
        typeof val.type === 'function'
          ? val.type.displayName || val.type.name || ''
          : typeof val.type === 'string'
            ? val.type
            : '';
      return typeName ? truncateLabel(`[ReactFiber <${typeName}>]`) : '[ReactFiber]';
    }
    return '[ReactHost]';
  } catch {
    return '[ToxicObject]';
  }
}

function sanitizeValue(val, depth = 0, seen = new Map(), disambiguate = null) {
  if (typeof val !== 'object' || val === null) return val;
  if (seen.has(val)) return seen.get(val);

  if (isDirectToxic(val)) {
    const base = summarizeToxicDirect(val);
    if (!disambiguate) return base;
    let label = base;
    if (disambiguate.usedLabels.has(base)) {
      disambiguate.seq += 1;
      label = `${base} #${disambiguate.seq}`;
    } else {
      disambiguate.usedLabels.add(base);
    }
    seen.set(val, label);
    return label;
  }

  if (depth >= MAX_PROBE_DEPTH) {
    return Array.isArray(val) ? '[Array]' : '[Object]';
  }

  try {
    if (Array.isArray(val)) {
      const out = [];
      seen.set(val, out);
      const limit = Math.min(val.length, MAX_KEYS_PER_NODE);
      for (let i = 0; i < limit; i += 1) {
        out.push(sanitizeValue(val[i], depth + 1, seen, disambiguate));
      }
      if (val.length > limit) out.push(`... (${val.length - limit} more)`);
      return out;
    }

    const out = {};
    seen.set(val, out);
    const keys = Object.keys(val);
    const limit = Math.min(keys.length, MAX_KEYS_PER_NODE);
    for (let i = 0; i < limit; i += 1) {
      const k = keys[i];
      out[k] = sanitizeValue(val[k], depth + 1, seen, disambiguate);
    }
    return out;
  } catch {
    return '[Object]';
  }
}

function installSafeTestAssert() {
  if (globalThis.__helmSafeTestAssertInstalled) return;
  globalThis.__helmSafeTestAssertInstalled = true;

  const require = createRequire(import.meta.url);
  const looseAssert = require('node:assert');
  const strictAssert = require('node:assert/strict');
  const { AssertionError } = looseAssert;

  function throwSanitized(actual, expected, message, operator, stackStartFn) {
    if (message instanceof Error) throw message;
    throw new AssertionError({
      actual: isToxicForInspect(actual) ? sanitizeValue(actual) : actual,
      expected: isToxicForInspect(expected) ? sanitizeValue(expected) : expected,
      message,
      operator,
      stackStartFn,
    });
  }

  function wrapStrictEqual(orig) {
    return function safeStrictEqual(actual, expected, message) {
      if (arguments.length < 2) return orig.apply(this, arguments);
      if (Object.is(actual, expected)) return;
      if (!isToxicForInspect(actual) && !isToxicForInspect(expected)) {
        return orig.apply(this, arguments);
      }
      throwSanitized(actual, expected, message, 'strictEqual', safeStrictEqual);
    };
  }

  function wrapNotStrictEqual(orig) {
    return function safeNotStrictEqual(actual, expected, message) {
      if (arguments.length < 2) return orig.apply(this, arguments);
      if (!Object.is(actual, expected)) return;
      if (!isToxicForInspect(actual)) {
        return orig.apply(this, arguments);
      }
      throwSanitized(actual, expected, message, 'notStrictEqual', safeNotStrictEqual);
    };
  }

  function wrapLooseEqual(orig) {
    return function safeEqual(actual, expected, message) {
      if (arguments.length < 2) return orig.apply(this, arguments);
      if (Object.is(actual, expected)) return;
      if (!isToxicForInspect(actual) && !isToxicForInspect(expected)) {
        return orig.apply(this, arguments);
      }
      // any one side is danger object and strictly do not etc.:null/undefined/same is object scenario directly by == failed path summary;
      // the rest original value compare first core verify == is otherwise indeed failed, avoid break loose equal semantics.
      if (
        (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') ||
        actual === null ||
        actual === undefined ||
        expected === null ||
        expected === undefined ||
        // eslint-disable-next-line eqeqeq
        actual != expected
      ) {
        throwSanitized(actual, expected, message, '==', safeEqual);
      }
    };
  }

  function wrapLooseNotEqual(orig) {
    return function safeNotEqual(actual, expected, message) {
      if (arguments.length < 2) return orig.apply(this, arguments);
      if (
        (actual !== null &&
          typeof actual === 'object' &&
          (expected === null ||
            expected === undefined ||
            (typeof expected === 'object' && !Object.is(actual, expected)))) ||
        (expected !== null &&
          typeof expected === 'object' &&
          (actual === null || actual === undefined))
      ) {
        return;
      }
      if (!isToxicForInspect(actual) && !isToxicForInspect(expected)) {
        return orig.apply(this, arguments);
      }
      // eslint-disable-next-line eqeqeq
      if (actual != expected) return;
      throwSanitized(actual, expected, message, '!=', safeNotEqual);
    };
  }

  function wrapDeepEqual(orig, operator) {
    return function safeDeepEqual(actual, expected, message) {
      if (arguments.length < 2) return orig.apply(this, arguments);
      if (Object.is(actual, expected)) return;
      if (!isToxicForInspect(actual) && !isToxicForInspect(expected)) {
        return orig.apply(this, arguments);
      }
      const seen = new Map();
      const disambiguate = { usedLabels: new Set(), seq: 1 };
      const safeActual = sanitizeValue(actual, 0, seen, disambiguate);
      const safeExpected = sanitizeValue(expected, 0, seen, disambiguate);
      try {
        return orig.call(this, safeActual, safeExpected, message);
      } catch (err) {
        if (err instanceof AssertionError && !(message instanceof Error)) {
          throw new AssertionError({
            actual: safeActual,
            expected: safeExpected,
            message,
            operator,
            stackStartFn: safeDeepEqual,
          });
        }
        throw err;
      }
    };
  }

  function patchTarget(target, { strictMode }) {
    const origEqual = target.equal;
    const origNotEqual = target.notEqual;
    const origStrictEqual = target.strictEqual;
    const origNotStrictEqual = target.notStrictEqual;
    const origDeepEqual = target.deepEqual;
    const origDeepStrictEqual = target.deepStrictEqual;

    target.strictEqual = wrapStrictEqual(origStrictEqual);
    target.notStrictEqual = wrapNotStrictEqual(origNotStrictEqual);
    target.equal = strictMode ? target.strictEqual : wrapLooseEqual(origEqual);
    target.notEqual = strictMode ? target.notStrictEqual : wrapLooseNotEqual(origNotEqual);
    target.deepStrictEqual = wrapDeepEqual(origDeepStrictEqual, 'deepStrictEqual');
    target.deepEqual = strictMode ? target.deepStrictEqual : wrapDeepEqual(origDeepEqual, 'deepEqual');
  }

  patchTarget(looseAssert, { strictMode: false });
  patchTarget(strictAssert, { strictMode: true });
  // keep assert.strict and node:assert/strict reference consistent (if not come Node separate two then fall back sync)
  if (looseAssert.strict && looseAssert.strict !== strictAssert) {
    patchTarget(looseAssert.strict, { strictMode: true });
  }
  syncBuiltinESMExports();
}

installSafeTestAssert();
