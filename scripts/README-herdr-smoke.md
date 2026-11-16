# herdr-smoke.mjs - `builtin:herdr` true link manually work verify script

independent manually work verify script,**do not accept `pnpm test`**(dependency real Herdr service, real pi CLI and real model credentials, will produce real model invoke). by human in merge eventually code after execute:

```bash
pnpm build                                  # first produce out packages/hub/dist and packages/plugins/dist
node scripts/herdr-smoke.mjs                # by default provider=magpie model=zhipu/glm-5.3
node scripts/herdr-smoke.mjs --json         # stdout exactly a eventually JSON(enter in stderr)
node scripts/herdr-smoke.mjs --keep-tmp     # after success keep temporary (contains complete herdr server log)
node scripts/herdr-smoke.mjs --timeout-ms 600000   # put wide total timeout (60000..1800000)
```

by default load script same warehouse `packages/hub/dist/app.js`; available `HERDR_SMOKE_KERNEL_APP=/path/to/app.js` points to other compile artifact (such as another worktree  build).

exit code 0 = all verify items PASS and clean up without failed; non- 0 = store in FAIL(verify items failed or clean up failed). enter and `PASS/FAIL` one by one items write stderr; failed live and log keep in temporary. main dry `createHelm` registered by default deactivate `builtin:herdr`, script negative duty config and enable; compile artifact must and when before source code sync.

## verify content (all real component, zero mock / zero skip)

1. **real compile artifact**:`packages/hub/dist/app.js`  `createHelm`(not build i.e. explicit failed).
2. **real plugin lifecycle**:`plugins.setConfig('builtin:herdr', { session, socketPath, startupTimeoutMs: 30000 })` → `plugins.enable`.
3. **real Profile API**:`kernel.profiles.save({ id: 'herdr-smoke-pi', runtime: { kind: 'herdr', agent: 'pi', args: [...] } })`.
4. **real GLM model**: preflight `pi --list-models` confirm target model in column (credentials unavailable then explicit failed, never swap by default model),Profile args pass `--provider magpie --model zhipu/glm-5.3 --thinking off -a --no-session`.
5. **real workflow**:`workflows.run(script)` → `wait`:
   - node one:`agent(prompt, { label:'task', agentType:'herdr-smoke-pi', isolation:'worktree', schema:{answer:number}, gate })`- - plugin via `herdr worktree create --trust-repository` create isolated worktree,pi in among them create `artifact.txt`(three row),gate real verify;
   - node two:`agent(prompt, { resume:'task' })` in**the same Herdr pane** continue chat.
6. **original run assertion**: result field (`first.answer === 3`,`second` non-empty), two node `executionId` identical,Gate only one node `ok=true` and shell side `gate-count` exactly one row,worktree directory/branch in run compute after keep,`artifact.txt` content one by one byte core for. create entrust dispatch before, script explicit open original repository work zone as already has pane baseline; compute after, real `session.snapshot` in pane/tab/workspace/agent ID set must precise restore baseline, since leaves no residue new increase entrust dispatch asset, also does not close already has pane.
7. **`resumeFromRunId` strictly replay (engine fix target contract)**:
   - `result2` and `result1` **deep each other etc.**(`assert.deepStrictEqual`);
   - replay run two agent node all `done` and `cached=true`(cache hit while non- live heavy run);
   - via transparent wrap**produce transport**(`createHerdrTransport`, same dist directory import, only counter do not change behavior) counter `agent.start` / `agent.prompt` RPC invoke**zero increase long**(original run counter do not hard encode, allows once legal self-heal, only compare replay before after);
   - Gate do not heavy run (`gate-count` still exactly one row);
   - snapshot precise restore already has pane baseline (zero new increase asset).

cache node do not want seek carry original run  `executionId`/`worktree` metadata (original run already verify these), replay only verify**without new invoke, without new asset, result consistent**.

### engine fix target (background)

old engine implement in `journalResumes`(ledger contains `agent({resume})` row) will global close prefix replay (`prefixIntact=false`), leads to `resumeFromRunId` for contains resume script repeat execution succeeded node. main dry already fix is one by one items match:**identical script all succeeded agent/resume/action prefix directly re- use result; prefix lose match after, attempt resume only store in at cache in sub- context when explicit failed**. the fix has independent side effect counter regression. this script enter one step verify real model original run after cache replay.

## transfer layer and counter

- import `packages/plugins/dist/herdr/transport.js`  `createHerdrTransport`(produce implement);
- `createTracedTransport` transparent wrap: only by `method` counter `agent.start` / `agent.prompt`,`call` and the rest method fully pass-through,**never mock return**;
- wrap after transport inject `createHelm({ herdrTransport })`, script itself `session.snapshot` each time invoke carries finite `timeoutMs`(re- use produce implement, without self system raw socket read).

## isolated and security boundary

- **independent headless session**:`spawn('herdr', ['--session', <unique name>, 'server'])` foreground child process (listen `error` event,ENOENT etc. failed to start explicit errors),stdout/stderr all amount `<tmp>/logs/herdr-server.log`; wait for**itself socket**(`<tmp>/xdg/herdr/sessions/<name>/herdr.sock`) can connect and `session.snapshot` reply after only then continue.
- **environment clean and socket parse**: produce transport priority is `socketPath > HERDR_SOCKET_PATH > session`(session via `XDG_CONFIG_HOME` push lead path). script kernel config `socketPath`, process `HERDR_SOCKET_PATH` and `XDG_CONFIG_HOME` three all points to the same isolated socket- - any priority under parse result consistent; also remove inherit all `HERDR_*` locate variable (`PANE_ID/TAB_ID/WORKSPACE_ID/...`), never trigger touch user existing session / pane / main Herdr process.
- **clean up discipline**: only `herdr --session <name> server stop` itself create session(15s timeout, after SIGTERM→SIGKILL fall back); succeeded and clean up without on failure, first verify worktree directory/branch indeed keep, again only when `git rev-parse --git-common-dir` belongs to this time temporary repository when remove itself create worktree;**any one clean up failed => whole FAIL,exit 1, keep all live and log**. clean up phase has independent has boundary pre- compute, total timeout after still ensure close itself server.
- **secret**: do not print any token / env / auth file content; error information only contains command output tail part.
- **port**: do not listen any port (kernel with store form process inside run, do not start Hub server).
- **total timeout**:`--timeout-ms`(by default 180000, scope 60000..1800000) override main stream process; wait for socket only do 250ms connect backoff, do not use sleep guess stream process complete.

## dependency

- node >= 24(`node:sqlite`), already `pnpm build` artifact (contains `packages/plugins/dist/herdr/transport.js`);
- PATH on `herdr`(>= 0.9.5 / protocol 22),`pi`,`git`;
- `~/.pi/agent/auth.json` inside target model real credentials (local machine is magpie gateway).
