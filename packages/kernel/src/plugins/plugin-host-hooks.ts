/**
 * Hook pipeline scheduling coordinate tune: only for snapshot moment enabled and idle plugin dispatch, and record in-flight task and isolated error notify.
 */
import {
  HelmError,
  type HookName,
  type HookPayloadMap,
  type HookResult,
} from '@helm/protocol';
import type { HookPipeline, IsolatedHookError } from './hooks.js';
import type { PluginTaskTracker } from './tracking.js';
import type { PluginHostBackend, PluginState } from './types.js';

export interface HookDispatchDeps {
  plugins: ReadonlyMap<string, PluginState>;
  pipelines: ReadonlyMap<HookName, HookPipeline<HookName>>;
  tracker: PluginTaskTracker;
  host: PluginHostBackend;
  redactText?: (text: string) => string;
}

function isHookActive(plugins: ReadonlyMap<string, PluginState>, pluginId: string): boolean {
  const s = plugins.get(pluginId);
  return !!s && s.enabled && s.phase === 'idle';
}

function notifyIsolatedHookErrors(
  errors: IsolatedHookError[],
  host: PluginHostBackend,
  redactText?: (text: string) => string,
): void {
  const redact = redactText ?? ((t: string) => t);
  for (const { pluginId, error } of errors) {
    host.emitEvent('notification', {
      type: 'notification',
      level: 'warning',
      title: `plugin ${pluginId} turn compute hook exception`,
      body: redact(error.message),
    });
  }
}

export async function dispatchPluginHook<K extends HookName>(
  name: K,
  payload: HookPayloadMap[K],
  deps: HookDispatchDeps,
): Promise<HookResult<HookPayloadMap[K]>> {
  const pipeline = deps.pipelines.get(name);
  if (!pipeline) {
    throw new HelmError('unknown_hook', `unknown hook mount point:${name}`, 400, { hook: name });
  }
  const participants = pipeline.entries().filter((h) => isHookActive(deps.plugins, h.pluginId));
  if (participants.length === 0) return { action: 'continue' };

  const snapshot = new Set(participants);
  const label = `hook:${name}`;
  for (const h of participants) deps.tracker.begin(h.pluginId, label);
  try {
    const r = await pipeline.run(payload, (h) => snapshot.has(h));
    if (r.isolatedErrors !== undefined && r.isolatedErrors.length > 0) {
      notifyIsolatedHookErrors(r.isolatedErrors, deps.host, deps.redactText);
    }
    if (r.shortCircuit) {
      return r.shortCircuit.action === 'handled'
        ? { action: 'handled', result: r.shortCircuit.result }
        : { action: 'block', reason: r.shortCircuit.reason };
    }
    return { action: 'transform', value: r.finalPayload } as HookResult<HookPayloadMap[K]>;
  } finally {
    for (const h of participants) deps.tracker.end(h.pluginId, label);
  }
}

export async function dispatchPluginHookAround(
  name: 'agent_spawn',
  payload: HookPayloadMap['agent_spawn'],
  defaultRun: (finalPayload: HookPayloadMap['agent_spawn']) => Promise<unknown>,
  deps: HookDispatchDeps,
): Promise<unknown> {
  const pipeline = deps.pipelines.get(name);
  if (!pipeline) {
    throw new HelmError('unknown_hook', `unknown hook mount point:${name}`, 400, { hook: name });
  }
  const participants = pipeline.entries().filter((h) => isHookActive(deps.plugins, h.pluginId));
  const label = `hook:${name}`;
  const snapshot = new Set(participants);
  for (const h of participants) deps.tracker.begin(h.pluginId, label);
  try {
    const spawnPipeline = pipeline as unknown as HookPipeline<'agent_spawn'>;
    return await spawnPipeline.runAround(
      payload,
      defaultRun,
      (h: { pluginId: string }) => snapshot.has(h as never),
    );
  } finally {
    for (const h of participants) deps.tracker.end(h.pluginId, label);
  }
}
