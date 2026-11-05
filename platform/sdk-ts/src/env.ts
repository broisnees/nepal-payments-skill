// Which gateway environment a host belongs to, from the hosts in skills/nepal-payments/references/*.md.
// The server flags a live paynp key talking to a sandbox host (SPEC-v2 section 4.4).

import { GATEWAY_HOSTS } from "./trace.ts";

/** Sandbox and test hosts per gateway. Every other host under the gateway's domain counts as production. */
export const SANDBOX_HOSTS: Record<string, readonly string[]> = {
  // rc-epay (form), rc (status), rc-checkout (Intent), rc-links (deeplinks); uat is dead but still in tutorials.
  esewa: ["rc.esewa.com.np", "rc-epay.esewa.com.np", "rc-checkout.esewa.com.np", "rc-links.esewa.com.np", "uat.esewa.com.np"],
  khalti: ["dev.khalti.com", "test-pay.khalti.com", "test-admin.khalti.com"],
  fonepay: ["dev-clientapi.fonepay.com", "dev-merchantapi.fonepay.com", "dev-merchant-login.fonepay.com"],
  connectips: ["uat.connectips.com"],
  cybersource: ["testsecureacceptance.cybersource.com", "apitest.cybersource.com", "businesscentertest.cybersource.com"],
  nps: ["apisandbox.nepalpayment.com", "gatewaysandbox.nepalpayment.com"],
  // IME Pay runs both on port 7979; the test one is stg.
  imepay: ["stg.imepay.com.np"],
};

const SANDBOX = new Set(Object.values(SANDBOX_HOSTS).flat());
const ALL_SUFFIXES = Object.values(GATEWAY_HOSTS).flat();

const under = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * "sandbox" for a known test host, "production" for any other host under a known gateway domain, undefined for
 * anything else (localhost, a custom host the app passed in `hosts`, a relative URL).
 */
export function gwEnvOf(urlOrHost: string | URL | null | undefined): "sandbox" | "production" | undefined {
  if (!urlOrHost) return undefined;
  let host: string;
  if (urlOrHost instanceof URL) host = urlOrHost.hostname;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost)) {
    try {
      host = new URL(urlOrHost).hostname;
    } catch {
      return undefined;
    }
  } else host = urlOrHost.split(":")[0];
  host = host.toLowerCase();
  if (!host) return undefined;
  if (SANDBOX.has(host)) return "sandbox";
  // Prefixed sandboxes under a known sandbox host (www.dev.khalti.com and the like).
  for (const s of SANDBOX) if (host.endsWith(`.${s}`)) return "sandbox";
  if (ALL_SUFFIXES.some((s) => under(host, s))) return "production";
  return undefined;
}

/** Whether a return URL uses https, or undefined when it isn't an absolute URL. */
export function isHttps(url: unknown): boolean | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return false;
    return undefined;
  } catch {
    return undefined;
  }
}
