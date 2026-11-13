/**
 * Payload updater 契约（骨架占位，不含真实下载器）。
 *
 * TODO(payload updater)——未来实现必须遵守的边界（详见 packages/desktop/README.md）：
 * 1. check() 只读（ manifest 版本比对），downloadAndInstall() 落盘 <dataDir>/payload-staging
 *    并原子换名到 payload 目录，任何一步失败不得破坏当前可运行 payload；
 * 2. 换装只允许在 supervisor.stop() 之后进行（桌面壳独占 Hub 生命周期），避免与
 *    payload 内部 agent / 会话中途写盘冲突；
 * 3. 下载必须校验完整性与来源签名（契约待定，TODO）；失败显式报错，禁止静默降级到旧版
 *    却宣称成功；
 * 4. updater 与 payload agent 的职责边界：updater 只管 payload 制品本身，不感知会话、
 *    不重启用户会话、不越权调用 Hub API。
 */
import { DesktopError } from './errors.js';
import type { DesktopConfig } from './config.js';

export interface PayloadInfo {
  name: string;
  version: string;
  /** payload 内 hub 入口（绝对路径）。 */
  entryPath: string;
}

export interface PayloadUpdateStatus {
  updateAvailable: boolean;
  current?: PayloadInfo;
  latest?: PayloadInfo;
  /** 未配置 updater 时的如实说明。 */
  reason?: 'updater_not_configured';
}

export interface PayloadUpdater {
  readonly id: string;
  check(): Promise<PayloadUpdateStatus>;
  downloadAndInstall(latest: PayloadInfo): Promise<void>;
}

/** 骨架实现：如实声明「未配置」，安装路径显式拒绝。 */
export class StubPayloadUpdater implements PayloadUpdater {
  readonly id = 'stub';

  async check(): Promise<PayloadUpdateStatus> {
    return { updateAvailable: false, reason: 'updater_not_configured' };
  }

  async downloadAndInstall(_latest: PayloadInfo): Promise<never> {
    throw new DesktopError(
      'updater_not_implemented',
      'payload 自动更新尚未实现（骨架阶段）；请通过 HELM_DESKTOP_PAYLOAD_ENTRY 显式指定 payload 入口',
    );
  }
}

/** 目前仅返回占位 updater；真实实现接入时按 config 选择策略。 */
export function createPayloadUpdater(_config: DesktopConfig): PayloadUpdater {
  return new StubPayloadUpdater();
}
