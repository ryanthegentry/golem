import { Wallet, VtxoManager, Ramps, OnchainWallet, Unroll, InMemoryWalletRepository, InMemoryContractRepository, WalletRepositoryImpl, ContractRepositoryImpl } from '@arkade-os/sdk';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import type { WalletBalance, ExtendedVirtualCoin, ExtendedCoin, SettlementEvent, ArkTransaction, NetworkName } from '@arkade-os/sdk';
import { GolemIdentity } from '../identity/golem-identity.js';
import type { GolemSigner, SignerInfo } from '../signer/types.js';
import type { GolemWalletConfig } from './config.js';
import { OorLimitExceededError } from './errors.js';
import { DEFAULT_RESERVE_PER_VTXO } from '../config/defaults.js';

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
  private readonly networkName: NetworkName;
  private onchainWallet: OnchainWallet | null = null;

  private constructor(
    private readonly signer: GolemSigner,
    private readonly identity: GolemIdentity,
    readonly sdkWallet: Wallet,
    readonly vtxoManager: VtxoManager,
    config: GolemWalletConfig,
  ) {
    this.oorLimitFraction = config.oorLimitFraction;
    this.oorLimitMinSats = config.oorLimitMinSats;
    this.networkName = config.networkName;
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
      ? (() => {
          const adapter = new FileSystemStorageAdapter(config.dataDir!);
          return {
            walletRepository: new WalletRepositoryImpl(adapter),
            contractRepository: new ContractRepositoryImpl(adapter),
          };
        })()
      : {
          walletRepository: new InMemoryWalletRepository(),
          contractRepository: new InMemoryContractRepository(),
        };

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

  /** Get transaction history */
  async getTransactionHistory(): Promise<ArkTransaction[]> {
    return this.sdkWallet.getTransactionHistory();
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
   * Get or create the OnchainWallet (lazy — same Identity, separate P2TR address).
   * Used for on-chain reserve balance and AnchorBumper during unilateral exit.
   */
  async getOrCreateOnchainWallet(): Promise<OnchainWallet> {
    if (!this.onchainWallet) {
      this.onchainWallet = await OnchainWallet.create(
        this.identity,
        this.networkName,
        this.sdkWallet.onchainProvider,
      );
    }
    return this.onchainWallet;
  }

  /** On-chain reserve balance (sats held for AnchorBumper fee-bump txs). */
  async getOnchainReserveBalance(): Promise<number> {
    const ocw = await this.getOrCreateOnchainWallet();
    return ocw.getBalance();
  }

  /** Required on-chain reserve based on current VTXO count. */
  async getRequiredReserve(): Promise<{ required: number; vtxoCount: number; perVtxo: number }> {
    const vtxos = await this.getVtxos();
    return {
      required: vtxos.length * DEFAULT_RESERVE_PER_VTXO,
      vtxoCount: vtxos.length,
      perVtxo: DEFAULT_RESERVE_PER_VTXO,
    };
  }

  /**
   * Exit ALL funds to an on-chain safe harbor address.
   *
   * Strategy:
   * 1. Shut down L402 gateway (mandatory — no new payments during exit)
   * 2. Try cooperative offboard (fast, requires ASP online)
   * 3. Fall back to unilateral unroll (slow, always works if on-chain reserve exists)
   *
   * NOTE: Unilateral exit assumes pre-signed tx tree data is available in local storage.
   * If wallet data dir is lost, unilateral exit is impossible.
   * Future: S3 backup of data dir (premium tier) or "back up data dir" warning (free tier).
   *
   * Note: Reserve fee rate uses a static 10 sat/vbyte estimate. Dynamic fee estimation
   * requires mempool monitoring (deferred to post-PoC).
   */
  async exitToSafeHarbor(
    safeHarborAddress: string,
    gateway?: { shutdown(): void },
    eventCallback?: (event: SettlementEvent) => void,
  ): Promise<{ txid: string; method: 'offboard' | 'unroll' }> {
    // 1. Shut down gateway immediately — no new 402 challenges
    if (gateway) {
      gateway.shutdown();
    }

    // 2. Try cooperative offboard first (fast, ASP required)
    try {
      const info = await this.sdkWallet.arkProvider.getInfo();
      const txid = await new Ramps(this.sdkWallet).offboard(
        safeHarborAddress, info.fees, undefined, eventCallback,
      );
      return { txid, method: 'offboard' };
    } catch (offboardError) {
      const offboardMsg = offboardError instanceof Error ? offboardError.message : String(offboardError);
      console.warn(`Cooperative offboard failed: ${offboardMsg}. Falling through to unilateral exit.`);
    }

    // 3. Unilateral exit — broadcast pre-signed tx trees, wait for CSV, spend
    const ocw = await this.getOrCreateOnchainWallet();
    const reserve = await ocw.getBalance();
    const vtxos = await this.getVtxos();
    const requiredReserve = vtxos.length * DEFAULT_RESERVE_PER_VTXO;

    if (reserve < requiredReserve) {
      throw new Error(
        `Unilateral exit requires on-chain reserve. ` +
        `Current: ${reserve} sats, Required: ~${requiredReserve} sats for ${vtxos.length} VTXOs. ` +
        `Cooperative offboard also failed (ASP unreachable).`
      );
    }

    // Unroll each VTXO — broadcast tree transactions with fee bumps
    const unrolledTxids: string[] = [];
    for (const vtxo of vtxos) {
      const session = await Unroll.Session.create(
        { txid: vtxo.txid, vout: vtxo.vout },
        ocw,
        this.sdkWallet.onchainProvider,
        this.sdkWallet.indexerProvider,
      );

      for await (const step of session) {
        await step.do();
        if (step.type === Unroll.StepType.DONE) {
          unrolledTxids.push(step.vtxoTxid);
        }
      }
    }

    // Complete unroll — spend CSV path to safe harbor address
    const txid = await Unroll.completeUnroll(
      this.sdkWallet, unrolledTxids, safeHarborAddress,
    );
    return { txid, method: 'unroll' };
  }

  /**
   * Check that cumulative unsettled OOR exposure + requested amount doesn't exceed limits.
   *
   * Uses the SDK's preconfirmed balance (VTXOs not yet settled into a round) as the
   * measure of current OOR exposure. This prevents fragmented drain attacks where many
   * small sends individually pass but cumulatively exceed the cap.
   */
  private async enforceOorLimit(amountSats: number): Promise<void> {
    const balance = await this.getBalance();
    const percentLimit = Math.floor(balance.total * this.oorLimitFraction);
    const maxOor = Math.max(percentLimit, this.oorLimitMinSats);

    // Cumulative check: preconfirmed (unsettled OOR) + this send must not exceed cap
    const currentOor = balance.preconfirmed ?? 0;
    if (currentOor + amountSats > maxOor) {
      throw new OorLimitExceededError(amountSats, maxOor, balance.total);
    }
  }
}
