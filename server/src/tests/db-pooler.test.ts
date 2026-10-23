import { describe, expect, it } from "vitest";
import { usesTransactionPooler } from "../db/client.js";

describe("usesTransactionPooler", () => {
  it("detects Neon pooled endpoints and explicit PgBouncer URLs", () => {
    expect(usesTransactionPooler("postgresql://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require")).toBe(true);
    expect(usesTransactionPooler("postgresql://u:p@db.example.com:6432/db?pgbouncer=true")).toBe(true);
  });
  it("treats direct connections as able to take startup parameters", () => {
    expect(usesTransactionPooler("postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/db")).toBe(false);
    expect(usesTransactionPooler("postgresql://u:p@127.0.0.1:5432/db")).toBe(false);
    expect(usesTransactionPooler("not a url")).toBe(false);
  });
});
