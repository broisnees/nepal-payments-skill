package np.payments;

/** Which providers to enable (null = disabled). Build with {@link #empty()} + withers or {@link Payments#configFromEnv()}. */
public record PaymentsConfig(
        Esewa.Config esewa,
        Khalti.Config khalti,
        Fonepay.Config fonepay,
        ConnectIps.Config connectips,
        CyberSource.Config cybersource,
        Nps.Config nps,
        ImePay.Config imepay,
        NepalPay.Config nepalpay,
        HamroPay.Config hamropay,
        GetPay.Config getpay) {

    public static PaymentsConfig empty() {
        return new PaymentsConfig(null, null, null, null, null, null, null, null, null, null);
    }

    public PaymentsConfig withEsewa(Esewa.Config c) {
        return new PaymentsConfig(c, khalti, fonepay, connectips, cybersource, nps, imepay, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withKhalti(Khalti.Config c) {
        return new PaymentsConfig(esewa, c, fonepay, connectips, cybersource, nps, imepay, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withFonepay(Fonepay.Config c) {
        return new PaymentsConfig(esewa, khalti, c, connectips, cybersource, nps, imepay, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withConnectIps(ConnectIps.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, c, cybersource, nps, imepay, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withCyberSource(CyberSource.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, c, nps, imepay, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withNps(Nps.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, c, imepay, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withImePay(ImePay.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, c, nepalpay, hamropay, getpay);
    }

    public PaymentsConfig withNepalPay(NepalPay.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, imepay, c, hamropay, getpay);
    }

    public PaymentsConfig withHamroPay(HamroPay.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, imepay, nepalpay, c, getpay);
    }

    public PaymentsConfig withGetPay(GetPay.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, imepay, nepalpay, hamropay, c);
    }
}
