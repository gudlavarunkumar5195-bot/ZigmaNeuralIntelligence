# Release runbook: CI gate, migrations, staging, credentials

This file is the operating procedure for shipping `main`. It covers branch protection, the deploy gate, migrations, staging checks and credential hygiene.

Nothing in it has been run against production. Every step marked **owner** needs a named person and a recorded result.

## 1. Make CI block merges (owner, GitHub admin)

CI (`.github/workflows/ci.yml`) runs on every pull request and on every push to `main`. It only *blocks* a merge once `main` requires it, and repository settings can't be changed from this repository's code. A repository admin sets this once.

GitHub → **Settings → Rules → Rulesets → New branch ruleset**:

| Setting | Value |
| --- | --- |
| Name | `main protection` |
| Enforcement status | Active |
| Target branches | Include default branch (`main`) |
| Restrict deletions | On |
| Block force pushes | On |
| Require a pull request before merging | On (1 approval if there is a second reviewer, otherwise 0) |
| Require status checks to pass | On |
| Required checks | `Type check, test, build, audit` and `Browser smoke tests` (source: GitHub Actions) |
| Require branches to be up to date before merging | On |
| Bypass list | Empty |

Classic branch protection (**Settings → Branches → Add rule** for `main`) with the same options works too.

To check it: open a PR that breaks a test. The merge button must stay disabled until CI is green.

## 2. Deploy only after CI (owner)

- `app.yaml` has `deploy_on_push: false` for the web service and the migration job. App Platform can't wait for a GitHub check, so automatic deploys would ship commits CI never passed.
- To release:
  1. Merge the PR into `main` once CI is green.
  2. Wait for the `push` run on `main` to go green.
  3. Deploy that commit from App Platform (**Actions → Deploy**).
- Only turn `deploy_on_push` back on once (a) section 1 is enforced and (b) every change reaches `main` through a PR. Even then, a red post-merge run on `main` would still deploy.

## 3. Migrations: once per release, direct connection

- The App Platform `migrate` job (`kind: PRE_DEPLOY`) runs `pnpm --dir server migrate:prod` once per deployment, before new web instances start. The web `run_command` only starts the server and never migrates.
- `Procfile` keeps a `release:` line for Procfile-based platforms, which also run it once per release. App Platform uses `app.yaml` and ignores it.
- The migrator prefers `DIRECT_DATABASE_URL` (Neon's non-pooled endpoint) and falls back to `DATABASE_URL`. It logs only which variable it used. DDL should not go through the `-pooler` endpoint.
- Every migration runs in its own transaction under an advisory lock. An edited applied migration aborts the run. Never edit or delete an applied migration file; add a new numbered one.
- **Privilege separation (pending, audit P1-3).**
  - Today: the web `DATABASE_URL` and the migration connection are typically the same Neon owner role.
  - Target: the migration job uses the owner role through `DIRECT_DATABASE_URL`. The web service uses a separate least-privilege role (DML only, no DDL, not the table owner) through `DATABASE_URL`.
  - This needs grant migrations and an RLS review, so it is a separate change. Until then, keep the owner credentials only in the two App Platform secrets.

What CI proves on every PR (step "Migration safety", `server/scripts/verify-migrations.mjs`, local throwaway PostgreSQL 16 only):

1. A role **without** `CREATEROLE` stops at `000` with the message "lacks CREATEROLE … CREATE ROLE … NOLOGIN" and applies nothing.
2. A Neon-like owner (`LOGIN CREATEDB CREATEROLE`, **not** superuser) migrates a fresh database from zero to latest. A second run is a no-op. `000` creates only `NOLOGIN` roles with no table grants.
3. An upgrade from `1ca145b` (migrations 001-026, the schema before Phase 1) and from the PR's base branch applies only the new versions. Every checksum stays intact, and the schema matches a fresh install.

## 4. Staging verification (owner, before each production release)

Use a **Neon branch** created from production (or an empty staging project), never production itself.

1. Point the staging app's `DATABASE_URL` / `DIRECT_DATABASE_URL` secrets at the branch, and deploy the release commit to the staging app.
2. Read the `migrate` job log. Expect `[migrate] Using DIRECT_DATABASE_URL connection.` and then:
   - **First deploy of Phase 1 on an existing database:** `000`, `027`, `028`, `029` and `030` are applied, and everything else is skipped.
   - **Fresh database:** everything is applied.
   - The job must run **once**. The web logs must contain no `[migrate]` lines.
3. If `000` fails with "lacks CREATEROLE", a Neon admin runs `CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;` once, then redeploys. On Neon the default owner role normally has `CREATEROLE`; this is unverified on the real project.
4. If the `028` log contains `scans_one_active_per_website NOT created`:
   - Finish or cancel the duplicate active scans.
   - Add the index in a new migration.
   - The app-level guard and `Idempotency-Key` still apply meanwhile.
5. Run the integration suite against a **separate throwaway** Neon branch, never production:
   ```bash
   RUN_INTEGRATION=1 TEST_DATABASE_URL='<throwaway branch URL>' pnpm --dir server test
   ```
6. Functional checks on staging:
   - `/ready` returns 200.
   - Verifying a site through a cross-host redirect fails.
   - A double-submitted scan returns the same scan.
   - Killing the worker mid-scan requeues the scan, and the final finding count is exact.
   - With no `OPENROUTER_API_KEY`, scans complete and intelligence shows unavailable.
   - `AI_ALLOW_PAID_MODELS` stays unset/false.
7. Record the Neon point-in-time restore window. Take a branch or snapshot before the production deploy.

Rollback: the migrations are additive. A rollback build must still contain every migration file the database has applied (the runner aborts on a missing file). So roll back application code, never migration files.

## 5. Credentials (owner)

`docs/STATUS_UPDATE.md` (7 Oct 2026) records that database, ClickHouse and GitHub credentials were shared in chat. Nobody has confirmed they were rotated. Removing a file from `HEAD` doesn't remove it from git history.

| Item | Action | Status |
| --- | --- | --- |
| Neon database password(s) shared in chat | Reset the role password in Neon, then update App Platform secrets | Owner must confirm |
| ClickHouse Cloud password shared in chat | Rotate it in ClickHouse Cloud, then update `CLICKHOUSE_PASSWORD` | Owner must confirm |
| GitHub token used for an earlier push | Revoke it (GitHub → Settings → Developer settings → Tokens) | Owner must confirm |
| Supabase project id + anon key, formerly in `utils/supabase/info.tsx` (still in history) | If the Supabase project still exists, rotate its keys or delete the project | Owner must confirm |

Repository checks:
- Run `git grep -nE 'eyJ[A-Za-z0-9_-]{20,}|sk-or-v1-|ghp_|github_pat_|AKIA[0-9A-Z]{16}' -- . ':!*pnpm-lock.yaml' ':!docs/RELEASE_RUNBOOK.md'` on `HEAD`. Expect no matches. Lockfile integrity hashes can contain look-alike substrings.
- Test fixtures use obviously fake values (for example `pw-should-never-leak`).

`.zigma-agent/` holds Claude Agent SDK orchestration scripts and an audit report. The scripts include an implementation agent with write and shell tools and a hard-coded Codespaces path. They are tooling, not application code, and nothing imports them, so they were **not** deleted. The owner should decide whether to move them to a separate repository, as the audit recommends.
