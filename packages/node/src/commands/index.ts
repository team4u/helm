/**
 * 命令表：命令名 → handler。入口 cli.ts 据此分发；新增命令在此注册。
 */
import type { CommandContext } from './shared.js';
import { connectCommand, restartCommand, startCommand, statusCommand, stopCommand } from './lifecycle.js';
import { doctorCommand, serviceCommand, upgradeCommand } from './maintenance.js';

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

export const COMMANDS: Record<string, CommandHandler> = {
  connect: connectCommand,
  start: startCommand,
  stop: stopCommand,
  restart: restartCommand,
  status: statusCommand,
  upgrade: upgradeCommand,
  doctor: doctorCommand,
  service: serviceCommand,
};
