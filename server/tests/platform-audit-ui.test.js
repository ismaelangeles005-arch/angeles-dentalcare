const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = file =>
  fs.readFileSync(path.join(__dirname, "../..", file), "utf8");

const orgId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

const platformUser = {
  id: "platform",
  username: "marlon",
  fullName: "Marlon",
  role: "PLATFORM_SUPER_ADMIN",
  scope: "PLATFORM",
  organizationId: null,
  mustChangePassword: false
};

function element() {
  return {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    dataset: {},
    children: [],
    onclick: null,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = [...items]; }
  };
}

function fixture(options = {}) {
  const elements = new Map();
  const calls = [];
  const redirects = [];

  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };

  get("organizationFilter").value = "";
  get("actionFilter").value = "";
  get("actorFilter").value = "";
  get("fromFilter").value = "";
  get("toFilter").value = "";

  const context = {
    console,
    URLSearchParams,
    document: {
      getElementById: get,
      addEventListener() {},
      createElement(tag) {
        const node = element();
        node.tagName = tag.toUpperCase();
        return node;
      }
    },
    window: {
      location: {
        href: "",
        replace(value) { redirects.push(value); },
        reload() {}
      },
      addEventListener() {}
    },
    DentalApi: {
      async getCurrentUser() {
        calls.push("me");
        if (options.authError) throw options.authError;
        return options.user === undefined ? platformUser : options.user;
      },

      async getPlatformOrganizations() {
        calls.push("organizations");
        return {
          organizations: [
            {
              id: orgId,
              name: "Review Clinic",
              organizationType: "CLINIC"
            }
          ]
        };
      },

      async getPlatformAudit(filters) {
        calls.push(["audit", filters]);

        if (options.auditError) throw options.auditError;

        return {
          events: options.events || [{
            id: "event-1",
            action: "platform_create_user",
            createdAt: "2026-09-27T03:00:00.000Z",
            organization: {
              id: orgId,
              name: "Review Clinic",
              organizationType: "CLINIC"
            },
            actor: {
              id: "platform",
              username: "marlon",
              fullName: "Marlon",
              role: "PLATFORM_SUPER_ADMIN"
            },
            targetUser: {
              id: "target",
              username: "doctor1",
              fullName: "Doctor One",
              role: "doctor"
            }
          }],
          pagination: {
            limit: 50,
            offset: filters.offset || 0,
            hasMore: options.hasMore === true
          }
        };
      },

      async logout() {
        calls.push("logout");
      }
    }
  };

  vm.runInNewContext(read("platform-audit.js"), context);

  return {
    context,
    calls,
    redirects,
    get,
    run: () => context.startPlatformAudit()
  };
}

test("audit UI validates platform session before loading data", async () => {
  const f = fixture();

  await f.run();

  assert.equal(f.calls[0], "me");
  assert.equal(f.calls[1], "organizations");
  assert.equal(f.calls[2][0], "audit");

  assert.equal(f.get("sessionError").hidden, true);
  assert.equal(f.get("platformAuditApp").hidden, false);
});

test("tenant users are redirected before audit data loads", async () => {
  const f = fixture({
    user: {
      role: "head_admin",
      scope: "ORGANIZATION",
      organizationId: orgId,
      mustChangePassword: false
    }
  });

  await f.run();

  assert.deepEqual(f.calls, ["me"]);
  assert.equal(f.redirects[0], "dashboard.html");
});

test("password-change-required platform user is redirected", async () => {
  const f = fixture({
    user: {
      ...platformUser,
      mustChangePassword: true
    }
  });

  await f.run();

  assert.deepEqual(f.calls, ["me"]);
  assert.equal(f.redirects[0], "cambiar-password.html");
});

test("expired session redirects to login", async () => {
  const f = fixture({
    authError: { status: 401 }
  });

  await f.run();

  assert.deepEqual(f.calls, ["me"]);
  assert.equal(f.redirects[0], "index.html");
});

test("filters reset offset and are sent to audit endpoint", async () => {
  const f = fixture();

  await f.run();

  f.get("organizationFilter").value = orgId;
  f.get("actionFilter").value = "platform_create_user";
  f.get("actorFilter").value = "marlon";
  f.get("fromFilter").value = "2026-09-01";
  f.get("toFilter").value = "2026-09-30";

  await f.get("applyFilters").onclick();

  const auditCalls = f.calls.filter(call => Array.isArray(call) && call[0] === "audit");
  const filters = auditCalls.at(-1)[1];

  assert.equal(filters.organizationId, orgId);
  assert.equal(filters.action, "platform_create_user");
  assert.equal(filters.actor, "marlon");
  assert.equal(filters.from, "2026-09-01T00:00:00");
  assert.equal(filters.to, "2026-09-30T23:59:59.999");
  assert.equal(filters.offset, 0);
  assert.equal(filters.limit, 50);
});

test("pagination advances and returns safely", async () => {
  const f = fixture({ hasMore: true });

  await f.run();

  await f.get("next").onclick();

  let auditCalls = f.calls.filter(call => Array.isArray(call) && call[0] === "audit");
  assert.equal(auditCalls.at(-1)[1].offset, 50);

  await f.get("previous").onclick();

  auditCalls = f.calls.filter(call => Array.isArray(call) && call[0] === "audit");
  assert.equal(auditCalls.at(-1)[1].offset, 0);
});

test("audit UI never uses localStorage or sessionStorage", () => {
  const source = read("platform-audit.js");

  assert(!source.includes("localStorage"));
  assert(!source.includes("sessionStorage"));
});

test("audit page and scripts are explicitly public", () => {
  const files = require("../src/config/public-web-files");

  assert(files.includes("platform-audit.html"));
  assert(files.includes("platform-audit.js"));

  const html = read("platform-audit.html");
  assert(html.includes('src="platform-audit.js?v=platform4-4"'));
  assert(html.includes("Auditoría de plataforma"));
});