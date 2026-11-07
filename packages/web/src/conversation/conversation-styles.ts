/**
 * conversation 模块内补充样式（styles.css 地基未覆盖的模块内微样式）。
 * 纯 .ts：导出样式字符串常量，由各组件的 <ConversationStyles /> 一次性注入 <style>。
 * 不与 styles.css 既有类冲突（全部加 conv- 前缀或为全新类名）。
 */
export const CONVERSATION_EXTRA_CSS = `
@keyframes convSpin360 { to { transform: rotate(360deg); } }
.spin-slow { animation: convSpin360 1.1s linear infinite; }

.entry-anchor { position: relative; }

.trace-entry { display: flex; flex-direction: column; gap: 0; width: 100%; }
.trace-entry .trace-row { width: 100%; }
.trace-entry-error .trace-tool-summary { color: var(--err); }

.trace-section-label {
  font-size: 10.5px;
  color: var(--fg-subtle);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}

.trace-toolview { margin: 2px 0; }

.plugin-card { display: flex; flex-direction: column; gap: 6px; }

.attachment-image-thumb {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  cursor: zoom-in;
  padding: 0;
  background: var(--bg-subtle);
  max-width: 200px;
}
.attachment-image-thumb:hover { border-color: var(--border-strong); }
.attachment-image-thumb img {
  display: block;
  max-width: 200px;
  max-height: 140px;
  object-fit: cover;
}

.composer-widgets {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
}
.composer-widget-item { display: block; }
.composer-pill-item { display: inline-flex; }

.composer-box[data-dragging='true'] { border-color: var(--accent); }

.composer-popover .popover-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 30px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--fg-secondary);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.composer-popover .popover-item:hover,
.composer-popover .popover-item-active { background: var(--bg-hover); color: var(--fg); }
.composer-popover .popover-item-meta {
  font-size: 11px;
  color: var(--fg-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.composer-popover .popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 4px;
  font-size: 11px;
  color: var(--fg-muted);
  user-select: none;
}

.btn-group { display: inline-flex; }
.btn-group .btn + .btn { margin-left: -1px; }
.btn-group .btn:first-child { border-radius: var(--radius-xs) 0 0 var(--radius-xs); }
.btn-group .btn:last-child { border-radius: 0 var(--radius-xs) var(--radius-xs); }
.btn-group .btn:not(:first-child):not(:last-child) { border-radius: 0; }

.phase-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.phase-segment {
  font-size: 11px;
  color: var(--fg-muted);
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-subtle);
}
.phase-segment-active {
  color: var(--accent);
  border-color: var(--accent-border);
  background: var(--accent-bg);
}

.mermaid-body svg { max-width: 100%; height: auto; }

.composer-picker-root .composer-popover { min-width: 260px; }
`
