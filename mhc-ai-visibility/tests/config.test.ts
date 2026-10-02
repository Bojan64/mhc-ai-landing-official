import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";
import { CONFIG_DIR, configWith } from "./helpers";

describe("config validation", () => {
  it("accepts the shipped config", () => {
    const { config, errors } = loadConfig(CONFIG_DIR);
    expect(errors).toEqual([]);
    expect(config?.prompts).toHaveLength(20);
    expect(config?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("warns about unconfirmed ground truth and missing prices", () => {
    const { warnings } = loadConfig(CONFIG_DIR);
    expect(warnings.some((w) => w.includes("NOT confirmed"))).toBe(true);
    expect(warnings.some((w) => w.includes("pricing not filled in"))).toBe(true);
  });

  it("rejects an unknown hotel tag, naming the hotel", () => {
    const dir = configWith("hotels.json", (h) => (h[0].tags.push("casino"), h));
    const { config, errors } = loadConfig(dir);
    expect(config).toBeNull();
    expect(errors.join()).toContain("HT1 → tags");
  });

  it("rejects a website_domain with http:// or www.", () => {
    for (const bad of ["https://hotel.si", "www.hotel.si"]) {
      const dir = configWith("hotels.json", (h) => ((h[0].website_domain = bad), h));
      expect(loadConfig(dir).errors.join()).toContain("website_domain");
    }
  });

  it("allows missing ground-truth keys but rejects unknown ones", () => {
    const ok = configWith("hotels.json", (h) => ((h[0].ground_truth = {}), h));
    expect(loadConfig(ok).errors).toEqual([]);
    const bad = configWith("hotels.json", (h) => ((h[0].ground_truth.sauna = true), h));
    expect(loadConfig(bad).errors.join()).toContain("sauna");
  });

  it("rejects a competitor that does not exist", () => {
    const dir = configWith("hotels.json", (h) => (h[0].competitor_ids.push("NOPE"), h));
    expect(loadConfig(dir).errors.join()).toContain('competitor "NOPE" does not exist');
  });

  it("rejects duplicate hotel ids", () => {
    const dir = configWith("hotels.json", (h) => [...h, { ...h[0] }]);
    expect(loadConfig(dir).errors.join()).toContain('duplicate hotel_id "HT1"');
  });

  it("rejects unknown placeholders and discovery prompts that name the hotel", () => {
    const dir = configWith("prompts.json", (p) => {
      p[0].text = "Best hotels in {town}";
      p[1].text = "Is {hotel_name} good?";
      return p;
    });
    const errors = loadConfig(dir).errors.join("\n");
    expect(errors).toContain("unknown placeholder {town}");
    expect(errors).toContain('LOC-02 is "discovery" but names the hotel');
  });

  it("requires an engine weight for every enabled engine", () => {
    const dir = configWith("scoring.json", (s) => (delete s.engine_weights.gemini, s));
    expect(loadConfig(dir).errors.join()).toContain('no entry for enabled engine "gemini"');
  });

  it("rejects an invalid mode and reports invalid JSON", () => {
    const dir = configWith("engines.json", (e) => ((e.engines[0].modes = ["deep_search"]), e));
    expect(loadConfig(dir).errors.join()).toContain("engines.json");
    const broken = configWith("scoring.json", () => "x");
    expect(loadConfig(broken).errors.join()).toContain("scoring.json");
  });
});
