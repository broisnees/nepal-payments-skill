// Shared app code for PHP (Laravel and plain PHP): payment types with settle(), the demo store,
// the reconcile job and the routes. Gateway modules live next to this folder.
// Routes take the gateway descriptor g and work for every gateway.

export interface Block {
  file: string;
  lang: string;
  code: string;
}

export interface GatewayRef {
  id: string;
  name: string;
  ts: string;
  py: string;
  php: string;
  go: string;
  java: string;
  kotlin: string;
}

export type Framework = "laravel" | "php";

export const types: Block[] = [
  {
    file: "Payments.php",
    lang: "php",
    code: `<?php

declare(strict_types=1);

namespace App\\Payments;

// Every payments type in one file, so plain PHP can require it once.
// Laravel requires it from AppServiceProvider. Split it into one class per file
// if you prefer PSR-4 autoloading (settle() and autoPostForm() stay together).

interface Gateway
{
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start;

    // $params: the callback's query and body params merged, or [] from the reconcile job.
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome;
}

final class Start
{
    private function __construct(
        public readonly string $type, // "redirect" or "form"
        public readonly ?string $url = null,
        public readonly ?string $action = null,
        public readonly array $fields = [],
        public readonly ?string $providerRef = null, // id the gateway hands back, if any
        public readonly ?string $enctype = null, // null = urlencoded; NPS needs 'multipart/form-data'
    ) {
    }

    public static function redirect(string $url, ?string $ref = null): self
    {
        return new self('redirect', url: $url, providerRef: $ref);
    }

    public static function form(string $action, array $fields, ?string $ref = null, ?string $enctype = null): self
    {
        return new self('form', action: $action, fields: $fields, providerRef: $ref, enctype: $enctype);
    }
}

final class Outcome
{
    public function __construct(
        public readonly string $status, // paid | pending | failed | canceled | refunded | not_found
        public readonly ?string $providerRef = null,
    ) {
    }
}

// Bad signature, amount mismatch, provider said no.
final class PaymentError extends \\RuntimeException
{
}

// Attempt states that can still change.
const OPEN = ['initiated', 'pending'];

// Apply a gateway answer to an attempt. Safe to call any number of times:
// transition() only succeeds once, so fulfil() runs once per order.
function settle(Store $store, array $attempt, Outcome $outcome): void
{
    if (in_array($outcome->status, ['paid', 'failed', 'canceled'], true)) {
        if ($store->transition($attempt['id'], OPEN, $outcome->status) && $outcome->status === 'paid') {
            // Keep the gateway's transaction id (refunds, support). A ref saved at start
            // (Khalti pidx, IME TokenId, NPS ProcessId) stays: confirm looks the payment up with it.
            if ($outcome->providerRef !== null && $outcome->providerRef !== '' && $attempt['providerRef'] === null) {
                $store->setProviderRef($attempt['id'], $outcome->providerRef);
            }
            $store->fulfil($attempt['orderId']);
        }
    } elseif ($outcome->status === 'pending') {
        $store->transition($attempt['id'], ['initiated'], 'pending');
    }
    // not_found: leave it, the reconcile job expires it after an hour.
}

// HTML page that auto-posts a form to the gateway.
function autoPostForm(Start $start): string
{
    $e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
    $inputs = '';
    foreach ($start->fields as $name => $value) {
        $inputs .= '<input type="hidden" name="' . $e((string) $name) . '" value="' . $e((string) $value) . '">';
    }
    $enctype = $start->enctype !== null ? ' enctype="' . $e($start->enctype) . '"' : '';
    return '<form id="pay" method="post" action="' . $e($start->action) . '"' . $enctype . '>' . $inputs
        . '<noscript><button>Continue to payment</button></noscript></form>'
        . '<script>document.getElementById("pay").submit()</script>';
}
`,
  },
];

export const store: Block[] = [
  {
    file: "Store.php",
    lang: "php",
    code: `<?php

declare(strict_types=1);

namespace App\\Payments;

// Demo store: swap for your database (table in the article).
// PHP forgets everything between requests, so this keeps orders and attempts
// in a JSON file and takes an exclusive file lock around every read and write.
final class Store
{
    public function __construct(private string $path)
    {
    }

    public function getOrder(string $id): ?array
    {
        return $this->locked(fn (array &$db) => $db['orders'][$id] ?? null);
    }

    public function createAttempt(string $orderId, int $amountPaisa): array
    {
        $attempt = [
            'id' => bin2hex(random_bytes(10)), // 20 lowercase hex chars
            'orderId' => $orderId,
            'amountPaisa' => $amountPaisa,
            'status' => 'initiated',
            'providerRef' => null,
            'createdAt' => time(),
        ];
        $this->locked(function (array &$db) use ($attempt) {
            $db['attempts'][$attempt['id']] = $attempt;
        });
        return $attempt;
    }

    public function getAttempt(string $id): ?array
    {
        return $this->locked(fn (array &$db) => $db['attempts'][$id] ?? null);
    }

    public function latestAttempt(string $orderId): ?array
    {
        return $this->locked(function (array &$db) use ($orderId) {
            $mine = array_filter($db['attempts'], fn ($a) => $a['orderId'] === $orderId);
            return $mine ? end($mine) : null;
        });
    }

    public function setProviderRef(string $id, string $ref): void
    {
        $this->locked(function (array &$db) use ($id, $ref) {
            $db['attempts'][$id]['providerRef'] = $ref;
        });
    }

    // Compare-and-set: move to $to only if the status is one of $from.
    // In SQL: UPDATE payment_attempts SET status = ? WHERE id = ? AND status IN (...)
    public function transition(string $id, array $from, string $to): bool
    {
        return $this->locked(function (array &$db) use ($id, $from, $to) {
            if (!in_array($db['attempts'][$id]['status'] ?? null, $from, true)) {
                return false;
            }
            $db['attempts'][$id]['status'] = $to;
            return true;
        });
    }

    public function openAttempts(int $olderThanSeconds): array
    {
        return $this->locked(fn (array &$db) => array_values(array_filter(
            $db['attempts'],
            fn ($a) => in_array($a['status'], OPEN, true) && $a['createdAt'] <= time() - $olderThanSeconds,
        )));
    }

    public function fulfil(string $orderId): void
    {
        error_log("order $orderId paid, fulfil it here");
    }

    // Run $fn with the whole data set under an exclusive lock, save it if $fn changed it.
    private function locked(callable $fn): mixed
    {
        $fh = fopen($this->path, 'c+') ?: throw new \\RuntimeException("cannot open {$this->path}");
        flock($fh, LOCK_EX);
        try {
            $raw = stream_get_contents($fh);
            $db = $raw ? json_decode($raw, true, flags: JSON_THROW_ON_ERROR)
                : ['orders' => ['demo' => ['id' => 'demo', 'amountPaisa' => 10000]], 'attempts' => []];
            $before = $db;
            $result = $fn($db);
            if (!$raw || $db !== $before) {
                ftruncate($fh, 0);
                rewind($fh);
                fwrite($fh, json_encode($db, JSON_PRETTY_PRINT));
                fflush($fh);
            }
            return $result;
        } finally {
            flock($fh, LOCK_UN);
            fclose($fh);
        }
    }
}
`,
  },
];

export const reconcile: Block[] = [
  {
    file: "Reconcile.php",
    lang: "php",
    code: `<?php

declare(strict_types=1);

namespace App\\Payments;

// Settle attempts whose buyer never came back. Run it every minute.
final class Reconcile
{
    public static function run(Store $store, Gateway $gateway): void
    {
        $open = $store->openAttempts(120); // older than 2 minutes
        foreach ($open as $attempt) {
            if ($attempt['createdAt'] < time() - 3 * 86400) {
                // Still open after 3 days: asking again rarely helps, so a person checks it
                // (gateway dashboard, bank statement) and closes it by hand.
                error_log("attempt {$attempt['id']} still {$attempt['status']} after 3 days, needs manual review");
                continue;
            }
            try {
                // Empty params: the gateway module asks the status API.
                $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], []);
                settle($store, $attempt, $outcome);
                if ($outcome->status === 'not_found' && $attempt['createdAt'] < time() - 3600) {
                    $store->transition($attempt['id'], OPEN, 'expired');
                }
            } catch (\\Throwable $e) {
                // One bad attempt must not stop the rest.
                error_log("reconcile {$attempt['id']}: {$e->getMessage()}");
            }
        }
        error_log('reconcile: checked ' . count($open) . ' open attempts');
    }
}
`,
  },
  {
    file: "routes/console.php",
    lang: "php",
    code: `<?php

// Laravel only. Plain PHP: cron runs \`php index.php reconcile\` instead.

use App\\Payments\\Gateway;
use App\\Payments\\Reconcile;
use App\\Payments\\Store;
use Illuminate\\Support\\Facades\\Artisan;
use Illuminate\\Support\\Facades\\Schedule;

Artisan::command('payments:reconcile', function (Store $store, Gateway $gateway) {
    Reconcile::run($store, $gateway);
})->purpose('Settle payment attempts the buyer never came back from');

// Runs every minute under \`php artisan schedule:work\`, or cron: * * * * * php artisan schedule:run
Schedule::command('payments:reconcile')->everyMinute();
`,
  },
];

export function routes(g: GatewayRef): Record<Framework, Block[]> {
  return {
    laravel: [
      {
        file: "routes/web.php",
        lang: "php",
        code: `<?php

use App\\Payments\\Gateway;
use App\\Payments\\PaymentError;
use App\\Payments\\Store;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Log;
use Illuminate\\Support\\Facades\\Route;

use function App\\Payments\\autoPostForm;
use function App\\Payments\\settle;

Route::get('/', fn () => '<h1>Order demo, Rs 100</h1>'
    . '<form method="post" action="/pay/demo">' . csrf_field() . '<button>Pay with ${g.name}</button></form>');

Route::post('/pay/{orderId}', function (string $orderId, Store $store, Gateway $gateway) {
    $order = $store->getOrder($orderId) ?? abort(404);
    $attempt = $store->createAttempt($orderId, $order['amountPaisa']);

    // Path segment, never a query string: some gateways append their own query parameters to this URL.
    $returnUrl = rtrim(env('BASE_URL', 'http://localhost:8000'), '/') . '/pay/return/' . $attempt['id'];
    $start = $gateway->startPayment($attempt['id'], $attempt['amountPaisa'], $returnUrl, "Order $orderId");
    if ($start->providerRef !== null) {
        $store->setProviderRef($attempt['id'], $start->providerRef);
    }

    return $start->type === 'redirect' ? redirect()->away($start->url, 303) : response(autoPostForm($start));
});

// GET and POST: most gateways redirect back, CyberSource and IME Pay POST a form.
// CSRF is switched off for this path in bootstrap/app.php.
Route::match(['get', 'post'], '/pay/return/{attemptId}', function (Request $request, string $attemptId, Store $store, Gateway $gateway) {
    $attempt = $store->getAttempt($attemptId) ?? abort(404);
    $params = array_merge($request->query(), $request->post());

    try {
        // Stored amount and providerRef, never values from the callback.
        $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], $params);
    } catch (PaymentError $e) {
        Log::warning("attempt $attemptId: {$e->getMessage()}");
        return response('Payment could not be verified', 400);
    } catch (Throwable $e) {
        report($e); // network or provider outage: the reconcile job retries later
        return response('Payment provider unavailable, try again shortly', 502);
    }

    settle($store, $attempt, $outcome);
    return redirect('/orders/' . $attempt['orderId'], 303);
});

Route::get('/orders/{orderId}', function (string $orderId, Store $store) {
    $attempt = $store->latestAttempt($orderId);
    return response("Order $orderId: " . ($attempt['status'] ?? 'no payment yet'))->header('Content-Type', 'text/plain');
});
`,
      },
      {
        file: "bootstrap/app.php",
        lang: "php",
        code: `<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Exceptions;
use Illuminate\\Foundation\\Configuration\\Middleware;
use Illuminate\\Http\\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // The gateway posts back without a Laravel CSRF token. Exempt this path only.
        $middleware->validateCsrfTokens(except: ['pay/return/*']);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
`,
      },
      {
        file: "app/Providers/AppServiceProvider.php",
        lang: "php",
        code: `<?php

namespace App\\Providers;

use App\\Payments\\${g.php};
use App\\Payments\\Gateway;
use App\\Payments\\Store;
use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Payments.php holds several classes and functions, so PSR-4 cannot find them.
        require_once app_path('Payments/Payments.php');

        // Routes and the reconcile command ask for Gateway and Store and get these.
        $this->app->singleton(Gateway::class, fn () => ${g.php}::fromEnv());
        $this->app->singleton(Store::class, fn () => new Store(storage_path('app/payments.json')));
    }

    public function boot(): void
    {
    }
}
`,
      },
    ],
    php: [
      {
        file: "index.php",
        lang: "php",
        code: `<?php

declare(strict_types=1);

// Front controller for the built-in server: php -S localhost:8000 index.php

require __DIR__ . '/Payments.php';
require __DIR__ . '/Store.php';
require __DIR__ . '/Reconcile.php';
require __DIR__ . '/${g.php}.php';

use App\\Payments\\${g.php};
use App\\Payments\\PaymentError;
use App\\Payments\\Reconcile;
use App\\Payments\\Store;

use function App\\Payments\\autoPostForm;
use function App\\Payments\\settle;

// Keep the data file out of any public web root in production.
$store = new Store(__DIR__ . '/payments.json');
$gateway = ${g.php}::fromEnv();
$baseUrl = rtrim(getenv('BASE_URL') ?: 'http://localhost:8000', '/');

// Cron, every minute: php index.php reconcile
if (PHP_SAPI === 'cli') {
    Reconcile::run($store, $gateway);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

function respond(int $code, string $body, string $type = 'text/html'): never
{
    http_response_code($code);
    header("Content-Type: $type; charset=utf-8");
    echo $body;
    exit;
}

function seeOther(string $url): never
{
    header("Location: $url", true, 303);
    exit;
}

if ($method === 'GET' && $path === '/') {
    respond(200, '<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>');
}

if ($method === 'POST' && preg_match('#^/pay/([\\w-]+)$#', $path, $m)) {
    $order = $store->getOrder($m[1]) ?? respond(404, 'Order not found', 'text/plain');
    $attempt = $store->createAttempt($order['id'], $order['amountPaisa']);

    // Path segment, never a query string: some gateways append their own query parameters to this URL.
    $returnUrl = "$baseUrl/pay/return/{$attempt['id']}";
    $start = $gateway->startPayment($attempt['id'], $attempt['amountPaisa'], $returnUrl, "Order {$order['id']}");
    if ($start->providerRef !== null) {
        $store->setProviderRef($attempt['id'], $start->providerRef);
    }
    $start->type === 'redirect' ? seeOther($start->url) : respond(200, autoPostForm($start));
}

// GET and POST: most gateways redirect back, CyberSource and IME Pay POST a form.
if (preg_match('#^/pay/return/([a-f0-9]+)$#', $path, $m)) {
    $attempt = $store->getAttempt($m[1]) ?? respond(404, 'Attempt not found', 'text/plain');
    $params = array_merge($_GET, $_POST);

    try {
        // Stored amount and providerRef, never values from the callback.
        $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], $params);
    } catch (PaymentError $e) {
        error_log("attempt {$attempt['id']}: {$e->getMessage()}");
        respond(400, 'Payment could not be verified', 'text/plain');
    } catch (Throwable $e) {
        error_log("attempt {$attempt['id']}: $e"); // the reconcile job retries later
        respond(502, 'Payment provider unavailable, try again shortly', 'text/plain');
    }

    settle($store, $attempt, $outcome);
    seeOther("/orders/{$attempt['orderId']}");
}

if ($method === 'GET' && preg_match('#^/orders/([\\w-]+)$#', $path, $m)) {
    $attempt = $store->latestAttempt($m[1]);
    respond(200, "Order $m[1]: " . ($attempt['status'] ?? 'no payment yet'), 'text/plain');
}

respond(404, 'Not found', 'text/plain');
`,
      },
    ],
  };
}

export const setup: Record<Framework, Block> = {
  laravel:
  {
    file: "Terminal",
    lang: "bash",
    code: `# New Laravel app. PHP 8.4+ with ext-curl and ext-openssl: the lock file
# composer create-project writes needs PHP 8.4.1 or newer.
composer create-project laravel/laravel shop
cd shop
mkdir -p app/Payments
# Payments.php, Store.php, Reconcile.php and the gateway class go in app/Payments

# Config: BASE_URL and the gateway's variables go in .env. \`php artisan serve\`
# does not pass shell environment variables through to the app, so export won't work.
echo 'BASE_URL=http://localhost:8000' >> .env

php artisan serve            # http://localhost:8000
php artisan schedule:work    # second terminal: runs the reconcile job every minute
`,
  },
  php:
  {
    file: "Terminal",
    lang: "bash",
    code: `# Plain PHP 8.2+ with ext-curl and ext-openssl, no Composer.
# Payments.php, Store.php, Reconcile.php, the gateway class and index.php side by side:
mkdir shop && cd shop

export BASE_URL=http://localhost:8000
# export the gateway variables too

php -S localhost:8000 index.php   # http://localhost:8000

# Reconcile job, every minute from cron (with the same variables set):
# * * * * * cd /path/to/shop && php index.php reconcile
`,
  },
};
