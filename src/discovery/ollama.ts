/**
 * Ollama auto-discovery — detect local Ollama instance.
 */

export interface OllamaDiscoveryResult {
  url: string;
  models: string[];
}

export async function discoverOllama(
  baseUrl = 'http://localhost:11434',
  timeoutMs = 2000,
): Promise<OllamaDiscoveryResult | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map(m => m.name);

    return { url: baseUrl, models };
  } catch {
    return null;
  }
}
