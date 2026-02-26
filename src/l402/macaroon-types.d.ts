declare module 'macaroon' {
  interface MacaroonJSON {
    v: number;
    s64?: string;
    s?: string;
    i64?: string;
    i?: string;
    l?: string;
    c?: Array<{ i64?: string; i?: string; l?: string; v64?: string; v?: string }>;
  }

  interface Macaroon {
    addFirstPartyCaveat(caveat: string): void;
    addThirdPartyCaveat(rootKey: Uint8Array, condition: string, loc: string): void;
    bindToRoot(rootMac: Macaroon): void;
    clone(): Macaroon;
    verify(rootKey: Uint8Array, check: (caveat: string) => string | null, discharges: Macaroon[]): void;
    exportJSON(): MacaroonJSON;
    exportBinary(): Uint8Array;
    caveats(): Array<{ _identifierStr?: string }>;
    location: string;
  }

  interface NewMacaroonParams {
    rootKey: Uint8Array;
    identifier: Uint8Array | string;
    location?: string;
  }

  export function newMacaroon(params: NewMacaroonParams): Macaroon;
  export function importMacaroon(data: Uint8Array): Macaroon;
  export function importMacaroons(data: Uint8Array): Macaroon[];
  export function dischargeMacaroon(
    macaroon: Macaroon,
    getDischarge: (loc: string, thirdPartyCaveatCondition: string) => Macaroon,
  ): Macaroon[];
  export function bytesToBase64(bytes: Uint8Array): string;
  export function base64ToBytes(s: string): Uint8Array;
}
