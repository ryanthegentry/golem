/**
 * 402Index.io API client — queries the public service directory.
 *
 * No authentication required (public API, 100 req/min free tier).
 * Used by `golem directory search` and `golem directory list` CLI commands.
 */

const DEFAULT_BASE_URL = 'https://402index.io';

export interface DirectoryService {
  id: string;
  name: string;
  description: string | null;
  url: string;
  protocol: 'L402' | 'x402' | 'both';
  price_sats: number | null;
  price_usd: number | null;
  payment_asset: string | null;
  payment_network: string | null;
  category: string | null;
  provider: string | null;
  source: string;
  featured: number;
  health_status: 'healthy' | 'degraded' | 'down' | 'unknown';
  uptime_30d: number | null;
  latency_p50_ms: number | null;
  last_checked: string | null;
  registered_at: string;
}

export interface DirectoryResponse {
  services: DirectoryService[];
  total: number;
  limit: number;
  offset: number;
}

export interface DirectoryQuery {
  q?: string;
  protocol?: string;
  category?: string;
  health?: string;
  max_price_usd?: number;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

/**
 * Query the 402Index.io service directory.
 *
 * @param query — search/filter parameters
 * @param baseUrl — override for testing (default: https://402index.io)
 */
export async function queryDirectory(
  query: DirectoryQuery = {},
  baseUrl = DEFAULT_BASE_URL,
): Promise<DirectoryResponse> {
  const url = new URL('/api/v1/services', baseUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`402Index API returned ${res.status}: ${res.statusText}`);
  }

  return await res.json() as DirectoryResponse;
}
