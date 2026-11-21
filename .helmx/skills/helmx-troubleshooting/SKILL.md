---
name: helmx-troubleshooting
description: Use when running long test suites, merging worktrees, debugging UI/production discrepancies, or hitting happy-dom/Radix/TypeScript/worktree gotchas in the helmx repository.
---

# Helmx Engineering & Troubleshooting Playbook

## 1. Long Verification Gates & Worktrees

- `pnpm test:all` takes ~9–10 min and exceeds the 600s bash cap: run via `setsid nohup env TEST_CONCURRENCY=8 pnpm test:integration >"<log>" 2>&1 </dev/null &` with a single-call bounded poll (`kill -0 $PID` + deadline) instead of `sleep N; tail` or bare `&` (which dies on disconnect).
- Fast day-to-day feedback: `pnpm test:unit` (~40–60s) and `pnpm check:changed`.
- First run in a fresh worktree: `pnpm install --prefer-offline && pnpm build`.
- Before killing any `test-suites` / `node` process found by inspection, check full `ps` argv for the worktree path — another agent's worktree may be running its own gate.

## 2. Merge Verification Shortcuts

- After `git merge --no-ff <branch>` into `main`, if `git rev-parse HEAD^{tree}` matches the verified branch tree byte-for-byte, no redundant full rerun is needed.
- If `main` advanced concurrently during worktree verification, check that both sides' changed files do not intersect, then run `pnpm build` + affected tests on the merged tree before pushing.
- Parallel slices can be integrated cleanly via same-origin `cherry-pick` so git deduplicates shared commits.

## 3. UI & Production Debugging

- **Two UI surfaces disagree**: compare the ruling function vs the fed facts first (same vocabulary over different inputs is the most common split).
- **UI appears unresponsive**: inspect server-side facts first (timestamps, batching, state transitions) before blaming projection or rendering.
- **User reports "still unchanged"**: verify `docker inspect helmx-hub` image build/start time and container `dist` against `git log` before assuming a semantic bug.
- **Read-only production inspection**: `HELMX_TOKEN` and `HELMX_HUB_URL` work directly with `curl` against production HTTP/SSE; for SQLite inspection use `python3` (`sqlite3` CLI is not installed; tokens are stored as digests only).

## 4. Test, Happy-DOM, Radix & TypeScript Gotchas

- `node:assert/strict`'s `assert.equal` carries `asserts` narrowing: for DOM null assertions use `assert.ok(x === null)` to avoid `never` narrowing traps.
- Radix Dialog in happy-dom tests: pass `inline: true` to assert inside the test container without portal chasing.
- Happy-dom interactive Radix overlays (`Select`, `DropdownMenu`, `HostStoreProviders`): dynamically `await import(...)` modules that pull in `@helmx/plugin-client` **after** `ensureHappyDom()`, and open menus with `new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })`.
- TypeScript `Array.prototype.find()` narrowing does not persist inside nested callbacks — bind to a `const` or assert before the closure.
- Deterministic timing-window tests: widen the window with injectable seams (e.g. deferred `fetchFn`) rather than betting on fixed `sleep`.
- Package-local scripts: run `pnpm exec tsx` from inside the owning package directory (workspace deps do not resolve from repo root); run lint via repo root `pnpm lint` (or inside package dir) rather than `pnpm --filter <pkg> exec oxlint`.
- Known non-regression `main` flakes (re-run standalone before chasing): `url-hash-screen-params` bare run ("React is not defined", passes under `test:unit`/`test:all`), `herdr.test.ts` abort timeout under 16-way concurrency (passes standalone), `packages/cli/test/check-changed.test.ts` SIGKILL PID marker race under heavy load (passes standalone).

## 5. Web Extensions & Forked Worktrees

- `timelineRenderer` is global with no scope isolation and returning `null` does not fall back to default rendering: claim entries strictly via `meta.renderer` + `kinds`, never by loose text sniffing.
- Navigation triggered from inside a drawer must close the drawer first (`store.openTarget` handles this uniformly).
- Fast Refresh: `.tsx` files may only export React components and TS types — move pure functions/constants to sibling `.ts` modules.
- Spawning a `fork` subagent with a custom `cwd` can pin the parent session's bash `cwd` to that path; if a removed worktree causes bash `spawn_error`, recreating the directory (e.g. writing and then deleting a placeholder file) restores bash execution.
