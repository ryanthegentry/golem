export type SweepAddressType = 'lightning-address' | 'lnurl-pay' | 'bolt11' | 'lnurl-raw';

export interface SweepConfig {
  enabled: boolean;
  address: string;
  threshold: number;
  /** Sats to keep in wallet after sweep. Default: 10000 */
  keep: number;
  /** Minimum sweep amount. Default: 5000 */
  minSweep: number;
}

export interface ResolvedInvoice {
  bolt11: string;
  amountSats: number;
  description?: string;
}

export interface LnurlPayResponse {
  callback: string;
  minSendable: number;  // millisats
  maxSendable: number;  // millisats
  tag: 'payRequest';
  metadata: string;
}

export interface LnurlCallbackResponse {
  pr: string;  // bolt11 invoice
  routes?: unknown[];
}

export type SweepEvent =
  | { type: 'check'; balance: number; threshold: number; timestamp: string }
  | { type: 'sweep_start'; amount: number; destination: string; timestamp: string }
  | { type: 'sweep_ok'; amount: number; destination: string; preimage: string; timestamp: string }
  | { type: 'sweep_skip'; reason: string; timestamp: string }
  | { type: 'sweep_error'; error: string; timestamp: string }
  | { type: 'stopped'; timestamp: string };
