---
name: generative-ui
description: Use when emitting interactive cards/forms/tables (ui code blocks) in reply bodies; covers primitive Props contracts, expression evaluation, and the three action directives.
managedByPlugin: builtin:json-render
---

# Generative UI Reference

Emit a ```ui code block in the reply body whose content is a single JSON object; the Web renders it inline as an interactive card.

## Applicability (do not overuse)

- Applicable: multi-dimensional metric overviews, comparison tables, multi-step progress tracking, and action cards needing user interaction (choose/input/toggle/button).
- Not applicable: plain Q&A, code display, simple lists -- use standard Markdown directly, without UI blocks.
- No-Emoji rule: any Emoji in copy is strictly forbidden; icons use lucide icon names (e.g. terminal, cpu, activity, check-circle, alert-triangle, git-branch; note there is no server icon -- use hard-drive for disks/machines).

## Two shapes

Tree shorthand (recommended): `{ "component": "Card", "title": "...", "children": [...] }`; the children array may contain nodes or strings (strings become Text body).
Flat shape: `{ "root": "id", "elements": { "id": { "type": "Card", "props": {}, "children": ["childId"] } } }`; child nodes must be defined in elements.

Chat UI blocks use a standalone spec with no owning plugin: they cannot subscribe to plugin docs and get no composer/screen control functions injected; the current protocol has no generic `$state` form store -- input components submit via their own action's `{$value}`; in-table `{$row}` works the same way.

## Expression evaluation ($docs / $sessionDocs / $data / $row / $value)

- `{$docs.<docName>.<path>}` / `{$sessionDocs.<name>.<path>}` / `{$data.<path>}`: public global docs, the current conversation's public docs, and the data passed at call time.
- When an entire attribute value is exactly one `{...}` expression, the raw JS type is preserved (number/boolean/array/object); embedded in longer text it becomes string interpolation.
- `{$row.<field>}` is available only inside a Table's rowActions; `{$value}` is available inside a form component's action (the submitted value).

## Drill-down on demand

- Full real Props contracts of all primitives (21): `load_skill({ skillId: "generative-ui", path: "references/primitives.md" })`
- The three declarative action directives: `load_skill({ skillId: "generative-ui", path: "references/actions.md" })`

## Full example (tree shape, valid)

```ui
{
  "component": "Card",
  "title": "Node inspection example",
  "subtitle": "Format sample only; replace with this round's real query results",
  "children": [
    { "component": "MetricGrid", "cols": 3, "children": [
      { "component": "MetricCard", "label": "Online", "value": "1", "tone": "ok" },
      { "component": "MetricCard", "label": "Offline", "value": "1", "tone": "err" },
      { "component": "MetricCard", "label": "Avg load", "value": "0.42", "hint": "1 min" }
    ] },
    { "component": "Table", "columns": [
      { "key": "nodeId", "label": "Node" },
      { "key": "status", "label": "Status" },
      { "key": "diskFreeGb", "label": "Disk free" }
    ], "rows": [
      { "nodeId": "local", "status": "online", "diskFreeGb": 128 },
      { "nodeId": "build-01", "status": "offline", "diskFreeGb": null }
    ] },
    { "component": "ActionBar", "actions": [
      { "label": "Re-inspect", "icon": "refresh-cw", "variant": "primary", "action": { "type": "helmx:send", "target": "current", "text": "Please re-inspect all nodes" } },
      { "label": "Open assistant", "icon": "terminal", "action": { "type": "helmx:open", "target": "conversation:1", "split": true } }
    ] }
  ]
}
```
