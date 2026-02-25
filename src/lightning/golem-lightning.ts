import {
  ArkadeLightning,
  BoltzSwapProvider,
  type PendingReverseSwap,
  type LimitsResponse,
  type FeesResponse,
} from '@arkade-os/boltz-swap';
import type { GolemWallet } from '../wallet/golem-wallet.js';
import type { GolemLightningConfig } from './config.js';

/** Thin wrapper over PendingReverseSwap with Golem-friendly fields */
export interface LightningInvoice {
  /** BOLT11 invoice string */
  bolt11: string;
  /** Amount in satoshis */
  amountSats: number;
  /** Payment hash hex */
  paymentHash: string;
  /** Invoice expiry as Unix timestamp (seconds) */
  expiresAt: number;
  /** Boltz swap ID for tracking */
  swapId: string;
  /** Pass-through for waitAndClaim */
  pendingSwap: PendingReverseSwap;
}

/** Boltz fee breakdown */
export type BoltzFees = FeesResponse;

/**
 * Lightning integration for Golem via Boltz non-custodial swaps.
 *
 * Wraps @arkade-os/boltz-swap's ArkadeLightning with Golem conventions:
 * clean types, error handling, and a thin API surface.
 *
 * Lightning is opt-in — create this explicitly when needed:
 *   const lightning = new GolemLightning(wallet, MUTINYNET_LIGHTNING_CONFIG);
 */
export class GolemLightning {
  private readonly arkadeLightning: ArkadeLightning;
  private readonly swapProvider: BoltzSwapProvider;

  constructor(wallet: GolemWallet, config: GolemLightningConfig) {
    this.swapProvider = new BoltzSwapProvider({
      apiUrl: config.boltzApiUrl,
      network: config.network,
      referralId: config.referralId,
    });

    this.arkadeLightning = new ArkadeLightning({
      wallet: wallet.sdkWallet,
      swapProvider: this.swapProvider,
    });
  }

  /**
   * Create a Lightning invoice to receive funds into Ark.
   * The payer sends Lightning; you receive Ark VTXOs.
   */
  async createInvoice(amountSats: number): Promise<LightningInvoice> {
    const result = await this.arkadeLightning.createLightningInvoice({
      amount: amountSats,
    });

    return {
      bolt11: result.invoice,
      amountSats: result.amount,
      paymentHash: result.paymentHash,
      expiresAt: result.expiry,
      swapId: result.pendingSwap.id,
      pendingSwap: result.pendingSwap,
    };
  }

  /**
   * Wait for a Lightning payment and claim into Ark VTXOs.
   * Blocks until the payment arrives and is claimed.
   */
  async waitAndClaim(invoice: LightningInvoice): Promise<{ txid: string }> {
    return this.arkadeLightning.waitAndClaim(invoice.pendingSwap);
  }

  /**
   * Send a Lightning payment from Ark balance.
   * Submarine swap: Ark VTXOs → Lightning.
   */
  async payInvoice(bolt11: string): Promise<{ txid: string; preimage: string }> {
    const result = await this.arkadeLightning.sendLightningPayment({
      invoice: bolt11,
    });
    return { txid: result.txid, preimage: result.preimage };
  }

  /** Get current Boltz swap limits (min/max satoshis) */
  async getLimits(): Promise<LimitsResponse> {
    return this.arkadeLightning.getLimits();
  }

  /** Get current Boltz fee rates */
  async getFees(): Promise<BoltzFees> {
    return this.arkadeLightning.getFees();
  }

  /** Clean up resources (WebSocket connections, etc.) */
  async dispose(): Promise<void> {
    await this.arkadeLightning.dispose();
  }
}
