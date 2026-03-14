/**
 * 402index.io auto-registration client.
 *
 * Registers the gateway with the public L402 directory on startup.
 * Non-blocking — registration failure never prevents gateway from starting.
 */

export interface RegistrationParams {
  registryUrl: string;
  publicUrl: string;
  serviceName: string;
  description?: string;
  priceSats: number;
  category?: string;
  contactEmail?: string;
  probeBody?: string;
}

export type RegistrationStatus = 'pending' | 'already_registered' | 'probe_failed' | 'failed' | 'skipped';

export interface RegistrationResult {
  status: RegistrationStatus;
  id?: string;
  error?: string;
  reason?: string;
}

export async function registerWithIndex(params: RegistrationParams): Promise<RegistrationResult> {
  if (!params.publicUrl) {
    return { status: 'skipped', reason: 'No publicUrl configured — cannot register with 402index. Set publicUrl in golem.yaml or pass --public-url.' };
  }

  const body = {
    url: params.publicUrl,
    name: params.serviceName,
    protocol: 'L402',
    description: params.description,
    provider: 'golem-gateway',
    category: params.category ?? 'ai/inference',
    http_method: 'POST',
    contact_email: params.contactEmail,
    probe_body: params.probeBody,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${params.registryUrl}/api/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.status === 201) {
      const data = await response.json() as { id: string; status: string };
      return { status: 'pending', id: data.id };
    }

    if (response.status === 409) {
      return { status: 'already_registered' };
    }

    if (response.status === 422) {
      const data = await response.json() as { error: string };
      return { status: 'probe_failed', error: data.error };
    }

    const text = await response.text().catch(() => '');
    return { status: 'failed', error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}
