import { describe, it, expect } from 'vitest';
import { buildRefreshArkadeScript, buildClaimArkadeScript } from './arkade-script.js';

describe('buildRefreshArkadeScript', () => {
  it('returns 7-byte recursive covenant (PR #63)', () => {
    const script = buildRefreshArkadeScript();
    expect(script).toEqual(new Uint8Array([
      0x00, 0xd1, // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp_out, ver_out]
      0x00, 0xca, // OP_0 OP_INSPECTINPUTSCRIPTPUBKEY → [wp_out, ver_out, wp_in, ver_in]
      0x7b,       // OP_ROT → [wp_out, wp_in, ver_in, ver_out]
      0x88,       // OP_EQUALVERIFY → versions equal, stack: [wp_out, wp_in]
      0x87,       // OP_EQUAL → witness programs equal
    ]));
  });

  it('returns Uint8Array of length 7', () => {
    expect(buildRefreshArkadeScript()).toHaveLength(7);
  });

  it('is deterministic (stateless)', () => {
    const a = buildRefreshArkadeScript();
    const b = buildRefreshArkadeScript();
    expect(a).toEqual(b);
  });
});

describe('buildClaimArkadeScript', () => {
  it('rejects preimageHash that is not 20 bytes', () => {
    const badHash = new Uint8Array(19);
    const wp = new Uint8Array(32);
    expect(() => buildClaimArkadeScript(badHash, wp, 1000n)).toThrow('Expected 20-byte');
  });

  it('rejects witnessProgram that is not 32 bytes', () => {
    const hash = new Uint8Array(20);
    const badWp = new Uint8Array(31);
    expect(() => buildClaimArkadeScript(hash, badWp, 1000n)).toThrow('Expected 32-byte');
  });

  it('encodes minAmount as LE 8-byte', () => {
    const hash = new Uint8Array(20).fill(0xab);
    const wp = new Uint8Array(32).fill(0xcd);
    const script = buildClaimArkadeScript(hash, wp, 10_000n);

    // Find the amount bytes: after INSPECTOUTPUTVALUE opcode (0xcf), preceded by push8 (0x08)
    // Script layout:
    //   HASH160(a9) PUSH20(14) <20 bytes hash> EQUALVERIFY(88)     = 23 bytes
    //   OP_0(00) INSPECTOUTPUTSCRIPTPUBKEY(d1) OP_1(51) EQUALVERIFY(88) = 4 bytes
    //   PUSH32(20) <32 bytes WP> EQUALVERIFY(88)                    = 34 bytes
    //   OP_0(00) INSPECTOUTPUTVALUE(cf) PUSH8(08) <8 bytes LE> GTE64(df) = 12 bytes
    // Total: 73 bytes

    // 10_000 in LE = 0x10, 0x27, 0x00, ...
    const amountOffset = 23 + 4 + 34 + 3; // after OP_0 INSPECTOUTPUTVALUE PUSH8
    const amountBytes = script.slice(amountOffset, amountOffset + 8);
    const view = new DataView(amountBytes.buffer, amountBytes.byteOffset, 8);
    expect(view.getBigUint64(0, true)).toBe(10_000n);
  });

  it('returns expected bytecode structure', () => {
    const hash = new Uint8Array(20).fill(0x11);
    const wp = new Uint8Array(32).fill(0x22);
    const script = buildClaimArkadeScript(hash, wp, 500n);

    // Verify structure markers
    expect(script[0]).toBe(0xa9); // OP_HASH160
    expect(script[1]).toBe(0x14); // PUSH20
    expect(script[22]).toBe(0x88); // EQUALVERIFY (after hash)
    expect(script[23]).toBe(0x00); // OP_0
    expect(script[24]).toBe(0xd1); // OP_INSPECTOUTPUTSCRIPTPUBKEY
    expect(script[25]).toBe(0x51); // OP_1
    expect(script[26]).toBe(0x88); // EQUALVERIFY
    expect(script.length).toBe(73);
  });
});
