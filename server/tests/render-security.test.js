const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const net = require("node:net");
const { createRequire } = require("node:module");
const { Client } = require("pg");
const { poolOptions } = require("../src/config/deployment");

const production = { NODE_ENV: "production", DATABASE_URL: "postgres://db.example.test/review" };

test("updated IP parser preserves rate-limit keys without adding an SSRF consumer", () => {
  const { ipKeyGenerator } = require("express-rate-limit");
  assert.equal(ipKeyGenerator("192.0.2.1"), "192.0.2.1");
  assert.equal(ipKeyGenerator("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(ipKeyGenerator("2001:db8::1"), ipKeyGenerator("2001:db8::2"));
  assert.throws(() => new (require("ip-address").Address4)("0127.0.0.1"));
});

test("updated query parser handles ordinary and adversarial input without prototype mutation", () => {
  const qs = require("qs");
  assert.deepEqual(qs.parse("page=1&filter[name]=test"), { page: "1", filter: { name: "test" } });
  assert.doesNotThrow(() => qs.parse("a[isBuffer]=x&a[0]=x&__proto__[polluted]=true"));
  assert.equal({}.polluted, undefined);
});

test("TLS modes are explicit and remote production never disables encryption", () => {
  assert.deepEqual(poolOptions({ ...production, PG_TLS: "require" }).ssl, { rejectUnauthorized: false });
  assert.deepEqual(poolOptions({ ...production, PG_TLS: "verify-full" }).ssl, { rejectUnauthorized: true });
  assert.equal(poolOptions(production).ssl.rejectUnauthorized, true);
  assert.equal(poolOptions({ PG_TLS: "disable" }).ssl, false);
  assert.equal(poolOptions({ DATABASE_URL: "postgres://localhost:5433/local" }).ssl, false);
  assert.throws(() => poolOptions({ ...production, PG_TLS: "disable" }), /Remote production/);
  for (const mode of ["verfy-full", "prefer", "REQUIRE", " require"]) {
    assert.throws(() => poolOptions({ ...production, PG_TLS: mode }), /Invalid PG_TLS/);
  }
});

test("CA configuration and URL SSL conflicts fail closed", () => {
  const missing = path.join(os.tmpdir(), `missing-ca-${require("crypto").randomUUID()}.pem`);
  assert.throws(() => poolOptions({ ...production, PG_TLS_CA_FILE: missing }), /ENOENT/);
  for (const mode of ["require", "disable"]) {
    assert.throws(() => poolOptions({ PG_TLS: mode, PG_TLS_CA_FILE: missing }), /requires PG_TLS=verify-full/);
  }
  for (const key of ["sslmode", "sslcert", "sslrootcert", "uselibpqcompat"]) {
    assert.throws(() => poolOptions({ ...production, PG_TLS: "require",
      DATABASE_URL: production.DATABASE_URL + `?${key}=require` }), /Use PG_TLS/);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-ca-test-"));
  try {
    const ca = path.join(temp, "ca.pem");
    fs.writeFileSync(ca, "CA configuration fixture, not a certificate");
    assert.equal(poolOptions({ ...production, PG_TLS_CA_FILE: ca }).ssl.ca, fs.readFileSync(ca, "utf8"));
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test("pg require rejects a server refusing SSL without plaintext startup or reconnect", async () => {
  let connections = 0;
  const packets = [];
  const server = net.createServer(socket => {
    connections++;
    socket.on("data", data => { packets.push(Buffer.from(data)); socket.end("N"); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new Client({ ...poolOptions({ PG_TLS: "require" }),
    host: "127.0.0.1", port: server.address().port, user: "test", database: "test",
    connectionTimeoutMillis: 2000 });
  try {
    await assert.rejects(client.connect(), /does not support SSL/);
    assert.equal(connections, 1);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].length, 8);
    assert.equal(packets[0].readInt32BE(4), 80877103);
  } finally {
    await client.end();
    await new Promise(resolve => server.close(resolve));
  }
});

test("pg forwards TLS verification and hostname to the native TLS transport", () => {
  const file = require.resolve("pg/lib/connection");
  const actualRequire = createRequire(file);
  for (const mode of ["require", "verify-full"]) {
    let options;
    const secure = new (require("node:events").EventEmitter)();
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      Buffer, module, exports: module.exports,
      require(name) {
        if (name === "./stream") return { getSecureStream(value) { options = value; return secure; } };
        return actualRequire(name);
      }
    });
    const raw = {};
    const connection = new module.exports({ stream: raw, ssl: poolOptions({ ...production, PG_TLS: mode }).ssl });
    connection.upgradeToSSL("db.example.test", () => {});
    assert.equal(options.socket, raw);
    assert.equal(options.servername, "db.example.test");
    assert.equal(options.rejectUnauthorized, mode === "verify-full");
    assert.equal(options.checkServerIdentity, undefined); // Node's default hostname verification stays intact.
  }
});

test("patient upload route preserves PDF uploads, MIME/size limits and handles malformed fields", async () => {
  const express = require("express");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-upload-test-"));
  const file = path.resolve(__dirname, "../src/routes/patientFiles.js");
  const actualRequire = createRequire(file);
  const module = { exports: {} };
  let inserts = 0;
  const fakeDb = { async query(sql) {
    if (sql.includes("FROM patients")) return { rows: [{ id: "patient" }] };
    if (sql.includes("INSERT INTO patient_files")) { inserts++; return { rows: [{ id: "file" }] }; }
    throw new Error("Unexpected database operation in isolated test");
  } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports, console, Buffer,
    require(name) {
      if (name === "../db") return fakeDb;
      if (name === "../config/deployment") return { patientFilesDirectory: () => temp };
      if (name === "../middleware/auth") return {
        authenticate(req, res, next) { req.user = { id: "user", organizationId: "org" }; next(); },
        allowRoles: () => (req, res, next) => next()
      };
      return actualRequire(name);
    }
  });
  const app = express();
  app.use("/files", module.exports);
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "REJECTED" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/files`;
  async function upload(type, size, name = "file") {
    const form = new FormData();
    form.append(name, new Blob([Buffer.alloc(size)], { type }), "fixture.pdf");
    const response = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    return response.status;
  }
  try {
    assert.equal(await upload("application/pdf", 32), 201);
    assert.equal(inserts, 1);
    assert.equal(await upload("text/plain", 32), 400);
    assert.equal(await upload("application/pdf", 10 * 1024 * 1024 + 1), 400);
    assert.equal(await upload("application/pdf", 32, "file[999999999]"), 400);
    for (const name of ["__proto__[x]", "field[999999999]"]) {
      const form = new FormData(); form.append(name, "x");
      const response = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      assert.equal(response.status, 400);
    }
    assert.equal(await upload("application/pdf", 32), 201);
    assert.equal(inserts, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true });
  }
});
