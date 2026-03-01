// ~72 hours at 10 min/block
export const DEFAULT_EXIT_THRESHOLD_BLOCKS = 432;

// Held back for AnchorBumper fee-bump txs during unilateral exit
export const DEFAULT_ONCHAIN_RESERVE_SATS = 50_000;

// tree_depth=6 * bump_tx_size=250 * fee_rate=10
export const DEFAULT_RESERVE_PER_VTXO = 15_000;
