/**
 * 测试卫生静态分析（TypeScript Compiler API，不引入任何新 lint 依赖）。
 *
 * 覆盖 AGENTS §5 的三条可静态判定的规则：
 *   timeout-missing       每个 test()/it() 调用必须显式声明 options.timeout（自有、
 *                         共享 const 选项对象、或按 node:test 语义继承自外层
 *                         describe/父测试的 timeout，三者任一即算已声明）；
 *   skip-without-reason   skip 必须附理由字符串（{ skip: true }、裸 test.skip、
 *                         无法静态确认带理由的 skip 条件均视为违规）；
 *   suite-timeout-env     禁止给 process.env.HELM_TEST_SUITE_TIMEOUT_MS 赋值
 *                         （kernel env-registry-races 依赖宿主 HELM_* 被剥除，注入即误报）；
 *   unsafe-dom-assert     禁止对 DOM 节点 / Window 调用 assert.equal / strictEqual /
 *                         deepEqual / deepStrictEqual / notDeepEqual / notDeepStrictEqual
 *                         （或双侧均为 DOM 节点的 notEqual / notStrictEqual），避免失败时
 *                         util.inspect 递归遍历整棵 DOM/React Fiber 树引发卡死或 OOM。
 *
 * 识别范围：node:test 的具名导入（test/it/describe，含 as 别名）、默认导入、命名空间导入
 * （import * as nt 后 nt.test/nt.it/nt.describe，含 .skip/.todo 变体）。todo 不执行 →
 * 豁免全部规则；恒定 skip（skip 值为字符串字面量）不执行 → 豁免 timeout；条件 skip
 * 可能执行 → 仍需 timeout。options 可为本文件顶层 const 绑定的共享对象
 * （如 `const timeout = { timeout: 60_000 } as const`，含 as const 解包）。
 * t.test() 子测试暂不纳入规则（继承语义复杂、存量多未声明，单独计数报告，
 * 不静默豁免也不冒进全量改写——是否收紧由人决定）。不做正则解析：嵌套调用、
 * 多行 options、别名一律靠 AST 结构判定。
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

/** 收集 node:assert / node:assert/strict 的导入绑定（默认、具名/别名、命名空间、strict）。 */
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

/** 解包括号、as / 类型断言 / satisfies / 非空断言。 */
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

/** 收集 node:test 的导入绑定：testFn（test/it，含别名）、describe、命名空间。 */
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
    if (clause.name) testFn.add(clause.name.text); // 默认导出即 test 函数
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text; // as 别名时 propertyName 是源名
        if (imported === 'test' || imported === 'it') testFn.add(el.name.text);
        else if (imported === 'describe') describeFn.add(el.name.text);
      }
    }
    if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
  }
  return { testFn, describeFn, namespaces };
}

/** 解包 as const / 类型断言 / satisfies，露出真正的初始化表达式。 */
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

/** 收集本文件顶层 const 绑定（identifier → 初始化表达式），供共享 options 对象解析。 */
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

/** options 对象里的指定属性（仅 PropertyAssignment 形式），供 timeout/skip 判定。 */
function findOptionProp(ts, options, name) {
  for (const p of options?.properties ?? []) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p;
  }
  return undefined;
}

/** 解析调用实参里的 options：对象字面量直接用；标识符查顶层 const；其余记为不可解析。 */
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
 * 判定 CallExpression 的被调者：test/it 或 describe 家族。
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
      return null; // t.skip(...) / t.test(...)（TestContext 运行时参数）不在本规则范围
    }
    // 命名空间导入：nt.test(...) / nt.it(...) / nt.describe(...) 及其 .skip/.todo 变体
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
 * skip 值静态分析。
 * @returns {{ hasReason: boolean, mayExecute: boolean }}
 *   hasReason：skip 生效时是否带字符串理由（false 字面量不触发 skip，视为无害）；
 *   mayExecute：该测试是否存在被执行的路径（恒定 skip 则为 false）。
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
  // 标识符 / 其他表达式：可能是布尔条件（无理由）也可能是理由字符串，无法静态确认 → 如实报违规。
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
 * 分析单个测试源文件。
 * @param {typeof import('typescript')} ts
 * @param {string} filePath 展示用路径
 * @param {string} source 源码文本
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
    return '<无名>';
  };

  /**
   * @param {import('typescript').Node} node
   * @param {boolean} inheritedTimeout 外层 describe/父测试已声明的 timeout 是否覆盖本调用
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
            message: `禁止对 DOM/Window 节点调用 assert.${assertMethod}(...)（失败时 util.inspect 会遍历 DOM/Fiber 树导致卡死或 OOM）；请改用 assert.ok(el === null, ...) 或 assert.ok(a === b, ...)`,
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
          stats.subtestCalls += 1; // 仅计数供报告，不套规则
        } else if (cls.family === 'describe') {
          if (cls.mode === 'skip' && !(skipProp && analyzeSkipProp(skipProp).hasReason)) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'skip-without-reason',
              message: `describe.skip("${namePreview(node)}") 未附理由：请在 options 声明 { skip: '理由' }`,
            });
          }
        } else if (cls.mode === 'todo') {
          stats.todoCalls += 1; // todo 永不执行，豁免全部规则
        } else if (cls.mode === 'skip') {
          stats.skipCalls += 1;
          const value = skipProp && ts.isPropertyAssignment(skipProp) ? analyzeSkipProp(skipProp) : undefined;
          if (!value?.hasReason) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'skip-without-reason',
              message: `test.skip("${namePreview(node)}") 未附理由：请在 options 声明 { skip: '理由' }`,
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
              message: `"${namePreview(node)}" 的 skip 无理由：请用 { skip: '理由' } 或条件式 '理由' : false`,
            });
          }
          if (skipAnalysis.mayExecute && !hasTimeout && !inheritedTimeout) {
            violations.push({
              file: filePath,
              line: lineOf(node),
              rule: 'timeout-missing',
              message: `"${namePreview(node)}" 缺少显式 timeout（自有 options、共享 const 对象或外层 describe 任一均可；runner 默认仅 20s）`,
            });
          }
        }
        // node:test 语义：未声明 timeout 的子测试继承父级 timeout。
        node.forEachChild((c) => visit(c, inheritedTimeout || Boolean(hasTimeout)));
        return;
      }
    }
    if (isAssignmentToSuiteEnv(ts, node)) {
      violations.push({
        file: filePath,
        line: lineOf(node),
        rule: 'suite-timeout-env',
        message: `禁止给 process.env.${ENV_VAR} 赋值（kernel env-registry-races 依赖宿主 HELM_* 被剥除，注入会误报）`,
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

  /** skip PropertyAssignment → { hasReason, mayExecute }（闭包内复用 analyzeSkipValue）。 */
  function analyzeSkipProp(prop) {
    return analyzeSkipValue(ts, prop.initializer);
  }

  sourceFile.forEachChild((n) => visit(n, false));
  violations.sort((a, b) => a.line - b.line);
  return { violations, stats };
}

/** 全仓收集受检测试文件（与 scripts/test-suites.mjs 相同的枚举范围：各 packages 的 test 目录下 *.test.ts / *.test.tsx）。 */
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

/** 判断相对仓库根的路径是否为本工具认定的测试文件。 */
export function isTestFilePath(file) {
  return TEST_SUFFIXES.some((s) => file.endsWith(s));
}
