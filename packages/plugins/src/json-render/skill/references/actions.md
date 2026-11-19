# The Three Declarative Action Directives

The value of an action field is one of the following three directive objects:

1. Invoke a plugin action: `{ "type": "helmx:action", "pluginId": "<pluginId>", "actionId": "<actionId>", "input": {} }`. Chat blocks should pass pluginId explicitly (e.g. builtin:triggers); actionId is the ID within that plugin -- look up the action catalog and Schema first (`helmx actions list --json`).
2. Open a target: `{ "type": "helmx:open", "target": "conversation:<id>" | "screen:<pluginId>/<screenId>" | "artifact:<id>", "split": true }` (when target is "artifact:<id>", the artifact preview modal opens directly; split true opens the conversation/Screen in split view). In reply bodies you can also inline-render artifacts via `[filename](artifact:<id>)` or `![title](artifact:<id>)`.
3. Send input: `{ "type": "helmx:send", "target": "current", "text": "..." }` (submitted with human origin). When target is omitted or `"current"`, it defaults to the current conversation -- write it this way when interacting inside a conversation card; use `"conversation:<id>"` only when explicitly sending to another conversation.

## Safety boundaries

- Pure display components (Text/Markdown/Badge/Metric etc.) must not invoke actions automatically; actions trigger only on explicit user click/submit.
- Form input values submit via `{$value}`; components execute no arbitrary JS; the evaluator only parses data paths, with no eval.
