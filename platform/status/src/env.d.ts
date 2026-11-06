// The status site's bindings. Named Env so the shared status code (worker/src/status/aggregate.ts) type-checks here.
interface Env {
  DB: D1Database;
  /** This site's origin, for canonical links and API URLs. */
  APP_URL?: string;
  /** The platform, where logos and sign-up live. */
  PLATFORM_URL?: string;
}
