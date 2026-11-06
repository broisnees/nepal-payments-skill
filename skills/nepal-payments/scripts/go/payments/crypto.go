package payments

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// ToBase64 encodes bytes as standard base64 with padding.
func ToBase64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// FromBase64 decodes base64 leniently: url-safe alphabet, missing padding, and '+' turned into ' '
// by query parsers are all tolerated. Spaces become '+' BEFORE trimming, or a leading/trailing '+'
// would be lost.
func FromBase64(b64 string) ([]byte, error) {
	s := strings.ReplaceAll(b64, " ", "+")
	s = jsTrim(s)
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	for len(s)%4 != 0 {
		s += "="
	}
	return atob(s)
}

// atob implements the WHATWG forgiving-base64 decode used by JavaScript's atob.
func atob(s string) ([]byte, error) {
	s = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\f' || r == '\r' || r == ' ' {
			return -1
		}
		return r
	}, s)
	if len(s)%4 == 0 {
		if strings.HasSuffix(s, "==") {
			s = s[:len(s)-2]
		} else if strings.HasSuffix(s, "=") {
			s = s[:len(s)-1]
		}
	}
	if len(s)%4 == 1 {
		return nil, errors.New("invalid base64: bad length")
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !(isAlnum(c) || c == '+' || c == '/') {
			return nil, errors.New("invalid base64: illegal character")
		}
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// ToHex encodes bytes as lowercase hex.
func ToHex(b []byte) string { return hex.EncodeToString(b) }

// HMACSHA256 returns HMAC-SHA256(key, message).
func HMACSHA256(key, message []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(message)
	return m.Sum(nil)
}

// HMACSHA512 returns HMAC-SHA512(key, message).
func HMACSHA512(key, message []byte) []byte {
	m := hmac.New(sha512.New, key)
	m.Write(message)
	return m.Sum(nil)
}

// SHA256 returns the SHA-256 digest of data.
func SHA256(data []byte) []byte {
	h := sha256.Sum256(data)
	return h[:]
}

// SafeEqual compares two strings in constant time (for equal lengths).
func SafeEqual(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

// BasicAuth returns an HTTP Basic Authorization header value.
func BasicAuth(user, pass string) string {
	return "Basic " + ToBase64([]byte(user+":"+pass))
}

// ParseRSAPrivateKeyPEM parses an unencrypted RSA private key in PKCS#8 ("BEGIN PRIVATE KEY") or
// PKCS#1 ("BEGIN RSA PRIVATE KEY") PEM. A bare base64 DER body (no PEM headers) is also accepted,
// and other PEM blocks (certificates) in the same text are skipped.
//
// The standard library cannot read .pfx/.p12 files. Convert the connectIPS CREDITOR.pfx once with:
//
//	openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
//
// (add -legacy to the pkcs12 command on OpenSSL 3+ if the .pfx uses RC2/3DES).
func ParseRSAPrivateKeyPEM(pemText string) (*rsa.PrivateKey, error) {
	rest := []byte(pemText)
	sawBlock := false
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		sawBlock = true
		switch block.Type {
		case "PRIVATE KEY":
			return parsePKCS8RSA(block.Bytes)
		case "RSA PRIVATE KEY":
			if _, encrypted := block.Headers["DEK-Info"]; encrypted {
				return nil, errors.New("encrypted RSA key; decrypt with: openssl rsa -in key.pem -out key.dec.pem")
			}
			return x509.ParsePKCS1PrivateKey(block.Bytes)
		case "ENCRYPTED PRIVATE KEY":
			return nil, errors.New("encrypted PKCS#8 key; decrypt with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem")
		}
	}
	if sawBlock {
		return nil, errors.New("no private key block found in PEM")
	}
	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(pemText), ""))
	if err != nil {
		return nil, errors.New("not a PEM private key")
	}
	if k, err := parsePKCS8RSA(der); err == nil {
		return k, nil
	}
	return x509.ParsePKCS1PrivateKey(der)
}

func parsePKCS8RSA(der []byte) (*rsa.PrivateKey, error) {
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private key is %T, want RSA", k)
	}
	return rk, nil
}

// RSASHA256SignBase64 signs message with RSA PKCS#1 v1.5 + SHA-256 and returns base64.
// pemKey may be PKCS#8 or PKCS#1 PEM (see [ParseRSAPrivateKeyPEM]).
func RSASHA256SignBase64(pemKey, message string) (string, error) {
	key, err := ParseRSAPrivateKeyPEM(pemKey)
	if err != nil {
		return "", err
	}
	return rsaSign(key, message)
}

func rsaSign(key *rsa.PrivateKey, message string) (string, error) {
	digest := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return ToBase64(sig), nil
}

// parseRSAPublicKeyPEM parses an SPKI "BEGIN PUBLIC KEY" PEM. From a certificate (.cer/.crt):
//
//	openssl x509 -in NPI.cer [-inform der] -pubkey -noout > npi.pub.pem
func parseRSAPublicKeyPEM(spkiPEM string) (*rsa.PublicKey, error) {
	if !strings.Contains(spkiPEM, "BEGIN PUBLIC KEY") {
		return nil, errors.New("expected a PUBLIC KEY PEM; extract it from the certificate with: openssl x509 -in NPI.cer -pubkey -noout")
	}
	rest := []byte(spkiPEM)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return nil, errors.New("no PUBLIC KEY block found in PEM")
		}
		if block.Type != "PUBLIC KEY" {
			continue
		}
		k, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		rk, ok := k.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("public key is %T, want RSA", k)
		}
		return rk, nil
	}
}

// RSASHA256VerifyBase64 verifies a base64 RSA PKCS#1 v1.5 + SHA-256 signature with an SPKI PEM.
// False on any malformed input.
func RSASHA256VerifyBase64(spkiPEM, message, signatureB64 string) bool {
	key, err := parseRSAPublicKeyPEM(spkiPEM)
	if err != nil {
		return false
	}
	sig, err := FromBase64(signatureB64)
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(message))
	return rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) == nil
}

// RSAPKCS1EncryptBase64 encrypts plaintext with RSA PKCS#1 v1.5 padding ("RSA/ECB/PKCS1Padding") under an
// SPKI PEM and returns base64. The plaintext may be at most k-11 bytes (245 for a 2048-bit key).
func RSAPKCS1EncryptBase64(spkiPEM, plaintext string) (string, error) {
	key, err := parseRSAPublicKeyPEM(spkiPEM)
	if err != nil {
		return "", err
	}
	ct, err := rsa.EncryptPKCS1v15(rand.Reader, key, []byte(plaintext))
	if errors.Is(err, rsa.ErrMessageTooLong) {
		k := key.Size()
		return "", fmt.Errorf("plaintext too long for a %d-bit RSA key (max %d bytes)", k*8, k-11)
	}
	if err != nil {
		return "", err
	}
	return ToBase64(ct), nil
}
