const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const platform = { role: "PLATFORM_SUPER_ADMIN", scope: "PLATFORM", organizationId: null, username: "platform" };
const row = { id, name: "Review", organization_type: "CLINIC", active: true, owner_user_id: "owner",
  created_at: "2026-01-01", updated_at: "2026-02-01", total_users: 3, active_users: 2, inactive_users: 1,
  owner_id: "owner", owner_full_name: "Review Owner", owner_username: "review", owner_role: "head_admin", owner_active: true };
function apiFixture(data = row) {
  const routes = {}, guards = [], params = {};
  let queries = 0;
  const router = { use(fn) { guards.push(fn); }, param(name, fn) { params[name] = fn; } };
  for (const method of ["get", "post", "patch"]) router[method] = (url, handler) => { routes[method + url] = handler; };
  vm.runInNewContext(read("server/src/routes/platform.js"), { module: { exports: {} }, require(name) {
    if (name === "express") return { Router: () => router };
    if (name === "../middleware/auth") return { authenticate() {} };
    if (name === "../utils/asyncHandler") return fn => fn;
    if (name === "bcryptjs") return {};
    if (name === "../utils/passwordPolicy") return {};
    if (name === "../db") return { async query(sql, values) {
      queries++;
      assert.equal(values[0], id);
      assert.match(sql, /WHERE o.id = \$1/);
      assert.match(sql, /owner.organization_id = o.id/);
      assert.match(sql, /u.organization_id = o.id/);
      assert.match(sql, /u.role <> 'PLATFORM_SUPER_ADMIN'/);
      assert.match(sql, /owner.role <> 'PLATFORM_SUPER_ADMIN'/);
      assert.match(sql, /u.deleted_at IS NULL/);
      assert.match(sql, /COUNT\(\*\)::int AS total_users/);
      assert.match(sql, /WHERE u.active = true/);
      assert.match(sql, /WHERE u.active = false/);
      assert(!/password_hash|pin_hash|pin_lookup_hash|patients|appointments|billing|clinical_notes|SELECT \*/.test(sql));
      return { rows: data ? [data] : [] };
    }};
    throw new Error(name);
  }});
  return { get queries() { return queries; }, async call(user = platform, target = id) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    let allowed = false;
    guards[1]({ user }, res, () => { allowed = true; });
    if (!allowed) return res;
    allowed = false;
    params.id({}, res, () => { allowed = true; }, target);
    if (allowed) await routes["get/organizations/:id"]({ params: { id: target } }, res);
    return res;
  }};
}
test("detail preserves structural contract, safe owner fields and scoped counts", async () => {
  const fixture = apiFixture({ ...row, password_hash: "must-not-leak", pin_hash: "must-not-leak" });
  const res = await fixture.call();
  assert.equal(res.code, 200);
  for (const [key, value] of Object.entries({ id, name: "Review", organizationType: "CLINIC", active: true, ownerUserId: "owner", createdAt: row.created_at, updatedAt: row.updated_at })) assert.equal(res.body[key], value);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.summary)), { totalUsers: 3, activeUsers: 2, inactiveUsers: 1 });
  assert.deepEqual(Object.keys(res.body.owner).sort(), ["active", "fullName", "id", "role", "username"]);
  assert.equal(res.body.owner.fullName, row.owner_full_name);
  assert(!JSON.stringify(res.body).includes("must-not-leak"));
  assert.equal(fixture.queries, 1);
});
test("tenant denied before query; invalid UUID 400; missing organization 404", async () => {
  const fixture = apiFixture();
  const denied = await fixture.call({ role: "head_admin", scope: "ORGANIZATION", organizationId: id });
  assert.equal(denied.code, 403); assert.equal(denied.body.code, "PLATFORM_ACCESS_REQUIRED");
  assert.equal((await fixture.call(platform, "invalid")).code, 400); assert.equal(fixture.queries, 0);
  assert.equal((await apiFixture(null).call()).code, 404);
});
test("unmatched cross-tenant owner cannot leak; unassigned owner explicit; zero counts", async () => {
  for (const ownerUserId of [null, "other-tenant-owner"]) {
    const res = await apiFixture({ ...row, owner_user_id: ownerUserId, owner_id: null,
      owner_full_name: null, owner_username: null, owner_role: null, owner_active: null,
      total_users: 0, active_users: 0, inactive_users: 0 }).call();
    assert.equal(res.body.owner, null);
    assert.equal(res.body.ownerState, ownerUserId ? "UNAVAILABLE" : "UNASSIGNED");
    assert.equal(res.body.summary.totalUsers, 0);
  }
});

function uiFixture(options = {}) {
  const elements = new Map(), calls = [], locations = [];
  const el = name => { if (!elements.has(name)) elements.set(name, { hidden: true, textContent: "", dataset: {}, disabled: false }); return elements.get(name); };
  const detail = { id, name: "Review", organizationType: "CLINIC", active: true, summary: { totalUsers: 3, activeUsers: 2, inactiveUsers: 1 }, owner: null, ownerState: "UNASSIGNED" };
  const context = { URLSearchParams, document: { getElementById: el, addEventListener() {} },
    window: { location: { search: options.search ?? `?id=${id}`, replace: url => locations.push(url) }, confirm: () => true, addEventListener() {} },
    DentalApi: {
      async getCurrentUser() { calls.push("me"); if (options.authError) throw options.authError; return options.user === undefined ? platform : options.user; },
      async getPlatformOrganization(target) { calls.push("detail"); assert.equal(target, id); if (options.detailError) throw options.detailError; return detail; },
      async setPlatformOrganizationStatus(target, active) { calls.push("status"); assert.equal(target, id); detail.active = active; },
      async logout() { calls.push("logout"); }
    }
  };
  vm.runInNewContext(read("platform-organization.js"), context);
  return { context, calls, locations, el, run: () => context.startPlatformOrganization() };
}
test("detail UI verifies me before detail; status action reuses endpoint and refreshes", async () => {
  const ui = uiFixture(); await ui.run();
  assert.deepEqual(ui.calls, ["me", "detail"]);
  assert.equal(ui.el("organizationContent").hidden, false);
  assert.equal(ui.el("totalUsers").textContent, 3);
  await ui.el("toggleStatus").onclick();
  assert.deepEqual(ui.calls, ["me", "detail", "status", "detail"]);
  assert.equal(ui.el("organizationStatus").textContent, "Inactiva");
  await ui.el("logout").onclick(); assert.equal(ui.locations.at(-1), "index.html");
});
test("tenant, malformed platform, password change and expired session redirect without detail", async () => {
  for (const [options, destination] of [
    [{ user: { role: "admin", scope: "ORGANIZATION", organizationId: id } }, "dashboard.html"],
    [{ user: { ...platform, organizationId: id } }, "index.html"],
    [{ user: { ...platform, mustChangePassword: true } }, "cambiar-password.html"],
    [{ authError: { status: 401 } }, "index.html"],
    [{ authError: { status: 403, code: "PASSWORD_CHANGE_REQUIRED" } }, "cambiar-password.html"]
  ]) { const ui = uiFixture(options); await ui.run(); assert.deepEqual(ui.calls, ["me"]); assert.equal(ui.locations[0], destination); }
});
test("missing/invalid IDs show safe state without detail request", async () => {
  for (const search of ["", "?id=invalid"]) {
    const ui = uiFixture({ search }); await ui.run(); assert.deepEqual(ui.calls, ["me"]);
    assert.equal(ui.el("message").dataset.error, "true");
  }
});
test("404, server and network errors do not expose internals; retry remains enabled", async () => {
  for (const error of [{ status: 404 }, { status: 500, message: "SQL internal secret" }, new Error("network internal")]) {
    const ui = uiFixture({ detailError: error }); await ui.run();
    assert.equal(ui.el("organizationContent").hidden, true);
    assert.equal(ui.el("refresh").disabled, false);
    assert(!ui.el("message").textContent.includes("internal"));
    if (error.status === 404) assert.equal(ui.el("message").textContent, "Organización no encontrada.");
  }
});
test("platform list navigation and detail allowlist are explicit", () => {
  assert.match(read("platform-ui.js"), /platform-organization.html\?id=\$\{encodeURIComponent\(org.id\)\}/);
  assert(!read("platform-organization.js").includes("localStorage"));
  const files = require("../src/config/public-web-files");
  for (const file of ["platform-organization.html", "platform-organization.js"]) assert(files.includes(file));
  assert(read("platform-organization.html").includes('href="platform.html"'));
});
