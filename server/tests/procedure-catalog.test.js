const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PROCEDURE_A = "33333333-3333-4333-8333-333333333333";
const PROCEDURE_B = "44444444-4444-4444-8444-444444444444";

const dbPath = require.resolve("../src/db");
const authPath = require.resolve("../src/middleware/auth");
const auditPath = require.resolve("../src/utils/audit");
const routerPath = require.resolve("../src/routes/procedures");

const db = require(dbPath);
const auth = require(authPath);
const audit = require(auditPath);

const originalDbQuery = db.query;
const originalAuthenticate = auth.authenticate;
const originalAllowRoles = auth.allowRoles;
const originalHasAnyRole = auth.hasAnyRole;
const originalAudit = audit.writeAuditLog;

function createRows() {
  return [
    {
      id: PROCEDURE_A,
      organization_id: ORG_A,
      category_key: "operatoria",
      category_name: "Operatoria",
      name: "Consulta inicial",
      base_price: 1000,
      duration_minutes: 30,
      requires_tooth: false,
      active: true,
      deleted_at: null
    },
    {
      id: PROCEDURE_B,
      organization_id: ORG_B,
      category_key: "operatoria",
      category_name: "Operatoria",
      name: "Consulta inicial",
      base_price: 1500,
      duration_minutes: 30,
      requires_tooth: false,
      active: true,
      deleted_at: null
    }
  ];
}

function projected(row) {
  return {
    id: row.id,
    category_key: row.category_key,
    category_name: row.category_name,
    name: row.name,
    base_price: row.base_price,
    duration_minutes: row.duration_minutes,
    requires_tooth: row.requires_tooth,
    active: row.active
  };
}

function installMocks(rows) {
  db.query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT id, category_key")) {
      const orgId = params[0];

      return {
        rows: rows
          .filter(row =>
            row.organization_id === orgId &&
            row.deleted_at === null &&
            (
              normalized.includes("active = true")
                ? row.active === true
                : true
            )
          )
          .sort((a, b) =>
            `${a.category_name}${a.name}`.localeCompare(
              `${b.category_name}${b.name}`
            )
          )
          .map(projected)
      };
    }

    if (normalized.startsWith("SELECT category_key")) {
      const [id, orgId] = params;

      const row = rows.find(item =>
        item.id === id &&
        item.organization_id === orgId &&
        item.deleted_at === null
      );

      return {
        rows: row
          ? [{
              category_key: row.category_key,
              category_name: row.category_name
            }]
          : []
      };
    }

    if (normalized.startsWith("UPDATE procedure_catalog")) {
      const [
        id,
        orgId,
        categoryKey,
        categoryName,
        name,
        basePrice,
        duration,
        requiresTooth,
        active
      ] = params;

      const row = rows.find(item =>
        item.id === id &&
        item.organization_id === orgId &&
        item.deleted_at === null
      );

      if (!row) {
        return { rows: [] };
      }

      Object.assign(row, {
        category_key: categoryKey,
        category_name: categoryName,
        name,
        base_price: basePrice,
        duration_minutes: duration,
        requires_tooth: requiresTooth,
        active
      });

      return {
        rows: [projected(row)]
      };
    }

    throw new Error(`Unexpected SQL in test: ${normalized}`);
  };

  auth.authenticate = (req, res, next) => {
    req.user = {
      id: "test-user",
      role: "admin",
      organizationId: req.headers["x-test-org"]
    };

    next();
  };

  auth.allowRoles = () => (req, res, next) => next();

  auth.hasAnyRole = (user, roles) =>
    roles.includes(user.role);

  audit.writeAuditLog = async () => {};
}

function restoreMocks() {
  db.query = originalDbQuery;
  auth.authenticate = originalAuthenticate;
  auth.allowRoles = originalAllowRoles;
  auth.hasAnyRole = originalHasAnyRole;
  audit.writeAuditLog = originalAudit;
  delete require.cache[routerPath];
}

async function createServer() {
  const rows = createRows();

  installMocks(rows);

  delete require.cache[routerPath];
  const router = require(routerPath);

  const app = express();

  app.use(express.json());
  app.use("/procedures", router);

  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,

    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });

      restoreMocks();
    }
  };
}

async function request(server, method, path, organizationId, body) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-org": organizationId
    },
    body: body === undefined
      ? undefined
      : JSON.stringify(body)
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

test("GET procedure catalog is isolated by organization", async () => {
  const server = await createServer();

  try {
    const orgA = await request(
      server,
      "GET",
      "/procedures",
      ORG_A
    );

    const orgB = await request(
      server,
      "GET",
      "/procedures",
      ORG_B
    );

    assert.equal(orgA.status, 200);
    assert.equal(orgB.status, 200);

    assert.equal(orgA.body.length, 1);
    assert.equal(orgB.body.length, 1);

    assert.equal(orgA.body[0].id, PROCEDURE_A);
    assert.equal(orgB.body[0].id, PROCEDURE_B);

    assert.equal(orgA.body[0].base_price, 1000);
    assert.equal(orgB.body[0].base_price, 1500);

    assert.equal(orgA.body[0].name, "Consulta inicial");
    assert.equal(orgB.body[0].name, "Consulta inicial");
  } finally {
    await server.close();
  }
});

test("PATCH changes price only inside the current organization", async () => {
  const server = await createServer();

  try {
    const response = await request(
      server,
      "PATCH",
      `/procedures/${PROCEDURE_A}`,
      ORG_A,
      {
        categoryKey: "operatoria",
        categoryName: "Operatoria",
        name: "Consulta inicial",
        basePrice: 1200,
        durationMinutes: 30,
        requiresTooth: false,
        active: true
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.base_price, 1200);

    const orgA = await request(
      server,
      "GET",
      "/procedures",
      ORG_A
    );

    const orgB = await request(
      server,
      "GET",
      "/procedures",
      ORG_B
    );

    assert.equal(orgA.body[0].base_price, 1200);
    assert.equal(orgB.body[0].base_price, 1500);
  } finally {
    await server.close();
  }
});

test("cross-organization PATCH is rejected and leaves original price intact", async () => {
  const server = await createServer();

  try {
    const response = await request(
      server,
      "PATCH",
      `/procedures/${PROCEDURE_A}`,
      ORG_B,
      {
        categoryKey: "operatoria",
        categoryName: "Operatoria",
        name: "Consulta inicial",
        basePrice: 9999,
        durationMinutes: 30,
        requiresTooth: false,
        active: true
      }
    );

    assert.equal(response.status, 404);

    const orgA = await request(
      server,
      "GET",
      "/procedures",
      ORG_A
    );

    const orgB = await request(
      server,
      "GET",
      "/procedures",
      ORG_B
    );

    assert.equal(orgA.body[0].base_price, 1000);
    assert.equal(orgB.body[0].base_price, 1500);
  } finally {
    await server.close();
  }
});
