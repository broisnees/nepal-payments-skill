// The product name in one place. Renaming the product starts here (and the CLI's package.json "bin").
export const NAME = "paynp";
export const DISPLAY_NAME = "discerns";
// The hosted service. paynp.discerns.app still routes to the same Worker for installs from before the move.
export const DEFAULT_ENDPOINT = "https://discerns.app";
export const LOCAL_ENDPOINT = "http://localhost:8787";
export const KEY_PREFIX = { test: "pnp_test_", live: "pnp_live_", pat: "pnp_pat_" } as const;
export const SESSION_COOKIE = `${NAME}_session`;
export const CSRF_HEADER = "X-Paynp-CSRF";
export const SIGNATURE_HEADER = "X-Paynp-Signature";
export const TIMESTAMP_HEADER = "X-Paynp-Timestamp";
// The sister product: the open-source skill and gateway adapters. One line each, so a rename touches only these.
export const SKILL_SITE_NAME = "Nepal Payments";
export const SKILL_SITE_URL = "https://skill.discerns.app";
// The third product: live status of every Nepali gateway, with a public API and a checkout widget.
export const STATUS_SITE_NAME = "discerns status";
export const STATUS_SITE_URL = "https://status.discerns.app";
export const REPO_URL = "https://github.com/broisnees/nepal-payments-skill";
