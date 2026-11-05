package np.payments;

import java.util.LinkedHashMap;
import java.util.Map;

/** Optional payer details (all fields nullable). Sent where the provider supports it (Khalti customer_info). */
public record Customer(String name, String email, String phone) {

    /** JSON object with the non-null fields only (JSON.stringify drops undefined fields the same way). */
    Map<String, Object> toJson() {
        Map<String, Object> m = new LinkedHashMap<>();
        if (name != null) m.put("name", name);
        if (email != null) m.put("email", email);
        if (phone != null) m.put("phone", phone);
        return m;
    }
}
