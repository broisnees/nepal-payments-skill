export type ProviderKey = "esewa" | "khalti" | "fonepay" | "connectips" | "cybersource" | "nps" | "imepay" | "nepalpay";

export interface ProviderSnippet {
  /** Start a payment for one attempt. */
  initiate: string;
  /** Return-handler body: verify with stored values, then decideTransition. */
  verify: string;
  /** Short language-specific facts for this provider. */
  notes?: string[];
}

export interface LangSnippets {
  lang: "ts" | "python" | "java" | "kotlin" | "php" | "go";
  label: string;
  /** Build the payments object from env vars once. */
  setup: string;
  providers: Record<ProviderKey, ProviderSnippet>;
}
