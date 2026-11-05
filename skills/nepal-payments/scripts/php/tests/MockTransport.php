<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Http\HttpClient;
use NepalPayments\Http\HttpRequest;
use NepalPayments\Http\HttpResponse;
use NepalPayments\Http\HttpTransport;
use NepalPayments\Internal\Json;

/** Port of the TS fetch mock: records calls; handler returns ['status' => ?int, 'body' => mixed]. */
final class MockTransport implements HttpTransport
{
    /** @var list<HttpRequest> */
    public array $calls = [];

    /** @param \Closure(HttpRequest): array{status?: int, body: mixed} $handler */
    public function __construct(private \Closure $handler)
    {
    }

    /** @param \Closure(HttpRequest): array{status?: int, body: mixed} $handler */
    public static function client(\Closure $handler, ?self &$mock = null): HttpClient
    {
        $mock = new self($handler);

        return new HttpClient($mock, static function (int $ms): void {
        });
    }

    public function send(HttpRequest $request): HttpResponse
    {
        $this->calls[] = $request;
        $r = ($this->handler)($request);
        $body = $r['body'];

        return new HttpResponse($r['status'] ?? 200, is_string($body) ? $body : Json::encode($body));
    }

    public function header(int $i, string $name): ?string
    {
        return $this->calls[$i]->headers[$name] ?? null;
    }

    /** @return array<string, mixed> */
    public function jsonBody(int $i): array
    {
        $d = json_decode((string) $this->calls[$i]->body, true, 512, JSON_THROW_ON_ERROR);
        \assert(is_array($d));

        return $d;
    }
}
