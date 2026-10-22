# Known backend issues

## Fixed in this phase

| # | Defect | Evidence | Root cause | Change | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Every rate-limited response (429) had error code `ERROR`, so clients could not tell rate limiting apart from other failures | Seen while testing the new endpoint: the body was `{"code":"ERROR","message":"Rate limit exceeded…"}` | `@fastify/rate-limit` errors carry no `code`; the central handler fell back to `"ERROR"` | `middleware/error.ts` maps 429 to `RATE_LIMITED` (the plugin still sets `Retry-After`) | `admin-unit.test.ts` › central error handler |
| 2 | Passwords longer than 72 bytes were accepted at registration and silently truncated by bcrypt: two long passwords sharing their first 72 bytes were interchangeable | `registerSchema` only had `.min(8)`; bcrypt only uses 72 bytes | No upper bound | `passwordWithinBcryptLimit` is enforced at registration and password reset | `admin-unit.test.ts` (byte limit), `admin-control-center.integration.test.ts` (reset rejects 74 bytes) |
| 3 | The OpenRouter `HTTP-Referer` and the scanner `User-Agent` pointed to `zignaneural.com`, a misspelling and not the product's domain | `openrouter.ts`, `catalog.service.ts`, `scanner/fetch.ts` | Typo | Changed to `zigmaneural.com`. **Not changed:** the public verification identifiers (`zignaneural-site-verification` meta tag, `zignaneural-verify.txt`, `_zignaneural-verify` TXT record), because customers may already have deployed them. The migration lock key was not changed either, because changing it could let two releases' migrators run at once | None asserts the URL; existing scanner and verification tests still pass |
| 4 | AI credentials could only change through a redeploy, and a revoked key kept being used until then | `getOxAlphaExecutor` cached a single executor built from `config.OPENROUTER_API_KEY` | Static configuration | Keys resolve through the credential registry; the executor is rebuilt when the key changes | Integration: "stores a validated key…", "an outage keeps…" |
| 5 | Deactivating a user never revoked refresh tokens (`revokeAllUserTokens` had no caller) | Code search | There was no deactivation flow | Admin deactivation revokes all refresh tokens in the same transaction. Org routes already re-check `users.active` on every request | Integration: "deactivation revokes sessions…" |
| 6 | `users` had no last-login information | Schema | Not recorded | `users.last_login_at` (034), set on successful login | Integration: users list |

## Open (documented, not fixed in this phase)

| Issue | Impact | Why not fixed now | Suggested fix |
| --- | --- | --- | --- |
| The worker runs inside the web process (audit item P1-5) | A long crawl delays scheduling; web and worker cannot scale apart; diagnostics can only see the heartbeat of the process that answers | Architectural change; outside this phase | Separate worker process (`node dist/worker.js`) with a database heartbeat table |
| `GET /auth/me` (authenticate only) keeps working for up to 15 minutes after deactivation | Low: it returns only the caller's own id and email; all org and admin routes re-check `users.active` | Changing `authenticate` for every route adds a query per request | Optional: check `active` in `/me` too |
| Organization IDs are copied into the JWT (`orgIds`) | A removed membership stays in the token for up to 15 minutes. Harmless, because `requireOrgMember` re-checks membership in the database | — | None needed |
| Google API pacing is per process | Fine with one worker; scaling out can exceed Google quotas | Needs shared state | A rate limiter stored in PostgreSQL or Redis |
| No email provider | Password-reset links and alert emails cannot be delivered | Needs owner approval and credentials | Implement `platform/mailer.ts` (for example Resend, Postmark or SES) and add it to the registry with a validation call |
| Server errors are kept only in memory, per process | Lost on restart; other instances are not visible | A durable store or APM needs a decision | An APM service (Sentry or similar) with PII scrubbing, or an `error_events` table with retention |
| `oxfmt --check` fails on 279 files; there is no ESLint configuration | No automated style or lint gate | Mass formatting would touch every file and hide real diffs | Format in one dedicated, behaviour-free commit, then add `oxfmt --check` and an ESLint config to CI |
| Unreferenced tables and redundant indexes | Storage and write overhead only | Destructive; needs approval | See `UNUSED_CODE_AND_DATABASE_AUDIT.md` |
| Credentials recorded in `docs/STATUS_UPDATE.md` were never confirmed as rotated | Possible credential exposure | Only the owner can rotate them | Rotate them, then record the date |
