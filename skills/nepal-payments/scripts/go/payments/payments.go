package payments

import (
	"fmt"
	"os"
	"strings"
)

// Config enables providers: a nil provider config leaves that provider disabled.
type Config struct {
	Esewa       *EsewaConfig
	Khalti      *KhaltiConfig
	Fonepay     *FonepayConfig
	ConnectIPS  *ConnectIPSConfig
	CyberSource *CyberSourceConfig
	NPS         *NPSConfig
	IMEPay      *IMEPayConfig
	// HTTPClient is used by every provider whose own HTTPClient is nil (default: a client that
	// follows redirects, with per-request timeouts from each provider config).
	HTTPClient Doer
}

// Payments holds the configured adapters; a nil field means the provider is not configured.
type Payments struct {
	Esewa       *Esewa
	Khalti      *Khalti
	Fonepay     *Fonepay
	ConnectIPS  *ConnectIPS
	CyberSource *CyberSource
	NPS         *NPS
	IMEPay      *IMEPay
}

// New builds every configured adapter.
func New(cfg Config) (*Payments, error) {
	p := &Payments{}
	var err error
	pick := func(d Doer) Doer {
		if d != nil {
			return d
		}
		return cfg.HTTPClient
	}
	if c := cfg.Esewa; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.Esewa, err = NewEsewa(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.Khalti; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.Khalti, err = NewKhalti(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.Fonepay; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.Fonepay, err = NewFonepay(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.ConnectIPS; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.ConnectIPS, err = NewConnectIPS(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.CyberSource; c != nil {
		if p.CyberSource, err = NewCyberSource(*c); err != nil {
			return nil, err
		}
	}
	if c := cfg.NPS; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.NPS, err = NewNPS(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.IMEPay; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.IMEPay, err = NewIMEPay(cc); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func (p *Payments) all() []Adapter {
	var out []Adapter
	if p.Esewa != nil {
		out = append(out, p.Esewa)
	}
	if p.Khalti != nil {
		out = append(out, p.Khalti)
	}
	if p.Fonepay != nil {
		out = append(out, p.Fonepay)
	}
	if p.ConnectIPS != nil {
		out = append(out, p.ConnectIPS)
	}
	if p.CyberSource != nil {
		out = append(out, p.CyberSource)
	}
	if p.NPS != nil {
		out = append(out, p.NPS)
	}
	if p.IMEPay != nil {
		out = append(out, p.IMEPay)
	}
	return out
}

// Adapter returns a configured provider by id (e.g. a route param), for generic handlers.
func (p *Payments) Adapter(id string) (Adapter, error) {
	for _, a := range p.all() {
		if string(a.ID()) == id {
			return a, nil
		}
	}
	return nil, fmt.Errorf("payment provider %q is not configured", id)
}

// Enabled lists the configured providers.
func (p *Payments) Enabled() []ProviderID {
	var ids []ProviderID
	for _, a := range p.all() {
		ids = append(ids, a.ID())
	}
	return ids
}

// ConfigFromEnv builds a Config from environment variables (same names as the TS
// paymentsConfigFromEnv; see references/env.md). A provider is enabled when its required vars are set.
func ConfigFromEnv() Config { return ConfigFromLookup(os.Getenv) }

// ConfigFromLookup is ConfigFromEnv with a custom lookup (empty string = unset).
func ConfigFromLookup(getenv func(string) string) Config {
	mode := func(key string) Env {
		if v := getenv(key); v == "production" || v == "live" {
			return EnvProduction
		}
		return EnvSandbox
	}
	var cfg Config
	if getenv("ESEWA_PRODUCT_CODE") != "" && getenv("ESEWA_SECRET_KEY") != "" {
		cfg.Esewa = &EsewaConfig{Env: mode("ESEWA_ENV"), ProductCode: getenv("ESEWA_PRODUCT_CODE"), SecretKey: getenv("ESEWA_SECRET_KEY")}
		if getenv("ESEWA_INTENT_PRODUCT_CODE") != "" && getenv("ESEWA_INTENT_ACCESS_KEY") != "" {
			cfg.Esewa.Intent = &EsewaIntentConfig{
				ProductCode: getenv("ESEWA_INTENT_PRODUCT_CODE"),
				AccessKey:   getenv("ESEWA_INTENT_ACCESS_KEY"),
				BaseURL:     getenv("ESEWA_INTENT_BASE_URL"),
			}
		}
	}
	if getenv("KHALTI_SECRET_KEY") != "" && getenv("KHALTI_WEBSITE_URL") != "" {
		cfg.Khalti = &KhaltiConfig{Env: mode("KHALTI_ENV"), SecretKey: getenv("KHALTI_SECRET_KEY"), WebsiteURL: getenv("KHALTI_WEBSITE_URL")}
	}
	if getenv("FONEPAY_MERCHANT_CODE") != "" && getenv("FONEPAY_SECRET_KEY") != "" {
		cfg.Fonepay = &FonepayConfig{
			Env: mode("FONEPAY_ENV"), MerchantCode: getenv("FONEPAY_MERCHANT_CODE"), SecretKey: getenv("FONEPAY_SECRET_KEY"),
			Username: getenv("FONEPAY_USERNAME"), Password: getenv("FONEPAY_PASSWORD"),
		}
	}
	if getenv("CONNECTIPS_MERCHANT_ID") != "" && getenv("CONNECTIPS_APP_ID") != "" && getenv("CONNECTIPS_PRIVATE_KEY_PEM") != "" {
		cfg.ConnectIPS = &ConnectIPSConfig{
			Env: mode("CONNECTIPS_ENV"), MerchantID: getenv("CONNECTIPS_MERCHANT_ID"), AppID: getenv("CONNECTIPS_APP_ID"),
			AppName: getenv("CONNECTIPS_APP_NAME"), AppPassword: getenv("CONNECTIPS_APP_PASSWORD"),
			PrivateKeyPEM: strings.ReplaceAll(getenv("CONNECTIPS_PRIVATE_KEY_PEM"), `\n`, "\n"),
		}
	}
	if getenv("CYBERSOURCE_PROFILE_ID") != "" && getenv("CYBERSOURCE_ACCESS_KEY") != "" && getenv("CYBERSOURCE_SECRET_KEY") != "" {
		cfg.CyberSource = &CyberSourceConfig{
			Env: mode("CYBERSOURCE_ENV"), ProfileID: getenv("CYBERSOURCE_PROFILE_ID"), AccessKey: getenv("CYBERSOURCE_ACCESS_KEY"),
			SecretKey: getenv("CYBERSOURCE_SECRET_KEY"), Currency: orDefault(getenv("CYBERSOURCE_CURRENCY"), "NPR"),
		}
	}
	if getenv("NPS_MERCHANT_ID") != "" && getenv("NPS_SECRET_KEY") != "" {
		cfg.NPS = &NPSConfig{
			Env: mode("NPS_ENV"), MerchantID: getenv("NPS_MERCHANT_ID"), MerchantName: getenv("NPS_MERCHANT_NAME"),
			APIUsername: getenv("NPS_API_USERNAME"), APIPassword: getenv("NPS_API_PASSWORD"), SecretKey: getenv("NPS_SECRET_KEY"),
		}
	}
	if getenv("IMEPAY_MERCHANT_CODE") != "" && getenv("IMEPAY_USERNAME") != "" {
		cfg.IMEPay = &IMEPayConfig{
			Env: mode("IMEPAY_ENV"), MerchantCode: getenv("IMEPAY_MERCHANT_CODE"), Username: getenv("IMEPAY_USERNAME"),
			Password: getenv("IMEPAY_PASSWORD"), Module: getenv("IMEPAY_MODULE"),
		}
	}
	return cfg
}
