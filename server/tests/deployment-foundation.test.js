const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const { poolOptions, patientFilesDirectory, frontendDirectory, trustProxy } = require("../src/config/deployment");
const { reviewConfig, provision } = require("../scripts/provision-review");
const root = path.resolve(__dirname, "../..");

async function apiRequest(config, stale) {
  const requests = [];
  const context = vm.createContext({
    window: { MAELVEN_WEB_CONFIG: config }, URL, FormData, AbortController,
    localStorage: { getItem: key => key === "apiUrl" ? stale : null },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => [] }; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "api.js"), "utf8"), context);
  await vm.runInContext("DentalApi.getProcedures()", context);
  return requests[0];
}

test("API: explicit configuration, local development, same-origin, stale storage", async () => {
  assert.equal((await apiRequest({ environment: "development" })).url, "http://127.0.0.1:3001/api/procedures");
  assert.equal((await apiRequest(undefined, "http://old.invalid/api")).url, "/api/procedures");
  assert.equal((await apiRequest({ apiBase: "https://api.example.test/api/" })).url, "https://api.example.test/api/procedures");
  assert.equal((await apiRequest({ apiBase: "/api", environment: "development" })).url, "/api/procedures");
  assert.equal((await apiRequest({ environment: "development" }, "http://localhost:3001/api")).url, "http://localhost:3001/api/procedures");
  assert.equal((await apiRequest()).options.credentials, "include");
  await assert.rejects(apiRequest({ apiBase: "http://api.example.test/api" }));
  await assert.rejects(apiRequest({ apiBase: "https://user:pass@api.example.test/api" }));
  await assert.rejects(apiRequest({ apiBase: "https://api.example.test/api?key=value" }));
});

test("local server supplies development config without changing public assets", () => {
  const source = fs.readFileSync(path.join(root, "server/scripts/frontend-server.js"), "utf8");
  assert.match(source, /const host = "127\.0\.0\.1"/);
  assert.match(source, /environment: "development"/);
  assert.match(source, /require\("\.\.\/src\/config\/public-web-files"\)/);
  const assets = new Set(require("../src/config/public-web-files"));
  assert(assets.has("dental-tooth-selector.js"));
  assert(!assets.has(".env"));
  assert(!assets.has("server/src/server.js"));
});

test("TLS verified for remote production; local desktop compatibility; bounded pool", () => {
  assert.equal(poolOptions({}).ssl, false);
  const remote = { NODE_ENV: "production", DATABASE_URL: "postgres://db.example.test/review" };
  assert.equal(poolOptions(remote).ssl.rejectUnauthorized, true);
  assert.equal(poolOptions({ ...remote, DATABASE_URL: "postgres://127.0.0.1:5433/review" }).ssl, false);
  assert.throws(() => poolOptions({ ...remote, PG_TLS: "disable" }));
  assert.throws(() => poolOptions({ ...remote, DATABASE_URL: remote.DATABASE_URL + "?sslmode=no-verify" }));
  assert.throws(() => poolOptions({ PG_POOL_MAX: "0" }));
  assert.throws(() => poolOptions({ PG_CONNECTION_TIMEOUT_MS: "NaN" }));
  assert.equal(poolOptions({ PG_POOL_MAX: "4" }).max, 4);
  assert.equal(poolOptions({}).connectionTimeoutMillis, 10000);
});

test("trust proxy fails closed", () => {
  assert.equal(trustProxy({}), false);
  assert.deepEqual(trustProxy({ TRUST_PROXY: "127.0.0.1,10.2.0.0/24" }), ["127.0.0.1", "10.2.0.0/24"]);
  for (const value of ["true", "1", "*", "0.0.0.0/0", "::/0", "10.0.0.1/99"]) {
    assert.throws(() => trustProxy({ TRUST_PROXY: value }));
  }
});

test("storage and public artifact guards, using only disposable directories", () => {
  const backupRoot = path.join(root, "backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  // Public guard rejects backups by design: use a dedicated, unique project temp dir.
  const temp = fs.mkdtempSync(path.join(root, ".foundation-test-"));
  try {
    const storage = path.join(temp, "private");
    const web = path.join(temp, "web");
    fs.mkdirSync(storage); fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>QA fixture</title>");
    const env = { NODE_ENV: "production", PATIENT_FILES_DIR: storage, FRONTEND_ROOT: web };
    assert.equal(patientFilesDirectory(env), fs.realpathSync(storage));
    assert.equal(frontendDirectory(env), fs.realpathSync(web));
    assert.throws(() => patientFilesDirectory({ NODE_ENV: "production" }));
    assert.throws(() => patientFilesDirectory({ NODE_ENV: "production", PATIENT_FILES_DIR: "relative" }));
    assert.throws(() => patientFilesDirectory({ ...env, PATIENT_FILES_DIR: path.join(temp, "missing") }));
    for (const dir of [root, path.dirname(root), path.join(root, "server"), backupRoot]) {
      assert.throws(() => frontendDirectory({ ...env, FRONTEND_ROOT: dir }));
    }
    assert.throws(() => frontendDirectory({ ...env, PATIENT_FILES_DIR: web }));
    fs.writeFileSync(path.join(web, ".env"), "QA_ONLY=not-a-secret");
    assert.throws(() => frontendDirectory(env));
  } finally {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), root);
    assert(path.basename(resolved).startsWith(".foundation-test-"));
    fs.rmSync(resolved, { recursive: true });
  }
});

test("production seed exits before bcrypt/db imports (VM only)", () => {
  const imports = [];
  const exit = new Error("blocked");
  assert.throws(() => vm.runInNewContext(fs.readFileSync(path.join(root, "server/scripts/seed.js"), "utf8"), {
    require: name => { imports.push(name); if (name === "dotenv") return { config() {} }; throw new Error("Unexpected import"); },
    process: { env: { NODE_ENV: "production" }, exit: code => { assert.equal(code, 1); throw exit; } },
    console: { error() {} }
  }), error => error === exit);
  assert.deepEqual(imports, ["dotenv"]);
});

const config = () => reviewConfig({
  DATABASE_URL: "postgres://unused.invalid/review", REVIEW_ORGANIZATION_NAME: "Simulated org",
  REVIEW_ADMIN_USERNAME: "qa-admin", REVIEW_ADMIN_NAME: "QA only",
  REVIEW_ADMIN_PASSWORD: require("crypto").randomBytes(24).toString("hex") + "Aa1!"
});

function fakePool(existing = null, failInsert = false, newOrganization = false) {
  const calls = [];
  return { calls, connect: async () => ({
    release() { calls.push("RELEASE"); },
    async query(sql, params) {
      calls.push(sql.trim());
      if (sql.startsWith("SELECT id, active FROM organizations")) return { rows: newOrganization ? [] : [{ id: "org", active: true }] };
      if (sql.startsWith("INSERT INTO organizations")) return { rows: [{ id: "org" }] };
      if (sql.startsWith("SELECT id, organization_id")) return { rows: existing ? [existing] : [] };
      if (sql.includes("INSERT INTO users")) {
        assert.equal(params[0], "org"); assert.equal(params[2], "hashed");
        if (failInsert) throw new Error("simulated insert failure");
        return { rows: [{ id: "user" }] };
      }
      return { rows: [] };
    }
  }) };
}

test("provision variables reject missing/weak values, no DB imported", () => {
  assert.throws(() => reviewConfig({}));
  assert.equal(config().role, "admin");
  assert.throws(() => reviewConfig({ DATABASE_URL: "postgres://unused.invalid/review",
    REVIEW_ORGANIZATION_NAME: "QA", REVIEW_ADMIN_USERNAME: "admin", REVIEW_ADMIN_NAME: "QA",
    REVIEW_ADMIN_PASSWORD: "weak" }));
  assert(!Object.keys(require.cache).some(file => file === path.join(root, "server/src/db.js")));
});

test("provision transaction creates, repeats without reset, conflicts/failures roll back", async () => {
  const pool = fakePool();
  const result = await provision(config(), pool, async () => "hashed");
  assert.equal(result.created, true); assert(pool.calls.includes("COMMIT"));
  assert(pool.calls.some(sql => sql.includes("must_change_password")));
  const repeat = fakePool({ id: "user", organization_id: "org", role: "admin", active: true });
  assert.equal((await provision(config(), repeat, async () => { throw new Error("Must not rehash"); })).created, false);
  assert(!repeat.calls.some(sql => /^(UPDATE|INSERT)/.test(sql)));
  const conflict = fakePool({ id: "user", organization_id: "other", role: "admin", active: true });
  await assert.rejects(provision(config(), conflict, async () => "hashed"));
  assert(conflict.calls.includes("ROLLBACK"));
  const failed = fakePool(null, true);
  await assert.rejects(provision(config(), failed, async () => "hashed"));
  assert(failed.calls.includes("ROLLBACK")); assert(!failed.calls.includes("COMMIT"));
  const fresh = fakePool(null, false, true);
  assert.equal((await provision(config(), fresh, async () => "hashed")).created, true);
  assert(fresh.calls.some(sql => sql.startsWith("INSERT INTO organizations")));
  assert(fresh.calls.includes("COMMIT"));
});

test("all 27 migrations appear once in dependency order", () => {
  const dir = path.join(root, "server/database");
  const names = JSON.parse(fs.readFileSync(path.join(dir, "migrations.json"), "utf8"));
  const actual = fs.readdirSync(dir).filter(name => /^migration_.*\.sql$/.test(name));
  assert.equal(names.length, 27); assert.deepEqual([...names].sort(), actual.sort());
  for (const [first, second] of [
    ["procedures_billing", "billing_payments_discounts"], ["procedures_billing", "billing_statuses"],
    ["billing_payments_discounts", "organizations_multi_mode"], ["head_admin_users", "organizations_multi_mode"],
    ["organizations_multi_mode", "pin_login"], ["clinical_evolution", "clinical_record_upgrade"],
    ["patient_profiles", "dominican_timezone"], ["odontogram_entries", "treatment_plans"],
    ["treatment_plans", "treatment_plan_acceptances"], ["treatment_plan_acceptances", "odontogram_primary_teeth"]
  ]) assert(names.indexOf(`migration_${first}.sql`) < names.indexOf(`migration_${second}.sql`));
});

test("migration runner fail-fast simulated; NO psql/Docker execution", { skip: process.platform !== "win32" }, () => {
  const wrapper = path.join(__dirname, "migration-fail-fast.mock.ps1");
  for (const docker of [false, true]) for (const failAt of [1, 4, 0]) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper,
      "-FailAt", String(failAt), ...(docker ? ["-DockerPath"] : [])], { encoding: "utf8" });
    const calls = (result.stdout.match(/MOCK_SQL/g) || []).length;
    assert.equal(calls, failAt || 28, result.stderr);
    assert.equal(result.status === 0, failAt === 0, result.stderr);
    if (failAt) assert.match(result.stderr, /Fallo SQL/);
  }
});
