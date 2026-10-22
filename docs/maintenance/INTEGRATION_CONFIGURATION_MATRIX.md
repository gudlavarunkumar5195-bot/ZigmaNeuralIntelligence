# Integration configuration matrix

The single source of status is `GET /api/v1/admin/integrations`, backed by `server/src/platform/integrations.ts`. Feature modules get provider secrets from `resolveSecret()` in `server/src/platform/credential-store.ts`, and ask whether a capability is available with `capabilityAvailable()`. They never read provider keys from their own tables or ask the administrator again.

| Integration | Managed | Configuration | Validation (cost) | Capabilities / features | Without it |
| --- | --- | --- | --- | --- | --- |
| OpenRouter (AI) | **Admin → Integrations & API Keys** (encrypted in `platform_credentials`). Fallback: `OPENROUTER_API_KEY` | API key from openrouter.ai → Settings → Keys | `GET https://openrouter.ai/api/v1/key` (free, no model call). Distinguishes invalid (401), insufficient credits (402), permission (403), rate limit (429), outage (5xx), timeout and network failure | `ai_analysis` (scan intelligence, keyword prioritization), `model_catalog` | AI features show "not configured"; deterministic features keep working |
| Google OAuth client | Deployment: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, plus `INTEGRATION_ENCRYPTION_KEYS` | Google Cloud Console → APIs & Services → Credentials (Web client); consent screen with the `webmasters.readonly` scope | Token-endpoint probe with a code that cannot exist: Google answers `invalid_grant` only for an authenticated client, `invalid_client` otherwise. No user data, no cost | `search_console_connect` | Organizations cannot connect Search Console |
| Google Search Console connections | Per organization, OAuth (Settings → Integrations) | Each organization connects its own Google account | Per connection, during sync (`invalid_grant` → reauthorization required) | `search_performance`, `keyword_research_first_party` | Search performance and keyword research have no data |
| Credential encryption key ring | Deployment: `INTEGRATION_ENCRYPTION_KEYS`, `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` | `k1:<base64 32 bytes>[,k2:…]` | Local encrypt/decrypt self-test | `credential_storage` | No provider key or Google connection can be stored. Saving returns `503 ENCRYPTION_NOT_CONFIGURED`; nothing is ever stored in plaintext |
| PostgreSQL | Deployment: `DATABASE_URL` (`DIRECT_DATABASE_URL` for migrations), `DB_SSL_*` | Neon or any PostgreSQL 14+ | `testPostgres()`: DNS, TLS, auth, query, timing | Everything | The app does not start |
| ClickHouse | Deployment: `CLICKHOUSE_HOST`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_CA_CERT` | ClickHouse Cloud or self-hosted, HTTPS | `testClickHouse("connection")`: DNS, TLS (certificate is always verified), auth, query | `analytics_events` (outbox dispatch) | Events stay in the PostgreSQL outbox; analytics pages read PostgreSQL |
| Transactional email | **Not implemented** | — | — | Password-reset links, alert emails | Reset links cannot be delivered (`EMAIL_NOT_CONFIGURED`); notification deliveries are marked FAILED with the reason |
| Licensed keyword / SERP / backlink data | **Not implemented** | Needs approval (paid) | — | Volume, difficulty, CPC, rankings, backlinks, competitor discovery | Shown as unsupported, never estimated |
| Anthropic, Sarvam, other AI providers | **Not implemented** (only OpenRouter exists in the server) | — | — | — | — |

## Deployment-managed secrets: how to change them

The application cannot change its host's environment. In DigitalOcean App Platform:
1. Go to App → Settings → the component → Environment Variables.
2. Set the value as an **encrypted** variable.
3. Save. This triggers a redeploy.
4. Open Admin → Integrations & API Keys and press **Test** to verify.

Never put these values in `VITE_*` variables, in the repository, or in chat.
