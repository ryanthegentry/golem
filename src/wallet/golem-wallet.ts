import { Wallet, VtxoManager } from '@arkade-os/sdk';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import type { WalletBalance, ExtendedVirtualCoin } from '@arkade-os/sdk';
import { GolemIdentity } from '../identity/golem-identity.js';
import type { GolemSigner, SignerInfo } from '../signer/types.js';
import type { GolemWalletConfig } from './config.js';

/**
 * Golem wallet — wraps the Ark SDK Wallet with GolemIdentity.
 *
 * Manages the signer lifecycle and provides a clean API for
 * wallet operations. The signer holds keys; this class never
 * touches private key material.
 */
export class GolemWallet {
  private constructor(
    private readonly signer: GolemSigner,
    private readonly identity: GolemIdentity,
    readonly sdkWallet: Wallet,
    readonly vtxoManager: VtxoManager,
  ) {}

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

    return new GolemWallet(signer, identity, sdkWallet, vtxoManager);
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

  /** Check for VTXOs expiring soon */
  async getExpiringVtxos(): Promise<ExtendedVirtualCoin[]> {
    return this.vtxoManager.getExpiringVtxos();
  }

  /** Renew expiring VTXOs to prevent loss */
  async renewVtxos(): Promise<string> {
    return this.vtxoManager.renewVtxos();
  }
}
