import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../db/client.js", () => ({ query: queryMock }));

import { collectEvidence } from "../ai/evidence/store.js";

const base = {
  tenantId: "00000000-0000-4000-8000-0000000000aa",
  taskId: "task-a",
  evidenceType: "HTML_DOCUMENT",
  sourceType: "CRAWLER",
  sourceReference: "unit",
  observedAt: new Date().toISOString(),
  content: { title: "x" },
};

function insertCall() {
  const call = queryMock.mock.calls.find(([sql]) => /INSERT INTO evidence \(/.test(sql as string));
  expect(call).toBeDefined();
  const sql = call![0] as string;
  const params = call![1] as unknown[];
  const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
  const placeholders = (sql.match(/VALUES \(([^)]*)\)/)![1]).split(",");
  return { sql, params, cols, placeholders };
}

describe("evidence store legacy type column", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => (/RETURNING id/.test(sql) ? { rows: [{ id: params[0] }] } : { rows: [] }));
  });

  it("writes type = evidenceType on the logical-key upsert path", async () => {
    await collectEvidence({ ...base, logicalKey: "lk-1" });
    const { sql, params, cols, placeholders } = insertCall();
    expect(cols).toContain("type");
    expect(cols).toContain("evidence_type");
    expect(cols).toContain("org_id");
    expect(cols).toContain("task_id");
    expect(sql).toContain("ON CONFLICT (org_id, task_id, logical_key) DO UPDATE");
    expect(placeholders).toHaveLength(cols.length);
    expect(params).toHaveLength(cols.length);
    expect(params[cols.indexOf("type")]).toBe("HTML_DOCUMENT");
    expect(params[cols.indexOf("evidence_type")]).toBe("HTML_DOCUMENT");
    expect(params[cols.indexOf("org_id")]).toBe(base.tenantId);
    expect(params[cols.indexOf("task_id")]).toBe("task-a");
  });

  it("writes type = evidenceType on the plain insert path", async () => {
    await collectEvidence({ ...base });
    const { sql, params, cols, placeholders } = insertCall();
    expect(cols).toContain("type");
    expect(cols).not.toContain("logical_key");
    expect(sql).not.toContain("ON CONFLICT");
    expect(placeholders).toHaveLength(cols.length);
    expect(params).toHaveLength(cols.length);
    expect(params[cols.indexOf("type")]).toBe("HTML_DOCUMENT");
    expect(params[cols.indexOf("evidence_type")]).toBe("HTML_DOCUMENT");
    expect(params[cols.indexOf("org_id")]).toBe(base.tenantId);
    expect(params[cols.indexOf("task_id")]).toBe("task-a");
  });
});
