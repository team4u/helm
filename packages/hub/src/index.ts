/**
 * @helm/hub: produce product composition root public exit.
 *
 * composition root only do two piece matter: choose built-in plugin set and default start stop (from @helm/plugins),
 * install match KernelRuntime(from @helm/kernel). kernel mechanism package can independent open
 * (KernelRuntime.open zero built-in plugin), this package do not implement any mechanism.
 */
export { createHelm, type HelmOptions } from './app.js';
