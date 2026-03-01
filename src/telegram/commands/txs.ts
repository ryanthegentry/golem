import type { BotContext, CommandResult } from '../types.js';
import { formatTxs } from '../formatter.js';

export async function handleTxs(ctx: BotContext): Promise<CommandResult> {
  const txs = await ctx.wallet.getTransactionHistory();

  return {
    text: formatTxs(txs),
    parseMode: 'MarkdownV2',
  };
}
