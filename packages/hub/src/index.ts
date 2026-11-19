/**
 * @helmx/hub: Public entrypoint of the product composition root.
 *
 * The composition root does only two things: select built-in plugins and their default
 * enabled states (from `@helmx/plugins`), and assemble `KernelRuntime` (from `@helmx/kernel`).
 * The kernel mechanism package can be opened standalone (`KernelRuntime.open` with zero
 * built-in plugins); this package implements no core mechanisms itself.
 */
export { createHelmx, type HelmxOptions } from './app.js';
