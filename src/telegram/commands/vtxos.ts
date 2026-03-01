import type { BotContext, CommandResult } from '../types.js';
import { formatVtxos } from '../formatter.js';

export async function handleVtxos(ctx: BotContext): Promise<CommandResult> {
  const vtxos = await ctx.wallet.getVtxos();

  return {
    text: formatVtxos(vtxos),
    parseMode: 'MarkdownV2',
  };
}
