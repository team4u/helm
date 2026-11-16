/**
 * pure test file static decide and concurrency shard scheduler (TypeScript Compiler API, zero new dependency).
 *
 * is what cannot all amount open `--test-isolation=none`: contains happy-dom / GlobalRegistrator,
 * modify globalThis/window/document/process.env/console/timers, child process/network/SQLite/file write
 * or async heavy type collection into test in the same process sharing global environment when will string state or competition.
 *
 * this module only filter choose [strictly in-memory] test file (contains recursion check its reference same package test auxiliary module)
 * to K  `--test-isolation=none` shard parallel execute, remaining test keep original has process isolated.
 * when pass-through parameter explicit designate `--test-isolation` / `--test-reporter` / `--test-name-pattern`
 * etc. semantics sensitive switch when, whole retreat back single route common rule isolated execute, never change test semantics or hit chaotic output format.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const FORBIDDEN_MODULE_PREFIXES = [
  '@happy-dom',
  'happy-dom',
  'react-dom/client',
  'node:child_process',
  'child_process',
  'node:sqlite',
  'sqlite',
  'node:http',
  'http',
  'node:https',
  'https',
  'node:http2',
  'http2',
  'node:net',
  'net',
  'node:dgram',
  'dgram',
  'node:tls',
  'tls',
  'node:worker_threads',
  'worker_threads',
  'node:cluster',
  'cluster',
  '@helm/plugin-build',
];

const FORBIDDEN_FS_IMPORTS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdtemp',
  'mkdtempSync',
  'mkdir',
  'mkdirSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'rmdir',
  'rmdirSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'truncate',
  'truncateSync',
  'createWriteStream',
  'open',
  'openSync',
]);

const FORBIDDEN_CALLS = new Set([
  ...FORBIDDEN_FS_IMPORTS,
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
  'createServer',
  'listen',
  'KernelRuntime',
  'createHelm',
  'DatabaseSync',
  'runWorkflow',
  'compilePluginClientModule',
  'createRequire',
]);

const FORBIDDEN_CONSTRUCTORS = new Set(['KernelRuntime', 'DatabaseSync', 'Worker']);

const DOM_OR_GLOBAL_OBJECTS = new Set(['document', 'window', 'globalThis', 'GlobalRegistrator']);

const PROCESS_IMPURE_PROPS = new Set([
  'stdin',
  'chdir',
  'exit',
  'kill',
  'on',
  'once',
  'stdout',
  'stderr',
]);

const MUTATED_GLOBAL_IDENTIFIERS = new Set([
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'setImmediate',
  'fetch',
  'console',
]);

/** unwrap parentheses, type assertion,satisfies and non-empty assertion. */
function unwrapExpr(ts, node) {
  let cur = node;
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

function isForbiddenModule(specifier) {
  return FORBIDDEN_MODULE_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

function isFsModule(specifier) {
  return (
    specifier === 'node:fs' ||
    specifier === 'fs' ||
    specifier === 'node:fs/promises' ||
    specifier === 'fs/promises'
  );
}

function isAssignmentExpr(ts, node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function isProcessEnvExpr(ts, node) {
  const cur = unwrapExpr(ts, node);
  if (!cur || !ts.isPropertyAccessExpression(cur) || cur.name.text !== 'env') return false;
  const host = unwrapExpr(ts, cur.expression);
  return Boolean(host && ts.isIdentifier(host) && host.text === 'process');
}

function isProcessEnvMemberExpr(ts, node) {
  const cur = unwrapExpr(ts, node);
  if (!cur) return false;
  if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    return isProcessEnvExpr(ts, cur.expression);
  }
  return false;
}

function isProcessArgvExpr(ts, node) {
  const cur = unwrapExpr(ts, node);
  if (!cur || !ts.isPropertyAccessExpression(cur) || cur.name.text !== 'argv') return false;
  const host = unwrapExpr(ts, cur.expression);
  return Boolean(host && ts.isIdentifier(host) && host.text === 'process');
}

/** collect file in all runtime import identifier symbol (exclude pure type import). */
function collectRuntimeImportBindings(ts, sourceFile) {
  const bindings = new Set();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
    const { name, namedBindings } = st.importClause;
    if (name) bindings.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.add(namedBindings.name.text);
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const el of namedBindings.elements) {
        if (!el.isTypeOnly) bindings.add(el.name.text);
      }
    }
  }
  return bindings;
}

/** from test file path parse same warehouse test directory inside each other for auxiliary module path. */
export function resolveRelativeTestHelper(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const raw = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [raw];
  if (raw.endsWith('.js') || raw.endsWith('.jsx')) {
    const stem = raw.slice(0, raw.endsWith('.jsx') ? -4 : -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (raw.endsWith('.mjs')) {
    candidates.push(`${raw.slice(0, -4)}.mts`);
  } else if (raw.endsWith('.cjs')) {
    candidates.push(`${raw.slice(0, -4)}.cts`);
  } else {
    candidates.push(
      `${raw}.ts`,
      `${raw}.tsx`,
      `${raw}.mts`,
      `${raw}.js`,
      `${raw}.mjs`,
      path.join(raw, 'index.ts'),
      path.join(raw, 'index.tsx'),
    );
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        // only recursion with enter at test directory inside auxiliary module/fixture; do not across by test src directory.
        const parts = candidate.split(path.sep);
        if (parts.includes('test')) return candidate;
      }
    } catch {
      // ignore invalid path
    }
  }
  return null;
}

/**
 * static analyze single test source code (and optional each other for auxiliary module parse) process isolated security.
 * @param {typeof import('typescript')} ts
 * @param {string} filePath
 * @param {string} source
 * @param {(fromFile: string, specifier: string) => { path: string, source: string } | null} [resolveHelper]
 * @param {Set<string>} [visited]
 * @returns {{ pure: boolean, reasons: string[] }}
 */
export function analyzeTestSourcePurity(
  ts,
  filePath,
  source,
  resolveHelper = undefined,
  visited = new Set(),
) {
  if (visited.has(filePath)) return { pure: true, reasons: [] };
  visited.add(filePath);

  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const importedBindings = collectRuntimeImportBindings(ts, sourceFile);
  const reasons = new Set();

  const visitHelper = (specifier) => {
    if (!resolveHelper || !specifier.startsWith('.')) return;
    const helper = resolveHelper(filePath, specifier);
    if (!helper) return;
    const sub = analyzeTestSourcePurity(ts, helper.path, helper.source, resolveHelper, visited);
    for (const r of sub.reasons) reasons.add(r);
  };

  const checkMutatedTarget = (targetExpr, contextLabel) => {
    const target = unwrapExpr(ts, targetExpr);
    if (!target) return;
    if (ts.isIdentifier(target)) {
      if (DOM_OR_GLOBAL_OBJECTS.has(target.text) || MUTATED_GLOBAL_IDENTIFIERS.has(target.text)) {
        reasons.add(`${contextLabel}:${target.text}`);
      } else if (importedBindings.has(target.text)) {
        reasons.add(`${contextLabel}:imported:${target.text}`);
      }
      return;
    }
    if (isProcessEnvExpr(ts, target)) {
      reasons.add(`${contextLabel}:process.env`);
    }
  };

  const visit = (node) => {
    // type node produces no runtime behavior.
    if (ts.isTypeNode(node)) return;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      const nb = clause?.namedBindings;
      const allNamedTypeOnly =
        !clause?.name &&
        nb &&
        ts.isNamedImports(nb) &&
        nb.elements.length > 0 &&
        nb.elements.every((el) => el.isTypeOnly);
      if (allNamedTypeOnly) return;

      const mod = node.moduleSpecifier.text;
      if (isForbiddenModule(mod)) reasons.add(`import:${mod}`);
      if (isFsModule(mod) && nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          const importedName = (el.propertyName ?? el.name).text;
          if (FORBIDDEN_FS_IMPORTS.has(importedName)) {
            reasons.add(`import-fs:${importedName}`);
          }
        }
      }
      visitHelper(mod);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = unwrapExpr(ts, node.expression);
      const prop = ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
      if (obj && ts.isIdentifier(obj)) {
        if (DOM_OR_GLOBAL_OBJECTS.has(obj.text)) {
          reasons.add(`global:${obj.text}${prop ? `.${prop}` : '[]'}`);
        }
        if (obj.text === 'process' && prop && PROCESS_IMPURE_PROPS.has(prop)) {
          reasons.add(`process.${prop}`);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        (prop === 'timers' || prop === 'method') &&
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === 'mock'
      ) {
        reasons.add(`mock.${prop}`);
      }
      if (ts.isPropertyAccessExpression(node) && prop === 'timers' && obj && ts.isIdentifier(obj) && obj.text === 'mock') {
        reasons.add('mock.timers');
      }
    }

    if (ts.isDeleteExpression(node) && isProcessEnvMemberExpr(ts, node.expression)) {
      reasons.add('delete:process.env');
    }

    if (isAssignmentExpr(ts, node)) {
      const left = unwrapExpr(ts, node.left);
      if (isProcessEnvExpr(ts, left) || isProcessEnvMemberExpr(ts, left)) {
        reasons.add('assign:process.env');
      } else if (isProcessArgvExpr(ts, left)) {
        reasons.add('assign:process.argv');
      } else if (left && ts.isIdentifier(left) && MUTATED_GLOBAL_IDENTIFIERS.has(left.text)) {
        reasons.add(`override:${left.text}`);
      } else if (
        left &&
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(unwrapExpr(ts, left.expression)) &&
        MUTATED_GLOBAL_IDENTIFIERS.has(unwrapExpr(ts, left.expression).text)
      ) {
        reasons.add(`override:${unwrapExpr(ts, left.expression).text}.${left.name.text}`);
      }
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        const arg0 = unwrapExpr(ts, node.arguments[0]);
        if (arg0 && ts.isStringLiteralLike(arg0)) {
          if (isForbiddenModule(arg0.text)) reasons.add(`dyn-import:${arg0.text}`);
          visitHelper(arg0.text);
        } else {
          reasons.add('dyn-import:dynamic');
        }
      }

      const callee = unwrapExpr(ts, node.expression);
      if (callee && ts.isIdentifier(callee)) {
        if (callee.text === 'require' && node.arguments.length >= 1) {
          const arg0 = unwrapExpr(ts, node.arguments[0]);
          if (arg0 && ts.isStringLiteralLike(arg0)) {
            if (isForbiddenModule(arg0.text)) reasons.add(`require:${arg0.text}`);
          } else {
            reasons.add('require:dynamic');
          }
        }
        if (FORBIDDEN_CALLS.has(callee.text)) {
          reasons.add(`call:${callee.text}`);
        }
      } else if (callee && ts.isPropertyAccessExpression(callee)) {
        const host = unwrapExpr(ts, callee.expression);
        const method = callee.name.text;
        if (host && ts.isIdentifier(host) && host.text === 'GlobalRegistrator' && method === 'register') {
          reasons.add('call:GlobalRegistrator.register');
        } else if (FORBIDDEN_CALLS.has(method)) {
          // regex literal `/.../.exec(str)` is in-memory invoke, non- `child_process.exec`.
          if (!(method === 'exec' && host && ts.isRegularExpressionLiteral(host))) {
            reasons.add(`call:${method}`);
          }
        }
        if (
          host &&
          ts.isIdentifier(host) &&
          ((host.text === 'Object' && (method === 'assign' || method === 'defineProperty' || method === 'defineProperties')) ||
            (host.text === 'Reflect' && (method === 'set' || method === 'defineProperty' || method === 'deleteProperty'))) &&
          node.arguments.length >= 1
        ) {
          checkMutatedTarget(node.arguments[0], `${host.text}.${method}`);
        }
        if (isProcessArgvExpr(ts, host)) {
          reasons.add(`mutate:process.argv.${method}`);
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const cls = unwrapExpr(ts, node.expression);
      if (cls && ts.isIdentifier(cls) && FORBIDDEN_CONSTRUCTORS.has(cls.text)) {
        reasons.add(`new:${cls.text}`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  const sorted = [...reasons].sort();
  return { pure: sorted.length === 0, reasons: sorted };
}

/**
 * analyze disk on single test file (automatically parse and recursion check each other for auxiliary module).
 * @param {typeof import('typescript')} ts
 * @param {string} absFilePath
 * @returns {{ pure: boolean, reasons: string[] }}
 */
export function analyzeTestFilePurity(ts, absFilePath) {
  let source;
  try {
    source = readFileSync(absFilePath, 'utf8');
  } catch (err) {
    return { pure: false, reasons: [`read-error:${err.message}`] };
  }
  const resolveHelper = (fromFile, specifier) => {
    const resolved = resolveRelativeTestHelper(fromFile, specifier);
    if (!resolved) return null;
    try {
      return { path: resolved, source: readFileSync(resolved, 'utf8') };
    } catch {
      return { path: resolved, source: '' };
    }
  };
  return analyzeTestSourcePurity(ts, absFilePath, source, resolveHelper, new Set());
}

/** decide pass-through parameter is otherwise will change runner isolated, concurrency or output report format. */
export function shouldDisableSharding(extraArgs) {
  return extraArgs.some((arg) => {
    if (arg === '-t' || arg === '--watch' || arg === '--test-only' || arg === '--test-force-exit') {
      return true;
    }
    return [
      '--test-isolation',
      '--test-name-pattern',
      '--test-reporter',
      '--test-reporter-destination',
      '--test-shard',
      '--test-concurrency',
    ].some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`));
  });
}

/**
 * test file collection split is can sharing isolated shard (LPT load all balance) and must process isolated file list.
 * @param {{ ts: typeof import('typescript'), repoRoot: string, files: string[], cpus: number, filesPerShard?: number, weightFn: (relPath: string) => number }} input
 * @returns {{ pureFiles: string[], isolatedFiles: string[], shards: string[][] }}
 */
export function partitionFilesForSharding({
  ts,
  repoRoot,
  files,
  cpus,
  filesPerShard = 8,
  weightFn,
}) {
  const pureFiles = [];
  const isolatedFiles = [];
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (analyzeTestFilePurity(ts, abs).pure) pureFiles.push(rel);
    else isolatedFiles.push(rel);
  }

  const byWeightDesc = (a, b) => weightFn(b) - weightFn(a) || a.localeCompare(b);
  pureFiles.sort(byWeightDesc);
  isolatedFiles.sort(byWeightDesc);

  if (pureFiles.length === 0) {
    return { pureFiles, isolatedFiles, shards: [] };
  }

  const shardCount = Math.min(
    Math.max(1, cpus),
    Math.max(1, Math.ceil(pureFiles.length / filesPerShard)),
  );
  const buckets = Array.from({ length: shardCount }, () => ({ weight: 0, files: /** @type {string[]} */ ([]) }));

  for (const rel of pureFiles) {
    let lightest = buckets[0];
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i].weight < lightest.weight) lightest = buckets[i];
    }
    lightest.files.push(rel);
    lightest.weight += weightFn(rel);
  }

  const shards = buckets.map((b) => b.files).filter((list) => list.length > 0);
  return { pureFiles, isolatedFiles, shards };
}
