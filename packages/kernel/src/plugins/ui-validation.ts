/**
 * PluginHost UI 注册规范与动作绑定校验。
 */
import { HelmError } from '@helm/protocol';
import type { UiRegistry } from './ui-registry.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { PluginState } from './types.js';
import { isPlainObject } from './shared.js';

export function assertUiDocsRegistered(
  pluginId: string,
  uiRegistry: UiRegistry,
  hasPublicDoc: (name: string) => boolean,
  hasPublicSessionDoc: (name: string) => boolean,
): void {
  uiRegistry.assertUiDocsRegistered(
    pluginId,
    hasPublicDoc,
    hasPublicSessionDoc,
  );
}

/**
 * composer.completer 动作源绑定校验（定义期末 / 启用提交点）：
 * - 本插件引用：动作必须已声明且 idempotent: true（补全查询高频触发，
 *   不得绑定非幂等副作用动作）；动作声明可晚于 UI 声明，故在定义期末校验；
 * - 跨插件引用：仅在启用提交点（crossPlugin=true，与 enabled 发布同一同步块）
 *   且目标插件当前已启用时校验存在与 idempotent；目标尚未注册/启用时不拒绝
 *   （合法的稍后注册，运行期前端经 action manifest 兑底校验可用性）。
 * idempotent 只是声明性标记（允许断链重跑），不代表代码安全沙箱。
 */
export function assertUiCompleterActionBindings(
  pluginId: string,
  uiRegistry: UiRegistry,
  capabilityRegistry: CapabilityRegistry,
  plugins: Map<string, PluginState>,
  crossPlugin: boolean,
): void {
  for (const u of uiRegistry.getUiByPlugin(pluginId)) {
    if (u.surface !== 'composer.completer') continue;
    const source = (u.spec as { source?: unknown }).source;
    if (!isPlainObject(source) || source['kind'] !== 'action') continue;
    const actionId = source['actionId'];
    if (typeof actionId !== 'string') continue; // 注册边界已拒绝非法形状
    const actionPluginId = source['actionPluginId'];
    const targetPluginId =
      typeof actionPluginId === 'string' && actionPluginId.length > 0 ? actionPluginId : pluginId;
    if (targetPluginId !== pluginId && !crossPlugin) continue;
    if (targetPluginId !== pluginId) {
      const target = plugins.get(targetPluginId);
      if (!target || !target.enabled) continue; // 目标未注册/未启用：允许稍后注册
      const binding = capabilityRegistry.getActionBinding(targetPluginId, actionId);
      if (binding === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的补全源引用了插件 ${targetPluginId} 未声明的动作 ${actionId}`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
        );
      }
      if (!binding.idempotent) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的补全源绑定的动作 ${targetPluginId}.${actionId} 必须 idempotent: true`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
        );
      }
      continue;
    }
    const binding = capabilityRegistry.getActionBinding(pluginId, actionId);
    if (binding === undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} 的补全源引用了本插件未声明的动作 ${actionId}`,
        400,
        { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
      );
    }
    if (!binding.idempotent) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} 的补全源绑定的动作 ${actionId} 必须 idempotent: true（补全查询不得触发非幂等副作用）`,
        400,
        { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
      );
    }
  }
}
