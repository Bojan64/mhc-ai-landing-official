import { describe, expect, it } from "vitest";
import { applicablePrompts, promptApplies, renderPrompt } from "../src/runner/applicability";
import { hotel, prompt, realConfig } from "./helpers";

describe("prompt applicability", () => {
  it("empty applies_if applies to every hotel", () => {
    expect(promptApplies(prompt(), hotel())).toBe(true);
  });

  it("tags use OR logic", () => {
    const p = prompt({ applies_if: ["couples", "adults_only"] });
    expect(promptApplies(p, hotel({ tags: ["adults_only"] }))).toBe(true);
    expect(promptApplies(p, hotel({ tags: ["couples", "spa"] }))).toBe(true);
    expect(promptApplies(p, hotel({ tags: ["family"] }))).toBe(false);
  });

  it("LUX-01 applies if luxury tag OR at least 4 stars", () => {
    const p = prompt({ applies_if: ["luxury"], min_stars: 4 });
    expect(promptApplies(p, hotel({ stars: 3, tags: ["luxury"] }))).toBe(true);
    expect(promptApplies(p, hotel({ stars: 4 }))).toBe(true);
    expect(promptApplies(p, hotel({ stars: 3 }))).toBe(false);
  });

  it("min_stars alone is a requirement", () => {
    const p = prompt({ min_stars: 5 });
    expect(promptApplies(p, hotel({ stars: 4 }))).toBe(false);
    expect(promptApplies(p, hotel({ stars: 5 }))).toBe(true);
  });

  it("renders all placeholders", () => {
    const p = prompt({ text: "{hotel_name} | {city} | {region} | {stars}-star" });
    expect(renderPrompt(p, hotel({ stars: 4 }))).toBe("Hotel X | Portorož | Slovenian coast | 4-star");
  });

  it("seed prompts give the expected counts for the example hotels", () => {
    const c = realConfig();
    const ids = (hid: string) => applicablePrompts(c.prompts, c.hotels.find((h) => h.hotel_id === hid)!).map((p) => p.id);
    // HT1: 4-star spa/couples/business/events hotel
    expect(ids("HT1")).toHaveLength(17);
    expect(ids("HT1")).toContain("LUX-01");
    expect(ids("HT1")).not.toContain("FAM-01");
    // HT2: 3-star family hotel
    expect(ids("HT2")).toEqual(
      expect.arrayContaining(["LOC-01", "FAM-01", "FAM-02", "BRAND-01", "BRAND-02"]),
    );
    expect(ids("HT2")).not.toContain("LUX-01");
  });
});
