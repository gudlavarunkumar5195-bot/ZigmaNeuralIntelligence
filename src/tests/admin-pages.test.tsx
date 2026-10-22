// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    apiGetMe: vi.fn(),
    apiListWebsites: vi.fn(),
    apiListAlerts: vi.fn(),
    apiAdminIntegrations: vi.fn(),
    apiAdminSaveCredential: vi.fn(),
    apiAdminTestIntegration: vi.fn(),
    apiAdminSetIntegrationEnabled: vi.fn(),
    apiAdminRemoveCredential: vi.fn(),
    apiAdminUsers: vi.fn(),
    apiAdminUser: vi.fn(),
    apiAdminSetUserActive: vi.fn(),
    apiAdminChangeRole: vi.fn(),
    apiAdminSendPasswordReset: vi.fn(),
    apiAdminRevokeSessions: vi.fn(),
    apiAdminCredentialAccount: vi.fn(),
    apiAdminGenerateCredentials: vi.fn(),
    apiAdminDiagnostics: vi.fn(),
    apiAdminRetryJob: vi.fn(),
    apiAdminExportDiagnostics: vi.fn(),
    apiConfirmPasswordReset: vi.fn(),
    apiRequestPasswordReset: vi.fn(),
  };
});

import * as api from "../services/api";
import { Shell } from "../components/layout/Shell";
import { IntegrationsAdminPage } from "../pages/admin/IntegrationsAdminPage";
import { UsersAdminPage } from "../pages/admin/UsersAdminPage";
import { ControlCenterPage } from "../pages/admin/ControlCenterPage";
import { ResetPasswordPage } from "../pages/auth/ResetPasswordPage";

// Response shapes match server/src/tests/admin-control-center.integration.test.ts. Synthetic values.
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ data, error: null, meta }) as never;
const fail = (code: string, message: string, details?: Record<string, unknown>) => ({ data: null, error: { code, message, details } }) as never;

const openrouter = (over: Record<string, unknown> = {}) => ({
  id: "openrouter", name: "OpenRouter (AI models)", purpose: "AI analysis.", management: "admin", docsUrl: "https://openrouter.ai/settings/keys", setup: "Create a key.",
  envVars: [{ name: "OPENROUTER_API_KEY", set: false }], capabilities: ["ai_analysis", "model_catalog"], configured: true, canTest: true, featureEnabled: true,
  credential: { source: "admin", stored: true, suffix: "1111", enabled: true, validatedAt: "2030-01-01T00:00:00Z", status: "valid", error: null, updatedAt: "2030-01-01T00:00:00Z", decryptError: null, envFallback: false },
  lastCheck: { status: "valid", message: "OpenRouter accepted the key.", checkedAt: "2030-01-01T00:00:00Z", trigger: "save" }, lastSuccessAt: "2030-01-01T00:00:00Z", details: { freeTier: true },
  ...over,
});
const email = { id: "email", name: "Transactional email", purpose: "Password-reset emails.", management: "unsupported", docsUrl: null, setup: "Not implemented.", envVars: [], capabilities: [], configured: false, canTest: false, featureEnabled: false, credential: null, lastCheck: null, lastSuccessAt: null, details: {} };
const postgres = { ...email, id: "postgres", name: "PostgreSQL", management: "deployment", configured: true, canTest: true, featureEnabled: true, setup: "DATABASE_URL", envVars: [{ name: "DATABASE_URL", set: true }] };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("__APP_VERSION__", "test");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const at = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Administration navigation", () => {
  const renderShell = () => render(<MemoryRouter><Routes><Route path="/" element={<Shell />}><Route index element={<div>home</div>} /></Route></Routes></MemoryRouter>);
  beforeEach(() => {
    vi.mocked(api.apiListWebsites).mockResolvedValue(ok([], { page: 1, pageSize: 100 }));
    vi.mocked(api.apiListAlerts).mockResolvedValue(ok([], { page: 1, pageSize: 100 }));
  });
  it("is hidden from users who are not platform administrators", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(ok({ id: "u", email: "me@example.org", orgIds: [], isPlatformAdmin: false }));
    renderShell();
    expect(await screen.findByText("me@example.org")).toBeTruthy();
    expect(screen.queryByText("Administration")).toBeNull();
  });
  it("is shown to platform administrators", async () => {
    vi.mocked(api.apiGetMe).mockResolvedValue(ok({ id: "u", email: "me@example.org", orgIds: [], isPlatformAdmin: true }));
    renderShell();
    expect(await screen.findByText("Administration")).toBeTruthy();
  });
});

describe("Integrations & API keys", () => {
  it("shows status with a masked key only, and reports unsupported integrations honestly", async () => {
    vi.mocked(api.apiAdminIntegrations).mockResolvedValue(ok([openrouter(), email, postgres]));
    at(<IntegrationsAdminPage />);
    const card = await screen.findByRole("region", { name: "OpenRouter (AI models)" });
    expect(card.textContent).toMatch(/stored here \(••••1111\)/);
    expect(within(card).getByRole("link", { name: "Provider documentation" }).getAttribute("href")).toBe("https://openrouter.ai/settings/keys");
    const mail = screen.getByRole("region", { name: "Transactional email" });
    expect(mail.textContent).toMatch(/Not available/);
    expect(within(mail).queryByRole("button")).toBeNull();
  });

  it("a rejected key shows the provider's reason, keeps the old key and clears the field", async () => {
    vi.mocked(api.apiAdminIntegrations).mockResolvedValue(ok([openrouter(), postgres]));
    vi.mocked(api.apiAdminSaveCredential).mockResolvedValue(fail("CREDENTIAL_NOT_VERIFIED", "OpenRouter rejected the key.", { status: "invalid", previousCredentialKept: true }));
    at(<IntegrationsAdminPage />);
    const card = await screen.findByRole("region", { name: "OpenRouter (AI models)" });
    const input = within(card).getByLabelText("Replace API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    await userEvent.type(input, "sk-or-wrong-key-9999");
    await userEvent.click(within(card).getByRole("button", { name: "Save & validate" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toMatch(/Rejected by provider: OpenRouter rejected the key\. The previously saved key is still in use\./);
    expect(input.value).toBe("");
    expect(card.textContent).toMatch(/••••1111/);
    expect(screen.queryByText(/Verified and activated/)).toBeNull();
    // The other card is unaffected.
    expect(within(screen.getByRole("region", { name: "PostgreSQL" })).queryByRole("alert")).toBeNull();
  });

  it("a verified key shows success and the new masked suffix", async () => {
    vi.mocked(api.apiAdminIntegrations).mockResolvedValue(ok([openrouter({ credential: null, featureEnabled: false, configured: false })]));
    vi.mocked(api.apiAdminSaveCredential).mockResolvedValue(ok({ result: { status: "valid", message: "ok", details: {} }, integration: openrouter({ credential: { ...openrouter().credential, suffix: "2222" } }) }));
    at(<IntegrationsAdminPage />);
    const card = await screen.findByRole("region", { name: "OpenRouter (AI models)" });
    await userEvent.type(within(card).getByLabelText("API key"), "sk-or-good-key-2222");
    await userEvent.click(within(card).getByRole("button", { name: "Save & validate" }));
    expect((await within(card).findByRole("status")).textContent).toMatch(/Verified and activated/);
    expect(card.textContent).toMatch(/••••2222/);
    expect(card.textContent).not.toMatch(/sk-or-good-key-2222/);
  });

  it("removal needs confirmation", async () => {
    vi.mocked(api.apiAdminIntegrations).mockResolvedValue(ok([openrouter()]));
    vi.mocked(api.apiAdminRemoveCredential).mockResolvedValue(ok({ removed: true, integration: openrouter({ credential: { ...openrouter().credential, stored: false, source: null } }) }));
    at(<IntegrationsAdminPage />);
    const card = await screen.findByRole("region", { name: "OpenRouter (AI models)" });
    await userEvent.click(within(card).getByRole("button", { name: "Remove key" }));
    expect(api.apiAdminRemoveCredential).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Yes, remove" }));
    expect(api.apiAdminRemoveCredential).toHaveBeenCalledWith("openrouter");
  });

  it("explains when the caller is not a platform administrator", async () => {
    vi.mocked(api.apiAdminIntegrations).mockResolvedValue(fail("PLATFORM_ADMIN_REQUIRED", "needs a platform administrator"));
    at(<IntegrationsAdminPage />);
    expect(await screen.findByText("Platform administrators only")).toBeTruthy();
  });
});

describe("Generate login credentials", () => {
  const user = { id: "u1", email: "a@example.org", full_name: null, active: true, created_at: "2030-01-01T00:00:00Z", last_login_at: null, active_sessions: 1, isPlatformAdmin: false, memberships: [{ orgId: "o1", orgName: "Org", role: "owner" }] };
  beforeEach(() => {
    vi.mocked(api.apiAdminUsers).mockResolvedValue(ok([user], { nextCursor: null }));
    vi.mocked(api.apiAdminCredentialAccount).mockResolvedValue(ok({ email: "info@zigmaneural.com", exists: false, active: null, lastLoginAt: null }));
  });

  it("locks the email, shows the generated password once with a copy button and a warning, and never stores it", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(api.apiAdminGenerateCredentials).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    at(<UsersAdminPage />);
    const emailBox = (await screen.findByLabelText("Email")) as HTMLInputElement;
    await waitFor(() => expect(emailBox.value).toBe("info@zigmaneural.com"));
    expect(emailBox.readOnly).toBe(true);
    const button = screen.getByRole("button", { name: "Generate Login Credentials" });
    await userEvent.click(button);
    // A second click while the first request runs does nothing.
    await userEvent.click(screen.getByRole("button", { name: "Generating…" }));
    expect(api.apiAdminGenerateCredentials).toHaveBeenCalledTimes(1);
    expect(api.apiAdminGenerateCredentials).toHaveBeenCalledWith("info@zigmaneural.com", false);
    resolve({ data: { email: "info@zigmaneural.com", password: "Gen-Pass_word#2345xyz", created: true, accountActive: true, revokedSessions: 0 }, error: null });
    const panel = await screen.findByRole("region", { name: "Generated credentials" });
    expect(within(panel).getByTestId("generated-password").textContent).toBe("Gen-Pass_word#2345xyz");
    expect(panel.textContent).toMatch(/shown only once/);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(within(panel).getByRole("button", { name: "Copy Password" }));
    expect(writeText).toHaveBeenCalledWith("Gen-Pass_word#2345xyz");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("Gen-Pass_word");
    expect(JSON.stringify({ ...localStorage })).not.toContain("Gen-Pass_word");
    await userEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("Gen-Pass_word#2345xyz")).toBeNull();
  });

  it("asks for confirmation before replacing an existing account's password", async () => {
    vi.mocked(api.apiAdminCredentialAccount).mockResolvedValue(ok({ email: "info@zigmaneural.com", exists: true, active: true, lastLoginAt: null }));
    vi.mocked(api.apiAdminGenerateCredentials)
      .mockResolvedValueOnce(fail("CONFIRMATION_REQUIRED", "exists", { exists: true, active: true }))
      .mockResolvedValueOnce(ok({ email: "info@zigmaneural.com", password: "Replaced-Pass#2345abc", created: false, accountActive: true, revokedSessions: 2 }));
    at(<UsersAdminPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Generate Login Credentials" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm password replacement" });
    expect(screen.queryByRole("region", { name: "Generated credentials" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace password" }));
    expect(api.apiAdminGenerateCredentials).toHaveBeenLastCalledWith("info@zigmaneural.com", true);
    expect((await screen.findByRole("region", { name: "Generated credentials" })).textContent).toMatch(/2 session\(s\) signed out/);
  });

  it("shows server errors and no password", async () => {
    vi.mocked(api.apiAdminGenerateCredentials).mockResolvedValue(fail("RECENTLY_GENERATED", "Credentials for this account were generated a few seconds ago."));
    at(<UsersAdminPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Generate Login Credentials" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/generated a few seconds ago/);
    expect(screen.queryByRole("region", { name: "Generated credentials" })).toBeNull();
  });
});

describe("Users & access", () => {
  const user = { id: "u1", email: "a@example.org", full_name: "A", active: true, created_at: "2030-01-01T00:00:00Z", last_login_at: null, active_sessions: 1, isPlatformAdmin: false, memberships: [{ orgId: "o1", orgName: "Org", role: "owner" }] };
  beforeEach(() => {
    vi.mocked(api.apiAdminCredentialAccount).mockResolvedValue(ok({ email: "info@zigmaneural.com", exists: true, active: true, lastLoginAt: null }));
    vi.mocked(api.apiAdminUsers).mockResolvedValue(ok([user], { nextCursor: null }));
    vi.mocked(api.apiAdminUser).mockResolvedValue(ok({ user, events: [{ timestamp: "2030-01-01T00:00:00Z", action: "login", result: "success", byUser: "self", request_id: null }] }));
  });

  it("confirms before acting and shows the server's refusal (last owner)", async () => {
    vi.mocked(api.apiAdminChangeRole).mockResolvedValue(fail("LAST_OWNER", "This is the organization's last active owner."));
    at(<UsersAdminPage />);
    await userEvent.click(await screen.findByRole("button", { name: "a@example.org" }));
    const detail = await screen.findByRole("region", { name: "User a@example.org" });
    await userEvent.selectOptions(within(detail).getByLabelText("Role in Org"), "admin");
    expect(api.apiAdminChangeRole).not.toHaveBeenCalled();
    await userEvent.click(within(detail).getByRole("button", { name: "Confirm" }));
    expect(api.apiAdminChangeRole).toHaveBeenCalledWith("u1", "o1", "admin");
    expect((await within(detail).findByRole("alert")).textContent).toMatch(/last active owner/);
  });

  it("a password reset without email delivery says so", async () => {
    vi.mocked(api.apiAdminSendPasswordReset).mockResolvedValue(fail("EMAIL_NOT_CONFIGURED", "No email provider is configured, so password-reset links cannot be delivered."));
    at(<UsersAdminPage />);
    await userEvent.click(await screen.findByRole("button", { name: "a@example.org" }));
    const detail = await screen.findByRole("region", { name: "User a@example.org" });
    await userEvent.click(within(detail).getByRole("button", { name: "Send password-reset link" }));
    await userEvent.click(within(detail).getByRole("button", { name: "Confirm" }));
    expect((await within(detail).findByRole("alert")).textContent).toMatch(/No email provider is configured/);
  });
});

describe("Control Center", () => {
  const diag = {
    generatedAt: "2030-01-01T00:00:00Z",
    process: { uptimeSeconds: 7200, node: "v22", environment: "production", memoryRssMb: 100 },
    database: { status: "ok", latencyMs: 4 },
    migrations: { status: "up_to_date", currentVersion: "034", latestOnDisk: "034", pending: [], checksumMismatches: [] },
    worker: { running: false, startedAt: null, lastTickAt: null, status: "not_running_in_this_process", lastError: null },
    jobs: { window: "7 days", scans: { completed: 3, failed: 1, stuckWithExpiredLease: 0 } },
    failedJobs: [
      { kind: "analytics_outbox", id: "42", orgId: "o", at: "2030-01-01T00:00:00Z", error: "ClickHouse 503", retryable: true, retryNote: "Returns the event to the queue." },
      { kind: "scan", id: "s1", orgId: "o", at: "2030-01-01T00:00:00Z", error: "timeout", retryable: false, retryNote: "Start a new scan from the website page." },
    ],
    integrations: [{ id: "postgres", name: "PostgreSQL", management: "deployment", configured: true, featureEnabled: true, lastCheck: null, lastSuccessAt: null }],
    serverErrors: { errors: [{ at: "2030-01-01T00:00:00Z", requestId: "req-1", method: "GET", route: "/api/v1/x", statusCode: 500, errorClass: "TypeError" }], totalSinceStart: 1, capacity: 100 },
    configurationWarnings: [{ severity: "info", message: "No email provider is integrated." }],
    adminEvents: [],
  };

  it("shows measured values, labels unknowns, and retries only eligible jobs", async () => {
    vi.mocked(api.apiAdminDiagnostics).mockResolvedValue(ok(diag));
    vi.mocked(api.apiAdminRetryJob).mockResolvedValue(ok({ kind: "analytics_outbox", result: { requeued: true } }));
    at(<ControlCenterPage />);
    const health = await screen.findByRole("region", { name: "Health" });
    expect(health.textContent).toMatch(/4 ms round trip/);
    expect(health.textContent).toMatch(/not running in this process/);
    expect(health.textContent).toMatch(/0 verified \/ 1 configured/);
    expect(screen.getByText(/Start a new scan from the website page/)).toBeTruthy();
    const retry = screen.getAllByRole("button", { name: "Retry" });
    expect(retry).toHaveLength(1);
    await userEvent.click(retry[0]);
    expect(api.apiAdminRetryJob).toHaveBeenCalledWith("analytics_outbox", "42");
    expect(await screen.findByText("The event was returned to the dispatch queue.")).toBeTruthy();
  });

  it("shows an error state with retry when diagnostics fail", async () => {
    vi.mocked(api.apiAdminDiagnostics).mockResolvedValueOnce(fail("INTERNAL_ERROR", "An unexpected error occurred")).mockResolvedValueOnce(ok(diag));
    at(<ControlCenterPage />);
    expect(await screen.findByText("Unable to load diagnostics")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("region", { name: "Health" })).toBeTruthy();
  });
});

describe("Reset password page", () => {
  const atPath = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/reset-password" element={<ResetPasswordPage />} /></Routes></MemoryRouter>);

  it("sets a new password with the token from the link", async () => {
    vi.mocked(api.apiConfirmPasswordReset).mockResolvedValue(ok({ message: "Your password has been changed." }));
    atPath("/reset-password?token=tok-abcdefghijklmnopqrstuvwxyz");
    await userEvent.type(screen.getByLabelText("New password"), "New-password-1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "New-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(api.apiConfirmPasswordReset).toHaveBeenCalledWith("tok-abcdefghijklmnopqrstuvwxyz", "New-password-1");
    expect((await screen.findByRole("status")).textContent).toMatch(/changed/);
  });

  it("checks that both passwords match before calling the server", async () => {
    atPath("/reset-password?token=tok-abcdefghijklmnopqrstuvwxyz");
    await userEvent.type(screen.getByLabelText("New password"), "New-password-1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "New-password-2");
    await userEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/do not match/);
    expect(api.apiConfirmPasswordReset).not.toHaveBeenCalled();
  });

  it("without a token, requests a link and shows the server's generic answer", async () => {
    vi.mocked(api.apiRequestPasswordReset).mockResolvedValue(ok({ message: "If an account exists for this email and email delivery is available, a reset link has been sent." }));
    atPath("/reset-password");
    await userEvent.type(screen.getByLabelText("Email"), "someone@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/If an account exists/);
  });
});
