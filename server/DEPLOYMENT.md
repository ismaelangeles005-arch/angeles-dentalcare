# MAELVEN Dental: deployment foundation

No provider is selected and nothing is deployed by this block. Do not use real
patient information for an external review until access and backups are validated.

## Recommended architecture

Browser -> HTTPS -> MAELVEN Dental Web/API -> verified TLS -> PostgreSQL

Web/API -> private persistent patient-file volume

Prefer one origin with `/api` routed to Node. Electron and Docker Desktop are not
required on reviewers' machines. Terminate HTTPS at a controlled reverse proxy.

## Public API configuration

`api.js` reads `window.MAELVEN_WEB_CONFIG` before initialization:

1. Explicit `apiBase` wins: `/api` or an absolute HTTPS API URL ending in `/api`.
2. Explicit `environment: "development"` permits the existing localStorage
   `apiUrl` override, then falls back to `http://127.0.0.1:3001/api`.
3. Otherwise `/api` is used, regardless of hostname or stale localStorage values.

`npm run web` / the loopback-only frontend server supplies development mode in
the served `api.js`; no HTML changes are needed. This preserves the local Electron
development flow too. Other static development servers must supply the public
configuration themselves. Same-origin production requires no configuration.

For an explicitly separate API, the dedicated web artifact may prepend:

```js
window.MAELVEN_WEB_CONFIG = { apiBase: "https://api.example.com/api" };
```

No secrets belong here. HTTP absolute APIs are accepted only in explicit development
mode. Credentials, query parameters and fragments in the API URL are rejected.
Different origins still need exact CLIENT_ORIGIN and cookies. Different sites
remain outside this block: SameSite=Strict has deliberately not been changed.

## Server environment

Required for web production:

- `NODE_ENV=production` (enables Secure session cookies and storage checks).
- `DATABASE_URL`: private connection URL supplied by the operator, not committed.
- `JWT_SECRET`: independently generated secret of at least 32 characters.
- `CLIENT_ORIGIN`: exact HTTPS frontend origin(s), comma-separated; never `*`.
- `PATIENT_FILES_DIR`: absolute existing readable/writable private persistent directory.
- `PG_TLS=verify-full`: explicitly recommended for remote production.

Optional:

- `PORT` (3001), `JWT_EXPIRES_IN` (8h; cookie currently remains eight hours).
- `PIN_LOOKUP_SECRET` (fallback JWT_SECRET); keep stable or existing PIN lookups
  will no longer match. `PIN_MAX_ATTEMPTS` (5), `PIN_LOCK_SECONDS` (30).
- `PG_TLS_CA_FILE`: path to provider/operator CA PEM, otherwise system trust roots.
- `PG_POOL_MAX` (10), `PG_CONNECTION_TIMEOUT_MS` (10000), `PG_IDLE_TIMEOUT_MS` (30000).
- `TRUST_PROXY`: false by default; explicit proxy IPs or CIDRs only.
  Hop counts and blanket `true` are rejected. Prevent bypass of the chosen proxy.
- `FRONTEND_ROOT`: dedicated public artifact or empty for API-only deployment.

Remote production verifies certificates and cannot set PG_TLS=disable. Local
loopback PostgreSQL keeps TLS disabled by default for compatibility with existing
development/desktop use. TLS can also be enabled explicitly for local databases.
SSL connection-string options are rejected to avoid overriding certificate
verification: use PG_TLS and PG_TLS_CA_FILE instead. No DB connection is made
until the pool is used. These settings do not edit the existing `.env`.

## Public artifact and CSP

Do not publish the repository. Copy only the existing public frontend assets to a
dedicated directory during a later deployment step. Production validates against
the existing public filenames, rejects symlinks, internal directories, ancestors
of the repo, unknown files and overlap with private storage. This is a startup
check: keep that artifact read-only at runtime. The local public list is unchanged.

With FRONTEND_ROOT, production sends Helmet's CSP baseline in **report-only** mode
to preserve existing inline scripts/handlers. This is not an enforced XSS defense.
An enforced compatible CSP and third-party resource review remain release tasks.
API-only mode retains Helmet's normal enforced baseline. Development retains its
previous CSP behavior; no desktop files are changed.

## Initialization and order (fresh database certified)

From the project root, with psql installed and DATABASE_URL exported:

```powershell
npm run database:migrate
```

The script does not load server/.env. It applies schema.sql followed by the exact
24-file order in `database/migrations.json`; missing/duplicate files fail closed.
ON_ERROR_STOP and every native exit code are checked. A configured DATABASE_URL
never falls back to the local Docker database. No SQL was changed.

For remote psql, also export libpq `PGSSLMODE=verify-full` and, when needed,
`PGSSLROOTCERT` pointing to the CA PEM. PG_TLS/PG_TLS_CA_FILE configure Node only,
not psql. These commands are documentation for later authorized execution.

Key dependencies checked against all 24 files:

- schema creates the base organizations/users/patients/appointments/clinical tables;
- users soft-delete and password-change columns before provisioning;
- patient profiles before timezone; assignments/files and visits before org backfill;
- procedures_billing before billing_statuses and billing_payments_discounts;
- billing payments before organizations_multi_mode (its ALTER/backfill uses them);
- head_admin before organizations_multi_mode (the latter restores expanded roles);
- organizations before PIN/odontology; evolution before clinical_record_upgrade;
- procedures and clinical tables before odontogram; plans before acceptances.

The old alphabetical order was invalid on an empty DB because billing tables are
not in schema.sql and were altered before procedures_billing created them.
The manifest resolves dependencies without renaming or editing historical SQL.

This is a certified **fresh initialization path**, not a migration ledger.
Do not replay blindly over existing data. In particular short_patient_codes
rewrites patient codes, head_admin temporarily narrows roles, and multiple files
perform backfills. IF NOT EXISTS does not make all data operations idempotent.
Failure stops subsequent files but does not undo previously committed statements.
A versioned upgrade strategy for existing databases remains pending.
Legacy setup-db-docker.bat is not the deployment entry point.

### Fresh database certification

Verdict: **FRESH DATABASE CERTIFIED**. Scope: **fresh initialization from an empty
PostgreSQL database** only.

The isolated PostgreSQL 18.4 certification applied schema.sql and all 24 migrations
to an empty database, producing 21 tables and 70 indexes. Provisioning and its
idempotency passed. The QA backend returned health 200, auth 200 and API smoke 200;
QA storage was valid and cleanup completed.

This does not certify upgrades of existing databases, cloud production, real HTTPS,
the definitive enforced CSP, cloud backup/restore or complete multi-tenant isolation.

## Provision review access (validated during fresh database certification)

The development seed is blocked when NODE_ENV=production, without an override.
Do not use it on shared review databases, even with NODE_ENV=development.

Temporarily supply REVIEW_ORGANIZATION_NAME, REVIEW_ADMIN_USERNAME,
REVIEW_ADMIN_NAME, REVIEW_ADMIN_PASSWORD and optionally REVIEW_ADMIN_ROLE
(`admin` default or `head_admin`). Username is lowercase and globally unique in
the existing model. Password: 12-200 characters, letters, numbers and a symbol,
also checked with the existing password policy. Do not store it in source/history.

From `server/`:

```text
node scripts/provision-review.js --validate-only
node scripts/provision-review.js
```

Validation-only does not load the DB module. Execution uses bcrypt cost 12 and
one transaction with an advisory lock. It reuses an active organization by name,
or creates a CLINIC, and inserts the admin with organization_id and required first
password change. Existing matching active accounts are left entirely unchanged;
conflicting role/organization/deletion state fails with rollback. Passwords are
never printed or silently reset. Remove provisioning variables after execution.
Optional doctor/reception accounts are not provisioned in this block.

## Start, health, files and backups

Install later with `npm ci --prefix server`; production start from root:
`npm --prefix server start`. GET `/api/health` returns 200 for DB reachable, 503
otherwise. It does not certify schema completeness or file-volume durability.

Production refuses missing/relative/nonexistent/inaccessible PATIENT_FILES_DIR;
it does not silently create a fallback directory. Permission checks cannot prove
that a mounted volume is durable: the operator must configure and test that.
Development keeps its previous default storage directory.

Clinical documents/images are files plus DB metadata. Treatment Plan signatures
are stored in PostgreSQL `treatment_plan_acceptances.signature_data` as PNG data
URLs (base64), alongside JSONB snapshots. No signature filesystem migration.

Back up BOTH PostgreSQL (including signature snapshots) and the private files,
with coordinated recovery, encryption, retention and restore tests. Keep JWT/PIN
secrets separately protected. Do not run the development Docker backup scripts
against a remote installation without a separately reviewed procedure.

## Isolated validation and changed-file inventory

Run from the project root: `node --test server/tests/deployment-foundation.test.js`.
The ten test groups use VM/fake pool responses, disposable folders and mocked
PowerShell commands. They do not start Node API, psql, Docker, seed or provisioning
against a database. PowerShell execution policy is bypassed only for the child
test process, not changed on the machine. Both migration transport paths are mocked.

Existing files changed by Foundation only:

- `api.js`
- `scripts/database-migrate.ps1`
- `server/.env.example`
- `server/scripts/frontend-server.js`
- `server/scripts/seed.js`
- `server/src/db.js`
- `server/src/routes/patientFiles.js` (storage configuration only)
- `server/src/server.js` (deployment configuration only)

Added:

- `server/src/config/deployment.js`
- `server/scripts/provision-review.js`
- `server/database/migrations.json`
- `server/DEPLOYMENT.md`
- `server/tests/deployment-foundation.test.js`
- `server/tests/migration-fail-fast.mock.ps1`

Backups and before/after SHA256 are kept under
`backups/deployment-foundation-1.0-20260922-171614/` (not for commit).
Pre-existing unrelated working-tree changes are retained.
