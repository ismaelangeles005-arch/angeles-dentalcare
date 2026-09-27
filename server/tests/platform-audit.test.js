const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "../..", file), "utf8");

const org = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const actorId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const eventId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

const platform = {
  id: actorId,
  role: "PLATFORM_SUPER_ADMIN",
  scope: "PLATFORM",
  organizationId: null
};

function fixture(rows = []) {
  const routes = {};
  const guards = [];
  let lastSql = "";
  let lastValues = [];

  const router = {
    use(fn) { guards.push(fn); },
    param() {}
  };

  for (const method of ["get", "post", "patch"]) {
    router[method] = (url, handler) => {
      routes[`${method} ${url}`] = handler;
    };
  }

  vm.runInNewContext(read("server/src/routes/platform.js"), {
    module: { exports: {} },
    process,
    require(name) {
      if (name === "express") return { Router: () => router };
      if (name === "../middleware/auth") return { authenticate() {} };
      if (name === "../utils/asyncHandler") return fn => fn;
      if (name === "../utils/passwordPolicy") return { validateStrongPassword() {} };
      if (name === "bcryptjs") return {};
      if (name === "../db") return {
        async query(sql, values = []) {
          lastSql = sql.replace(/\s+/g, " ").trim();
          lastValues = values;
          return { rows };
        },
        pool: { connect: async () => { throw new Error("not used"); } }
      };
      throw new Error(name);
    }
  });

  async function call(query = {}, user = platform) {
    const res = {
      code: 200,
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; }
    };

    let allowed = false;
    guards[1]({ user }, res, () => { allowed = true; });

    if (allowed) {
      await routes["get /audit"]({ query, user }, res);
    }

    return res;
  }

  return {
    call,
    get sql() { return lastSql; },
    get values() { return lastValues; }
  };
}

test("platform audit returns only selected administrative fields", async () => {
  const f = fixture([{
    id: eventId,
    action: "platform_set_user_pin",
    entity: "organizations",
    entity_id: org,
    created_at: "2026-09-27T03:00:00.000Z",
    organization_id: org,
    organization_name: "Review Clinic",
    organization_type: "CLINIC",
    actor_id: actorId,
    actor_username: "platform",
    actor_full_name: "Platform Admin",
    actor_role: "PLATFORM_SUPER_ADMIN",
    target_user_id: target,
    target_username: "doctor1",
    target_full_name: "Doctor One",
    target_role: "doctor",
    payload: { pin: "4826", password: "secret" }
  }]);

  const res = await f.call();

  assert.equal(res.code, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].action, "platform_set_user_pin");
  assert.equal(res.body.events[0].organization.id, org);
  assert.equal(res.body.events[0].actor.id, actorId);
  assert.equal(res.body.events[0].targetUser.id, target);

  const serialized = JSON.stringify(res.body);
  assert(!serialized.includes("4826"));
  assert(!serialized.includes("secret"));
  assert(!serialized.includes("payload"));
  assert(!serialized.includes("pin_hash"));
  assert(!serialized.includes("password_hash"));

  assert.match(f.sql, /l\.action LIKE 'platform_%'/);
  assert.match(f.sql, /actor\.organization_id IS NULL/);
  assert.match(f.sql, /target\.organization_id = l\.organization_id/);
  assert(!/SELECT \*/.test(f.sql));
});

test("tenant caller is denied before audit query", async () => {
  const f = fixture();

  const res = await f.call({}, {
    id: "tenant",
    role: "head_admin",
    scope: "ORGANIZATION",
    organizationId: org
  });

  assert.equal(res.code, 403);
  assert.equal(res.body.code, "PLATFORM_ACCESS_REQUIRED");
  assert.equal(f.sql, "");
});

test("audit validates organization and target UUID filters", async () => {
  for (const query of [
    { organizationId: "invalid" },
    { targetUserId: "invalid" }
  ]) {
    const f = fixture();
    const res = await f.call(query);
    assert.equal(res.code, 400);
    assert.equal(f.sql, "");
  }
});

test("audit validates action and date ranges", async () => {
  for (const query of [
    { action: "invalid action!" },
    { from: "not-a-date" },
    { to: "not-a-date" },
    { from: "2026-09-28T00:00:00Z", to: "2026-09-27T00:00:00Z" }
  ]) {
    const f = fixture();
    const res = await f.call(query);
    assert.equal(res.code, 400);
    assert.equal(f.sql, "");
  }
});

test("audit applies scoped filters and bounded pagination", async () => {
  const f = fixture();

  const res = await f.call({
    organizationId: org,
    action: "platform_create_user",
    actor: "marlon",
    targetUserId: target,
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-30T23:59:59Z",
    limit: "500",
    offset: "20"
  });

  assert.equal(res.code, 200);
  assert.equal(res.body.pagination.limit, 100);
  assert.equal(res.body.pagination.offset, 20);

  assert.match(f.sql, /l\.organization_id = \$1/);
  assert.match(f.sql, /l\.action = \$2/);
  assert.match(f.sql, /targetUserId/);
  assert.match(f.sql, /actor\.username ILIKE/);
  assert.match(f.sql, /l\.created_at >=/);
  assert.match(f.sql, /l\.created_at <=/);

  assert.equal(f.values[0], org);
  assert.equal(f.values[1], "platform_create_user");
  assert.equal(f.values[2], target);
  assert.equal(f.values[3], "%marlon%");
  assert.equal(f.values.at(-2), 101);
  assert.equal(f.values.at(-1), 20);
});

test("audit pagination reports hasMore without leaking extra row", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `${index}`,
    action: "platform_create_user",
    entity: "organizations",
    entity_id: org,
    created_at: "2026-09-27T03:00:00.000Z",
    organization_id: org,
    organization_name: "Review",
    organization_type: "CLINIC",
    actor_id: actorId,
    actor_username: "platform",
    actor_full_name: "Platform Admin",
    actor_role: "PLATFORM_SUPER_ADMIN",
    target_user_id: null
  }));

  const f = fixture(rows);
  const res = await f.call({ limit: "2" });

  assert.equal(res.body.events.length, 2);
  assert.equal(res.body.pagination.hasMore, true);
});

test("audit query joins platform actor by identity rather than tenant membership", async () => {
  const f = fixture();
  await f.call();

  assert.match(
    f.sql,
    /actor\.id = l\.user_id AND actor\.role = 'PLATFORM_SUPER_ADMIN' AND actor\.organization_id IS NULL/
  );

  assert.doesNotMatch(
    f.sql,
    /actor\.organization_id = l\.organization_id/
  );
});