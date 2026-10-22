import { describe, expect, it } from "vitest";
import { brandTermsFromDomain, classifyGap, classifyIntent, compareSnapshots, isValidKeyword, normalizeKeyword, type GapDataset } from "../research/keywords.js";

// Synthetic fixtures only (no customer data).

describe("keyword normalization", () => {
  it("folds case, Unicode forms, whitespace and edge punctuation, but keeps meaningful symbols", () => {
    expect(normalizeKeyword("  Running   SHOES ")).toBe("running shoes");
    expect(normalizeKeyword("ＲＵＮＮＩＮＧ shoes")).toBe("running shoes"); // full-width
    expect(normalizeKeyword("\"best shoes?\"")).toBe("best shoes");
    expect(normalizeKeyword("c++ tutorial")).toBe("c++ tutorial");
    expect(normalizeKeyword("learn c#")).toBe("learn c#");
    expect(normalizeKeyword(".net core")).toBe(".net core");
    expect(normalizeKeyword("node.js")).toBe("node.js");
    expect(normalizeKeyword("running shoes.")).toBe("running shoes");
    expect(normalizeKeyword("shoe")).not.toBe(normalizeKeyword("shoes")); // no stemming
    expect(normalizeKeyword("x".repeat(500))).toHaveLength(200);
  });

  it("validates input", () => {
    expect(isValidKeyword("shoes")).toBe(true);
    expect(isValidKeyword("   ")).toBe(false);
    expect(isValidKeyword("?!")).toBe(false);
    expect(isValidKeyword("bad\u0000input")).toBe(false);
    expect(isValidKeyword(42)).toBe(false);
    expect(isValidKeyword("x".repeat(401))).toBe(false);
  });
});

describe("rule-based intent", () => {
  it("labels clear wording and declines to guess otherwise", () => {
    expect(classifyIntent("buy running shoes")).toMatchObject({ intent: "transactional" });
    expect(classifyIntent("best running shoes 2030")).toMatchObject({ intent: "commercial" });
    expect(classifyIntent("nike vs adidas")).toMatchObject({ intent: "commercial" });
    expect(classifyIntent("how to clean shoes")).toMatchObject({ intent: "informational" });
    expect(classifyIntent("are leather shoes waterproof")).toMatchObject({ intent: "informational" });
    expect(classifyIntent("shop login")).toMatchObject({ intent: "transactional" }); // first matching rule wins, documented order
    expect(classifyIntent("acme account")).toMatchObject({ intent: "navigational" });
    expect(classifyIntent("running shoes")).toBeNull();
    expect(classifyIntent("")).toBeNull();
  });

  it("treats the site's own brand as navigational, matching whole words only", () => {
    const brand = brandTermsFromDomain("www.acme-shop.example");
    expect(brand).toEqual(["acme-shop", "acme shop"]);
    expect(classifyIntent("acme shop opening hours", brand)).toEqual({ intent: "navigational", rule: 'brand term "acme shop"' });
    expect(classifyIntent("acme-shopping bags", brand)).toBeNull();
    expect(brandTermsFromDomain("ab.example")).toEqual([]);
  });
});

describe("keyword gap", () => {
  const ds = (id: string, role: GapDataset["role"], rows: GapDataset["rows"], complete = true): GapDataset => ({ id, label: id, role, complete, observedAt: "2030-01-31", rows });

  it("classifies shared, missing and unique keywords across several competitors", () => {
    const r = classifyGap(
      ds("me", "customer", [{ keyword: "Running Shoes", position: 4, clicks: 10, impressions: 100 }, { keyword: "trail shoes", position: 9 }]),
      [
        ds("c1", "competitor", [{ keyword: "running shoes", position: 2 }, { keyword: "shoe laces", position: 5 }]),
        ds("c2", "competitor", [{ keyword: "RUNNING SHOES ", position: 7 }, { keyword: "shoe laces" }]),
      ],
    );
    expect(r.counts).toEqual({ shared: 1, missing: 1, unique: 1 });
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(by["running shoes"]).toMatchObject({ category: "shared", competitorsPresent: 2, keyword: "Running Shoes", absenceFromSample: false });
    expect(by["shoe laces"]).toMatchObject({ category: "missing", competitorsPresent: 2 });
    expect(by["trail shoes"]).toMatchObject({ category: "unique", competitorsPresent: 0 });
    // Missing metrics stay null: never zero.
    expect(by["shoe laces"].observations.c2).toEqual({ position: null, clicks: null, impressions: null, duplicates: 0 });
    expect(by["trail shoes"].observations.me.clicks).toBeNull();
  });

  it("marks absence-based categories that rely on a sample", () => {
    const r = classifyGap(ds("me", "customer", [{ keyword: "a" }], false), [ds("c", "competitor", [{ keyword: "b" }], false)]);
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(by.a).toMatchObject({ category: "unique", absenceFromSample: true });
    expect(by.b).toMatchObject({ category: "missing", absenceFromSample: true });
  });

  it("merges duplicates (best position, summed counts), skips invalid rows and handles empty datasets", () => {
    const r = classifyGap(
      ds("me", "customer", [{ keyword: "x", position: 8, clicks: 1, impressions: 10 }, { keyword: " X ", position: 3, clicks: 2, impressions: null }, { keyword: "   " }, { keyword: "y", position: null }]),
      [ds("c", "competitor", [])],
    );
    expect(r.rows.find((x) => x.key === "x")!.observations.me).toEqual({ position: 3, clicks: 3, impressions: 10, duplicates: 1 });
    expect(r.datasets[0]).toMatchObject({ keywords: 2, duplicatesMerged: 1, invalidSkipped: 1 });
    expect(r.counts).toEqual({ shared: 0, missing: 0, unique: 2 });
    expect(classifyGap(ds("me", "customer", []), [ds("c", "competitor", [])]).rows).toEqual([]);
  });

  it("is deterministic and rejects inconsistent inputs", () => {
    const a = ds("me", "customer", [{ keyword: "b" }, { keyword: "a" }]);
    const c = ds("c", "competitor", [{ keyword: "a" }]);
    expect(classifyGap(a, [c])).toEqual(classifyGap(a, [c]));
    expect(() => classifyGap(a, [ds("me", "competitor", [])])).toThrow(/unique/);
    expect(() => classifyGap(c, [a])).toThrow(/roles/);
  });
});

describe("snapshot comparison", () => {
  it("reports added, removed and changed metrics; unchanged rows are omitted", () => {
    const older = [{ key: "a", metrics: { clicks: 1, position: 5 } }, { key: "b", metrics: { clicks: 2 } }];
    const newer = [{ key: "a", metrics: { clicks: 3, position: 5 } }, { key: "c", metrics: { clicks: 1 } }];
    expect(compareSnapshots(older, newer)).toEqual({ added: ["c"], removed: ["b"], changed: [{ key: "a", changes: { clicks: { from: 1, to: 3 } } }] });
  });
});

describe("request log redaction of research inputs", () => {
  it("keeps keyword searches out of logged URLs", async () => {
    const { sanitizeLoggedUrl } = await import("../http/log-redaction.js");
    const out = sanitizeLoggedUrl("/api/v1/keyword-research/runs/r1?sort=clicks&search=acme+merger+plans")!;
    expect(out).not.toContain("acme");
    expect(out).toContain("sort=clicks");
    expect(sanitizeLoggedUrl("/api/v1/keyword-research/lists/l1/items?keyword=secret+launch")).not.toContain("secret");
  });
});
