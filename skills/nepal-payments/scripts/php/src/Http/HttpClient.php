<?php

declare(strict_types=1);

namespace NepalPayments\Http;

use NepalPayments\Internal\Json;
use NepalPayments\PaymentException;
use NepalPayments\ProviderId;

/**
 * Port of the TS `http()` helper: JSON bodies, default Accept/Content-Type, timeouts, and retries
 * (extra attempts on network error / 5xx / 429, backoff 300 ms * 2^n). Retries are only requested by callers
 * for idempotent reads (status checks).
 */
final class HttpClient
{
    /** @var \Closure(int): void */
    private \Closure $sleep;

    /** @param (\Closure(int): void)|null $sleepMs Override the backoff sleep (tests). */
    public function __construct(
        private readonly HttpTransport $transport = new CurlTransport(),
        ?\Closure $sleepMs = null,
    ) {
        $this->sleep = $sleepMs ?? static function (int $ms): void {
            usleep($ms * 1000);
        };
    }

    public function transport(): HttpTransport
    {
        return $this->transport;
    }

    /**
     * @param 'GET'|'POST' $method
     * @param array<string, string> $headers
     * @param mixed $body Arrays/objects are JSON-encoded (an empty array becomes "{}"); strings are sent as-is.
     *
     * @throws PaymentException network_error when the last attempt failed at the network level
     */
    public function request(
        ProviderId $provider,
        string $url,
        string $method = 'GET',
        array $headers = [],
        mixed $body = null,
        int $timeoutMs = 15_000,
        int $retries = 0,
    ): HttpResult {
        $payload = match (true) {
            $body === null => null,
            is_string($body) => $body,
            $body === [] => '{}',
            default => Json::encode($body),
        };
        $final = array_merge(['Accept' => 'application/json'], $headers);
        if ($payload !== null) {
            $hasType = false;
            foreach ($final as $name => $_) {
                if (strtolower((string) $name) === 'content-type') {
                    $hasType = true;
                }
            }
            if (!$hasType) {
                $final['Content-Type'] = 'application/json';
            }
        }

        $lastErr = null;
        for ($attempt = 0; $attempt <= $retries; $attempt++) {
            if ($attempt > 0) {
                ($this->sleep)(300 * 2 ** ($attempt - 1));
            }
            try {
                $res = $this->transport->send(new HttpRequest($method, $url, $final, $payload, $timeoutMs));
            } catch (\Exception $e) {
                $lastErr = $e;
                if ($attempt >= $retries) {
                    break;
                }
                continue;
            }
            $text = str_starts_with($res->body, "\xEF\xBB\xBF") ? substr($res->body, 3) : $res->body;
            if (($res->status >= 500 || $res->status === 429) && $attempt < $retries) {
                $lastErr = new PaymentException("HTTP {$res->status}", $provider, 'upstream_error', $res->status, $text);
                continue;
            }
            $data = null;
            if ($text !== '') {
                try {
                    $data = Json::decode($text);
                } catch (\JsonException) {
                    $data = $text; // non-JSON body: keep text
                }
            }

            return new HttpResult($res->status, $data, $text);
        }

        $host = (string) parse_url($url, PHP_URL_HOST);
        $port = parse_url($url, PHP_URL_PORT);
        if (is_int($port)) {
            $host .= ":{$port}";
        }

        throw new PaymentException(
            "request to {$host} failed: " . ($lastErr instanceof \Throwable ? $lastErr->getMessage() : 'unknown error'),
            $provider,
            'network_error',
            null,
            $lastErr,
            $lastErr instanceof \Throwable ? $lastErr : null,
        );
    }
}
