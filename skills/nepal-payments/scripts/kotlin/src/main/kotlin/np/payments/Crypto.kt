/*
 * Encoding + crypto on the JDK (javax.crypto / java.security). No third-party providers.
 */
package np.payments

import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

enum class HmacAlgorithm(internal val jca: String) {
    SHA_256("HmacSHA256"),
    SHA_512("HmacSHA512"),
}

fun toBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

/** Tolerates the url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers. */
fun fromBase64(b64: String): ByteArray {
    // Spaces back to '+' BEFORE trimming, or a leading/trailing '+' is lost.
    val s = StringBuilder(
        b64.replace(' ', '+').trim().replace('-', '+').replace('_', '/')
            .filterNot { it == '\t' || it == '\n' || it == '\u000C' || it == '\r' },
    )
    while (s.length % 4 != 0) s.append('=')
    return Base64.getDecoder().decode(s.toString())
}

/** base64 -> UTF-8 -> JSON (Map/List/String/BigDecimal/Boolean/null). */
fun base64Json(b64: String): Any? = Json.parse(decodeUtf8(fromBase64(b64)))

fun toHex(bytes: ByteArray): String {
    val hex = "0123456789abcdef"
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
        val v = bytes[i].toInt() and 0xff
        out[i * 2] = hex[v ushr 4]
        out[i * 2 + 1] = hex[v and 0x0f]
    }
    return String(out)
}

fun hmac(algorithm: HmacAlgorithm, key: ByteArray, message: ByteArray): ByteArray {
    val mac = Mac.getInstance(algorithm.jca)
    mac.init(SecretKeySpec(key, algorithm.jca))
    return mac.doFinal(message)
}

/** Key and message are UTF-8 encoded. */
fun hmac(algorithm: HmacAlgorithm, key: String, message: String): ByteArray =
    hmac(algorithm, key.toByteArray(Charsets.UTF_8), message.toByteArray(Charsets.UTF_8))

fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

fun sha256(data: String): ByteArray = sha256(data.toByteArray(Charsets.UTF_8))

/** Constant-time comparison of the UTF-8 bytes (avoids leaking signature prefixes via timing). */
fun safeEqual(a: String, b: String): Boolean =
    MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

/** RSA PKCS#1 v1.5 + SHA-256 signature over the UTF-8 message, base64 output. */
fun rsaSha256SignBase64(privateKey: PrivateKey, message: String): String {
    val signer = Signature.getInstance("SHA256withRSA")
    signer.initSign(privateKey)
    signer.update(message.toByteArray(Charsets.UTF_8))
    return toBase64(signer.sign())
}

/** Same, with a PKCS#8 PEM key (see [loadPkcs8PrivateKey]). */
fun rsaSha256SignBase64(pkcs8Pem: String, message: String): String =
    rsaSha256SignBase64(loadPkcs8PrivateKey(pkcs8Pem), message)

/**
 * Parse a PKCS#8 PEM RSA key ("-----BEGIN PRIVATE KEY-----"). Convert a .pfx once with:
 *   openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
 * (add -legacy on OpenSSL 3+ if the .pfx uses RC2/3DES), or load the .pfx directly with [loadPfxPrivateKey].
 */
fun loadPkcs8PrivateKey(pkcs8Pem: String): PrivateKey {
    if (pkcs8Pem.contains("BEGIN RSA PRIVATE KEY")) {
        throw IllegalArgumentException(
            "PKCS#1 key given; convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem",
        )
    }
    val body = pkcs8Pem.replace(Regex("-----(BEGIN|END) PRIVATE KEY-----"), "").replace(Regex("\\s+"), "")
    return KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(fromBase64(body)))
}

/**
 * Load the private key from a PKCS#12 keystore (e.g. the connectIPS CREDITOR.pfx) with the JDK's KeyStore.
 * [alias] defaults to the first key entry. The JDK reads legacy RC2/3DES .pfx files without extra flags.
 */
fun loadPfxPrivateKey(pfx: ByteArray, password: CharArray, alias: String? = null): PrivateKey {
    val store = KeyStore.getInstance("PKCS12")
    ByteArrayInputStream(pfx).use { store.load(it, password) }
    val name = alias ?: store.aliases().toList().firstOrNull { store.isKeyEntry(it) }
        ?: throw IllegalArgumentException("no private key entry in the .pfx")
    return store.getKey(name, password) as? PrivateKey
        ?: throw IllegalArgumentException("alias \"$name\" in the .pfx is not a private key")
}

/** Basic auth header value. Credentials are UTF-8 encoded (RFC 7617). */
fun basicAuth(user: String, pass: String): String = "Basic " + toBase64("$user:$pass".toByteArray(Charsets.UTF_8))

/** UTF-8 decode that drops a leading BOM, like WHATWG TextDecoder / fetch's res.text(). */
internal fun decodeUtf8(bytes: ByteArray): String {
    val s = String(bytes, Charsets.UTF_8)
    return if (s.startsWith('﻿')) s.substring(1) else s
}
