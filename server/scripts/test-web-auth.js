const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// In-memory regression checks: no listeners, database connections or persisted users.
const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const secret = "web-auth-simulation-only-not-a-real-secret";
const user = { id: "test-user", role: "doctor", username: "test", doctor: "Test Doctor", organizationId: "test-org", mustChangePassword: false };
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const reply = (status, data = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

function browser(fetch) {
  const events = {};
  const windowEvents = {};
  const body = { hidden: false, inert: false, classList: { add() {} }, replaceChildren() {}, appendChild() {} };
  const document = {
    body,
    addEventListener: (name, fn) => { events[name] = fn; },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {} })
  };
  const context = {
    localStorage: storage(), sessionStorage: storage(), document, console, FormData, AbortController,
    window: { location: { href: "", reload() { this.reloaded = true; } }, setTimeout: () => 1, clearTimeout() {}, addEventListener: (name, fn) => { windowEvents[name] = fn; } },
    fetch
  };
  context.localStorage.setItem("autoLockMinutes", "0");
  vm.createContext(context);
  vm.runInContext(read("api.js") + ";globalThis.api = DentalApi;", context);
  context.loadRoles = () => vm.runInContext(read("roles.js") + ";globalThis.roles = DentalRoles;", context);
  context.events = events;
  context.windowEvents = windowEvents;
  return context;
}

function middleware(db) {
  const context = { module: { exports: {} }, process: { env: { JWT_SECRET: secret } }, require: name => name === "../db" ? db : require(name) };
  vm.runInNewContext(read("server/src/middleware/auth.js"), context);
  return context.module.exports;
}

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; }, send() { return this; }, setHeader(key, value) { this.headers[key] = value; } };
}

async function run() {
  for (const file of ["api.js", "roles.js", "server/src/routes/auth.js", "server/src/middleware/auth.js"]) new vm.Script(read(file), { filename: file });
  for (const file of ["index.html", "pacientes.html", "citas.html", "procedimientos.html", "dashboard.html", "doctor.html", "usuarios.html", "auditoria.html", "reportes.html", "facturacion.html", "cambiar-password.html"]) {
    const html = read(file);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc=/.test(match[1])) new vm.Script(match[2], { filename: file });
    }
    if (file !== "index.html") {
      assert.equal((html.match(/data-dental-page=/g) || []).length, 1, file);
      assert.match(html, /<script type="text\/plain" data-dental-page=/);
      assert(!html.includes("DentalRoles.protectPage("), file);
      assert(html.indexOf('src="roles.js') < html.indexOf("data-dental-page="), file);
    }
  }
  console.log("PASS syntax and all ten private-page startup gates");

  for (const method of ["login", "pinLogin"]) {
    const ctx = browser(async () => reply(401, { message: "internal account detail" }));
    await assert.rejects(ctx.api[method]("0000", "wrong"), /Credenciales incorrectas/);
    assert.equal(ctx.window.location.href, "");
    assert.equal(ctx.api.getToken(), "");
  }
  const valid = browser(async (url, options) => {
    assert.equal(options.credentials, "include");
    return reply(200, { user });
  });
  await valid.api.login("test", "test-password");
  assert.equal(valid.localStorage.getItem("token"), null);
  assert.equal(valid.localStorage.getItem("organizationId"), user.organizationId);
  assert.equal(typeof valid.api.changePassword, "function");
  await valid.api.pinLogin("2468");
  console.log("PASS credential errors stay on login; valid password/PIN uses cookie credentials, no stored JWT");

  const loginUi = browser(async () => reply(401));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", className: "", disabled: false, offsetWidth: 0, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, focus() {} });
    return elements.get(id);
  };
  const keys = Array.from({ length: 12 }, () => ({ disabled: false }));
  loginUi.document.getElementById = element;
  loginUi.document.querySelectorAll = selector => selector === "#pinPad button" ? keys : [];
  const indexScript = [...read("index.html").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].find(match => !/src=/.test(match[1]))[2];
  vm.runInContext(indexScript, loginUi);
  await vm.runInContext('pin="9999"; submitPin()', loginUi);
  assert.equal(vm.runInContext('pin', loginUi), "");
  assert.equal(vm.runInContext('pending', loginUi), false);
  assert(keys.every(key => !key.disabled));
  assert.match(element('pinMessage').textContent, /Credenciales incorrectas/);
  assert.equal(loginUi.window.location.href, "");
  element('usuario').value = "test";
  element('password').value = "wrong";
  await loginUi.login();
  assert.equal(element('password').value, "");
  assert.equal(element('usuario').value, "test");
  assert.equal(vm.runInContext('legacyPending', loginUi), false);
  console.log("PASS actual login UI: visible rejection, PIN/password cleared, keypad and retry remain usable");

  let requests = 0;
  const reload = browser(async url => { assert(url.endsWith("/auth/me")); requests++; return reply(200, { user }); });
  reload.localStorage.setItem("sessionActive", "true");
  reload.localStorage.setItem("rol", "head_admin");
  reload.localStorage.setItem("organizationId", "forged-org");
  assert.equal(reload.api.getToken(), "");
  reload.loadRoles();
  assert.equal(reload.roles.rol, "");
  assert(await reload.roles.protectPage());
  assert(await reload.roles.protectPage());
  assert.equal(requests, 1);
  assert.equal(reload.roles.rol, "doctor");
  assert.equal(reload.roles.user.organizationId, "test-org");
  assert.equal(reload.localStorage.getItem("rol"), "doctor");
  assert.equal(reload.localStorage.getItem("organizationId"), "test-org");
  assert.equal(await reload.roles.protectPage({ adminOnly: true }), false);
  assert.equal(reload.window.location.href, "dashboard.html");
  for (const status of [401, 403]) {
    const ctx = browser(async () => reply(status));
    ctx.localStorage.setItem("sessionActive", "true");
    ctx.localStorage.setItem("rol", "head_admin");
    ctx.loadRoles();
    assert.equal(await ctx.roles.protectPage(), false);
    assert.equal(ctx.localStorage.getItem("sessionActive"), null);
    assert.equal(ctx.window.location.href, "index.html");
    assert.equal(ctx.document.body.inert, true);
  }
  const emptyStorage = browser(async () => reply(200, { user }));
  emptyStorage.loadRoles();
  assert(await emptyStorage.roles.protectPage());
  console.log("PASS reload verifies backend; forged storage ignored; missing/expired session denied; cookie works without local indicators");

  let resolveSession;
  const gated = browser(() => new Promise(resolve => { resolveSession = resolve; }));
  gated.loadRoles();
  let activated = false;
  const source = { dataset: { dentalPage: '{}' }, textContent: 'function existingInlineHandler() { return "works"; }', replaceWith(script) { activated = true; vm.runInContext(script.textContent, gated); } };
  gated.document.querySelector = selector => selector === "script[data-dental-page]" ? source : null;
  const starting = gated.events.DOMContentLoaded();
  assert.equal(activated, false);
  assert.equal(gated.document.body.inert, true);
  resolveSession(reply(200, { user }));
  await starting;
  assert.equal(activated, true);
  assert.equal(vm.runInContext("existingInlineHandler()", gated), "works");
  assert.equal(gated.document.body.inert, false);
  gated.windowEvents.pagehide();
  assert.equal(gated.document.body.hidden, true);
  gated.windowEvents.pageshow({ persisted: true });
  assert.equal(gated.window.location.reloaded, true);
  console.log("PASS page code waits for session, inline globals preserved, back/forward cache rechecks session");

  const failed = browser(async () => { throw new Error("raw fetch internals"); });
  failed.loadRoles();
  assert.equal(await failed.roles.protectPage(), false);
  assert.equal(failed.api.getToken(), "");
  const internal = browser(async () => reply(500, { message: "stack/SQL/secret" }));
  await assert.rejects(internal.api.login("test", "test"), error => error.status === 500 && !error.message.includes("SQL"));
  const expired = browser(async () => reply(401));
  await assert.rejects(expired.api.getPatients());
  assert.equal(expired.window.location.href, "index.html");
  const denied = browser(async () => reply(403, { message: "No tienes permiso" }));
  await assert.rejects(denied.api.getUsers(), error => error.status === 403);
  assert.equal(denied.window.location.href, "");
  console.log("PASS outages fail closed with safe messages; protected 401 redirects, permission 403 stays distinct");

  let serverAvailable = false;
  const closing = browser(async url => { assert(url.endsWith("/auth/logout")); if (!serverAvailable) throw new Error("offline"); return reply(204); });
  closing.loadRoles();
  await closing.roles.logout();
  assert.equal(closing.localStorage.getItem("logoutPending"), "true");
  assert(closing.sessionStorage.getItem("authNotice"));
  await assert.rejects(closing.api.getCurrentUser());
  serverAvailable = true;
  await assert.rejects(closing.api.getCurrentUser(), error => error.status === 401);
  assert.equal(closing.localStorage.getItem("logoutPending"), null);
  assert.equal(await closing.api.logout(), true);
  assert.equal(closing.api.getToken(), "");
  console.log("PASS logout success and outage; pending logout never silently restores old cookie");

  let privateRequests = 0;
  const otherTab = browser(async () => { privateRequests++; return reply(200, { user }); });
  otherTab.loadRoles();
  assert(await otherTab.roles.protectPage());
  privateRequests = 0;
  otherTab.localStorage.setItem("logoutPending", "true");
  await assert.rejects(otherTab.api.getPatients(), error => error.status === 401);
  await assert.rejects(otherTab.api.viewPatientFile("patient", "file"), error => error.status === 401);
  await assert.rejects(otherTab.api.downloadPatientFile("patient", "file", "name"), error => error.status === 401);
  assert.equal(privateRequests, 0);
  otherTab.windowEvents.storage({ key: "logoutPending", newValue: "true" });
  assert.equal(otherTab.document.body.inert, true);
  assert.equal(otherTab.window.location.href, "index.html");
  const wrongCurrentPassword = browser(async () => reply(401, { code: "INVALID_CURRENT_PASSWORD", message: "La contrasena actual no es correcta" }));
  await assert.rejects(wrongCurrentPassword.api.changePassword("wrong", "newpass1"), /contrasena actual/);
  assert.equal(wrongCurrentPassword.window.location.href, "");
  const expiredChange = browser(async () => reply(401, { message: "Sesion vencida" }));
  await assert.rejects(expiredChange.api.changePassword("old", "newpass1"));
  assert.equal(expiredChange.window.location.href, "index.html");
  console.log("PASS other verified tab and file requests blocked before fetch after logout; wrong current password retries inline, expired cookie still redirects");

  const auth = middleware({ query: async () => ({ rows: [] }) });
  for (const role of ["head_admin", "admin", "doctor", "recepcion", "owner_doctor", "clinic_admin", "receptionist", "independent_assistant", "assistant", "cashier"]) {
    const normalized = valid.api.normalizeRole(role);
    assert(normalized && auth.roleMatches(role, normalized), role);
  }
  assert.equal(valid.api.normalizeRole("unknown"), "");
  assert.equal(valid.api.normalizeRole("__proto__"), "");
  console.log("PASS normalized UI roles stay within backend-recognized permissions; unknown roles denied");

  const token = jwt.sign({ id: user.id, role: "head_admin", organizationId: "forged-org" }, secret);
  const row = { id: user.id, username: user.username, role: "doctor", organization_id: "test-org", must_change_password: true };
  const guarded = middleware({ query: async sql => { assert(sql.includes("u.must_change_password")); return { rows: [row] }; } });
  async function check(method, baseUrl, requestPath, headers = { cookie: `dental_session=${token}` }) {
    const req = { method, baseUrl, path: requestPath, headers };
    const res = response();
    let next = false;
    await guarded.authenticate(req, res, error => { assert(!error); next = true; });
    return { req, res, next };
  }
  for (const [method, baseUrl, route] of [["GET", "/api/patients", "/"], ["POST", "/api/appointments", "/"], ["GET", "/api/auth", "/other"], ["POST", "/api/auth", "/me"], ["GET", "/api/patients", "/me"]]) {
    const r = await check(method, baseUrl, route);
    assert.equal(r.res.statusCode, 403);
    assert.equal(r.res.body.code, "PASSWORD_CHANGE_REQUIRED");
    assert(!r.next);
  }
  for (const [method, route] of [["GET", "/me"], ["POST", "/change-password"], ["POST", "/logout"]]) {
    const r = await check(method, "/api/auth", route);
    assert(r.next);
    assert.equal(r.req.user.role, "doctor");
    assert.equal(r.req.user.organizationId, "test-org");
    assert.equal(r.req.user.mustChangePassword, true);
  }
  for (const [method, route] of [["GET", "/me/"], ["HEAD", "/ME"], ["POST", "/change-password/"], ["POST", "/CHANGE-PASSWORD"], ["POST", "/logout/"]]) {
    assert((await check(method, "/API/AUTH", route)).next, `${method} ${route}`);
  }
  for (const route of ["/me/other", "/change-password/other"]) {
    assert.equal((await check("POST", "/api/auth", route)).res.statusCode, 403);
  }
  console.log("PASS session/change/logout case and trailing-slash aliases; no blanket auth exemption");
  row.must_change_password = false;
  assert((await check("GET", "/api/patients", "/")).next);
  for (const headers of [{}, { cookie: "dental_session=%broken" }, { cookie: `dental_session=${jwt.sign({ id: user.id }, secret, { expiresIn: -1 })}` }]) assert.equal((await check("GET", "/api/patients", "/", headers)).res.statusCode, 401);
  assert((await check("GET", "/api/patients", "/", { authorization: `Bearer ${token}` })).next);
  let forwarded;
  const dbFailure = middleware({ query: async () => { throw new Error("db unavailable"); } });
  await dbFailure.authenticate({ headers: { cookie: `dental_session=${token}` } }, response(), error => { forwarded = error; });
  assert.equal(forwarded.message, "db unavailable");
  const change = browser(async () => reply(200, { user: { ...user, mustChangePassword: true } }));
  change.loadRoles();
  assert.equal(await change.roles.protectPage(), false);
  assert.equal(change.window.location.href, "cambiar-password.html");
  assert.equal(await change.roles.protectPage({ allowPasswordChange: true }), true);
  console.log("PASS live password-change flag enforced, exact exemptions, expired/malformed cookie rejected, DB outage not misreported as 401");

  const routes = new Map();
  const router = { post(route, ...handlers) { routes.set('POST ' + route, handlers); }, get(route, ...handlers) { routes.set('GET ' + route, handlers); } };
  const loginRow = { ...row, password_hash: await bcrypt.hash("only-test-password", 4), pin_hash: await bcrypt.hash("2468", 4), failed_pin_attempts: 0 };
  const context = {
    module: { exports: {} }, process: { env: { JWT_SECRET: secret } },
    require(name) {
      if (name === "express") return { Router: () => router };
      if (name === "express-rate-limit") return { rateLimit: () => (req, res, next) => next() };
      if (name === "../db") return { query: async sql => ({ rows: /SELECT/.test(sql) ? [loginRow] : [] }) };
      if (name === "../utils/asyncHandler") return handler => handler;
      if (name === "../middleware/auth") return guarded;
      if (name === "../utils/audit") return { writeAuditLog: async () => {} };
      if (name === "../utils/passwordPolicy") return require("../src/utils/passwordPolicy");
      return require(name);
    }
  };
  vm.runInNewContext(read("server/src/routes/auth.js"), context);
  const call = async (route, body, currentUser) => { const res = response(); await routes.get(route).at(-1)({ body, user: currentUser }, res); return res; };
  assert.equal((await call("POST /login", { username: "test", password: "wrong" })).statusCode, 401);
  assert.equal((await call("POST /login", {})).statusCode, 400);
  const signedIn = await call("POST /login", { username: "test", password: "only-test-password" });
  assert.equal(signedIn.statusCode, 200);
  assert.match(signedIn.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/);
  assert.equal(signedIn.body.token, undefined);
  assert.equal((await call("POST /pin-login", { pin: "12" })).statusCode, 400);
  assert.equal((await call("POST /pin-login", { pin: "9999" })).statusCode, 401);
  assert.equal((await call("POST /pin-login", { pin: "2468" })).statusCode, 200);
  const badCurrent = await call("POST /change-password", { currentPassword: "wrong", newPassword: "newpass123" }, user);
  assert.equal(badCurrent.statusCode, 401);
  assert.equal(badCurrent.body.code, "INVALID_CURRENT_PASSWORD");
  const me = await call("GET /me", {}, { ...user, mustChangePassword: true });
  assert.equal(me.headers['Cache-Control'], 'no-store');
  assert.equal(me.body.user.mustChangePassword, true);
  const out = await call("POST /logout", {});
  assert.equal(out.statusCode, 204);
  assert.match(out.headers['Set-Cookie'], /dental_session=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0/);
  context.process.env.NODE_ENV = "production";
  const secureLogin = await call("POST /login", { username: "test", password: "only-test-password" });
  assert.match(secureLogin.headers['Set-Cookie'], /; Secure$/);
  assert.match((await call("POST /logout", {})).headers['Set-Cookie'], /; Secure$/);
  console.log("PASS real auth handlers with mocked DB: login/PIN statuses, cookie flags unchanged, /me, logout cookie clearing");
  console.log("All WEB STABILITY 1.3 simulations passed. No DB, Docker or network used.");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
