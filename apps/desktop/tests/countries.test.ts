import { describe, expect, it } from "vite-plus/test";
import { countries, filterCountries } from "../src/renderer/countries.ts";

describe("countries", () => {
  it("lists every region with a name, flag and calling code", () => {
    const us = countries().find((c) => c.code === "US");
    expect(us).toMatchObject({ name: "United States", dial: "1", flag: "🇺🇸" });
    expect(countries().length).toBeGreaterThan(200);
  });

  it("filters by name prefix first, ignoring accents", () => {
    const names = filterCountries(countries(), "ar").map((c) => c.code);
    expect(names.indexOf("AR")).toBeLessThan(names.indexOf("SA"));
    expect(filterCountries(countries(), "curacao").map((c) => c.code)).toContain("CW");
  });

  it("filters by region code and calling code", () => {
    expect(filterCountries(countries(), "gb")[0]?.code).toBe("GB");
    expect(filterCountries(countries(), "+44").map((c) => c.code)).toContain("GB");
    expect(filterCountries(countries(), "44").every((c) => c.dial.startsWith("44"))).toBe(true);
  });
});
