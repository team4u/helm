# Helmx

**English** · [简体中文](README.zh-CN.md)

Helmx runs coding agents on your own machines. A Hub keeps conversation history and task records in one place, while agents work in the repositories and environments you choose. You can follow their work in a browser or from the `helmx` CLI.

## Get started

With Node.js 24.12 or newer installed, run:

```bash
npm install -g @helmx/cli
helmx start
```

Leave this terminal open and visit <http://127.0.0.1:3202>. Prefer a background Hub that survives the terminal: `helmx start -d`, and `helmx stop` / `helmx restart` manage it. Register it as an OS login service with `helmx service install`. Create an admin password, add your provider credentials under **Models & Credentials Center**, and choose a default model. Open a conversation in your project directory and try asking where the tests start and how to run them. Use Git on any machine where agents will work in separate worktrees. [Installation and CLI setup (Chinese)](docs/getting-started/installation.md)

## Try Swarm

In a top-level conversation, send:

```text
/skill:swarm Find out how this project runs its tests. Have one agent read the CI configuration and another check the test scripts. Compare their findings and give me the commands to run locally. Leave the files as they are.
```

The conversation coordinates the work. Agents can hand findings to each other on a shared board, and you can open a member's conversation from the workbench to see how they arrived at a conclusion. For a coding task, give each writer a separate Git worktree and let a reviewer ask the writer for changes on the board. [Swarm walkthrough (Chinese)](docs/getting-started/orchestration-guide.md)

## Run work across machines

Install `@helmx/node` on a Windows, macOS, or Linux machine and connect it to your Hub. The node opens the connection, so it needs outbound access to the Hub. Set a conversation's node and working directory to run its file and shell tools there. You can also forward a TCP port to a service the node can reach. [Node setup (Chinese)](docs/getting-started/installation.md#接入远端节点) · [EnvFabric reference (Chinese)](docs/architecture/envfabric.md)

## Save a workflow

If you run the same sequence often, write it as a JavaScript workflow. For example, have two agents review different parts of a change, then combine their findings. A coding step can run a test command in the agent's worktree before it counts as successful. When you resume a failed run, the engine can reuse completed steps that still match the recorded calls. [First workflow (Chinese)](docs/getting-started/first-workflow.md) · [Recovery rules (Chinese)](docs/workflows/journaling-recovery.md)

## Use the terminal you already work in

The optional Herdr plugin can run Claude Code, Codex, and other CLI agents in terminal panes. Results can be handed back through a file with schema validation. When an agent waits for approval, you can respond in the terminal or the browser. If the terminal moves on first, the browser approval expires. [Herdr setup and approval behavior (Chinese)](docs/plugins/herdr.md)

## Documentation

- For scheduled work and inbound events, see [Cron and Webhooks](docs/plugins/triggers.md) and [SuperAgent](docs/plugins/superagent.md).
- To turn a recurring task into a tool you can open from the browser, see [App Center](docs/plugins/apps.md) and [plugin development](docs/plugins/plugin-development.md).
- For the full docs, including the [CLI reference](docs/cli/reference.md) and [architecture](docs/architecture/overview.md), see the [documentation index](docs/README.md). Detailed guides are in Chinese.

Helmx uses a single administrator account. Installed plugins and shell commands run with the privileges of the process that executes them. Interfaces and data formats can change between releases. [Deployment and credential details (Chinese)](docs/getting-started/installation.md) · [Plugin trust model (Chinese)](docs/plugins/overview.md)

[Contributing](AGENTS.md) · [MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
