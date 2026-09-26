const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const jwt = require("jsonwebtoken");
const read = file => fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
const platform = { id: "actor", role: "PLATFORM_SUPER_ADMIN", scope: "PLATFORM", organizationId: null };
const orgId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

function harness(options = {}) {
  const calls = [], routes = {}, guards = [], params = {};
  const state = { organizations: [], users: [], doctors: [], audits: [] };
  if (options.existing) state.organizations.push({ id: orgId, name: "Test", organization_type: "CLINIC", active: true });
  let snapshot;
  const client = {
    release() { calls.push("RELEASE"); },
    async query(sql, values = []) {
      const q = sql.replace(/\s+/g, " ").trim(); calls.push(q);
      if (q === "BEGIN") snapshot = structuredClone(state);
      if (q === "ROLLBACK") Object.assign(state, snapshot);
      if (options.fail && q.startsWith(options.fail)) throw Object.assign(new Error("simulated failure"), { code: options.failCode });
      if (q.includes("UNION ALL")) return { rows: options.duplicate ? [{ exists: 1 }] : [] };
      if (q.startsWith("INSERT INTO organizations")) { state.organizations.push({ id: orgId, name: values[0], organization_type: values[1], active: true }); return { rows: [{ id: orgId }] }; }
      if (q.startsWith("INSERT INTO doctors")) { state.doctors.push({ id: "doctor", organizationId: values[0] }); return { rows: [{ id: "doctor" }] }; }
      if (q.startsWith("INSERT INTO users")) { state.users.push({ id: "owner", organizationId: values[0], username: values[1], role: values[4], doctorId: values[5], mustChangePassword: q.includes("true)") }); return { rows: [{ id: "owner" }] }; }
      if (q.startsWith("UPDATE organizations")) {
        const org = state.organizations.find(row => row.id === values[0]);
        if (q.includes("owner_user_id =")) org.owner_user_id = values[1]; else org.active = values[1];
        return { rows: [org] };
      }
      if (q.startsWith("SELECT id, name")) return { rows: state.organizations.filter(row => row.id === values[0]) };
      if (q.startsWith("INSERT INTO audit_logs")) state.audits.push(values);
      return { rows: [] };
    }
  };
  const router = { use(fn) { guards.push(fn); }, param(name, fn) { params[name] = fn; } };
  for (const method of ["get", "post", "patch"]) router[method] = (url, fn) => { routes[`${method} ${url}`] = fn; };
  vm.runInNewContext(read("server/src/routes/platform.js"), { module: { exports: {} }, require(name) {
    if (name === "express") return { Router: () => router };
    if (name === "../db") return { pool: { connect: async () => client }, query: client.query };
    if (name === "../middleware/auth") return { authenticate() {} };
    if (name === "../utils/asyncHandler") return fn => fn;
    if (name === "../utils/passwordPolicy") return require("../src/utils/passwordPolicy");
    if (name === "bcryptjs") return { hash: async (_, cost) => { assert.equal(cost, 12); return "simulated-hash"; } };
    throw new Error(name);
  }});
  return { state, calls, guards, params, async call(key, body, id = orgId) {
    const res = response(); await routes[key]({ body, params: { id }, user: platform }, res); return res;
  }};
}
const payload = type => ({ organization: { name: "Test", organizationType: type }, initialUser: { username: "Owner.Test", fullName: "Owner Test", password: "Test123!" } });

for (const type of ["CLINIC", "INDEPENDENT"]) test(`atomic organization/owner creation: ${type}`, async () => {
  const h = harness(); const r = await h.call("post /organizations", payload(type));
  assert.equal(r.code, 201); assert.equal(h.state.users[0].organizationId, orgId);
  assert.equal(h.state.users[0].username, "owner.test"); assert.equal(h.state.users[0].mustChangePassword, true);
  assert.equal(h.state.users[0].role, type === "CLINIC" ? "head_admin" : "owner_doctor");
  assert.equal(h.state.organizations[0].owner_user_id, "owner");
  assert.equal(h.state.doctors.length, type === "INDEPENDENT" ? 1 : 0);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0][0], orgId); assert.equal(h.state.audits[0][1], "actor");
  assert.equal(h.state.audits[0][2], "platform_create_organization");
  assert.equal(h.state.audits[0][3].initialUserId, "owner");
  assert(!JSON.stringify([r.body, h.state.audits]).match(/password|hash|Test123/));
  assert.equal(h.calls.at(-2), "COMMIT"); assert.equal(h.calls.at(-1), "RELEASE");
});
for (const target of ["organizations", "users", "doctors", "audit_logs"]) test(`rollback on ${target} failure`, async () => {
  const h = harness({ fail: `INSERT INTO ${target}`, failCode: target === "audit_logs" ? undefined : "23505" });
  const r = await h.call("post /organizations", payload("INDEPENDENT"));
  assert.equal(r.code, target === "audit_logs" ? 500 : 409);
  for (const rows of Object.values(h.state)) assert.equal(rows.length, 0);
  assert.equal(h.calls.at(-2), "ROLLBACK"); assert.equal(h.calls.at(-1), "RELEASE");
});
test("duplicate precheck returns conflict without partial creation", async () => {
  const h = harness({ duplicate: true }); assert.equal((await h.call("post /organizations", payload("CLINIC"))).code, 409);
  assert.equal(h.state.organizations.length, 0); assert(h.calls.includes("ROLLBACK"));
});
test("invalid input and role injection create nothing", async () => {
  for (const mutate of [p => p.organization.organizationType = "OTHER", p => p.initialUser.password = "weak", p => p.initialUser.role = "PLATFORM_SUPER_ADMIN", p => p.initialUser.username = "bad user"]) {
    const h = harness(), p = payload("CLINIC"); mutate(p);
    assert.equal((await h.call("post /organizations", p)).code, 400); assert.equal(h.calls.length, 0);
  }
});
test("status changes audited; repeat no-op; reactivation preserves owner and users", async () => {
  const h = harness(); await h.call("post /organizations", payload("CLINIC"));
  const before = JSON.stringify(h.state.users);
  for (const active of [false, false, true]) assert.equal((await h.call("patch /organizations/:id/status", { active })).code, 200);
  assert.equal(h.state.organizations[0].active, true); assert.equal(h.state.organizations[0].owner_user_id, "owner");
  assert.equal(JSON.stringify(h.state.users), before); assert.equal(h.state.audits.length, 3);
  assert.equal(h.state.audits[1][2], "platform_deactivate_organization"); assert.equal(h.state.audits[2][2], "platform_activate_organization");
});
test("status audit failure rolls back; missing org and invalid status rejected", async () => {
  const h = harness({ existing: true, fail: "INSERT INTO audit_logs" });
  assert.equal((await h.call("patch /organizations/:id/status", { active: false })).code, 500);
  assert.equal(h.state.organizations[0].active, true);
  assert.equal((await harness().call("patch /organizations/:id/status", { active: false })).code, 404);
  assert.equal((await harness().call("patch /organizations/:id/status", { active: "false" })).code, 400);
});
test("platform guard and UUID validation fail closed", () => {
  const h = harness(); let passed = false;
  h.guards[1]({ user: platform }, response(), () => { passed = true; }); assert(passed);
  for (const user of [{ ...platform, role: "admin" }, { ...platform, organizationId: orgId }, { ...platform, scope: "ORGANIZATION" }]) {
    const res = response(); h.guards[1]({ user }, res, () => assert.fail()); assert.equal(res.body.code, "PLATFORM_ACCESS_REQUIRED");
  }
  const res = response(); h.params.id({}, res, () => assert.fail(), "invalid"); assert.equal(res.code, 400);
});
test("UI guard, mandatory change, and redirects", () => {
  const ctx = { document: { addEventListener() {} }, window: { addEventListener() {} } };
  vm.runInNewContext(read("platform-ui.js"), ctx);
  assert.equal(ctx.platformDestination(platform), null);
  assert.equal(ctx.platformDestination({ ...platform, mustChangePassword: true }), "cambiar-password.html");
  assert.equal(ctx.platformDestination({ role: "admin", scope: "ORGANIZATION", organizationId: orgId }), "dashboard.html");
  assert.equal(ctx.platformDestination(null), "index.html");
  assert.equal(ctx.platformDestination({ ...platform, organizationId: orgId }), "index.html");
  for (const file of ["index.html", "cambiar-password.html", "roles.js"]) {
    assert(!read(file).includes('"/api/platform/status"')); assert(read(file).includes('"platform.html"'));
  }
  assert(!read("platform-ui.js").includes("localStorage"));
});
test("real auth middleware retains scope denial and organization active check", async () => {
  const secret = "test-only-platform-secret";
  let active = true, platformAccount = true;
  const module = { exports: {} };
  vm.runInNewContext(read("server/src/middleware/auth.js"), { module, process: { env: { JWT_SECRET: secret } }, require(name) {
    if (name === "jsonwebtoken") return jwt;
    if (name === "../db") return { async query(sql) {
      assert(sql.includes("o.active = true"));
      return { rows: active ? [{ id: "actor", role: platformAccount ? "PLATFORM_SUPER_ADMIN" : "admin", organization_id: platformAccount ? null : orgId }] : [] };
    }};
    throw new Error(name);
  }});
  async function check(baseUrl) {
    const res = response(); let passed = false;
    await module.exports.authenticate({ headers: { cookie: `dental_session=${jwt.sign({ id: "actor" }, secret)}` }, path: "/", baseUrl, method: "GET" }, res, error => { if (error) throw error; passed = true; });
    return { res, passed };
  }
  assert.equal((await check("/api/patients")).res.body.code, "PLATFORM_TENANT_ACCESS_DENIED");
  assert.equal((await check("/api/platform")).passed, true);
  platformAccount = false; active = false;
  assert.equal((await check("/api/patients")).res.code, 401);
  active = true; assert.equal((await check("/api/patients")).passed, true);
});
