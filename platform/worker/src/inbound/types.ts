import type { InboundProvider, PaymentEvent } from "@paynp/shared";
import { HttpError } from "../lib/util.ts";

export interface Registered {
  /** The webhook's id in the provider. */
  id: string;
  /** Its signing secret. */
  secret: string;
}

export type Verified = { ok: true; body: unknown; /** Provider's id for this delivery, stable across retries. */ deliveryId: string } | { ok: false; error: string };

export interface ProviderAdapter {
  id: InboundProvider;
  /** Throws an HttpError 400 when the key cannot be used for this environment. */
  checkKey(apiKey: string, env: "test" | "live"): void;
  register(apiKey: string, env: "test" | "live", url: string, description: string): Promise<Registered>;
  /** Deletes the webhook; resolves when it is gone, including when the provider no longer has it. */
  remove(apiKey: string, env: "test" | "live", webhookId: string): Promise<void>;
  verify(raw: string, headers: Headers, secret: string, nowMs: number): Promise<Verified>;
  /** Unvalidated events; the caller runs validateEvent on each. Unknown provider events map to []. */
  map(body: unknown, deliveryId: string): PaymentEvent[];
}

/** Signatures older or newer than this are rejected, as both providers' own libraries do. */
export const TOLERANCE_MS = 5 * 60_000;

/** Provider API failures, surfaced to the dashboard as 502 with the provider's message. */
export async function providerError(provider: string, res: Response): Promise<Error> {
  let msg = `${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: string } | string; message?: string };
    msg = (typeof j.error === "object" ? j.error?.message : j.error) ?? j.message ?? msg;
  } catch {
    /* not JSON */
  }
  const code = res.status === 401 || res.status === 403 ? "provider_auth" : "provider_error";
  return new HttpError(502, code, `${provider} said: ${String(msg).slice(0, 300)}`);
}
