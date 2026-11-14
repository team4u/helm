/**
 * @helm/hub：产品组合根的公开出口。
 *
 * 组合根只做两件事：选择内置插件集合与缺省启停（来自 @helm/plugins）、
 * 装配 KernelRuntime（来自 @helm/kernel）。内核机制包可独立打开
 * （KernelRuntime.open 零内置插件），本包不实现任何机制。
 */
export { createHelm, type HelmOptions } from './app.js';
