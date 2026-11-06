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
	NepalPay    *NepalPayConfig
	HamroPay    *HamroPayConfig
	GetPay      *GetPayConfig
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
	NepalPay    *NepalPay
	HamroPay    *HamroPay
	GetPay      *GetPay
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
	if c := cfg.NepalPay; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.NepalPay, err = NewNepalPay(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.HamroPay; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.HamroPay, err = NewHamroPay(cc); err != nil {
			return nil, err
		}
	}
	if c := cfg.GetPay; c != nil {
		cc := *c
		cc.HTTPClient = pick(c.HTTPClient)
		if p.GetPay, err = NewGetPay(cc); err != nil {
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
	if p.NepalPay != nil {
		out = append(out, p.NepalPay)
	}
	if p.HamroPay != nil {
		out = append(out, p.HamroPay)
	}
	if p.GetPay != nil {
		out = append(out, p.GetPay)
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
	if getenv("NEPALPAY_ACQUIRER_ID") != "" && getenv("NEPALPAY_MERCHANT_ID") != "" && getenv("NEPALPAY_USERNAME") != "" && getenv("NEPALPAY_PRIVATE_KEY_PEM") != "" {
		cfg.NepalPay = &NepalPayConfig{
			Env: mode("NEPALPAY_ENV"), AcquirerID: getenv("NEPALPAY_ACQUIRER_ID"), MerchantID: getenv("NEPALPAY_MERCHANT_ID"),
			MerchantName: getenv("NEPALPAY_MERCHANT_NAME"), MerchantCategoryCode: getenv("NEPALPAY_MCC"),
			MerchantCity: orDefault(getenv("NEPALPAY_MERCHANT_CITY"), "Kathmandu"), MerchantPostalCode: orDefault(getenv("NEPALPAY_MERCHANT_POSTAL_CODE"), "44600"),
			StoreLabel: orDefault(getenv("NEPALPAY_STORE_LABEL"), "Store1"), TerminalLabel: getenv("NEPALPAY_TERMINAL_LABEL"),
			Username: getenv("NEPALPAY_USERNAME"), Password: getenv("NEPALPAY_PASSWORD"),
			PrivateKeyPEM:    strings.ReplaceAll(getenv("NEPALPAY_PRIVATE_KEY_PEM"), `\n`, "\n"),
			NCHLPublicKeyPEM: strings.ReplaceAll(getenv("NEPALPAY_NCHL_PUBLIC_KEY_PEM"), `\n`, "\n"),
		}
		if getenv("NEPALPAY_WS_URL") != "" {
			cfg.NepalPay.WSURL, cfg.NepalPay.WSUsername, cfg.NepalPay.WSAPIToken = getenv("NEPALPAY_WS_URL"), getenv("NEPALPAY_WS_USERNAME"), getenv("NEPALPAY_WS_API_TOKEN")
		}
		if getenv("NEPALPAY_CLIENT_ID") != "" {
			cfg.NepalPay.Auth, cfg.NepalPay.ClientID, cfg.NepalPay.ClientSecret = "oauth", getenv("NEPALPAY_CLIENT_ID"), getenv("NEPALPAY_CLIENT_SECRET")
		}
	}
	if getenv("HAMROPAY_MERCHANT_ID") != "" && getenv("HAMROPAY_CLIENT_ID") != "" && getenv("HAMROPAY_CLIENT_API_KEY") != "" && getenv("HAMROPAY_CLIENT_SECRET") != "" {
		cfg.HamroPay = &HamroPayConfig{
			Env: mode("HAMROPAY_ENV"), MerchantID: getenv("HAMROPAY_MERCHANT_ID"), ClientID: getenv("HAMROPAY_CLIENT_ID"),
			ClientAPIKey: getenv("HAMROPAY_CLIENT_API_KEY"), ClientSecret: getenv("HAMROPAY_CLIENT_SECRET"),
			WebhookSecret: getenv("HAMROPAY_WEBHOOK_SECRET"), APIBaseURL: getenv("HAMROPAY_API_BASE_URL"), GatewayURL: getenv("HAMROPAY_GATEWAY_URL"),
		}
	}
	if getenv("GETPAY_PAP_INFO") != "" && getenv("GETPAY_OPR_KEY") != "" && getenv("GETPAY_WEBSITE_DOMAIN") != "" {
		cfg.GetPay = &GetPayConfig{
			Env: mode("GETPAY_ENV"), PapInfo: getenv("GETPAY_PAP_INFO"), OprKey: getenv("GETPAY_OPR_KEY"), InsKey: getenv("GETPAY_INS_KEY"),
			WebsiteDomain: getenv("GETPAY_WEBSITE_DOMAIN"), BusinessName: getenv("GETPAY_BUSINESS_NAME"), ImageURL: getenv("GETPAY_IMAGE_URL"),
			Currency: getenv("GETPAY_CURRENCY"), BundleURL: getenv("GETPAY_BUNDLE_URL"), BaseURL: getenv("GETPAY_BASE_URL"),
		}
	}
	return cfg
}
