// Inbound webhooks: payment providers with webhooks of their own (Stripe, Dodo Payments) post to paynp, which turns
// each provider event into PaymentEvents and ingests them like SDK events. paynp registers the webhook in the
// provider with the merchant's API key, so the merchant never copies a URL or signing secret by hand.
import type { Env } from "./api.ts";

export const INBOUND_PROVIDERS = ["stripe", "dodo"] as const;
export type InboundProvider = (typeof INBOUND_PROVIDERS)[number];

export const INBOUND_PROVIDER_NAMES: Record<InboundProvider, string> = { stripe: "Stripe", dodo: "Dodo Payments" };

export interface InboundSource {
  id: string;
  env: Env;
  provider: InboundProvider;
  /** The webhook's id in the provider (Stripe we_..., Dodo whk_...). */
  provider_webhook_id: string;
  /** Where the provider posts. */
  url: string;
  /** Masked API key, e.g. rk_test_51H****9xQz. */
  api_key_hint: string;
  enabled: boolean;
  last_event_at: number | null;
  /** Last signature or mapping error, cleared by the next good delivery. */
  last_error: string | null;
  created_at: number;
}
