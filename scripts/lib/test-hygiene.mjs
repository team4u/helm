/**
 * Static test-hygiene analysis (TypeScript Compiler API, no new lint dependencies).
 *
 * Covers the statically decidable rules from AGENTS §5:
 *   timeout-missing       every test()/it() call must declare options.timeout explicitly
 *                         (its own options, a shared const options object, or a timeout
 *                         inherited from an outer describe/parent test per node:test
 *                         semantics — any of the three counts as declared);
 *   skip-without-reason   skip must carry a reason string ({ skip: true }, bare test.skip,
 *                         and skip conditions whose reason cannot be statically confirmed
 *                         are all violations);
 *   suite-timeout-env     assigning to process.env.HELM_TEST_SUITE_TIMEOUT_MS is forbidden
 *                         (kernel env-registry-races relies on host HELM_* being stripped;
 *                         injecting it causes false positives);
 *   unsafe-dom-assert     calling assert.equal / strictEqual / deepEqual / deepStrictEqual /
 *                         notDeepEqual / notDeepStrictEqual on DOM nodes / Window is
 *                         forbidden (likewise notEqual / notStrictEqual when both sides are
 *                         DOM nodes), because on failure util.inspect walks the whole
 *                         DOM/React Fiber tree and can hang or OOM.
 *
 * Recognition scope: named imports of node:test (test/it/describe, including as aliases),
 * default imports, and namespace imports (import * as nt then nt.test/nt.it/nt.describe,
 * including .skip/.todo variants). todo never executes → exempt from every rule; constant
 * skip (a string-literal skip value) never executes → exempt from timeout; conditional skip
 * may execute → timeout still required. The options object may be a shared object bound to a
 * top-level const in the same file (e.g. `const timeout = { timeout: 60_000 } as const`,
 * unwrapping as const). t.test() subtests are not covered by these rules for now
 * (inheritance semantics are involved and the existing corpus mostly does not declare them;
 * they are counted and reported separately — neither silently exempted nor aggressively
 * rewritten; whether to tighten is a human decision). No regex parsing: nested calls,
 * multiline options, and aliases are all decided by AST structure.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

const ENV_VAR = 'HELM_TEST_SUITE_TIMEOUT_MS';
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

/**
 * @typedef {{ file: string, line: number, rule: 'timeout-missing' | 'skip-without-reason' | 'suite-timeout-env' | 'unsafe-dom-assert', message: string }} HygieneViolation
 * @typedef {{ violations: HygieneViolation[], stats: { testCalls: number, skipCalls: number, todoCalls: number, subtestCalls: number } }} HygieneReport
 */

const ASSERT_METHODS = new Set([
  'equal',
  'strictEqual',
  'notEqual',
  'notStrictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notDeepEqual',
  'notDeepStrictEqual',
]);
const SINGLE_ARG_DOM_UNSAFE = new Set([
  'equal',
  'strictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notDeepEqual',
  'notDeepStrictEqual',
]);
const BOTH_ARG_DOM_UNSAFE = new Set(['notEqual', 'notStrictEqual']);

const DOM_RETURNING_METHODS = new Set([
  'querySelector',
  'getElementById',
  'closest',
  'createElement',
  'cloneNode',
]);
const DOM_COLLECTION_METHODS = new Set([
  'querySelectorAll',
  'getElementsByTagName',
  'getElementsByClassName',
]);
const DOM_RETURNING_PROPS = new Set([
  'activeElement',
  'parentElement',
  'parentNode',
  'firstElementChild',
  'lastElementChild',
  'firstChild',
  'lastChild',
  'nextElementSibling',
  'previousElementSibling',
  'documentElement',
  'ownerDocument',
  'defaultView',
]);

/** Collect import bindings of node:assert / node:assert/strict (default, named/aliased, namespace, strict). */
function collectAssertBindings(ts, sourceFile) {
  /** @type {Set<string>} */ const assertObjects = new Set();
  /** @type {Map<string, string>} */ const assertFns = new Map();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (spec.text !== 'node:assert' && spec.text !== 'node:assert/strict') continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) assertObjects.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text;
        const local = el.name.text;
        if (imported === 'strict') assertObjects.add(local);
        else if (ASSERT_METHODS.has(imported)) assertFns.set(local, imported);
      }
    }
    if (nb && ts.isNamespaceImport(nb)) assertObjects.add(nb.name.text);
  }
  return { assertObjects, assertFns };
}

function classifyAssertCall(ts, callee, assertBindings) {
  if (ts.isIdentifier(callee)) {
    return assertBindings.assertFns.get(callee.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if (!ASSERT_METHODS.has(method)) return null;
    const host = callee.expression;
    if (ts.isIdentifier(host) && assertBindings.assertObjects.has(host.text)) return method;
    if (
      ts.isPropertyAccessExpression(host) &&
      (host.name.text === 'strict' || host.name.text === 'default') &&
      ts.isIdentifier(host.expression) &&
      assertBindings.assertObjects.has(host.expression.text)
    ) {
      return method;
    }
  }
  return null;
}

/** Unwrap parentheses, as / type assertions / satisfies / non-null assertions. */
function unwrapExpr(ts, expr) {
  let cur = expr;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur))
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isDomCollectionExpr(ts, expr, lookupDomListVar) {
  const cur = unwrapExpr(ts, expr);
  if (!cur) return false;
  if (ts.isIdentifier(cur)) return lookupDomListVar(cur.text);
  if (ts.isCallExpression(cur)) {
    const callee = unwrapExpr(ts, cur.expression);
    if (ts.isPropertyAccessExpression(callee) && DOM_COLLECTION_METHODS.has(callee.name.text)) {
      return true;
    }
  }
  return false;
}

function isDomNodeExpr(ts, expr, lookupDomVar, lookupDomListVar) {
  const cur = unwrapExpr(ts, expr);
  if (!cur) return false;
  if (ts.isIdentifier(cur)) {
    return cur.text === 'document' || cur.text === 'window' || lookupDomVar(cur.text);
  }
  if (ts.isCallExpression(cur)) {
    const callee = unwrapExpr(ts, cur.expression);
    if (ts.isPropertyAccessExpression(callee) && DOM_RETURNING_METHODS.has(callee.name.text)) {
      return true;
    }
    return false;
  }
  if (ts.isElementAccessExpression(cur)) {
    return isDomCollectionExpr(ts, cur.expression, lookupDomListVar);
  }
  if (ts.isPropertyAccessExpression(cur)) {
    const prop = cur.name.text;
    if (DOM_RETURNING_PROPS.has(prop)) return true;
    if (prop === 'body' || prop === 'head') {
      const host = unwrapExpr(ts, cur.expression);
      return Boolean(host && ts.isIdentifier(host) && host.text === 'document');
    }
  }
  return false;
}

/** Collect node:test import bindings: testFn (test/it, incl. aliases), describe, namespaces. */
function collectTestBindings(ts, sourceFile) {
  /** @type {Set<string>} */ const testFn = new Set();
  /** @type {Set<string>} */ const describeFn = new Set();
  /** @type {Set<string>} */ const namespaces = new Set();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || spec.text !== 'node:test') continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) testFn.add(clause.name.text); // the default export is the test function
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text; // with an as alias, propertyName is the source name
        if (imported === 'test' || imported === 'it') testFn.add(el.name.text);
        else if (imported === 'describe') describeFn.add(el.name.text);
      }
    }
    if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
  }
  return { testFn, describeFn, namespaces };
}

/** Unwrap as const / type assertions / satisfies to expose the real initializer. */
function unwrapAssertion(ts, expr) {
  const wrappers = new Set([
    ts.SyntaxKind.AsExpression,
    ts.SyntaxKind.TypeAssertionExpression,
    ts.SyntaxKind.SatisfiesExpression,
    ts.SyntaxKind.NonNullExpression,
  ]);
  let cur = expr;
  while (wrappers.has(cur.kind)) cur = cur.expression;
  return cur;
}

/** Collect top-level const bindings of the file (identifier → initializer) for shared options object resolution. */
function collectTopLevelConsts(ts, sourceFile) {
  const map = new Map();
  for (const st of sourceFile.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) map.set(d.name.text, unwrapAssertion(ts, d.initializer));
    }
  }
  return map;
}

/** The given property of an options object (PropertyAssignment form only), for timeout/skip decisions. */
function findOptionProp(ts, options, name) {
  for (const p of options?.properties ?? []) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p;
  }
  return undefined;
}

/** Resolve options from the call arguments: use object literals directly; resolve identifiers against top-level consts; anything else is recorded as unresolvable. */
function resolveOptionsArg(ts, args, consts) {
  for (const a of args.slice(0, 2)) {
    if (ts.isObjectLiteralExpression(unwrapAssertion(ts, a))) {
      return { object: unwrapAssertion(ts, a), unresolvedName: null };
    }
    if (ts.isIdentifier(a)) {
      const bound = consts.get(a.text);
      if (bound && ts.isObjectLiteralExpression(bound)) return { object: bound, unresolvedName: null };
      return { object: undefined, unresolvedName: a.text };
    }
  }
  return { object: undefined, unresolvedName: null };
}

/**
 * Classify the callee of a CallExpression: the test/it or describe family.
 * @returns {{ family: 'test' | 'describe', mode: 'plain' | 'skip' | 'todo' } | null}
 */
function classifyCallee(ts, callee, bindings) {
  const check = (ident, viaNamespace) => {
    if (bindings.testFn.has(ident)) return { family: 'test', mode: 'plain' };
    if (bindings.describeFn.has(ident)) return { family: 'describe', mode: 'plain' };
    if (viaNamespace) return null;
    return null;
  };
  if (ts.isIdentifier(callee)) return check(callee.text, false);
  if (ts.isPropertyAccessExpression(callee)) {
    let mode = 'plain';
    let base = callee;
    const prop = callee.name.text;
    if (prop === 'skip' || prop === 'todo') {
      mode = prop;
      base = callee.expression;
    }
    if (ts.isIdentifier(base)) {
      const r = check(base.text, false);
      if (r) return { family: r.family, mode };
      return null; // t.skip(...) / t.test(...) (runtime TestContext parameters) are out of scope for these rules
    }
    // namespace imports: nt.test(...) / nt.it(...) / nt.describe(...) and their .skip/.todo variants
    if (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      bindings.namespaces.has(base.expression.text)
    ) {
      const inner = base.name.text;
      if (inner === 'test' || inner === 'it') return { family: 'test', mode };
      if (inner === 'describe') return { family: 'describe', mode };
    }
    return null;
  }
  return null;
}

/**
 * Static analysis of a skip value.
 * @returns {{ hasReason: boolean, mayExecute: boolean }}
 *   hasReason: whether skip, when in effect, carries a string reason (a false literal does
 *   not trigger skip and counts as harmless);
 *   mayExecute: whether the test has any path that executes (false for constant skip).
 */
function analyzeSkipValue(ts, expr) {
  expr = unwrapAssertion(ts, expr);
  if (ts.isStringLiteralLike(expr)) return { hasReason: true, mayExecute: false };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { hasReason: true, mayExecute: true };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { hasReason: false, mayExecute: false };
  if (ts.isConditionalExpression(expr)) {
    const a = analyzeSkipValue(ts, expr.whenTrue);
    const b = analyzeSkipValue(ts, expr.whenFalse);
    return { hasReason: a.hasReason && b.hasReason, mayExecute: a.mayExecute || b.mayExecute };
  }
  // Identifier / other expressions: could be a boolean condition (no reason) or a reason
  // string; statically unconfirmable → report the violation honestly.
  return { hasReason: false, mayExecute: true };
}

function isAssignmentToSuiteEnv(ts, node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === ENV_VAR &&
    ts.isPropertyAccessExpression(node.left.expression) &&
    node.left.expression.name.text === 'env' &&
    ts.isIdentifier(node.left.expression.expression) &&
    node.left.expression.expression.text === 'process'
  );
}

/**
 * Analyze a single test source file.
 * @param {typeof import('typescript')} ts
 * @param {string} filePath display path
 * @param {string} source source text
 * @returns {HygieneReport}
 */
export function analyzeTestSource(ts, filePath, source) {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const bindings = collectTestBindings(ts, sourceFile);
  const assertBindings = collectAssertBindings(ts, sourceFile);
  const consts = collectTopLevelConsts(ts, sourceFile);
  /** @type {HygieneViolation[]} */
  const violations = [];
  const stats = { testCalls: 0, skipCalls: 0, todoCalls: 0, subtestCalls: 0 };

  const scopeStack = [{ domVars: new Map(), domListVars: new Map() }];
  const lookupScope = (kind, name) => {
    for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
      if (scopeStack[i][kind].has(name)) return scopeStack[i][kind].get(name);
    }
    return false;
  };
  const lookupDomVar = (name) => lookupScope('domVars', name);
  const lookupDomListVar = (name) => lookupScope('domListVars', name);
  const assignScope = (kind, name, value) => {
    for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
      if (scopeStack[i][kind].has(name)) {
        scopeStack[i][kind].set(name, value);
        return;
      }
    }
    scopeStack[scopeStack.length - 1][kind].set(name, value);
  };
  const isScopeNode = (node) =>
    ts.isBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node);

  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const namePreview = (call) => {
    const first = call.arguments[0];
    if (first && ts.isStringLiteralLike(first)) return first.text.slice(0, 40);
    return '<unnamed>';
  };

  /**
   * @param {import('typescript').Node} node
   * @param {boolean} inheritedTimeout whether a timeout declared by an outer describe/parent test covers this call
   */
  const visit = (node, inheritedTimeout) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const top = scopeStack[scopeStack.length - 1];
      const isDom = node.initializer
        ? isDomNodeExpr(ts, node.initializer, lookupDomVar, lookupDomListVar)
        : false;
      const isList = node.initializer
        ? isDomCollectionExpr(ts, node.initializer, lookupDomListVar)
        : false;
      top.domVars.set(node.name.text, isDom);
      top.domListVars.set(node.name.text, isList);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignScope('domVars', node.left.text, isDomNodeExpr(ts, node.right, lookupDomVar, lookupDomListVar));
      assignScope('domListVars', node.left.text, isDomCollectionExpr(ts, node.right, lookupDomListVar));
    }

    if (ts.isCallExpression(node)) {
      const assertMethod = classifyAssertCall(ts, node.expression, assertBindings);
      if (assertMethod && node.arguments.length >= 2) {
        const leftIsDom = isDomNodeExpr(ts, node.arguments[0], lookupDomVar, lookupDomListVar);
        const rightIsDom = isDomNodeExpr(ts, node.arguments[1], lookupDomVar, lookupDomListVar);
        const unsafe = SINGLE_ARG_DOM_UNSAFE.has(assertMethod)
          ? leftIsDom || rightIsDom
          : BOTH_ARG_DOM_UNSAFE.has(assertMethod) && leftIsDom && rightIsDom;
        if (unsafe) {
          violations.push({
            file: filePath,
            line: lineOf(node),
            rule: 'unsafe-dom-assert',
            message: `assert.${assertMethod}(...) must not be called on DOM/Window nodes (on failure util.inspect walks the DOM/Fiber tree and can hang or OOM); use assert.ok(el === null, ...) or assert.ok(a === b, ...) instead`,
          });
        }
      }

      const cls = classifyCallee(ts, node.expression, bindings);
      const isSubtestCall =
        !cls &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'test' &&
        ts.isIdentifier(node.expression.expression) &&
        !bindings.testFn.has(node.expression.expression.text);
      if (cls || isSubtestCall) {
        const { object: options, unresolvedName } = resolveOptionsArg(ts, node.arguments, consts);
        const timeoutProp = findOptionProp(ts, options, 'timeout');
        const skipProp = findOptionProp(ts, options, 'skip');
        const hasTimeout = Boolean(timeoutProp) || unresolvedName !== null;

        if (isSubtestCall) {
          stats.subtestCalls += 1; // counted for reporting only; no rules applied
        } else if (cls.family === 'describe') {
          if (cls.mode === 'skip' && !(skipProp && analyzeSkipProp(skipProp).hasReason)) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'skip-without-reason',
              message: `describe.skip("${namePreview(node)}") has no reason: declare { skip: 'reason' } in the options`,
            });
          }
        } else if (cls.mode === 'todo') {
          stats.todoCalls += 1; // todo never executes; exempt from every rule
        } else if (cls.mode === 'skip') {
          stats.skipCalls += 1;
          const value = skipProp && ts.isPropertyAssignment(skipProp) ? analyzeSkipProp(skipProp) : undefined;
          if (!value?.hasReason) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'skip-without-reason',
              message: `test.skip("${namePreview(node)}") has no reason: declare { skip: 'reason' } in the options`,
            });
          }
        } else {
          stats.testCalls += 1;
          const skipAnalysis =
            skipProp && ts.isPropertyAssignment(skipProp)
              ? analyzeSkipProp(skipProp)
              : { hasReason: true, mayExecute: true };
          if (!skipAnalysis.hasReason) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'skip-without-reason',
              message: `"${namePreview(node)}" skips without a reason: use { skip: 'reason' } or the conditional form 'reason' : false`,
            });
          }
          if (skipAnalysis.mayExecute && !hasTimeout && !inheritedTimeout) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'timeout-missing',
              message: `"${namePreview(node)}" lacks an explicit timeout (its own options, a shared const object, or an outer describe all count; the runner default is only 20s)`,
            });
          }
        }
        // node:test semantics: subtests without a declared timeout inherit the parent timeout.
        node.forEachChild((c) => visit(c, inheritedTimeout || Boolean(hasTimeout)));
        return;
      }
    }
    if (isAssignmentToSuiteEnv(ts, node)) {
      violations.push({
        file: filePath,
        line: lineOf(node),
        rule: 'suite-timeout-env',
        message: `assigning to process.env.${ENV_VAR} is forbidden (kernel env-registry-races relies on host HELM_* being stripped; injecting it causes false positives)`,
      });
    }
    if (isScopeNode(node)) {
      scopeStack.push({ domVars: new Map(), domListVars: new Map() });
      try {
        node.forEachChild((c) => visit(c, inheritedTimeout));
      } finally {
        scopeStack.pop();
      }
      return;
    }
    node.forEachChild((c) => visit(c, inheritedTimeout));
  };

  /** skip PropertyAssignment → { hasReason, mayExecute } (reuses analyzeSkipValue inside the closure). */
  function analyzeSkipProp(prop) {
    return analyzeSkipValue(ts, prop.initializer);
  }

  sourceFile.forEachChild((n) => visit(n, false));
  violations.sort((a, b) => a.line - b.line);
  return { violations, stats };
}

/** Collect all test files across the repo (same enumeration scope as scripts/test-suites.mjs: *.test.ts / *.test.tsx under each package's test dir). */
export function collectAllTestFiles(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let testEntries;
    try {
      testEntries = readdirSync(path.join(packagesDir, e.name, 'test'), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of testEntries) {
      if (f.isFile() && TEST_SUFFIXES.some((s) => f.name.endsWith(s))) {
        files.push(`packages/${e.name}/test/${f.name}`);
      }
    }
  }
  return files.sort();
}

/** Whether a repo-root-relative path counts as a test file for this tool. */
export function isTestFilePath(file) {
  return TEST_SUFFIXES.some((s) => file.endsWith(s));
}
