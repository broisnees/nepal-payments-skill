<?php

declare(strict_types=1);

namespace NepalPayments\Http;

/**
 * Sends ONE HTTP request. Retries, JSON handling and error mapping live in {@see HttpClient}, so every transport
 * gets the same semantics as the TypeScript `http()` helper.
 *
 * Contract: return the response for ANY HTTP status (4xx/5xx included); throw {@see TransportException} (or any
 * other \Exception) only for network failures and timeouts. Honour `$request->timeoutMs` as a total timeout.
 * Follow redirects like fetch() does (301/302/303 -> GET, 307/308 keep method + body).
 *
 * Laravel (Http facade) example:
 *
 *     use Illuminate\Http\Client\ConnectionException;
 *     use Illuminate\Support\Facades\Http;
 *
 *     final class LaravelTransport implements HttpTransport
 *     {
 *         public function send(HttpRequest $r): HttpResponse
 *         {
 *             $req = Http::withHeaders($r->headers)->timeout(max(1, (int) ceil($r->timeoutMs / 1000)));
 *             if ($r->body !== null) {
 *                 $req = $req->withBody($r->body, $r->headers['Content-Type'] ?? 'application/json');
 *             }
 *             try {
 *                 $res = $req->send($r->method, $r->url);
 *             } catch (ConnectionException $e) {
 *                 throw new TransportException($e->getMessage(), 0, $e);
 *             }
 *             return new HttpResponse($res->status(), $res->body());
 *         }
 *     }
 *
 *     $payments = Payments::create(Payments::configFromEnv(), new LaravelTransport());
 *
 * Guzzle example: `$res = $guzzle->request($r->method, $r->url, ['headers' => $r->headers, 'body' => $r->body,
 * 'timeout' => $r->timeoutMs / 1000, 'http_errors' => false]); return new HttpResponse($res->getStatusCode(),
 * (string) $res->getBody());` and map `GuzzleHttp\Exception\TransferException` to TransportException.
 */
interface HttpTransport
{
    /** @throws TransportException */
    public function send(HttpRequest $request): HttpResponse;
}
