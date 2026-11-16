#!/usr/bin/env node
/**
 * packages/desktop(not come Electron desktop edition)CI contract check, supply .github/workflows/desktop-ci.yml
 * invoke, also can local directly execute.
 *
 * is what store in:desktop package not yet persisted,Desktop CI need to in it missing when by design skip, in it persisted after immediately
 * reference and all platform verify. two piece matter all dependency for packages/desktop real probe, and cannot static default fall back:
 *   -  `pnpm build`(pnpm -r build) will static default skip no build script package - -desktop missing build
 *     when workspace build see up all green but Electron artifact missing, must in this explicit intercept and to out diagnose;
 *   - desktop self has test script is otherwise store in, decide Linux on is otherwise need to xvfb-run package wrap execute (Electron
 *     smoke need to virtual show),workflow based on this condition orchestration, do not virtual construct script.
 *
 * use method:
 *   node scripts/desktop-ci-contract.mjs --detect
 *     only probe:stdout only output true/false(supply workflow catch), person read note away stderr, constant exit 0.
 *   node scripts/desktop-ci-contract.mjs [--github-output <file>]
 *     all amount contract check: violate rule print diagnose and exit 2; designate <file>(i.e. $GITHUB_OUTPUT) when append
 *     desktop_name / desktop_has_test machine can read output, supply after continue step do condition execute.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'packages', 'desktop');
const pkgPath = path.join(desktopDir, 'package.json');
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

const args = process.argv.slice(2);
const detectOnly = args.includes('--detect');
const outputFlagIdx = args.indexOf('--github-output');
const outputPath = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : undefined;

function fail(message) {
  console.error(`[desktop-ci] contract violate rule:${message}`);
  process.exit(2);
}

function note(message) {
  console.error(`[desktop-ci] hint:${message}`);
}

// with package.json is allow decide package is otherwise store in: empty directory or leftover missing directory do not compute package, avoid mistakenly enable matrix.
const desktopExists = existsSync(pkgPath);

if (detectOnly) {
  if (desktopExists) {
    console.error('[desktop-ci] detect to packages/desktop,Desktop CI all platform matrix enable.');
  } else {
    console.error('[desktop-ci] not detect to packages/desktop/package.json,desktop matrix task by design skip (non-blocking merge).');
  }
  console.log(desktopExists ? 'true' : 'false');
  process.exit(0);
}

if (!desktopExists) {
  // away to this in note workflow gate control (--detect) and this step result inconsistent, belongs to orchestration error while non- can fall back scenario.
  fail(`packages/desktop/package.json missing, but all amount contract check by want seek execute - -desktop-ci.yml condition orchestration inconsistent, check gate and matrix task if condition. probe path:${pkgPath}`);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  fail(`packages/desktop/package.json read/failed to parse:${err.message}`);
}

const problems = [];
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  problems.push('package.json missing name field (pnpm workspace filter and recursion scheduling all dependency package name).');
}

const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
if (typeof scripts.build !== 'string' || scripts.build.length === 0) {
  problems.push(
    'package.json not declaration scripts.build: pnpm build(pnpm -r build) will static default skip without build script package,' +
      'Electron artifact missing will not in workspace build in errors; please is desktop package patch complete build script.',
  );
}
const hasTest = typeof scripts.test === 'string' && scripts.test.length > 0;
if (!hasTest) {
  note('package.json not declaration scripts.test:desktop self has test do not separate execute (workspace set piece still override already register package).');
}

// warning level:test file already exists but not register SUITES when,scripts/test-suites.mjs invariant will let
// test:unit / test:all explicit failed, this in mention before point reason, avoid to test step only then discover.
const testDir = path.join(desktopDir, 'test');
if (existsSync(testDir)) {
  const hasTestFiles = readdirSync(testDir).some((f) => TEST_SUFFIXES.some((s) => f.endsWith(s)));
  if (hasTestFiles) {
    const suitesSrc = readFileSync(path.join(repoRoot, 'scripts', 'test-suites.mjs'), 'utf8');
    if (!/['"]desktop['"]/.test(suitesSrc)) {
      note(
        'packages/desktop/test already has test file, but scripts/test-suites.mjs  SUITES not yet register desktop Profile;' +
          'test:unit / test:all because set piece invariant explicit failed (design inside behavior), please first register SUITES.',
      );
    }
  }
}

// warning level: typecheck only override tsconfig.check.json  include,desktop source code not accept when
// this workflow typecheck step for desktop does not take effect, avoid"all green"false appearance.
const checkTsconfig = readFileSync(path.join(repoRoot, 'tsconfig.check.json'), 'utf8');
if (!checkTsconfig.includes('packages/desktop')) {
  note('tsconfig.check.json not yet accept packages/desktop: pnpm typecheck will not check desktop source code, please in persisted when patch complete include.');
}

for (const p of problems) fail(p);

if (outputPath) {
  appendFileSync(outputPath, `desktop_name=${pkg.name}\n`);
  appendFileSync(outputPath, `desktop_has_test=${hasTest}\n`);
}
console.error(`[desktop-ci] packages/desktop(${pkg.name}) contract check via.`);
process.exit(0);
