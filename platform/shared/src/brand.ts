// The product name in one place. Renaming the product starts here (and the CLI's package.json "bin").
export const NAME = "paynp";
export const DISPLAY_NAME = "paynp";
// Hosted on a subdomain of a domain the owner already has, until the product gets its own.
export const DEFAULT_ENDPOINT = "https://paynp.discerns.app";
export const LOCAL_ENDPOINT = "http://localhost:8787";
export const KEY_PREFIX = { test: "pnp_test_", live: "pnp_live_", pat: "pnp_pat_" } as const;
export const SESSION_COOKIE = `${NAME}_session`;
export const CSRF_HEADER = "X-Paynp-CSRF";
export const SIGNATURE_HEADER = "X-Paynp-Signature";
export const TIMESTAMP_HEADER = "X-Paynp-Timestamp";
