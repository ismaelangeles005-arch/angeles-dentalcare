const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

process.env.JWT_SECRET = "test-jwt-secret";
process.env.PIN_LOOKUP_SECRET = "test-pin-lookup-secret";

const AUTH_PATH = require.resolve("../src/routes/auth");

function createHarness(options = {}) {
  const originalLoad = Module._load;

  const state = {
    user: {
      id: "user-1",
      organizationId: "org-1",
      username: "owner",
      role: "owner_doctor",
      scope: "TENANT",
      doctorId: null,
      doctor: null,
      organizationName: "Clinic",
      organizationType: "CLINIC"
    },
    dbCalls: [],
    clientCalls: [],
    auditCalls: [],
    released: false,
    committed: false,
    rolledBack: false,
    updated: false
  };

  const db = {
    query: async (sql, params) => {
      state.dbCalls.push({ sql, params });

      if (/SELECT\s+id,\s+organization_id,\s+pin_hash/i.test(sql)) {
        return {
          rows: [{
            id: state.user.id,
            organization_id: state.user.organizationId,
            pin_hash:
              options.pinHash ||
              "$2a$12$LQv3c1yqBWQ0w4DncL8nFe9fpma.K2JZF8lQmJzv3N0q5nEqvHU7u",
            pin_lookup_hash: null,
            pin_enabled: true,
            active: true,
            deleted_at: null
          }]
        };
      }

      if (/SELECT\s+id\s+FROM\s+users/i.test(sql)) {
        return {
          rows: options.duplicate ? [{ id: "other-user" }] : []
        };
      }

      throw new Error(`Unexpected db.query: ${sql}`);
    },

    pool: {
      connect: async () => {
        const client = {
          query: async (sql, params) => {
            state.clientCalls.push({ sql, params });

            if (sql === "BEGIN") {
              return;
            }

            if (sql === "COMMIT") {
              state.committed = true;
              return;
            }

            if (sql === "ROLLBACK") {
              state.rolledBack = true;
              return;
            }

            if (/UPDATE\s+users/i.test(sql)) {
              if (options.updateError) {
                throw new Error("Simulated update failure");
              }

              state.updated = true;
              return;
            }

            if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
              if (options.auditError) {
                throw new Error("Simulated audit failure");
              }

              return;
            }

            throw new Error(`Unexpected client.query: ${sql}`);
          },

          release: () => {
            state.released = true;
          }
        };

        return client;
      }
    }
  };

  const bcrypt = {
    compare: async (value) => {
      if (options.invalidCurrentPin) {
        return false;
      }

      return value === "4826";
    },

    hash: async value => `bcrypt:${value}`
  };

  const audit = {
    writeAuditLog: async (
      req,
      action,
      entity,
      entityId,
      payload,
      client
    ) => {
      state.auditCalls.push({
        req,
        action,
        entity,
        entityId,
        payload,
        client
      });

      if (options.auditError) {
        throw new Error("Simulated audit failure");
      }

      await client.query(
        "INSERT INTO audit_logs (organization_id, user_id, action, entity, entity_id, payload)",
        []
      );
    }
  };

  const authMiddleware = {
    authenticate: (req, res, next) => {
      req.user = state.user;
      next();
    },

    deriveScope: () => "TENANT"
  };

  const asyncHandler = handler => (req, res, next) => {
    return Promise
      .resolve(handler(req, res, next))
      .catch(next);
  };

  const passwordPolicy = {
    validateStrongPassword: () => null
  };

  Module._load = function(request, parent, isMain) {
    if (request === "../db") {
      return db;
    }

    if (request === "bcryptjs") {
      return bcrypt;
    }

    if (request === "../utils/audit") {
      return audit;
    }

    if (request === "../middleware/auth") {
      return authMiddleware;
    }

    if (request === "../utils/asyncHandler") {
      return asyncHandler;
    }

    if (request === "../utils/passwordPolicy") {
      return passwordPolicy;
    }

    return originalLoad.apply(this, arguments);
  };

  delete require.cache[AUTH_PATH];

  let router;

  try {
    router = require(AUTH_PATH);
  } finally {
    Module._load = originalLoad;
  }

  function findPost(path) {
    const layer = router.stack.find(
      item =>
        item.route &&
        item.route.path === path &&
        item.route.methods.post
    );

    assert.ok(layer, `POST ${path} no encontrado`);

    return layer.route.stack;
  }

  const routeStack = findPost("/my-pin");

  async function call(body) {
    const response = {
      statusCode: 200,
      body: undefined,
      headers: {},
      ended: false,

      status(code) {
        response.statusCode = code;
        return response;
      },

      json(payload) {
        response.body = payload;
        response.ended = true;
        return response;
      },

      send(payload) {
        response.body = payload;
        response.ended = true;
        return response;
      },

      setHeader(name, value) {
        response.headers[name] = value;
      }
    };

    const req = {
      body,
      user: state.user,
      method: "POST",
      path: "/my-pin",
      originalUrl: "/my-pin"
    };

    async function dispatch(index) {
      if (index >= routeStack.length) {
        return response;
      }

      const middleware = routeStack[index].handle;

      return await new Promise((resolve, reject) => {
        let nextCalled = false;

        const next = error => {
          if (nextCalled) {
            return;
          }

          nextCalled = true;

          if (error) {
            reject(error);
            return;
          }

          dispatch(index + 1).then(resolve, reject);
        };

        try {
          const result = middleware(req, response, next);

          if (result && typeof result.then === "function") {
            result.then(
              () => {
                if (!nextCalled) {
                  if (response.ended || response.statusCode >= 400) {
                    resolve(response);
                  } else {
                    next();
                  }
                }
              },
              reject
            );
          } else if (middleware.length < 3 && !nextCalled) {
            if (response.ended || response.statusCode >= 400) {
              resolve(response);
            } else {
              next();
            }
          }
        } catch (error) {
          reject(error);
        }
      });
    }

    return dispatch(0);
  }

  return {
    state,
    call
  };
}

test("my-pin changes own PIN atomically and audits through the same client", async () => {
  const h = createHarness();

  const response = await h.call({
    currentPin: "4826",
    newPin: "7391",
    confirmPin: "7391"
  });

  assert.equal(response.statusCode, 204);

  assert.equal(h.state.updated, true);
  assert.equal(h.state.committed, true);
  assert.equal(h.state.rolledBack, false);
  assert.equal(h.state.released, true);

  assert.equal(h.state.clientCalls[0].sql, "BEGIN");

  assert.match(
    h.state.clientCalls[1].sql,
    /UPDATE\s+users/i
  );

  assert.match(
    h.state.clientCalls[2].sql,
    /INSERT\s+INTO\s+audit_logs/i
  );

  assert.equal(h.state.clientCalls[3].sql, "COMMIT");

  assert.equal(h.state.auditCalls.length, 1);
  assert.equal(h.state.auditCalls[0].action, "change_pin");
  assert.equal(h.state.auditCalls[0].entity, "users");
  assert.equal(h.state.auditCalls[0].entityId, "user-1");
  assert.equal(h.state.auditCalls[0].client !== undefined, true);
});

test("my-pin rejects invalid current PIN without transaction", async () => {
  const h = createHarness({
    invalidCurrentPin: true
  });

  const response = await h.call({
    currentPin: "0000",
    newPin: "7391",
    confirmPin: "7391"
  });

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.body.code,
    "INVALID_CURRENT_PIN"
  );

  assert.equal(h.state.clientCalls.length, 0);
  assert.equal(h.state.updated, false);
});

test("my-pin rejects duplicate PIN without transaction", async () => {
  const h = createHarness({
    duplicate: true
  });

  const response = await h.call({
    currentPin: "4826",
    newPin: "7391",
    confirmPin: "7391"
  });

  assert.equal(response.statusCode, 409);
  assert.equal(
    response.body.code,
    "PIN_ALREADY_IN_USE"
  );

  assert.equal(h.state.clientCalls.length, 0);
  assert.equal(h.state.updated, false);
});

test("my-pin rolls back UPDATE when audit fails", async () => {
  const h = createHarness({
    auditError: true
  });

  await assert.rejects(
    () =>
      h.call({
        currentPin: "4826",
        newPin: "7391",
        confirmPin: "7391"
      }),
    /Simulated audit failure/
  );

  assert.equal(h.state.updated, true);
  assert.equal(h.state.committed, false);
  assert.equal(h.state.rolledBack, true);
  assert.equal(h.state.released, true);

  assert.equal(h.state.clientCalls[0].sql, "BEGIN");

  assert.match(
    h.state.clientCalls[1].sql,
    /UPDATE\s+users/i
  );
});

test("my-pin validates confirmation and four-digit format before database access", async () => {
  const h = createHarness();

  const invalidCases = [
    {
      currentPin: "482",
      newPin: "7391",
      confirmPin: "7391"
    },
    {
      currentPin: "4826",
      newPin: "739",
      confirmPin: "739"
    },
    {
      currentPin: "4826",
      newPin: "7391",
      confirmPin: "7390"
    }
  ];

  for (const body of invalidCases) {
    const response = await h.call(body);

    assert.equal(response.statusCode, 400);
    assert.equal(h.state.clientCalls.length, 0);
    assert.equal(h.state.dbCalls.length, 0);
  }
});
