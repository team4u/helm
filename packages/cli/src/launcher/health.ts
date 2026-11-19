/**
 * Hub health probing over the kernel's public `GET /api/auth/status` endpoint (no token needed;
 * any 200 response means the HTTP layer is serving). This is auxiliary-only in the launcher: the
 * readiness gate is the candidate's own `Helm Hub: ` listen line (process.ts); this probe backs
 * identity confirmation before signalling a recorded pid and the read-only `status` snapshot.
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
