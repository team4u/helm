# Primitive Props Contracts (21)

## Layout & display (14)

- `Stack`: `direction` (vertical|horizontal, default vertical), `gap` (number), `children`.
- `Card`: `title`, `subtitle`, `children`.
- `Text`: `text`, `variant` (body|title|muted|mono), `lineClamp` (positive integer).
- `Badge`: `text`, `tone` (neutral|accent|ok|warn|err), `icon` (lucide icon name).
- `Markdown`: `text` (standard Markdown rendering; no other props).
- `MetricGrid`: `cols` (1..6), `children` (list of MetricCard).
- `MetricCard`: `label`, `value`, `hint`, `tone` (ok|warn|err|accent, default color when omitted).
- `KeyValueList`: `items: [{ label, value }]`.
- `Callout`: `tone` (info|warn|err|ok), `title`, `text`, `children`.
- `Steps`: `items: [{ title, detail?, status? }]`, status is pending|running|done|failed.
- `BarList`: `items: [{ label, value, max? }]` (horizontal proportion bars).
- `Table`: `columns: [{ key, label? }]`, `rows` (array of objects), `empty` (empty-table copy), `rowActions: [{ label, tone?: primary|danger, action }]` (`{$row.field}` available inside action).
- `Accordion`: `title`, `defaultOpen` (boolean, default true), `children`.
- `Slot`: plugin-view only -- `name` (a short name resolves to the current plugin's `name`, or fully-qualified `owner/xxx`), `mode` (list|single, default list), children serve as fallback when there are no contributions. Renders contributions injected by other plugins via `ctx.ui.slot({ target })`, each with an independent error boundary.

## Forms & interaction (7)

- `TextInput`: `label?`, `placeholder?`, `value?`, `secret?` (password style), `action?` (triggered by the submit button; `{$value}` is the input).
- `Select`: `label?`, `value?`, `options: [{ label, value }]`, `action?` (fires on selection; `{$value}`).
- `Switch`: `label?`, `value?` (boolean), `action` (fires on toggle; `{$value}` is the new boolean).
- `CheckboxGroup`: `label?`, `value?` (array of selected values), `options: [{ label, value }]`, `action?` (`{$value}` is the selection array).
- `Button`: `label`, `icon?`, `variant?` (primary|danger|ghost), `action`.
- `ActionBar`: `actions: [{ label, icon?, variant?, action }]` or `children` (horizontal button group).
- `Tabs`: `tabs: [{ id, label, children }]` (children is an array of tree nodes).
