/**
 * Strict JSON value redaction traversal is consolidated in @helm/protocol (single shared
 * implementation for kernel and plugins); this file only re-exports it for internal
 * relative-path imports (../redact.js) to remain stable.
 */
export { redactJsonValue } from '@helm/protocol';
