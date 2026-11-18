# Retired Reference

Workflow and multi-agent instructions are no longer part of the global `helm-cli` skill. Enable `builtin:workflow` and load its plugin-owned `workflow` skill instead:

```text
load_skill({ skillId: "workflow" })
load_skill({ skillId: "workflow", path: "references/dsl.md" })
load_skill({ skillId: "workflow", path: "references/subagents.md" })
```

This file is kept as a migration marker so stale references fail visibly instead of silently reading an outdated copy.
