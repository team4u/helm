/**
 * Command registry mapping command names to handlers. New CLI subcommands are registered here.
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
