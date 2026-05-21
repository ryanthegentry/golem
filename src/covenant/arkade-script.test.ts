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

  it('returns expected bytecode structure (Fulmine enforcePayTo style, post-PR-#69)', () => {
    const hash = new Uint8Array(20).fill(0x11);
    const wp = new Uint8Array(32).fill(0x22);
    const script = buildClaimArkadeScript(hash, wp);

    // Script layout:
    //   HASH160(a9) PUSH20(14) <20 bytes hash> EQUALVERIFY(88)                              = 23 bytes
    //   INPUTINDEX(cd) DUP(76) INSPECTOUTPUTSCRIPTPUBKEY(d1) OP_1(51) EQUALVERIFY(88)        = 5 bytes
    //   PUSH32(20) <32 bytes WP> EQUALVERIFY(88)                                             = 34 bytes
    //   INSPECTOUTPUTVALUE(cf) INPUTINDEX(cd) INSPECTINPUTVALUE(c9) GREATERTHANOREQUAL(a2)   = 4 bytes
    // Total: 66 bytes
    expect(script[0]).toBe(0xa9); // OP_HASH160
    expect(script[1]).toBe(0x14); // PUSH20
    expect(script[22]).toBe(0x88); // EQUALVERIFY (after hash)
    expect(script[23]).toBe(0xcd); // OP_PUSHCURRENTINPUTINDEX
    expect(script[24]).toBe(0x76); // OP_DUP
    expect(script[25]).toBe(0xd1); // OP_INSPECTOUTPUTSCRIPTPUBKEY
    expect(script[26]).toBe(0x51); // OP_1
    expect(script[27]).toBe(0x88); // EQUALVERIFY
    expect(script[28]).toBe(0x20); // PUSH32
    expect(script[61]).toBe(0x88); // EQUALVERIFY (after wp)
    expect(script[62]).toBe(0xcf); // OP_INSPECTOUTPUTVALUE
    expect(script[63]).toBe(0xcd); // OP_PUSHCURRENTINPUTINDEX
    expect(script[64]).toBe(0xc9); // OP_INSPECTINPUTVALUE
    expect(script[65]).toBe(0xa2); // OP_GREATERTHANOREQUAL (BigInt)
    expect(script.length).toBe(66);
  });

  it('ignores minAmount param (kept for backward-compat with regtest call sites)', () => {
    const hash = new Uint8Array(20).fill(0xab);
    const wp = new Uint8Array(32).fill(0xcd);
    const a = buildClaimArkadeScript(hash, wp);
    const b = buildClaimArkadeScript(hash, wp, 10_000n);
    const c = buildClaimArkadeScript(hash, wp, 99_999n);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });
});
