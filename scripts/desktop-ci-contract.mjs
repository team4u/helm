#!/usr/bin/env node
/**
 * CI contract checks for packages/desktop (the future Electron desktop app), invoked by
 * .github/workflows/desktop-ci.yml and also runnable locally.
 *
 * Why it exists: the desktop package does not exist yet; Desktop CI must skip by design
 * while it is absent and join full-platform verification the moment it lands. Both depend
 * on really probing packages/desktop, with no silent degradation:
 *   - Root `pnpm build` (pnpm -r build) silently skips packages without a build script —
 *     when desktop lacks one, the workspace build looks green while the Electron artifact
 *     is missing; that must be intercepted here with a diagnosis;
 *   - Whether desktop has its own test script decides whether Linux wraps execution in
 *     xvfb-run (Electron smoke needs a virtual display); the workflow branches on that
 *     fact and never invents a script.
 *
 * Usage:
 *   node scripts/desktop-ci-contract.mjs --detect
 *     Detect only: stdout prints just true/false (for the workflow to capture), human
 *     readable notes go to stderr, always exits 0.
 *   node scripts/desktop-ci-contract.mjs [--github-output <file>]
 *     Full contract check: violations print diagnostics and exit 2; when <file> (i.e.
 *     $GITHUB_OUTPUT) is given, machine-readable desktop_name / desktop_has_test are
 *     appended for later conditional steps.
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
  console.error(`[desktop-ci] contract violation: ${message}`);
  process.exit(2);
}

function note(message) {
  console.error(`[desktop-ci] note: ${message}`);
}

// package.json is the source of truth for package existence: an empty or partial directory
// does not count, avoiding accidentally enabling the matrix.
const desktopExists = existsSync(pkgPath);

if (detectOnly) {
  if (desktopExists) {
    console.error('[desktop-ci] packages/desktop detected; the Desktop CI full-platform matrix will be enabled.');
  } else {
    console.error('[desktop-ci] packages/desktop/package.json not detected; the desktop matrix jobs will skip by design (merge is not blocked).');
  }
  console.log(desktopExists ? 'true' : 'false');
  process.exit(0);
}

if (!desktopExists) {
  // Reaching here means the workflow gate (--detect) disagrees with this step — an
  // orchestration bug, not a degradable scenario.
  fail(`packages/desktop/package.json is absent, yet the full contract check was requested — desktop-ci.yml's conditional orchestration is inconsistent; check the gate and the matrix jobs' if conditions. Probe path: ${pkgPath}`);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  fail(`packages/desktop/package.json could not be read/parsed: ${err.message}`);
}

const problems = [];
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  problems.push('package.json is missing the name field (pnpm workspace filtering and recursive scheduling both rely on it).');
}

const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
if (typeof scripts.build !== 'string' || scripts.build.length === 0) {
  problems.push(
    'package.json does not declare scripts.build: root pnpm build (pnpm -r build) silently skips packages without a build script, ' +
      'so a missing Electron artifact never fails the workspace build; add the build script for the desktop package.',
  );
}
const hasTest = typeof scripts.test === 'string' && scripts.test.length > 0;
if (!hasTest) {
  note('package.json does not declare scripts.test: desktop-owned tests do not run separately (the workspace suites still cover registered packages).');
}

// Warning level: when test files exist but SUITES is not registered, the
// scripts/test-suites.mjs invariant makes test:unit / test:all fail explicitly; surface
// the reason here instead of discovering it at the test step.
const testDir = path.join(desktopDir, 'test');
if (existsSync(testDir)) {
  const hasTestFiles = readdirSync(testDir).some((f) => TEST_SUFFIXES.some((s) => f.endsWith(s)));
  if (hasTestFiles) {
    const suitesSrc = readFileSync(path.join(repoRoot, 'scripts', 'test-suites.mjs'), 'utf8');
    if (!/['"]desktop['"]/.test(suitesSrc)) {
      note(
        'packages/desktop/test already has test files, but scripts/test-suites.mjs SUITES has not registered a desktop tier; ' +
          'test:unit / test:all will fail explicitly on the suite invariant (by design) — register SUITES first.',
      );
    }
  }
}

// Warning level: the root typecheck only covers tsconfig.check.json's includes; if desktop
// sources are not included, this workflow's typecheck step does nothing for desktop —
// avoiding an all-green illusion.
const checkTsconfig = readFileSync(path.join(repoRoot, 'tsconfig.check.json'), 'utf8');
if (!checkTsconfig.includes('packages/desktop')) {
  note('tsconfig.check.json does not include packages/desktop yet: root pnpm typecheck will not check desktop sources; add the include when it lands.');
}

for (const p of problems) fail(p);

if (outputPath) {
  appendFileSync(outputPath, `desktop_name=${pkg.name}\n`);
  appendFileSync(outputPath, `desktop_has_test=${hasTest}\n`);
}
console.error(`[desktop-ci] packages/desktop (${pkg.name}) passed the contract check.`);
process.exit(0);
