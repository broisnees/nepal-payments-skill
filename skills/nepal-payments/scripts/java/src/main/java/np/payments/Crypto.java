package np.payments;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Enumeration;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** HMAC, SHA-256, RSA-SHA256 and constant-time comparison (JDK only). */
public final class Crypto {

    public enum Hash {
        SHA_256("HmacSHA256"),
        SHA_512("HmacSHA512");

        final String jca;

        Hash(String jca) {
            this.jca = jca;
        }
    }

    private Crypto() {}

    public static byte[] hmac(Hash hash, byte[] key, byte[] message) {
        try {
            Mac mac = Mac.getInstance(hash.jca);
            mac.init(new SecretKeySpec(key, hash.jca));
            return mac.doFinal(message);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(hash.jca + " unavailable", e);
        }
    }

    /** HMAC with a UTF-8 key and message. */
    public static byte[] hmac(Hash hash, String key, String message) {
        return hmac(hash, Codec.utf8(key), Codec.utf8(message));
    }

    public static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public static byte[] sha256(String data) {
        return sha256(Codec.utf8(data));
    }

    /** Constant-time string comparison (avoid leaking signature prefixes via timing). Null never matches. */
    public static boolean safeEqual(String a, String b) {
        if (a == null || b == null) return false;
        return MessageDigest.isEqual(Codec.utf8(a), Codec.utf8(b));
    }

    /**
     * Parses a PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"). Convert a .pfx once with
     * {@code openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem},
     * or skip the conversion and use {@link #privateKeyFromPkcs12}.
     */
    public static PrivateKey privateKeyFromPem(String pkcs8Pem) {
        if (pkcs8Pem.contains("BEGIN RSA PRIVATE KEY")) {
            throw new IllegalArgumentException("PKCS#1 key given; convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem");
        }
        if (pkcs8Pem.contains("BEGIN ENCRYPTED PRIVATE KEY")) {
            throw new IllegalArgumentException("encrypted PKCS#8 key given; decrypt it (openssl pkcs8 -nocrypt) or load the .pfx with privateKeyFromPkcs12");
        }
        String b64 = pkcs8Pem.replaceAll("-----(BEGIN|END) PRIVATE KEY-----", "").replaceAll(Js.WS + "+", "");
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Codec.fromBase64(b64)));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("not a PKCS#8 RSA private key", e);
        }
    }

    /** First private-key entry of a PKCS#12 (.pfx/.p12) file, e.g. the connectIPS CREDITOR.pfx. */
    public static PrivateKey privateKeyFromPkcs12(Path file, char[] password) {
        try (InputStream in = Files.newInputStream(file)) {
            return privateKeyFromPkcs12(in, password, null);
        } catch (IOException e) {
            throw new IllegalArgumentException("cannot read PKCS#12 file " + file + ": " + e.getMessage(), e);
        }
    }

    public static PrivateKey privateKeyFromPkcs12(byte[] pfx, char[] password) {
        return privateKeyFromPkcs12(new ByteArrayInputStream(pfx), password, null);
    }

    /**
     * Private key from a PKCS#12 stream. {@code alias} null = the first entry that holds a private key (certificate-only
     * entries are skipped). Reads both modern (AES) and legacy (RC2/3DES) files without OpenSSL's {@code -legacy}.
     */
    public static PrivateKey privateKeyFromPkcs12(InputStream in, char[] password, String alias) {
        try {
            KeyStore ks = KeyStore.getInstance("PKCS12");
            ks.load(in, password);
            String chosen = alias;
            if (chosen == null) {
                for (Enumeration<String> e = ks.aliases(); e.hasMoreElements(); ) {
                    String a = e.nextElement();
                    if (ks.isKeyEntry(a)) {
                        chosen = a;
                        break;
                    }
                }
            }
            if (chosen == null) throw new IllegalArgumentException("no private key entry in PKCS#12 file");
            Key key = ks.getKey(chosen, password);
            if (!(key instanceof PrivateKey pk)) throw new IllegalArgumentException("PKCS#12 entry \"" + chosen + "\" is not a private key");
            return pk;
        } catch (IOException | GeneralSecurityException e) {
            throw new IllegalArgumentException("cannot load PKCS#12 key: " + e.getMessage(), e);
        }
    }

    /** RSA PKCS#1 v1.5 + SHA-256 signature, base64 output. */
    public static String rsaSha256SignBase64(PrivateKey key, String message) {
        try {
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initSign(key);
            s.update(Codec.utf8(message));
            return Codec.toBase64(s.sign());
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("RSA-SHA256 signing failed: " + e.getMessage(), e);
        }
    }

    /** Same, from a PKCS#8 PEM (parsed on every call; prefer parsing once with {@link #privateKeyFromPem}). */
    public static String rsaSha256SignBase64(String pkcs8Pem, String message) {
        return rsaSha256SignBase64(privateKeyFromPem(pkcs8Pem), message);
    }
}
