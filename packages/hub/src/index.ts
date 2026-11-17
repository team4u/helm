/**
 * @helm/hub: Public entrypoint of the product composition root.
 *
 * The composition root does only two things: select built-in plugins and their default
 * enabled states (from `@helm/plugins`), and assemble `KernelRuntime` (from `@helm/kernel`).
 * The kernel mechanism package can be opened standalone (`KernelRuntime.open` with zero
 * built-in plugins); this package implements no core mechanisms itself.
 */
export { createHelm, type HelmOptions } from './app.js';
