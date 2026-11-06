<?php

declare(strict_types=1);

namespace NepalPayments\Http;

/**
 * Default transport (ext-curl). Same behaviour as fetch() in the TS adapters: follows up to 20 redirects
 * (301/302/303 turn POST into GET, 307/308 keep it), HTTP/1.1, transparent gzip/deflate, TLS verification on,
 * total timeout per attempt = request timeout, plus a connect timeout (default 10 s, capped at the total).
 */
final class CurlTransport implements HttpTransport
{
    public function __construct(
        private readonly int $connectTimeoutMs = 10_000,
        private readonly int $maxRedirects = 20,
        private readonly string $userAgent = 'nepal-payments-php/1.0',
        private readonly ?string $caBundle = null,
    ) {
    }

    public function send(HttpRequest $request): HttpResponse
    {
        $lines = [];
        foreach ($request->headers as $name => $value) {
            if (preg_match('/[\r\n\0]/', $name . $value) === 1) {
                throw new TransportException("invalid characters in header {$name}");
            }
            $lines[] = "{$name}: {$value}";
        }
        $lines[] = 'Expect:'; // no "100-continue" round trip for larger bodies

        $ch = curl_init();
        if ($ch === false) {
            throw new TransportException('curl_init failed');
        }
        $web = CURLPROTO_HTTP | CURLPROTO_HTTPS;
        $body = '';
        $opts = [
            CURLOPT_URL => $request->url,
            // Collect the body ourselves so the bytes survive a transfer that fails after they arrived.
            CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$body): int {
                $body .= $chunk;
                return strlen($chunk);
            },
            CURLOPT_HEADER => false,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_FOLLOWLOCATION => $this->maxRedirects > 0,
            CURLOPT_MAXREDIRS => $this->maxRedirects,
            CURLOPT_PROTOCOLS => $web,
            CURLOPT_REDIR_PROTOCOLS => $web,
            CURLOPT_CONNECTTIMEOUT_MS => max(1, min($this->connectTimeoutMs, $request->timeoutMs)),
            CURLOPT_TIMEOUT_MS => max(1, $request->timeoutMs),
            CURLOPT_NOSIGNAL => true,
            CURLOPT_ENCODING => '',
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT => $this->userAgent,
        ];
        if ($this->caBundle !== null) {
            $opts[CURLOPT_CAINFO] = $this->caBundle;
        }
        if ($request->method === 'POST') {
            $opts[CURLOPT_POST] = true; // not CUSTOMREQUEST: that would keep POST across 301/302/303
            $opts[CURLOPT_POSTFIELDS] = $request->body ?? '';
        } else {
            $opts[CURLOPT_HTTPGET] = true;
        }
        if (!curl_setopt_array($ch, $opts)) {
            throw new TransportException('curl_setopt_array failed: ' . curl_error($ch));
        }

        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        // Hamro Pay (grpc-gateway behind Envoy) aborts the stream after its error answers (curl errno 18). Keep a
        // body cut off mid-stream only when what arrived is complete JSON.
        if ($ok !== true && !($status > 0 && $body !== '' && self::isJson($body))) {
            throw new TransportException(sprintf('curl error %d: %s', curl_errno($ch), curl_error($ch)));
        }

        return new HttpResponse($status, $body);
    }

    private static function isJson(string $s): bool
    {
        json_decode($s);
        return json_last_error() === JSON_ERROR_NONE;
    }
}
