import { describe, it, expect } from 'vitest';
import { p2tr } from '@scure/btc-signer';
import { Transaction as ArkTransaction } from '@arkade-os/sdk';
import { schnorr, verifyAsync, etc } from '@noble/secp256k1';
import { GolemIdentity } from './golem-identity.js';
import { MockSigner } from '../signer/mock-signer.js';

/** Create a minimal P2TR Ark Transaction that can be signed by the given key */
function createTestArkTx(compressedPubkey: Uint8Array): ArkTransaction {
  const xOnlyPubkey = compressedPubkey.slice(1);
  const payment = p2tr(xOnlyPubkey);
  const tx = new ArkTransaction();
  tx.addInput({
    txid: '0000000000000000000000000000000000000000000000000000000000000001',
    index: 0,
    witnessUtxo: {
      script: payment.script,
      amount: 100_000n,
    },
    tapInternalKey: xOnlyPubkey,
  });
  tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 50_000n);
  return tx;
}

describe('GolemIdentity', () => {
  it('xOnlyPublicKey returns 32-byte x-only key', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const xOnly = await identity.xOnlyPublicKey();

    expect(xOnly).toBeInstanceOf(Uint8Array);
    expect(xOnly.length).toBe(32);

    // Should match the compressed key minus the prefix byte
    const compressed = await signer.getPublicKey();
    expect(etc.bytesToHex(xOnly)).toBe(etc.bytesToHex(compressed.slice(1)));
  });

  it('compressedPublicKey returns 33-byte compressed key', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const compressed = await identity.compressedPublicKey();

    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(compressed.length).toBe(33);
    expect([0x02, 0x03]).toContain(compressed[0]);

    // Should match signer's public key exactly
    const signerKey = await signer.getPublicKey();
    expect(etc.bytesToHex(compressed)).toBe(etc.bytesToHex(signerKey));
  });

  it('sign(tx) produces a signed Transaction via PSBT round-trip', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const pubkey = await signer.getPublicKey();

    const unsignedTx = createTestArkTx(pubkey);
    const signedTx = await identity.sign(unsignedTx);

    // Should have standard Transaction shape (getInput, toPSBT, etc.)
    expect(typeof signedTx.getInput).toBe('function');
    expect(typeof signedTx.toPSBT).toBe('function');

    // Should have a Schnorr signature on input 0
    const input = signedTx.getInput(0);
    expect(input.tapKeySig).toBeTruthy();
    expect(input.tapKeySig!.length).toBe(64);
  });

  it('sign(tx, inputIndexes) signs specific inputs', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const pubkey = await signer.getPublicKey();

    const unsignedTx = createTestArkTx(pubkey);
    const signedTx = await identity.sign(unsignedTx, [0]);

    const input = signedTx.getInput(0);
    expect(input.tapKeySig).toBeTruthy();
  });

  it('sign(tx) does not mutate the original transaction', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const pubkey = await signer.getPublicKey();

    const unsignedTx = createTestArkTx(pubkey);
    const originalPsbt = unsignedTx.toPSBT();

    await identity.sign(unsignedTx);

    // Original should be unchanged
    const afterPsbt = unsignedTx.toPSBT();
    expect(etc.bytesToHex(originalPsbt)).toBe(etc.bytesToHex(afterPsbt));
  });

  it('signMessage with schnorr delegates to signer', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const message = new TextEncoder().encode('hello ark');

    const sig = await identity.signMessage(message, 'schnorr');

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);

    // Verify signature against x-only pubkey
    const xOnly = await identity.xOnlyPublicKey();
    const valid = await schnorr.verifyAsync(sig, message, xOnly);
    expect(valid).toBe(true);
  });

  it('signMessage with ecdsa delegates to signer', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const message = new Uint8Array(32);
    message[0] = 0xde;

    const sig = await identity.signMessage(message, 'ecdsa');

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);

    const compressed = await identity.compressedPublicKey();
    const valid = await verifyAsync(sig, message, compressed, { prehash: false });
    expect(valid).toBe(true);
  });

  it('signMessage defaults to schnorr', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const message = new TextEncoder().encode('default schnorr');

    const sig = await identity.signMessage(message);

    const xOnly = await identity.xOnlyPublicKey();
    const valid = await schnorr.verifyAsync(sig, message, xOnly);
    expect(valid).toBe(true);
  });

  it('signerSession returns a valid SignerSession', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);
    const session = identity.signerSession();

    expect(session).toBeTruthy();
    expect(typeof session.getPublicKey).toBe('function');
    expect(typeof session.init).toBe('function');
    expect(typeof session.getNonces).toBe('function');
    expect(typeof session.sign).toBe('function');

    // Session key should be different from the identity key (it's ephemeral)
    const sessionPubkey = await session.getPublicKey();
    const identityPubkey = await identity.compressedPublicKey();
    expect(etc.bytesToHex(sessionPubkey)).not.toBe(etc.bytesToHex(identityPubkey));
  });

  it('each signerSession() call returns a fresh session', async () => {
    const signer = MockSigner.create();
    const identity = new GolemIdentity(signer);

    const session1 = identity.signerSession();
    const session2 = identity.signerSession();

    const key1 = await session1.getPublicKey();
    const key2 = await session2.getPublicKey();
    expect(etc.bytesToHex(key1)).not.toBe(etc.bytesToHex(key2));
  });
});
