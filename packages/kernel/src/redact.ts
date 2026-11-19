/**
 * Strict JSON value redaction traversal is consolidated in @helmx/protocol (single shared
 * implementation for kernel and plugins); this file only re-exports it for internal
 * relative-path imports (../redact.js) to remain stable.
 */
export { redactJsonValue } from '@helmx/protocol';
