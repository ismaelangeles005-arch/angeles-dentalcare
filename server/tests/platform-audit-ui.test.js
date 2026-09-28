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
  const downloads = [], blobs = [], revoked = [];

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
    Blob,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return "blob:test"; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    setTimeout(callback) { callback(); },
    document: {
      body: element(),
      getElementById: get,
      addEventListener() {},
      createElement(tag) {
        const node = element();
        node.tagName = tag.toUpperCase();
        node.click = () => downloads.push(node.download);
        node.remove = () => { node.removed = true; };
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
        if (options.audit) return options.audit(filters);

        return {
          events: options.events || Array.from({ length: options.hasMore ? 50 : 1 }, (_, index) => ({
            id: `event-${filters.offset + index}`,
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
          })),
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
    downloads, blobs, revoked,
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

test("draft edits stay unapplied during pagination/refresh, applying resets offset, clearing resets every field", async () => {
  const f = fixture({ hasMore: true }); await f.run();
  assert(f.get("previous").disabled);
  f.get("organizationFilter").value = orgId;
  f.get("targetUserFilter").value = orgId;
  await f.get("applyFilters").onclick();
  f.get("organizationFilter").value = "unapplied";
  await f.get("next").onclick();
  assert.equal(f.calls.at(-1)[1].organizationId, orgId);
  assert.equal(f.calls.at(-1)[1].targetUserId, orgId);
  assert.equal(f.calls.at(-1)[1].offset, 50);
  assert.equal(f.get("pageInfo").textContent, "Mostrando 51–100");
  await f.get("refresh").onclick();
  assert.equal(f.calls.at(-1)[1].organizationId, orgId);
  f.get("actorFilter").value = " Actor ";
  await f.get("applyFilters").onclick();
  assert.equal(f.calls.at(-1)[1].offset, 0);
  assert.equal(f.calls.at(-1)[1].actor, "Actor");
  await f.get("clearFilters").onclick();
  for (const id of ["organizationFilter", "actionFilter", "actorFilter", "targetUserFilter", "fromFilter", "toFilter"]) assert.equal(f.get(id).value, "");
  assert.equal(f.calls.at(-1)[1].organizationId, "");
  assert.equal(f.calls.at(-1)[1].offset, 0);
});

test("short pages disable next; failed pagination leaves prior range/offset intact; repeated clicks are blocked", async () => {
  const short = fixture(); await short.run();
  assert(short.get("next").disabled);
  assert.equal(short.get("pageInfo").textContent, "Mostrando 1–1");
  const count = short.calls.length;
  await short.get("next").onclick(); assert.equal(short.calls.length, count);
  let fail = false, release;
  const f = fixture({ audit: async filters => {
    if (fail) { await new Promise(resolve => { release = resolve; }); throw new Error("SECRET"); }
    return { events: Array.from({ length: 50 }, (_, i) => ({ id: String(i), action: "platform_create_user" })), pagination: { hasMore: true } };
  } });
  await f.run(); fail = true;
  const pending = f.get("next").onclick();
  assert(f.get("previous").disabled); assert(f.get("next").disabled); assert(f.get("exportCsv").disabled);
  const requests = f.calls.length;
  await f.get("next").onclick(); assert.equal(f.calls.length, requests);
  release(); await pending;
  assert.equal(f.get("pageInfo").textContent, "Mostrando 1–50");
  assert(f.get("previous").disabled);
  assert(!f.get("message").textContent.includes("SECRET"));
});

test("CSV pages the complete applied result independently of screen page, escapes cells and excludes metadata", async () => {
  const f = fixture({ audit: async filters => ({
    events: Array.from({ length: filters.limit === 100 ? (filters.offset === 0 ? 100 : 1) : 50 }, (_, i) => ({
      id: String(filters.offset + i), action: "platform_create_user", createdAt: "2026-09-27T03:00:00Z",
      organization: { name: 'Clínica, "Norte"\nSegunda línea' },
      actor: { fullName: "=SUM(1,2)", username: "actor" },
      targetUser: { fullName: "Doctora", username: "user" },
      entity: "users", entityId: "safe-id",
      payload: { password: "DO-NOT-EXPORT" }, password_hash: "SECRET-HASH", pin: "SECRET-PIN"
    })), pagination: { hasMore: true }
  }) });
  await f.run();
  f.get("organizationFilter").value = orgId;
  await f.get("applyFilters").onclick();
  await f.get("next").onclick();
  f.get("organizationFilter").value = "draft-only";
  await f.get("exportCsv").onclick();
  const batches = f.calls.filter(c => Array.isArray(c) && c[1].limit === 100);
  assert.deepEqual(batches.map(c => c[1].offset), [0, 100]);
  assert(batches.every(c => c[1].organizationId === orgId));
  assert.equal(f.get("pageInfo").textContent, "Mostrando 51–100");
  assert.equal(f.blobs.length, 1);
  const bytes = new Uint8Array(await f.blobs[0].arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
  const text = await f.blobs[0].text();
  assert(text.startsWith('"Fecha","Acción","Organización","Actor","Usuario objetivo","Entidad","ID entidad"\r\n'));
  assert(text.includes('"Clínica, ""Norte""\nSegunda línea"'));
  assert(text.includes('"\'=SUM(1,2) (actor)"'));
  assert.equal((text.match(/"safe-id"/g) || []).length, 101);
  assert(!/DO-NOT-EXPORT|SECRET|password_hash|payload/.test(text));
  assert.match(f.downloads[0], /^maelven-platform-audit-\d{8}-\d{4}\.csv$/);
  assert.deepEqual(f.revoked, ["blob:test"]);
  assert.equal(f.get("message").textContent, "CSV exportado correctamente.");
});

test("export double click blocked; failed page never downloads partial CSV or leaks errors", async () => {
  let release;
  const f = fixture({ audit: async filters => {
    if (filters.limit === 100) { await new Promise(resolve => { release = resolve; }); throw new Error("SECRET SQL"); }
    return { events: [], pagination: { hasMore: false } };
  } });
  await f.run();
  const pending = f.get("exportCsv").onclick();
  assert(f.get("exportCsv").disabled); assert(f.get("applyFilters").disabled);
  const count = f.calls.length;
  await f.get("exportCsv").onclick(); assert.equal(f.calls.length, count);
  release(); await pending;
  assert.equal(f.downloads.length, 0);
  assert.equal(f.get("message").textContent, "No fue posible exportar la auditoría.");
  assert(!f.get("exportCsv").disabled);
});

test("overlapping live export pages fail safely; empty dataset exports only header", async () => {
  const overlap = fixture({ audit: async filters => ({
    events: filters.limit === 100 ? Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) : [],
    pagination: { hasMore: false }
  }) });
  await overlap.run(); await overlap.get("exportCsv").onclick();
  assert.equal(overlap.downloads.length, 0);
  assert.equal(overlap.get("message").dataset.error, "true");
  const empty = fixture({ events: [] });
  await empty.run(); await empty.get("exportCsv").onclick();
  assert.equal((await empty.blobs[0].text()).split("\r\n").length, 2);
});

test("audit controls retain responsive layout, labels, safe DOM and existing API only", () => {
  const html = read("platform-audit.html"), source = read("platform-audit.js");
  for (const label of ["Organización", "Acción", "Actor", "Usuario objetivo", "Desde", "Hasta"]) assert(html.includes("<label>" + label));
  for (const label of ["Aplicar filtros", "Limpiar filtros", "Exportar CSV"]) assert(html.includes(label));
  assert(html.includes(".filters input,.filters select{width:100%;min-width:0}"));
  assert(html.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));
  assert(html.includes("@media(max-width:560px){.filter-actions,.toolbar-actions{display:grid;grid-template-columns:minmax(0,1fr);width:100%}"));
  assert(html.includes(":focus-visible"));
  assert(!/innerHTML|localStorage|sessionStorage|fetch\(/.test(source));
  assert.deepEqual([...new Set(source.match(/DentalApi\.\w+/g))].sort(), [
    "DentalApi.getCurrentUser", "DentalApi.getPlatformAudit", "DentalApi.getPlatformOrganizations", "DentalApi.logout"
  ]);
});
