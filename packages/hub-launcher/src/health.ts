/**
 * Hub health probing over the kernel's public `GET /api/auth/status` endpoint (no token needed;
 * any 200 response means the HTTP layer is serving). Used as the readiness gate for started Hub
 * candidates and as an identity confirmation before signalling a recorded pid.
 */
import { DEFAULTS } from './layout.js';

export interface HubHealthStatus {
  configured: boolean;
  authenticated: boolean;
}

/** Connect host for health probes: wildcard listen addresses are probed on loopback. */
function connectHost(host: string | undefined): string {
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

export function hubHealthUrl(port: number, host?: string): string {
  return `http://${connectHost(host)}:${port}/api/auth/status`;
}

/** One best-effort probe; `null` on timeout, connection failure, non-200, or malformed body. */
export async function probeHubHealth(
  port: number,
  host: string | undefined,
  options?: { fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<HubHealthStatus | null> {
  const fetchImpl = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULTS.healthRequestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(hubHealthUrl(port, host), { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { configured?: unknown; authenticated?: unknown };
    if (typeof body.configured !== 'boolean' || typeof body.authenticated !== 'boolean') return null;
    return { configured: body.configured, authenticated: body.authenticated };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll the health endpoint until it answers or the overall budget expires. Rejects with the last
 * failure detail — callers append their own diagnostics (e.g. the hub log tail).
 */
export async function waitForHubHealth(
  port: number,
  host: string | undefined,
  options: { timeoutMs: number; pollMs?: number; fetchFn?: typeof fetch },
): Promise<HubHealthStatus> {
  const pollMs = options.pollMs ?? DEFAULTS.healthPollMs;
  const url = hubHealthUrl(port, host);
  const deadline = Date.now() + options.timeoutMs;
  let lastError = 'no probe attempted';
  for (;;) {
    const status = await probeHubHealth(port, host, {
      fetchFn: options.fetchFn,
      timeoutMs: Math.min(DEFAULTS.healthRequestTimeoutMs, Math.max(pollMs * 2, 250)),
    });
    if (status !== null) return status;
    lastError = `GET ${url} not answering`;
    if (Date.now() + pollMs >= deadline) {
      throw new Error(`hub health check failed: ${url} did not answer within ${options.timeoutMs}ms (last: ${lastError})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
