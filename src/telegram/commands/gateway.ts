import type { BotContext, CommandResult } from '../types.js';
import { formatGateway } from '../formatter.js';

export async function handleGateway(ctx: BotContext): Promise<CommandResult> {
  const stats = ctx.getGatewayStats?.() ?? null;

  return {
    text: formatGateway(stats),
    parseMode: 'MarkdownV2',
  };
}
