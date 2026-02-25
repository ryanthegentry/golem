import { describe, it, expect } from 'vitest';
import { schnorr, verifyAsync, etc } from '@noble/secp256k1';
import { pubSchnorr } from '@scure/btc-signer/utils.js';
import { Transaction, p2tr } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MockSigner } from './mock-signer.js';

/** Create a minimal P2TR PSBT that can be signed by the given key */
function createTestPsbt(compressedPubkey: Uint8Array): Uint8Array {
  const xOnlyPubkey = compressedPubkey.slice(1);
  const payment = p2tr(xOnlyPubkey);
  const tx = new Transaction({
    allowUnknown: true,
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  });
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
  return tx.toPSBT();
}

describe('MockSigner', () => {
  it('creates a valid instance', () => {
    const signer = MockSigner.create();
    expect(signer).toBeInstanceOf(MockSigner);
  });

  it('getPublicKey returns a 33-byte compressed secp256k1 key', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBeInstanceOf(Uint8Array);
    expect(pubkey.length).toBe(33);
    // Compressed keys start with 0x02 or 0x03
    expect([0x02, 0x03]).toContain(pubkey[0]);
  });

  it('getPublicKey returns consistent key across calls', async () => {
    const signer = MockSigner.create();
    const key1 = await signer.getPublicKey();
    const key2 = await signer.getPublicKey();
    expect(etc.bytesToHex(key1)).toBe(etc.bytesToHex(key2));
  });

  it('fromSecretKey produces deterministic public key', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 1; // minimal valid secret key
    const signer1 = MockSigner.fromSecretKey(secret);
    const signer2 = MockSigner.fromSecretKey(secret);
    const key1 = await signer1.getPublicKey();
    const key2 = await signer2.getPublicKey();
    expect(etc.bytesToHex(key1)).toBe(etc.bytesToHex(key2));
  });

  it('fromSecretKey rejects invalid key', () => {
    const zeros = new Uint8Array(32); // all zeros = invalid
    expect(() => MockSigner.fromSecretKey(zeros)).toThrow('invalid secret key');
  });

  it('signTransaction signs a P2TR PSBT', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const psbt = createTestPsbt(pubkey);

    const result = await signer.signTransaction({ psbt });

    expect(result.psbt).toBeInstanceOf(Uint8Array);
    // Signed PSBT should be different from unsigned (witness data added)
    expect(result.psbt.length).toBeGreaterThan(psbt.length);

    // Verify it can be parsed back and has a signature
    const signedTx = Transaction.fromPSBT(result.psbt, {
      allowUnknown: true,
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    });
    const input = signedTx.getInput(0);
    expect(input.tapKeySig).toBeTruthy();
    expect(input.tapKeySig!.length).toBe(64); // Schnorr sig
  });

  it('signTransaction with inputIndexes signs only specified inputs', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const psbt = createTestPsbt(pubkey);

    const result = await signer.signTransaction({ psbt, inputIndexes: [0] });

    const signedTx = Transaction.fromPSBT(result.psbt, {
      allowUnknown: true,
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    });
    const input = signedTx.getInput(0);
    expect(input.tapKeySig).toBeTruthy();
  });

  it('signTransaction rejects empty data', async () => {
    const signer = MockSigner.create();
    await expect(signer.signTransaction({ psbt: new Uint8Array(0) }))
      .rejects.toThrow('empty transaction data');
  });

  it('signMessage with schnorr produces verifiable signature', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const message = new TextEncoder().encode('test message');
    const sig = await signer.signMessage(message, 'schnorr');

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);

    const xOnlyPubkey = pubkey.slice(1);
    const valid = await schnorr.verifyAsync(sig, message, xOnlyPubkey);
    expect(valid).toBe(true);
  });

  it('signMessage with ecdsa produces verifiable signature', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const message = new Uint8Array(32); // pre-hashed 32-byte message
    message[0] = 0xab;
    const sig = await signer.signMessage(message, 'ecdsa');

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64); // compact ECDSA sig

    const valid = await verifyAsync(sig, message, pubkey, { prehash: false });
    expect(valid).toBe(true);
  });

  it('signMessage rejects empty message', async () => {
    const signer = MockSigner.create();
    await expect(signer.signMessage(new Uint8Array(0), 'schnorr'))
      .rejects.toThrow('empty message');
  });

  it('ping reports available', async () => {
    const signer = MockSigner.create();
    const status = await signer.ping();
    expect(status.available).toBe(true);
    expect(status.lastSeen).toBeTruthy();
    // Verify it's a valid ISO timestamp
    expect(new Date(status.lastSeen).toISOString()).toBe(status.lastSeen);
  });

  it('getSignerInfo returns correct metadata', async () => {
    const signer = MockSigner.create();
    const info = await signer.getSignerInfo();
    expect(info.type).toBe('mock');
    expect(info.label).toContain('MockSigner');
    expect(info.supportsDelegation).toBe(false);
  });

  it('does not expose private key material in errors', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 1;
    const signer = MockSigner.fromSecretKey(secret);
    const secretHex = etc.bytesToHex(secret);

    // Verify the signer works
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBeInstanceOf(Uint8Array);

    // Trigger an error and verify no key material in the message
    try {
      await signer.signTransaction({ psbt: new Uint8Array(0) });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(secretHex);
    }

    // Verify toString/JSON don't leak keys
    const str = String(signer);
    expect(str).not.toContain(secretHex);
    const json = JSON.stringify(signer);
    expect(json).not.toContain(secretHex);
  });

  it('two signers produce different keys', async () => {
    const signer1 = MockSigner.create();
    const signer2 = MockSigner.create();
    const key1 = await signer1.getPublicKey();
    const key2 = await signer2.getPublicKey();
    expect(etc.bytesToHex(key1)).not.toBe(etc.bytesToHex(key2));
  });
});
