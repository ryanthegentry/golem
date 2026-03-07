import { encodeVarint, encodeUvarint } from './encoding.js';

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
