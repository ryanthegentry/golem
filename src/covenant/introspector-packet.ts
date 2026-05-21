import { encodeVarint, encodeUvarint } from './encoding.js';
import type { Transaction } from '@scure/btc-signer';

/**
 * arkd-side PSBT custom field for "condition witness" — the witness data the
 * conditionScript inside a ConditionMultisigTapscript leaf needs (e.g. the
 * preimage for HASH160 EQUAL). See arkade-os/arkd:pkg/ark-lib/txutils/psbt_fields.go
 * (ArkPsbtFieldKeyType=222, ArkFieldConditionWitness=[]byte("condition")).
 *
 * arkd reads this field in verifyNonArkdCheckpointSignatures →
 * VerifyTapscriptSigs (pkg/ark-lib/script/verify.go) to execute the
 * conditionScript before validating the multisig signatures. If absent, the
 * conditionScript pops from an empty stack and fails "index 0 invalid for
 * stack size 0".
 */
const ARK_PSBT_FIELD_KEY_TYPE = 222;
const ARK_FIELD_CONDITION_WITNESS = new Uint8Array([0x63, 0x6f, 0x6e, 0x64, 0x69, 0x74, 0x69, 0x6f, 0x6e]); // utf8 "condition"

/** Build OP_RETURN script with Introspector Packet */
export function buildOpReturnScript(entries: Array<{ vin: number; script: Uint8Array; witness?: Uint8Array }>): Uint8Array {
  entries.sort((a, b) => a.vin - b.vin);
  const entryParts: number[] = [];
  for (const entry of entries) {
    entryParts.push(entry.vin & 0xff, (entry.vin >> 8) & 0xff);
    const scriptLen = encodeVarint(entry.script.length);
    entryParts.push(...scriptLen, ...entry.script);
    const witnessData = entry.witness ?? new Uint8Array(0);
    const witnessLen = encodeVarint(witnessData.length);
    entryParts.push(...witnessLen, ...witnessData);
  }
  const entryCount = encodeVarint(entries.length);
  const packetPayload = new Uint8Array([...entryCount, ...entryParts]);
  const tlvRecord = new Uint8Array([0x01, ...encodeUvarint(packetPayload.length), ...packetPayload]);
  const data = new Uint8Array([0x41, 0x52, 0x4b, ...tlvRecord]); // "ARK" + TLV

  let pushOpcode: Uint8Array;
  if (data.length <= 0x4b) pushOpcode = new Uint8Array([data.length]);
  else if (data.length <= 0xff) pushOpcode = new Uint8Array([0x4c, data.length]);
  else pushOpcode = new Uint8Array([0x4d, data.length & 0xff, (data.length >> 8) & 0xff]);

  return new Uint8Array([0x6a, ...pushOpcode, ...data]);
}

/** Encode witness stack for Introspector Packet (standard Bitcoin witness format) */
export function encodeWitnessStack(items: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  parts.push(...encodeVarint(items.length));
  for (const item of items) {
    parts.push(...encodeVarint(item.length), ...item);
  }
  return new Uint8Array(parts);
}

/**
 * Attach a "condition witness" PSBT field to `tx`'s input at `inputIndex`. The
 * field value is the serialized witness stack containing whatever the
 * conditionScript needs to consume (e.g. `[preimage]` for HASH160 EQUAL).
 *
 * Required when the leaf at that input is a ConditionMultisigTapscript (or
 * ConditionCSVMultisigTapscript). arkd reads this field during checkpoint
 * signature verification — see ARK_PSBT_FIELD_KEY_TYPE comment above.
 */
export function setConditionWitness(
  tx: Transaction,
  inputIndex: number,
  witness: Uint8Array[],
): void {
  const witnessBytes = encodeWitnessStack(witness);
  const input = tx.getInput(inputIndex);
  const existing = input.unknown ?? [];
  tx.updateInput(inputIndex, {
    unknown: [
      ...existing,
      [{ type: ARK_PSBT_FIELD_KEY_TYPE, key: ARK_FIELD_CONDITION_WITNESS }, witnessBytes],
    ],
  });
}
