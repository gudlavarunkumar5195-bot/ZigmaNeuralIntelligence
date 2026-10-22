# Google Search Console integration

Read-only Search Console performance data (clicks, impressions, CTR, average position) for websites in an organization. This is Phase 3.

The integration is off until an operator configures it. Until then it reports which settings are missing, makes no Google call and shows no data.

## What an operator must set up (owner)

### 1. Google Cloud project

1. Create a Google Cloud project, or reuse one.
2. Enable the **Google Search Console API**.
3. Configure the **OAuth consent screen**:
   - user type: External (or Internal for a single Workspace)
   - app name and support email
   - scopes: `openid`, `email` and `https://www.googleapis.com/auth/webmasters.readonly`
4. While the app is in *Testing*, only listed test users can connect, and Google expires refresh tokens after 7 days. Users then see **Reauthorization required**. Publishing an app that uses a sensitive scope needs Google's verification.
5. Create an **OAuth client ID** of type *Web application*. Its **Authorized redirect URI** must match `GOOGLE_OAUTH_REDIRECT_URI` exactly:
   ```
   https://<your app host>/api/v1/integrations/google/oauth/callback
   ```

### 2. Server environment (names only; never commit values)

| Variable | Purpose |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client ID (secret in App Platform) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret (secret) |
| `GOOGLE_OAUTH_REDIRECT_URI` | Exact callback URL above; must be https in production |
| `APP_PUBLIC_URL` | Where the browser returns after OAuth. Defaults to the first `CORS_ORIGIN` |
| `INTEGRATION_ENCRYPTION_KEYS` | `k1:<base64 32 bytes>[,k2:...]`, used to encrypt stored refresh tokens (secret) |
| `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` | Optional. The key used for new writes (default: the last one listed) |
| `GSC_SYNC_INTERVAL_MINUTES` | Incremental sync interval per property (default 1440) |
| `GSC_INITIAL_LOOKBACK_DAYS` | First sync window (default 90, max 480) |
| `GSC_REVISIT_DAYS` | Recent days re-fetched on every sync (default 5) |
| `GSC_MAX_REQUESTS_PER_MINUTE` | Request pacing per Google connection (default 60) |
| `GSC_DATA_RETENTION_DAYS` | Daily observations kept (default 490, about 16 months) |
| `GSC_REQUEST_TIMEOUT_MS` | Per-request timeout (default 30000) |

Generate a key:
```bash
node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"
```

Production refuses to start in any of these cases:
- one OAuth variable is set but the others are not;
- the redirect URI is not https;
- the encryption keys are missing or malformed.

**Key rotation:**
1. Add `k2` and keep `k1` listed.
2. Set `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID=k2`.
3. Ask users to reconnect, or re-encrypt the rows.
4. Remove `k1` once no row uses it (`SELECT key_id, COUNT(*) FROM integrations GROUP BY 1`).

## How it works

- **Authorization** (owner/admin):
  - **Connect** sends the browser to Google's consent screen. The request uses authorization code + PKCE S256, `access_type=offline` and `prompt=consent`.
  - The `state` is single-use and lasts 10 minutes. It is bound to the browser by an httpOnly, SameSite=Lax cookie scoped to the callback path, and only its hash is stored.
  - The callback re-checks that the user is still an owner or admin and requires the read-only Search Console scope. If the user unticked it, whatever they did grant is revoked.
  - The callback redirects only to `APP_PUBLIC_URL`.
- **Credentials:**
  - The refresh token is encrypted with AES-256-GCM, bound to the organization and connection.
  - Access tokens live in server memory only.
  - Nothing secret reaches the browser or the logs.
  - A revoked or expired grant (`invalid_grant`) marks the connection **Reauthorization required**, and syncing pauses until someone reconnects.
- **Properties:**
  - Properties are listed live from Google.
  - A property can be linked only if:
    - the website is verified in ZigmaNeural (Google permission does not replace this);
    - the property covers the website's URL: a Domain property covers the domain and its subdomains, and a URL-prefix property must match scheme, host, port and path exactly;
    - the Google account can read its data (`siteOwner`, `siteFullUser` or `siteRestrictedUser`).
- **Sync:**
  - Each job is split into units: one dimension set times one Pacific Time day. The sets are total, query, page, country, device and searchAppearance.
  - Each unit is a single-day query with `dataState=all`, paged by 25,000 rows up to Google's 50,000 rows per day. Hitting that limit is recorded as `truncated`.
  - Jobs run in 20-second slices of the worker loop, so scans and monitoring keep running.
  - Each unit is a checkpoint. After a crash, the lease expires and another worker resumes from there.
  - Each property has at most one queued or running job, so duplicate requests share it.
- **Never losing good data:**
  - A day is replaced in a single transaction, and only after its fetch completed.
  - A complete but empty answer for a day that already has data keeps the stored data (`kept_previous`).
  - Failed fetches write nothing.
- **Failures:**

  | Failure | What happens |
  | --- | --- |
  | 401 | Refresh once and retry, then require reauthorization |
  | 403 on a property | The link is marked **access lost** |
  | 429 or quota 403 | The job pauses for `Retry-After` or 15 minutes (Google's advice), up to 12 times, then ends `partial` |
  | 5xx, timeouts | Retried with bounded, jittered backoff (3 attempts), then that unit is marked failed |

  A job with some failed units ends `partial`. Only a `completed` job advances "last successful sync".
- **Schedule:**
  - Every `GSC_SYNC_INTERVAL_MINUTES` (default daily), the worker queues an incremental sync from the last synced day minus `GSC_REVISIT_DAYS`, through yesterday (PT).
  - Google typically publishes data 2–3 days late and marks recent days incomplete. Those days are stored as `fresh` and re-fetched later.
  - No timing guarantee is made beyond what Google provides.
- **Quota assumptions:**
  - Google allows 1,200 Search Analytics queries per minute per site and per user, plus short- and long-term load limits.
  - We pace each connection to 60 per minute by default.
  - A 90-day initial sync is about 540 single-day queries (more if pages exceed 25,000 rows), which takes about 9 minutes at the default pace.

## Storage, retention, deletion

- **Storage:** PostgreSQL only.
  - Tables: `integrations`, `gsc_properties`, `gsc_sync_jobs`, `gsc_sync_units`, `gsc_coverage`, `gsc_search_daily` (migration 032).
  - ClickHouse is not verified in production, so it is not used. `gsc_search_daily` (property, set, day, value, metrics) can be copied there later through the existing outbox pattern.
- **Retention:** observations older than `GSC_DATA_RETENTION_DAYS` are deleted hourly, in bounded batches.
- **Unlinking a website** deletes its stored data and jobs.
- **Disconnecting a Google account:**
  1. Revokes the token at Google (best effort; the UI says if revocation failed).
  2. Deletes the credential.
  3. Deletes every property linked through that account, with its jobs and stored data.

## What the data does and does not mean

- **Coverage per day:** missing days (never fetched) are shown as missing, not as zero. A fully fetched day with no row in the property total is a real zero.
- **Rare queries are omitted.** Google returns top rows only and drops rare and anonymized queries, so query and page sums can be lower than the property totals.
- **Absent query or page values.** For a single query or page, a day without a row is "not returned" (unknown), not zero.
- **Range metrics.** Range CTR is clicks ÷ impressions. Range position is the impression-weighted average of daily positions.
- **Search type.** Only web search is synced; image, video, news and Discover are not.
- **Filters.** Performance filters accept one dimension at a time, because combined dimensions are not stored.

## API

| Method | Path | Role |
| --- | --- | --- |
| GET | `/api/v1/integrations` | member |
| POST | `/api/v1/integrations/google/oauth/start` `{returnTo}` | owner/admin |
| GET | `/api/v1/integrations/google/oauth/callback` | public (state + cookie) |
| GET | `/api/v1/integrations/:id/properties` | owner/admin |
| DELETE | `/api/v1/integrations/:id` | owner/admin |
| GET | `/api/v1/websites/:id/search-console` | member |
| PUT / DELETE | `/api/v1/websites/:id/search-console` | owner/admin |
| POST | `/api/v1/websites/:id/search-console/sync` `{from?, to?}` | member+ |
| GET | `/api/v1/websites/:id/search-console/sync-jobs` (`/:jobId/failures`) | member |
| POST | `/api/v1/websites/:id/search-console/sync-jobs/:jobId/cancel` | member+ |
| GET | `/api/v1/websites/:id/search-console/performance?from&to[&compareFrom&compareTo][&query\|page\|country\|device\|searchAppearance]` | member |
| GET | `/api/v1/websites/:id/search-console/top/:dimension?from&to&sort&order&search&limit&cursor` | member |

Every route is organization-scoped: another organization's ids return 404.

## Staging verification (opt-in, owner, real Google account)

CI never calls Google; it uses a mocked Google. To verify against Google, use a staging app with its own OAuth client and a Search Console property you own. Only read-only calls are made, and they are free within quota.

1. Set the variables above on staging. Check that the staging Integrations page no longer says "Not configured on this server".
2. Click **Connect Google Search Console** and approve. Expect "Google Search Console connected" and your Google email listed.
3. Cancel a second attempt on Google's screen. Expect "You cancelled the Google sign-in".
4. **Load Search Console properties**. Your properties should appear with the correct type and permission.
5. Link a property to a verified website that it covers.
   - Linking a property that does not cover the site must fail with the "does not cover" message.
6. On **Search performance**, wait for the initial sync. Check that:
   - it reaches *completed* or *partial*;
   - totals for a past week match the Search Console UI for the same dates (web search, PT), allowing for Google's own rounding;
   - preliminary days are labelled.
7. Remove the app's access at myaccount.google.com, then click **Sync now**. Expect *Reauthorization required*, then reconnect.
8. **Disconnect**. Confirm the account and its data are gone, and that Google shows the access removed.

Record the date, the person, and the results.
