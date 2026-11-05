import { expect, test } from "vitest";
import { deviceName } from "./ua.ts";

test("names common devices", () => {
  expect(deviceName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36").label).toBe("Chrome on Linux");
  expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1")).toEqual({ label: "Safari on iOS", mobile: true });
  expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0").label).toBe("Firefox on Windows");
  expect(deviceName(null).label).toBe("Unknown device");
});
