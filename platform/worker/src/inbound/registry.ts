import type { InboundProvider, InboundSource } from "@paynp/shared";
import { dodo } from "./dodo.ts";
import { stripe } from "./stripe.ts";
import type { ProviderAdapter } from "./types.ts";

export const ADAPTERS: Record<InboundProvider, ProviderAdapter> = { stripe, dodo };

export interface SourceRow {
  id: string;
  project_id: string;
  env: "test" | "live";
  provider: InboundProvider;
  provider_webhook_id: string;
  secret_enc: string;
  api_key_enc: string;
  api_key_hint: string;
  enabled: number;
  last_event_at: number | null;
  last_error: string | null;
  created_at: number;
}

export const inboundUrl = (origin: string, id: string) => `${origin}/v1/inbound/${id}`;

export const keyHint = (k: string) => (k.length > 16 ? `${k.slice(0, 12)}****${k.slice(-4)}` : "****");

export const toSource = (r: SourceRow, origin: string): InboundSource => ({
  id: r.id,
  env: r.env,
  provider: r.provider,
  provider_webhook_id: r.provider_webhook_id,
  url: inboundUrl(origin, r.id),
  api_key_hint: r.api_key_hint,
  enabled: !!r.enabled,
  last_event_at: r.last_event_at,
  last_error: r.last_error,
  created_at: r.created_at,
});
