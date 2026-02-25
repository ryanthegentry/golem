/**
 * Configuration for Golem's Lightning integration via Boltz swaps.
 */
export interface GolemLightningConfig {
  /** Boltz API endpoint URL */
  boltzApiUrl: string;
  /** Network name (must match Boltz and Ark server) */
  network: string;
  /** Optional Boltz referral ID */
  referralId?: string;
}

export const MUTINYNET_LIGHTNING_CONFIG: GolemLightningConfig = {
  boltzApiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
  referralId: 'golem',
};
