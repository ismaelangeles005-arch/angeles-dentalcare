const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const express = require("express");
const { buildWeb, safeName, validateReferences } = require("../../scripts/build-web");
const files = require("../src/config/public-web-files");
const { frontendDirectory } = require("../src/config/deployment");
const root = path.resolve(__dirname, "../..");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-public-build-"));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert(path.basename(absolute).startsWith("maelven-public-build-"));
    fs.rmSync(absolute, { recursive: true });
  });
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  return fs.realpathSync(dir);
}

test("deterministic build, exact allowlist and production artifact acceptance", t => {
  const dir = fixture(t);
  const first = buildWeb(dir);
  const second = buildWeb(dir);
  assert.deepEqual(second, first);
  assert.equal(first.count, 23);
  assert.equal(frontendDirectory({ NODE_ENV: "production", FRONTEND_ROOT: path.join(dir, "public-web") }), path.join(dir, "public-web"));
});

test("traversal, private names and absolute paths rejected", () => {
  for (const name of ["../api.js", "/api.js", "images/../api.js", "C:/api.js", "images\\api.js", ".env", "server/foo.js", "package.json", "dump.sql"]) {
    assert.throws(() => safeName(name));
  }
});

test("unowned output is never deleted", t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, "public-web"));
  const sentinel = path.join(dir, "public-web", "keep.txt");
  fs.writeFileSync(sentinel, "keep");
  assert.throws(() => buildWeb(dir));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("modified output or forbidden added content fails closed", t => {
  const dir = fixture(t);
  buildWeb(dir);
  fs.appendFileSync(path.join(dir, "public-web", "index.html"), "manual edit");
  assert.throws(() => buildWeb(dir), /modified/);
  const secret = path.join(dir, "public-web", ".env");
  fs.writeFileSync(secret, "QA_ONLY");
  assert.throws(() => buildWeb(dir), /Unexpected output/);
  assert.equal(fs.readFileSync(secret, "utf8"), "QA_ONLY");
});

test("missing input and missing HTML assets fail before deleting previous build", t => {
  const dir = fixture(t);
  buildWeb(dir);
  const receipt = fs.readFileSync(path.join(dir, ".public-web-build.json"), "utf8");
  fs.renameSync(path.join(dir, "api.js"), path.join(dir, "api.saved"));
  assert.throws(() => buildWeb(dir), /ENOENT/);
  fs.renameSync(path.join(dir, "api.saved"), path.join(dir, "api.js"));
  fs.appendFileSync(path.join(dir, "index.html"), '<img src="missing.svg">');
  assert.throws(() => buildWeb(dir), /Missing\/non-public asset/);
  assert.equal(fs.readFileSync(path.join(dir, ".public-web-build.json"), "utf8"), receipt);
});

test("output and source parent links are rejected without touching their targets", t => {
  const dir = fixture(t);
  const target = path.join(dir, "link-target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "keep");
  fs.symlinkSync(target, path.join(dir, "public-web"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => buildWeb(dir), /output link/);
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep");
  const other = fixture(t);
  fs.renameSync(path.join(other, "images"), path.join(other, "real-images"));
  fs.symlinkSync(path.join(other, "real-images"), path.join(other, "images"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => buildWeb(other), /contains a link/);
});

test("references include query strings, CSS and reject traversal/HTTP", t => {
  const dir = fixture(t);
  fs.appendFileSync(path.join(dir, "index.html"), '<img src="/images/maelven-dental-logo.svg?v=1"><style>a{background:url(images/maelven-dental-logo.svg)}</style>');
  assert(validateReferences(dir, files) > 0);
  fs.appendFileSync(path.join(dir, "index.html"), '<img src="../private.svg">');
  assert.throws(() => validateReferences(dir, files), /traversal/);
  fs.writeFileSync(path.join(dir, "index.html"), '<img src="http://example.test/a.svg">');
  assert.throws(() => validateReferences(dir, files), /Unsupported asset/);
});

test("published API defaults to same-origin despite stale localStorage", async () => {
  const context = vm.createContext({ window: {}, URL, FormData, AbortController,
    localStorage: { getItem: () => "http://localhost:3001/api" },
    fetch: async url => { assert.equal(url, "/api/procedures"); return { ok: true, status: 200, json: async () => [] }; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "public-web/api.js"), "utf8"), context);
  await vm.runInContext("DentalApi.getProcedures()", context);
});

test("HTTP artifact QA: every public file 200; private/traversal paths 404", async () => {
  const artifact = frontendDirectory({ NODE_ENV: "production", FRONTEND_ROOT: path.join(root, "public-web") });
  const app = express();
  app.use(express.static(artifact, { extensions: ["html"], index: "index.html", maxAge: 0 }));
  app.use((req, res) => res.sendStatus(404));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  function request(route) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port: server.address().port, path: route, agent: false }, res => {
        const data = []; res.on("data", chunk => data.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(data) }));
      });
      req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("HTTP QA timeout")));
    });
  }
  try {
    assert.deepEqual((await request("/")).body, fs.readFileSync(path.join(artifact, "index.html")));
    for (const file of files) {
      const result = await request("/" + file);
      assert.equal(result.status, 200, file);
      assert.deepEqual(result.body, fs.readFileSync(path.join(artifact, file)), file);
    }
    for (const route of ["/.env", "/.git/config", "/server/src/server.js", "/database/schema.sql", "/scripts/database-migrate.ps1", "/backups/", "/package.json", "/../server/.env", "/%2e%2e/server/.env", "/.public-web-build.json"]) {
      assert.equal((await request(route)).status, 404, route);
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
  }
});
