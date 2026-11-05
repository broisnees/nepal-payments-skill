package np.payments;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.StringJoiner;

/** Encoding helpers: UTF-8, base64, hex, Basic auth, form encoding. */
public final class Codec {
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Codec() {}

    public static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** UTF-8 decode with replacement characters; a leading BOM is dropped (like TextDecoder / fetch). */
    static String decodeUtf8(byte[] bytes) {
        String s = new String(bytes, StandardCharsets.UTF_8);
        return s.startsWith("﻿") ? s.substring(1) : s;
    }

    /** Standard base64 with padding. */
    public static String toBase64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    /**
     * Lenient base64: tolerates the url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers.
     * Spaces go back to '+' BEFORE trimming, or a leading/trailing '+' is lost.
     *
     * @throws IllegalArgumentException on invalid input
     */
    public static byte[] fromBase64(String b64) {
        StringBuilder s = new StringBuilder(Js.trim(b64.replace(' ', '+')).replace('-', '+').replace('_', '/'));
        while (s.length() % 4 != 0) s.append('=');
        return forgivingBase64Decode(s);
    }

    /** JSON.parse(UTF-8 decode(fromBase64(b64))). */
    public static Object base64Json(String b64) {
        return Json.parse(decodeUtf8(fromBase64(b64)));
    }

    /** Lowercase hex. */
    public static String toHex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = HEX[(bytes[i] >> 4) & 0xF];
            out[i * 2 + 1] = HEX[bytes[i] & 0xF];
        }
        return new String(out);
    }

    /**
     * Basic auth header value. Like the TS port (btoa), user:pass is encoded as Latin-1; characters above U+00FF are
     * rejected.
     */
    public static String basicAuth(String user, String pass) {
        String s = user + ":" + pass;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) > 0xFF) throw new IllegalArgumentException("basic auth credentials must be Latin-1");
        }
        return "Basic " + toBase64(s.getBytes(StandardCharsets.ISO_8859_1));
    }

    /** application/x-www-form-urlencoded, like URLSearchParams.toString(). */
    public static String formEncode(Map<String, String> params) {
        StringJoiner j = new StringJoiner("&");
        params.forEach((k, v) -> j.add(URLEncoder.encode(k, StandardCharsets.UTF_8) + "=" + URLEncoder.encode(v, StandardCharsets.UTF_8)));
        return j.toString();
    }

    /** WHATWG forgiving-base64 decode (what atob() does). */
    private static byte[] forgivingBase64Decode(CharSequence input) {
        StringBuilder d = new StringBuilder(input.length());
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (c != '\t' && c != '\n' && c != '\f' && c != '\r' && c != ' ') d.append(c);
        }
        if (d.length() % 4 == 0) {
            if (d.length() >= 2 && d.charAt(d.length() - 1) == '=' && d.charAt(d.length() - 2) == '=') d.setLength(d.length() - 2);
            else if (d.length() >= 1 && d.charAt(d.length() - 1) == '=') d.setLength(d.length() - 1);
        }
        if (d.length() % 4 == 1) throw new IllegalArgumentException("invalid base64");
        byte[] out = new byte[d.length() * 3 / 4];
        int n = 0;
        int buffer = 0;
        int bits = 0;
        for (int i = 0; i < d.length(); i++) {
            int v = value(d.charAt(i));
            if (v < 0) throw new IllegalArgumentException("invalid base64");
            buffer = (buffer << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[n++] = (byte) (buffer >> bits);
                buffer &= (1 << bits) - 1;
            }
        }
        return n == out.length ? out : java.util.Arrays.copyOf(out, n);
    }

    private static int value(char c) {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    }
}
