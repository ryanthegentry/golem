import { Wallet, VtxoManager, Ramps } from '@arkade-os/sdk';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import type { WalletBalance, ExtendedVirtualCoin, ExtendedCoin, SettlementEvent } from '@arkade-os/sdk';
import { GolemIdentity } from '../identity/golem-identity.js';
import type { GolemSigner, SignerInfo } from '../signer/types.js';
import type { GolemWalletConfig } from './config.js';
import { OorLimitExceededError } from './errors.js';

/**
 * Golem wallet — wraps the Ark SDK Wallet with GolemIdentity.
 *
 * Manages the signer lifecycle and provides a clean API for
 * wallet operations. The signer holds keys; this class never
 * touches private key material.
 */
export class GolemWallet {
  private readonly oorLimitFraction: number;
  private readonly oorLimitMinSats: number;

  private constructor(
    private readonly signer: GolemSigner,
    private readonly identity: GolemIdentity,
    readonly sdkWallet: Wallet,
    readonly vtxoManager: VtxoManager,
    config: GolemWalletConfig,
  ) {
    this.oorLimitFraction = config.oorLimitFraction;
    this.oorLimitMinSats = config.oorLimitMinSats;
  }

  /**
   * Create a new GolemWallet connected to an Ark server.
   * This calls the Ark server to fetch configuration — requires network.
   */
  static async create(
    signer: GolemSigner,
    config: GolemWalletConfig,
  ): Promise<GolemWallet> {
    const identity = new GolemIdentity(signer);

    const storage = config.dataDir
      ? new FileSystemStorageAdapter(config.dataDir)
      : undefined;

    const sdkWallet = await Wallet.create({
      identity,
      arkServerUrl: config.arkServerUrl,
      esploraUrl: config.esploraUrl,
      storage,
    });

    const vtxoManager = new VtxoManager(sdkWallet, {
      enabled: true,
    });

    return new GolemWallet(signer, identity, sdkWallet, vtxoManager, config);
  }

  /** Ark protocol address for receiving off-chain payments */
  async getAddress(): Promise<string> {
    return this.sdkWallet.getAddress();
  }

  /** On-chain address for boarding into Ark */
  async getBoardingAddress(): Promise<string> {
    return this.sdkWallet.getBoardingAddress();
  }

  async getBalance(): Promise<WalletBalance> {
    return this.sdkWallet.getBalance();
  }

  async getVtxos(): Promise<ExtendedVirtualCoin[]> {
    return this.sdkWallet.getVtxos();
  }

  async getSignerInfo(): Promise<SignerInfo> {
    return this.signer.getSignerInfo();
  }

  /** Get 33-byte compressed public key from the signer */
  async getPublicKey(): Promise<Uint8Array> {
    return this.signer.getPublicKey();
  }

  /**
   * Check for VTXOs expiring soon.
   * @param thresholdMs — ms before expiry to consider "expiring". Defaults to SDK's 3-day threshold.
   */
  async getExpiringVtxos(thresholdMs?: number): Promise<ExtendedVirtualCoin[]> {
    return this.vtxoManager.getExpiringVtxos(thresholdMs);
  }

  /** Renew expiring VTXOs to prevent loss */
  async renewVtxos(
    eventCallback?: (event: SettlementEvent) => void,
  ): Promise<string> {
    return this.vtxoManager.renewVtxos(eventCallback);
  }

  /** Get boarding UTXOs (on-chain funds waiting to enter Ark) */
  async getBoardingUtxos(): Promise<ExtendedCoin[]> {
    return this.sdkWallet.getBoardingUtxos();
  }

  /**
   * Board on-chain funds into Ark VTXOs.
   * Boarding UTXOs must exist at the boarding address first.
   */
  async onboard(
    eventCallback?: (event: SettlementEvent) => void,
  ): Promise<string> {
    const info = await this.sdkWallet.arkProvider.getInfo();
    return new Ramps(this.sdkWallet).onboard(info.fees, undefined, undefined, eventCallback);
  }

  /**
   * Settle with full control — specify inputs and outputs.
   */
  async settle(
    params?: { inputs: ExtendedCoin[]; outputs: { address: string; amount: bigint }[] },
    eventCallback?: (event: SettlementEvent) => void,
  ): Promise<string> {
    return this.sdkWallet.settle(params, eventCallback);
  }

  /**
   * Consolidate multiple VTXOs into a single output.
   * Sends the total value back to self. The Ark server deducts fees
   * from the output during the settlement round.
   */
  async consolidateVtxos(
    vtxos: ExtendedVirtualCoin[],
    eventCallback?: (event: SettlementEvent) => void,
  ): Promise<string> {
    const address = await this.getAddress();
    const total = vtxos.reduce((sum, v) => sum + BigInt(v.value), 0n);
    return this.settle({ inputs: vtxos, outputs: [{ address, amount: total }] }, eventCallback);
  }

  /**
   * Send bitcoin to an Ark address with OOR exposure limit enforcement.
   * The SDK handles OOR mechanics (preconfirm → settle at next round) internally.
   */
  async sendBitcoin(params: { address: string; amount: number }): Promise<string> {
    await this.enforceOorLimit(params.amount);
    return this.sdkWallet.sendBitcoin(params);
  }

  /**
   * Check that a send amount doesn't exceed OOR exposure limits.
   *
   * TODO: This checks individual send size, not cumulative unsettled OOR exposure.
   * The architecture doc specifies "maximum OOR balance" — meaning total unsettled
   * OOR across multiple sends. E.g. three 5% sends should trigger the 10% limit.
   * Per-send check is correct for PoC. A later phase should track cumulative OOR
   * balance by summing preconfirmed VTXOs that haven't settled into a round yet.
   */
  private async enforceOorLimit(amountSats: number): Promise<void> {
    const balance = await this.getBalance();
    const percentLimit = Math.floor(balance.total * this.oorLimitFraction);
    const maxOor = Math.max(percentLimit, this.oorLimitMinSats);

    if (amountSats > maxOor) {
      throw new OorLimitExceededError(amountSats, maxOor, balance.total);
    }
  }
}
