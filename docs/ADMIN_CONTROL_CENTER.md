# Admin Control Center

Platform administration: overview and diagnostics, integration credentials, and user administration. Only **platform administrators** can use it: the users whose UUIDs are listed in `PLATFORM_ADMIN_USER_IDS`, whose accounts are still active. Organization owners and admins cannot.

Design decisions and scope: `docs/maintenance/ADMIN_CONTROL_CENTER_PLAN.md`. Integration details: `docs/maintenance/INTEGRATION_CONFIGURATION_MATRIX.md`.

## Pages

| Page | What it shows / does |
| --- | --- |
| Administration → **Control Center** (`/admin/control-center`) | API, database round trip, migration status, worker heartbeat (of the answering process), job counts and failures (7 days), recent server errors (this process), configuration warnings, recent admin events. Actions: re-run checks, retry an eligible job (Search Console sync, dead-lettered analytics event), copy an error reference, export a redacted report |
| Administration → **Integrations & API Keys** (`/admin/integrations`) | Every integration in the codebase, with how it is managed, configuration and credential status (masked), last check and last success, capabilities, and a link to the provider's setup page. OpenRouter: save and validate, test, enable or disable, remove. Deployment-managed integrations: test only. Encryption: re-encrypt with the active key |
| Administration → **Users & Access** (`/admin/users`) | Search and filter users; see organizations and roles, status, creation date, last sign-in and active sessions; activate or deactivate; change roles (the last owner of an organization is protected); revoke sessions; send a password-reset link; **Generate Login Credentials** for the designated account |
| `/reset-password` (public) | Request a reset link (same answer whether or not the email exists), or set a new password from a link |

## Credential storage

- **Algorithm.** AES-256-GCM, with a fresh 12-byte IV per encryption and an authentication tag. Associated data binds each ciphertext to its record (`platform:openrouter`; `integration:google_search_console:<org>:<id>`). Tampered or moved ciphertext fails to decrypt (tested).
- **Key.** `INTEGRATION_ENCRYPTION_KEYS` lives in the deployment environment, never in the database or the repository. The database holds only `secret_enc`, the key id and the last 4 characters.
- **Never returned.** No API response contains a stored secret, only `••••<last 4>`. Audit events record the provider and suffix only. Request logs never include bodies, and diagnostic exports are redacted.
- **No key ring, no storage.** Without a key ring, saving fails with `ENCRYPTION_NOT_CONFIGURED`. There is no plaintext fallback.

### Key rotation

1. Generate a new key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Set `INTEGRATION_ENCRYPTION_KEYS=k1:<old>,k2:<new>` and `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID=k2`, then redeploy. Old values still decrypt, and new writes use `k2`.
3. In Integrations & API Keys → Credential encryption key ring, press **Re-encrypt with active key**. Platform credentials and Google refresh tokens are re-encrypted, and the result reports how many were re-encrypted and how many failed.
4. Only when it reports `failed 0`, remove `k1` and redeploy.

### Recovery

If the key ring is lost, stored credentials cannot be decrypted. The page shows "cannot be decrypted with the configured encryption keys".
- Re-enter the OpenRouter key in the admin page.
- Each organization reconnects Google in Settings → Integrations.

Back up the key ring in a password manager or secret store, separately from database backups. A database backup alone never exposes plaintext credentials.

## Credential validation

| Outcome | Stored? | Previous key | Message |
| --- | --- | --- | --- |
| Provider accepts | Yes (encrypted), enabled, effective immediately | Replaced | "Verified and activated" with capabilities |
| Invalid key (401) | No | Kept | "Rejected by provider … create a new key" |
| Insufficient credits (402) | No | Kept | "Quota exhausted …" |
| Permission (403) / rate limit (429) | No | Kept | Specific reason |
| Outage (5xx), timeout, network | No (HTTP 503) | Kept | "The key was not judged; try again later" |
| No encryption key ring | No (HTTP 503) | Kept | `ENCRYPTION_NOT_CONFIGURED` |

Stored keys are re-checked at startup and every 6 hours. A provider rejection stops the key being used and is shown on the page. An outage or quota problem keeps the key in use and records the result. Nothing ever deletes a key automatically.

## Generate Login Credentials

For one account only: `ADMIN_CREDENTIAL_ACCOUNT_EMAIL` (default `info@zigmaneural.com`). The email field is locked in the UI, and the server rejects any other address.

- **Account does not exist.** It is created through the normal registration path: a user, an organization named "ZigmaNeural", and an owner membership.
- **Account exists.** The server answers `409 CONFIRMATION_REQUIRED`. After confirmation it replaces the password, burns outstanding reset tokens and revokes all refresh tokens. Sessions end; access tokens expire within 15 minutes.
- **The password.** 20 characters from `crypto.randomInt`, with every character class and no look-alike characters, about 120 bits. It is stored as a bcrypt hash at cost 12.
  - It is returned once, with `Cache-Control: no-store`.
  - It is shown in a panel with **Copy Password** and a warning, and cleared on Hide, after 5 minutes, or on navigation.
  - It is never logged, audited, persisted in plaintext, or written to browser storage.
- **Safety.**
  - Platform admins only.
  - 10 requests per 15 minutes per admin session.
  - Requests are serialized by a database lock, and a second generation within 15 seconds is refused (double clicks).
  - In production it is refused unless the request arrived over HTTPS (`TRUST_PROXY` must be set behind the load balancer).
- **Audit.** `admin_credentials_generated`, with `created` and `revokedSessions` only.

An existing password can never be viewed: only bcrypt hashes are stored.

## Password reset

Tokens are 32 random bytes, stored only as a SHA-256 hash. They expire after 30 minutes and are single-use. Using one sets the new bcrypt hash, burns every outstanding token for that user and revokes all sessions. Administrators can send a reset link but never see the token.

**Email delivery is not implemented.** Until a provider is added to `server/src/platform/mailer.ts`:
- **Self-service request:** returns the same generic `202` and sends nothing.
- **Admin "Send password-reset link":** returns `503 EMAIL_NOT_CONFIGURED` and creates no token.

Use Generate Login Credentials for the designated account, or reactivate and coordinate out of band.

## Administrator safety

- Admins cannot deactivate themselves.
- The last active platform administrator cannot be deactivated (defense in depth below the API).
- An organization always keeps an active owner, enforced under a row lock.
- Every change requires a `confirm: true` body. The UI asks first.
- Every change is audited (`admin_*` actions) with the actor, the target, and the organization where relevant.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLATFORM_ADMIN_USER_IDS` | empty (nobody) | Comma-separated user UUIDs of platform administrators |
| `INTEGRATION_ENCRYPTION_KEYS` | unset | Key ring for stored credentials (see rotation) |
| `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` | last key | Key used for new writes |
| `ADMIN_CREDENTIAL_ACCOUNT_EMAIL` | `info@zigmaneural.com` | The only account Generate Login Credentials may create or reset |
| `OPENROUTER_API_KEY` | unset | Optional fallback when no admin-managed key is stored |
| `APP_PUBLIC_URL` | first `CORS_ORIGIN` | Base of reset links (once email exists) |
| `TRUST_PROXY` | off | Must be set (e.g. `1`) behind App Platform so HTTPS and client IPs are detected |

## Rollback

- **Code.** Revert the branch's merge commit. Migration 034 only adds objects, so older code keeps working with it in place.
- **Database.** Do not drop the 034 objects in a hurry: `platform_credentials` may hold the only copy of an admin-entered key. If they must go, first note the stored providers, then use a new numbered migration:
  ```sql
  DROP TABLE platform_credentials, platform_integration_checks, password_reset_tokens;
  ALTER TABLE users DROP COLUMN last_login_at;
  ```
  Never edit 034.
- **Credentials.** After a rollback, AI uses `OPENROUTER_API_KEY` again. Set it in the environment if the key only existed in the admin store.
