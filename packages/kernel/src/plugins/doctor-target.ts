/**
 * doctor-target.ts：外部插件 doctor 目标的目录路径统一边界校验。
 *
 * HTTP parseDoctorTarget（http/plugin-routes.ts，早拒）与
 * PluginHost.doctorExternalPlugin（host.plugins 端口与 HTTP 同权，兜底复检）
 * 双处调用同一实现（单点归一，规则不再双处维护）：
 * - 必须是跨平台绝对目录路径：POSIX `/`、Windows 盘符 `^[a-zA-Z]:[\\/]`、
 *   完整 UNC `\\\\server\\share`（见 shared.ts isCrossPlatformAbsolutePath）；
 * - 不含 .. 穿越段（正反斜杠均按段分隔）。
 * 非法输入显式 HelmError validation_error 400，绝不静默改写。
 */
import { HelmError } from '@helm/protocol';
import { isCrossPlatformAbsolutePath } from './shared.js';

/** 校验 doctor 目标目录路径（field 用于错误消息定位，如 'dir' / 'path'）。 */
export function assertDoctorTargetDir(dir: string, field: string): void {
  if (!isCrossPlatformAbsolutePath(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new HelmError(
      'validation_error',
      `doctor 目标 ${field} 需为不含 .. 段的跨平台绝对目录路径（以 / 或盘符开头）：${dir}`,
      400,
      { dir },
    );
  }
}
