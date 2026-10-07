import { describe, expect, it, vi } from "vitest";
import { parsePlatformAdminUserIds } from "../config-security.js";
import { createRequirePlatformAdmin } from "../middleware/auth.js";
import { loadConfig } from "../config.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parsePlatformAdminUserIds", () => {
  it("treats unset and empty as no platform admins", () => {
    expect(parsePlatformAdminUserIds(undefined)).toEqual([]);
    expect(parsePlatformAdminUserIds("")).toEqual([]);
    expect(parsePlatformAdminUserIds("   ")).toEqual([]);
  });
  it("trims, lower-cases and dedupes", () => {
    expect(parsePlatformAdminUserIds(` ${A.toUpperCase()} , ${B},${A}`)).toEqual([A, B]);
  });
  it("rejects emails, garbage and empty segments", () => {
    expect(() => parsePlatformAdminUserIds("admin@example.com")).toThrow(/UUID/);
    expect(() => parsePlatformAdminUserIds(`${A},nope`)).toThrow();
    expect(() => parsePlatformAdminUserIds(`${A},`)).toThrow();
  });
});

describe("loadConfig PLATFORM_ADMIN_USER_IDS", () => {
  const base = { ...process.env };
  it("defaults to empty (fail closed)", () => {
    const env = { ...base };
    delete env.PLATFORM_ADMIN_USER_IDS;
    expect(loadConfig(env).PLATFORM_ADMIN_USER_IDS).toEqual([]);
  });
  it("parses valid ids and fails startup on an invalid entry", () => {
    expect(loadConfig({ ...base, PLATFORM_ADMIN_USER_IDS: `${A}, ${B}` }).PLATFORM_ADMIN_USER_IDS).toEqual([A, B]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => loadConfig({ ...base, PLATFORM_ADMIN_USER_IDS: "boss@example.com" })).toThrow(/PLATFORM_ADMIN_USER_IDS/);
  });
});

describe("createRequirePlatformAdmin", () => {
  const run = async (ids: string[], userId?: string) => {
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    await createRequirePlatformAdmin(() => ids)(
      { authUser: userId ? { id: userId } : undefined } as never,
      { status } as never,
    );
    return { status, send };
  };
  it("denies everyone when the list is empty", async () => {
    const r = await run([], A);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.send.mock.calls[0][0].error.code).toBe("PLATFORM_ADMIN_REQUIRED");
  });
  it("denies users not listed and missing users", async () => {
    expect((await run([A], B)).status).toHaveBeenCalledWith(403);
    expect((await run([A])).status).toHaveBeenCalledWith(403);
  });
  it("allows listed users (case-insensitive)", async () => {
    expect((await run([A], A.toUpperCase())).status).not.toHaveBeenCalled();
  });
});
