package np.payments;

/** Which providers to enable (null = disabled). Build with {@link #empty()} + withers or {@link Payments#configFromEnv()}. */
public record PaymentsConfig(
        Esewa.Config esewa,
        Khalti.Config khalti,
        Fonepay.Config fonepay,
        ConnectIps.Config connectips,
        CyberSource.Config cybersource,
        Nps.Config nps,
        ImePay.Config imepay) {

    public static PaymentsConfig empty() {
        return new PaymentsConfig(null, null, null, null, null, null, null);
    }

    public PaymentsConfig withEsewa(Esewa.Config c) {
        return new PaymentsConfig(c, khalti, fonepay, connectips, cybersource, nps, imepay);
    }

    public PaymentsConfig withKhalti(Khalti.Config c) {
        return new PaymentsConfig(esewa, c, fonepay, connectips, cybersource, nps, imepay);
    }

    public PaymentsConfig withFonepay(Fonepay.Config c) {
        return new PaymentsConfig(esewa, khalti, c, connectips, cybersource, nps, imepay);
    }

    public PaymentsConfig withConnectIps(ConnectIps.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, c, cybersource, nps, imepay);
    }

    public PaymentsConfig withCyberSource(CyberSource.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, c, nps, imepay);
    }

    public PaymentsConfig withNps(Nps.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, c, imepay);
    }

    public PaymentsConfig withImePay(ImePay.Config c) {
        return new PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, c);
    }
}
