// Stack detection for `paynp init` and the wiring snippet printed for each stack.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ENDPOINT } from "../../shared/src/brand.ts";

export type StackId =
  | "nextjs" | "hono" | "fastify" | "express" | "node"
  | "laravel" | "php"
  | "django" | "fastapi" | "flask" | "python"
  | "go" | "spring" | "ktor" | "jvm"
  | "unknown";

export interface Stack {
  id: StackId;
  name: string;
  js: boolean;
  from: string; // file the detection came from
}

const NAMES: Record<StackId, string> = {
  nextjs: "Next.js", hono: "Hono", fastify: "Fastify", express: "Express", node: "Node.js",
  laravel: "Laravel", php: "PHP", django: "Django", fastapi: "FastAPI", flask: "Flask", python: "Python",
  go: "Go", spring: "Spring Boot", ktor: "Ktor", jvm: "JVM", unknown: "unknown",
};

const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const stack = (id: StackId, from: string): Stack => ({ id, name: NAMES[id], js: ["nextjs", "hono", "fastify", "express", "node"].includes(id), from });

export function detectStack(cwd: string): Stack {
  const pkgText = read(join(cwd, "package.json"));
  if (pkgText) {
    let deps: Record<string, string> = {};
    try {
      const pkg = JSON.parse(pkgText);
      deps = { ...pkg.devDependencies, ...pkg.dependencies };
    } catch {
      /* broken package.json: still a JS project */
    }
    for (const [dep, id] of [["next", "nextjs"], ["hono", "hono"], ["fastify", "fastify"], ["express", "express"]] as const) {
      if (dep in deps) return stack(id, "package.json");
    }
    return stack("node", "package.json");
  }

  const composer = read(join(cwd, "composer.json"));
  if (composer !== null) return stack(/"laravel\/framework"/.test(composer) || existsSync(join(cwd, "artisan")) ? "laravel" : "php", "composer.json");

  for (const f of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]) {
    const t = read(join(cwd, f));
    if (t === null) continue;
    const lower = t.toLowerCase();
    // Whole package names only: "django" matches "Django>=5" and "django-environ", not "mydjangoapp".
    if (/(^|[^a-z0-9_-])django([^a-z0-9_]|$)/m.test(lower)) return stack("django", f);
    if (/(^|[^a-z0-9_-])fastapi([^a-z0-9_]|$)/m.test(lower)) return stack("fastapi", f);
    if (/(^|[^a-z0-9_-])flask([^a-z0-9_]|$)/m.test(lower)) return stack("flask", f);
    return stack("python", f);
  }
  if (existsSync(join(cwd, "manage.py"))) return stack("django", "manage.py");

  if (existsSync(join(cwd, "go.mod"))) return stack("go", "go.mod");

  for (const f of ["build.gradle.kts", "build.gradle", "pom.xml"]) {
    const t = read(join(cwd, f));
    if (t === null) continue;
    if (/io\.ktor/.test(t)) return stack("ktor", f);
    if (/org\.springframework\.boot/.test(t)) return stack("spring", f);
    return stack("jvm", f);
  }

  try {
    if (readdirSync(cwd).some((f) => f.endsWith(".php"))) return stack("php", "*.php");
  } catch {
    /* unreadable dir */
  }
  return stack("unknown", "");
}

const GATEWAYS = ["esewa", "khalti", "fonepay", "connectips", "cybersource", "nps", "imepay", "nepalpay", "hamropay", "getpay"];

/** The gateway module the app already has (esewa.ts, khalti.py, ...), if any. Defaults to esewa. */
export function detectGateway(cwd: string): string {
  for (const dir of [".", "src", "lib", "app", "payments", "src/lib", "app/Payments"]) {
    let files: string[];
    try {
      files = readdirSync(join(cwd, dir)).map((f) => f.toLowerCase());
    } catch {
      continue;
    }
    for (const g of GATEWAYS) if (files.some((f) => f.startsWith(g) || f.startsWith(`${g}gateway`))) return g;
  }
  return "esewa";
}

/** How the app gets PAYNP_KEY from .env into its environment. */
export function envHint(id: StackId): string {
  switch (id) {
    case "nextjs":
    case "laravel":
      return "loads .env on its own.";
    case "express":
    case "fastify":
    case "hono":
    case "node":
      return "start it with node --env-file=.env server.js (or npx tsx --env-file=.env server.ts).";
    case "django":
    case "fastapi":
    case "flask":
    case "python":
      return "load it with python-dotenv (pip install python-dotenv, then load_dotenv() at startup), or export the variables in the shell.";
    case "go":
      return "export the variables before go run (set -a; . ./.env; set +a), or load it with github.com/joho/godotenv.";
    case "spring":
    case "ktor":
    case "jvm":
      return "export the variables before starting (set -a; . ./.env; set +a); Spring can also use spring.config.import=optional:file:.env[.properties].";
    case "php":
      return "export the variables in the web server or PHP-FPM config, or load it with vlucas/phpdotenv.";
    default:
      return "make PAYNP_KEY (and PAYNP_ENDPOINT if set) available as environment variables.";
  }
}

const jsNode = (g: string) => `// paynp.ts, next to ${g}.ts
import { createPaynp } from "@paynp/sdk";
import * as ${g} from "./${g}";
export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
export const gateway = paynp.wrapGateway("${g}", ${g});

// server.ts: import { gateway } from "./paynp";   instead of: import * as gateway from "./${g}";
// payments.ts, in settle() where transition() returned true (import { paynp } from "./paynp"):
//   paynp.statusChanged({ attemptId: attempt.id, gateway: "${g}", to: s, orderId: attempt.orderId });
//   paynp.fulfilled({ attemptId: attempt.id, gateway: "${g}", orderId: attempt.orderId }); // next to fulfil()`;

const nextjs = (g: string) => `// paynp.ts, next to ${g}.ts in the project root
import { createPaynp } from "@paynp/sdk";
import * as ${g} from "./${g}";
export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
export const gateway = paynp.wrapGateway("${g}", ${g});

// In app/pay/[orderId]/route.ts and app/pay/return/[attemptId]/route.ts:
//   import { after } from "next/server";
//   import { gateway, paynp } from "@/paynp";   // instead of: import * as gateway from "@/${g}"
//   after(() => paynp.flush());                 // first line of the handler: send events before the function freezes`;

const hono = (g: string) => `${jsNode(g)}

// On Cloudflare Workers: createPaynp({ key: c.env.PAYNP_KEY }) inside the handler, then
//   c.executionCtx.waitUntil(paynp.flush());`;

const python = (g: string, framework: string) => `# paynp.py: paynp has no Python SDK yet; this sends events to the ingest API directly.
import json, os, secrets, threading, urllib.request
from datetime import datetime, timezone

def paynp_event(type, attempt_id, gateway="${g}", **fields):
    key = os.environ.get("PAYNP_KEY")
    if not key:
        return  # no key: no-op
    event = {"id": "evt_" + secrets.token_hex(13), "type": type, "attempt_id": attempt_id, "gateway": gateway,
             "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), **fields}
    req = urllib.request.Request(os.environ.get("PAYNP_ENDPOINT", "${DEFAULT_ENDPOINT}") + "/v1/events",
                                 json.dumps({"events": [event]}).encode(),
                                 {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    def send():
        try:
            urllib.request.urlopen(req, timeout=5).close()
        except Exception:
            pass  # paynp being down never breaks a checkout
    threading.Thread(target=send, daemon=True).start()

# ${framework}: call it where the payment moves, e.g. in settle():
#   paynp_event("status.changed", attempt.id, status=to, data={"from": attempt.status, "to": to})
#   paynp_event("payment.fulfilled", attempt.id, order_id=attempt.order_id, status="paid")`;

const laravel = (g: string) => `<?php
// app/Payments/Paynp.php: paynp has no PHP SDK yet; this sends events to the ingest API directly.
namespace App\\Payments;

use Illuminate\\Support\\Facades\\Http;
use Illuminate\\Support\\Str;

class Paynp
{
    public static function event(string $type, string $attemptId, array $fields = [], string $gateway = '${g}'): void
    {
        $key = env('PAYNP_KEY');
        if (!$key) return; // no key: no-op
        $event = ['id' => 'evt_' . Str::ulid(), 'type' => $type, 'attempt_id' => $attemptId, 'gateway' => $gateway,
                  'ts' => now('UTC')->format('Y-m-d\\TH:i:s.v\\Z')] + $fields;
        $url = env('PAYNP_ENDPOINT', '${DEFAULT_ENDPOINT}') . '/v1/events';
        // After the response is sent, so paynp never slows down or breaks a checkout.
        dispatch(function () use ($key, $url, $event) {
            try { Http::withToken($key)->timeout(5)->post($url, ['events' => [$event]]); } catch (\\Throwable) {}
        })->afterResponse();
    }
}

// In settle(): Paynp::event('status.changed', $attempt->id, ['status' => $to, 'data' => ['from' => $attempt->status, 'to' => $to]]);`;

const php = (g: string) => `<?php
// paynp.php: paynp has no PHP SDK yet; this sends events to the ingest API directly.
function paynp_event(string $type, string $attemptId, array $fields = [], string $gateway = '${g}'): void
{
    $key = getenv('PAYNP_KEY');
    if (!$key) return; // no key: no-op
    $now = DateTime::createFromFormat('U.u', sprintf('%.6F', microtime(true)));
    $event = ['id' => 'evt_' . bin2hex(random_bytes(13)), 'type' => $type, 'attempt_id' => $attemptId,
              'gateway' => $gateway, 'ts' => $now->format('Y-m-d\\TH:i:s.v\\Z')] + $fields;
    $ch = curl_init((getenv('PAYNP_ENDPOINT') ?: '${DEFAULT_ENDPOINT}') . '/v1/events');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 3,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key, 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['events' => [$event]])]);
    curl_exec($ch); // errors ignored: paynp being down never breaks a checkout
    curl_close($ch);
}

// In settle(): paynp_event('status.changed', $attempt['id'], ['status' => $to, 'data' => ['from' => $attempt['status'], 'to' => $to]]);`;

const go = (g: string) => `// payments/paynp.go: paynp has no Go SDK yet; this sends events to the ingest API directly.
package payments

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"time"
)

var paynpClient = &http.Client{Timeout: 5 * time.Second}

// PaynpEvent sends one event in the background. No PAYNP_KEY: no-op.
func PaynpEvent(typ, attemptID string, fields map[string]any) {
	key := os.Getenv("PAYNP_KEY")
	if key == "" {
		return
	}
	id := make([]byte, 13)
	rand.Read(id)
	ev := map[string]any{"id": "evt_" + hex.EncodeToString(id), "type": typ, "attempt_id": attemptID, "gateway": "${g}",
		"ts": time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")}
	for k, v := range fields {
		ev[k] = v
	}
	body, _ := json.Marshal(map[string]any{"events": []any{ev}})
	endpoint := os.Getenv("PAYNP_ENDPOINT")
	if endpoint == "" {
		endpoint = "${DEFAULT_ENDPOINT}"
	}
	go func() {
		req, _ := http.NewRequest("POST", endpoint+"/v1/events", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		if res, err := paynpClient.Do(req); err == nil {
			res.Body.Close()
		} // errors ignored: paynp being down never breaks a checkout
	}()
}

// In Settle(): PaynpEvent("status.changed", attempt.ID, map[string]any{"status": to, "data": map[string]any{"from": from, "to": to}})`;

const jvmHeader = (lang: "java" | "kotlin", g: string) =>
  lang === "java"
    ? `// src/main/java/payments/Paynp.java: paynp has no Java SDK yet; this sends events to the ingest API directly.
package payments;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;

public final class Paynp {
  private static final HttpClient CLIENT = HttpClient.newHttpClient();
  private static final SecureRandom RANDOM = new SecureRandom();

  /** Sends one event in the background. extraJson: more fields, e.g. "\\"status\\":\\"paid\\"". No PAYNP_KEY: no-op. */
  public static void event(String type, String attemptId, String extraJson) {
    String key = System.getenv("PAYNP_KEY");
    if (key == null || key.isEmpty()) return;
    byte[] id = new byte[13];
    RANDOM.nextBytes(id);
    String ts = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString();
    String ev = "{\\"id\\":\\"evt_" + HexFormat.of().formatHex(id) + "\\",\\"type\\":\\"" + type + "\\",\\"attempt_id\\":\\"" + attemptId
        + "\\",\\"gateway\\":\\"${g}\\",\\"ts\\":\\"" + ts + "\\"" + (extraJson.isEmpty() ? "" : "," + extraJson) + "}";
    String endpoint = System.getenv().getOrDefault("PAYNP_ENDPOINT", "${DEFAULT_ENDPOINT}");
    HttpRequest req = HttpRequest.newBuilder(URI.create(endpoint + "/v1/events"))
        .header("Authorization", "Bearer " + key).header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString("{\\"events\\":[" + ev + "]}")).build();
    CLIENT.sendAsync(req, HttpResponse.BodyHandlers.discarding()); // errors ignored: paynp being down never breaks a checkout
  }
}

// In settle(): Paynp.event("status.changed", attempt.id(), "\\"status\\":\\"" + to + "\\"");`
    : `// src/main/kotlin/payments/Paynp.kt: paynp has no Kotlin SDK yet; this sends events to the ingest API directly.
package payments

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.SecureRandom
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.HexFormat

object Paynp {
    private val client = HttpClient.newHttpClient()
    private val random = SecureRandom()

    /** Sends one event in the background. extraJson: more fields, e.g. "\\"status\\":\\"paid\\"". No PAYNP_KEY: no-op. */
    fun event(type: String, attemptId: String, extraJson: String = "") {
        val key = System.getenv("PAYNP_KEY")?.takeIf { it.isNotEmpty() } ?: return
        val id = ByteArray(13).also { random.nextBytes(it) }
        val ts = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()
        val ev = """{"id":"evt_${"$"}{HexFormat.of().formatHex(id)}","type":"${"$"}type","attempt_id":"${"$"}attemptId","gateway":"${g}","ts":"${"$"}ts"""" +
            (if (extraJson.isEmpty()) "" else ",${"$"}extraJson") + "}"
        val endpoint = System.getenv("PAYNP_ENDPOINT") ?: "${DEFAULT_ENDPOINT}"
        val req = HttpRequest.newBuilder(URI.create("${"$"}endpoint/v1/events"))
            .header("Authorization", "Bearer ${"$"}key").header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString("""{"events":[${"$"}ev]}""")).build()
        client.sendAsync(req, HttpResponse.BodyHandlers.discarding()) // errors ignored: paynp being down never breaks a checkout
    }
}

// In settle(): Paynp.event("status.changed", attempt.id, "\\"status\\":\\"${"$"}to\\"")`;

/** The wiring for a stack, ready to print. */
export function snippet(id: StackId, gateway: string): { lang: string; code: string } {
  switch (id) {
    case "nextjs":
      return { lang: "ts", code: nextjs(gateway) };
    case "hono":
      return { lang: "ts", code: hono(gateway) };
    case "express":
    case "fastify":
    case "node":
      return { lang: "ts", code: jsNode(gateway) };
    case "django":
      return { lang: "python", code: python(gateway, "Django") };
    case "fastapi":
      return { lang: "python", code: python(gateway, "FastAPI") };
    case "flask":
      return { lang: "python", code: python(gateway, "Flask") };
    case "python":
      return { lang: "python", code: python(gateway, "Python") };
    case "laravel":
      return { lang: "php", code: laravel(gateway) };
    case "php":
      return { lang: "php", code: php(gateway) };
    case "go":
      return { lang: "go", code: go(gateway) };
    case "spring":
    case "jvm":
      return { lang: "java", code: jvmHeader("java", gateway) };
    case "ktor":
      return { lang: "kotlin", code: jvmHeader("kotlin", gateway) };
    default:
      return {
        lang: "text",
        code: `POST {PAYNP_ENDPOINT or ${DEFAULT_ENDPOINT}}/v1/events
Authorization: Bearer $PAYNP_KEY
{"events":[{"id":"evt_<unique>","type":"status.changed","ts":"<ISO 8601 with ms>","attempt_id":"<attempt>","gateway":"${gateway}","status":"paid"}]}`,
      };
  }
}
