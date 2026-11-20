/** Shared test-runner concurrency policy. */

export const DEFAULT_TEST_CONCURRENCY = 16;

/**
 * Resolve the default worker budget for one worktree.
 * @param {string | undefined} raw
 * @param {number} availableParallelism
 * @returns {number}
 */
export function resolveTestConcurrency(raw, availableParallelism) {
  const hostCapacity = Math.max(1, Math.floor(availableParallelism));
  if (raw === undefined || raw === '') return Math.min(DEFAULT_TEST_CONCURRENCY, hostCapacity);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`TEST_CONCURRENCY must be a positive integer, received: ${raw}`);
  }
  return value;
}

/** @param {string[]} args */
export function explicitTestConcurrency(args) {
  const index = args.findIndex((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
  if (index < 0) return undefined;
  const arg = args[index];
  const raw = arg === '--test-concurrency' ? args[index + 1] : arg.slice('--test-concurrency='.length);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`--test-concurrency must be a positive integer, received: ${String(raw)}`);
  }
  return value;
}

/**
 * Add the resolved worker budget unless the caller already supplied the Node runner flag.
 * @param {string[]} args
 * @param {number} concurrency
 * @returns {string[]}
 */
export function withDefaultTestConcurrency(args, concurrency) {
  return explicitTestConcurrency(args) === undefined ? [`--test-concurrency=${concurrency}`, ...args] : args;
}
