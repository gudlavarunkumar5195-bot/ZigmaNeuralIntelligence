# Route and API acceptance matrix (Phase 10)

How each user journey was accepted. The full route-to-endpoint mapping is in `docs/INTEGRATION_MATRIX.md`; this file records the acceptance status and evidence.

**Status**
- **PASS:** verified by an executed test against the real API and a migrated, seeded PostgreSQL database.
- **PARTIAL:** some behaviour was verified; the gaps are listed.
- **BLOCKED:** cannot be verified without a provider, credentials or an environment.
- **NOT IMPLEMENTED:** the capability does not exist.

**Suites**
- **R:** `pnpm test:e2e:integration` (24 tests, real API and database).
- **S:** `pnpm test:e2e` (5 signed-out smoke tests).
- **U:** frontend unit tests with the API mocked at the client boundary.
- **I:** server integration tests (real PostgreSQL).

| Journey / route | Status | Evidence | Gaps |
| --- | --- | --- | --- |
| Sign in, reload, sign out | PASS | R `session.spec`: "sign in, see real data, survive a browser refresh, sign out"; S `auth.spec` | — |
| Session expiry and renewal | PASS | R: expired access token renewed; unrenewable session goes to sign-in and back. I `session-hardening` (rotation grace, reuse is theft). U `api-refresh` (multi-tab retry) | — |
| Unauthorized and deep-link access | PASS | S: protected routes redirect signed-out visitors. R: deep link returns after sign-in | — |
| Role restrictions | PASS | R: a viewer's change is refused and the record is unchanged; a member is refused alert rules. I `http-rbac-tenancy` (each role against each mutation) | — |
| Cross-tenant access | PASS | R: another org's scan and website are invisible (UI and direct API). I `http-rbac-tenancy` (org header, ids of other tenants) | Database RLS is not a backstop (SECURITY-FINDINGS TEN-02) |
| Websites: list, add (validation), ownership | PARTIAL | R: list; invalid or private URL rejected with no request sent. U: add and verify flows | Real ownership verification and duplicate handling are not run end to end (they fetch the site) |
| Dashboard (`/`) | PASS | R route smoke; U KPIs, stale-website notice, history bounds. Measured: bounded payload | — |
| Scan start, progress, cancel | PARTIAL | U: polling backoff, 4xx stop, cancel confirmation. I: scan lifecycle, leases, recovery | Starting a real scan fetches external sites, so it is not run in E2E |
| Technical health | PASS | R: stored crawl issues shown; ignore with reason and reopen, persisted | Starting a crawl (external fetch) |
| Keyword research and gap | PARTIAL | R: saved lists (remove, delete). U: research views | Running research is BLOCKED (needs Search Console data) |
| Rank tracking | PARTIAL | R: create project, add keywords, pause (persisted). U: other tabs | Scheduled collection BLOCKED (no SERP provider) |
| Backlinks | PASS | R: CSV export with formula cells neutralized. U: import, gap, changes | Live link checks fetch external pages |
| Content | PARTIAL | R: create topic (persisted). U: audit, opportunities, briefs | AI brief suggestions BLOCKED (OpenRouter) |
| AI visibility | PARTIAL | R: brand creation (domain validation), re-matching. U: imports and metrics | Provider runs BLOCKED (OpenRouter key; web search off) |
| SEO workspace (date range across widgets) | PARTIAL | R route smoke. U: range controls and stale responses. I `seo-workspace` (range resolution, rules). Measured: bounded concurrency | Reconciling widgets with their source records was tested at service level (I), not in the browser |
| Monitoring, alert rules, alerts | PASS | R: alert resolved once and persisted; rules added and persisted; member refused | "Run now" starts a real scan |
| Reports and exports | PARTIAL | R: backlink CSV. U: workspace downloads. I: export formula safety per module | Print-to-PDF is manual |
| Settings and integrations | PARTIAL | R: Search Console unlink with confirmation | Connecting Google BLOCKED (OAuth credentials) |
| Administration | PASS | R: audit log; model disable and enable as platform admin. I `admin-control-center` | — |
| All 45 navigable routes | PASS | R `z-route-smoke`: no crash, one `h1`, no horizontal overflow, no page errors, and no serious or critical axe-core WCAG 2.2 A/AA violations | Automated scanning is not full WCAG conformance; manual screen-reader review was not done |
| Password reset email | BLOCKED | Token flow covered by I | No email provider configured |
| Accessibility, certificates, domains, client reports, AI control center, model benchmarks, testing (3 routes) | NOT IMPLEMENTED | Labelled N/A; the route smoke confirms they render honestly | — |
