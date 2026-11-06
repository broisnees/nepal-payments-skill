<?php

// Answers every request like Hamro Pay's Envoy front on errors: a chunked 401 whose only chunk is argv[1], then
// the socket closes without the terminating 0-length chunk. Prints the ephemeral port it listens on.
declare(strict_types=1);

$chunk = $argv[1] ?? '';
$srv = stream_socket_server('tcp://127.0.0.1:0', $errno, $err);
if ($srv === false) {
    fwrite(STDERR, "listen failed: {$err}\n");
    exit(1);
}
echo substr((string) strrchr((string) stream_socket_get_name($srv, false), ':'), 1), "\n";
fflush(STDOUT);
while (($conn = @stream_socket_accept($srv, 30)) !== false) {
    $req = '';
    while (!str_contains($req, "\r\n\r\n") && ($part = fread($conn, 65536)) !== false && $part !== '') {
        $req .= $part;
    }
    [$head, $rest] = explode("\r\n\r\n", $req, 2) + ['', ''];
    $need = preg_match('/^content-length:\s*(\d+)/mi', $head, $m) === 1 ? (int) $m[1] : 0;
    while (strlen($rest) < $need && ($part = fread($conn, 65536)) !== false && $part !== '') {
        $rest .= $part;
    }
    fwrite($conn, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nTrailer: Grpc-Status\r\n"
        . "Transfer-Encoding: chunked\r\n\r\n" . dechex(strlen($chunk)) . "\r\n{$chunk}\r\n");
    fclose($conn);
}
