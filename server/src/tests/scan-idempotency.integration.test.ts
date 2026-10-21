import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { INTEGRATION, cleanupOrgs, createHarness, seedOrg, type Harness, type SeededOrg } from "./helpers/http.js";

// P0-7 through the real HTTP route and PostgreSQL: Idempotency-Key replays,
// key reuse, concurrent submissions and the one-active-scan guard.
describe.skipIf(!INTEGRATION)("POST /api/v1/scans idempotency and duplicate prevention (real database)", () => {
  let h: Harness;
  let A: SeededOrg;
  let B: SeededOrg;
  let query: typeof import("../db/client.js").query;
  let seq = 0;

  const newWebsite = async (org: SeededOrg) => {
    const domain = `idem-${++seq}-${randomUUID().slice(0, 8)}.example`;
    return (await query<{ id: string }>(
      "INSERT INTO websites (org_id, url, domain, verified) VALUES ($1,$2,$3,TRUE) RETURNING id",
      [org.id, `https://${domain}`, domain],
    )).rows[0].id;
  };
  const submit = (org: SeededOrg, websiteId: string, key?: string, modules = ["seo"]) =>
    h.request("POST", "/api/v1/scans", {
      token: org.users.member.token,
      orgId: org.id,
      payload: { websiteId, modules },
      headers: key === undefined ? {} : { "idempotency-key": key },
    });
  const scansFor = async (websiteId: string) =>
    Number((await query<{ n: string }>("SELECT COUNT(*)::text AS n FROM scans WHERE website_id=$1", [websiteId])).rows[0].n);
  const finish = (websiteId: string) => query("UPDATE scans SET status='completed', completed_at=NOW() WHERE website_id=$1 AND status IN ('queued','running')", [websiteId]);

  beforeAll(async () => {
    h = await createHarness();
    ({ query } = await import("../db/client.js"));
    A = await seedOrg(h, "idem-a");
    B = await seedOrg(h, "idem-b");
  });
  afterAll(async () => {
    if (A && B) await cleanupOrgs([A.id, B.id]);
    await h?.close();
    const { closePool } = await import("../db/client.js");
    await closePool();
  });

  it("a retried request with the same key returns the same scan, even after it finished", async () => {
    const w = await newWebsite(A);
    const key = `retry-${randomUUID()}`;
    const first = await submit(A, w, key);
    expect(first.statusCode).toBe(201);
    const id = first.json().data.id;

    const again = await submit(A, w, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ data: { id }, meta: { idempotentReplay: true } });

    await finish(w);
    const afterDone = await submit(A, w, key);
    expect(afterDone.statusCode).toBe(200);
    expect(afterDone.json().data.id).toBe(id);
    expect(await scansFor(w)).toBe(1);

    // Without the key, a finished scan does not block a new one.
    const fresh = await submit(A, w);
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().data.id).not.toBe(id);
    await finish(w);
  });

  it("the same key for a different request is rejected and creates nothing", async () => {
    const w1 = await newWebsite(A);
    const w2 = await newWebsite(A);
    const key = `reuse-${randomUUID()}`;
    expect((await submit(A, w1, key)).statusCode).toBe(201);
    const otherSite = await submit(A, w2, key);
    expect(otherSite.statusCode).toBe(422);
    expect(otherSite.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const otherModules = await submit(A, w1, key, ["seo", "security"]);
    expect(otherModules.statusCode).toBe(422);
    expect(await scansFor(w2)).toBe(0);
    expect(await scansFor(w1)).toBe(1);
    await finish(w1);
  });

  it("keys are scoped to the organization", async () => {
    const key = `shared-${randomUUID()}`;
    const wa = await newWebsite(A);
    const wb = await newWebsite(B);
    const a = await submit(A, wa, key);
    const b = await submit(B, wb, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().data.id).not.toBe(a.json().data.id);
    await finish(wa);
    await finish(wb);
  });

  it("rejects malformed keys with 400 before touching the database", async () => {
    const w = await newWebsite(A);
    for (const bad of ["", "has space", "x".repeat(256), "tab\there", "ünicode"]) {
      const res = await submit(A, w, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    }
    expect(await scansFor(w)).toBe(0);
  });

  it("concurrent submissions with one key create exactly one scan and all return it", async () => {
    const w = await newWebsite(A);
    const key = `burst-${randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(A, w, key)));
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.json().data.id)).size).toBe(1);
    expect(await scansFor(w)).toBe(1);
    await finish(w);
  });

  it("concurrent submissions without a key for one website create exactly one active scan", async () => {
    const w = await newWebsite(A);
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(A, w)));
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const dups = responses.filter((r) => r.statusCode === 200);
    expect(dups).toHaveLength(7);
    expect(dups.every((r) => r.json().meta?.deduplicated === true)).toBe(true);
    expect(new Set(responses.map((r) => r.json().data.id)).size).toBe(1);
    expect(await scansFor(w)).toBe(1);
    await finish(w);
  });

  it("a double submit is answered with the active scan even when the tenant is at its concurrency limit", async () => {
    // Default MAX_CONCURRENT_SCANS_PER_TENANT is 2: fill both slots.
    const w1 = await newWebsite(A);
    const w2 = await newWebsite(A);
    const first = await submit(A, w1);
    expect(first.statusCode).toBe(201);
    expect((await submit(A, w2)).statusCode).toBe(201);
    const w3 = await newWebsite(A);
    expect((await submit(A, w3)).statusCode).toBe(429);

    const retry = await submit(A, w1);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ data: { id: first.json().data.id }, meta: { deduplicated: true } });
    await finish(w1);
    await finish(w2);
  });
});
