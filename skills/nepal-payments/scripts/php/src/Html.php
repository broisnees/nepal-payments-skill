<?php

declare(strict_types=1);

namespace NepalPayments;

final class Html
{
    private function __construct()
    {
    }

    /** Escape for safe interpolation into HTML attribute values. */
    public static function escape(string $s): string
    {
        return strtr($s, ['&' => '&amp;', '<' => '&lt;', '>' => '&gt;', '"' => '&quot;', "'" => '&#39;']);
    }

    /** Server-rendered auto-submitting form for FormResult results. */
    public static function renderAutoSubmitForm(FormResult $r): string
    {
        $inputs = '';
        foreach ($r->fields as $k => $v) {
            $inputs .= '<input type="hidden" name="' . self::escape((string) $k) . '" value="' . self::escape($v) . '">';
        }
        $enctype = $r->enctype !== null && $r->enctype !== '' ? ' enctype="' . self::escape($r->enctype) . '"' : '';

        return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            . '<title>Redirecting to payment…</title></head><body><form id="f" method="POST" action="' . self::escape($r->action) . '"'
            . $enctype . '>' . $inputs . '<noscript><button type="submit">Continue to payment</button></noscript></form>'
            . '<script>document.getElementById("f").submit()</script></body></html>';
    }
}
