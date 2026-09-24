const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { clientIpRateLimitOptions } = require("../src/config/client-ip");
const enabled = { NODE_ENV: "production", RENDER: "true", TRUST_PROXY: "false",
  TRUSTED_CLIENT_IP_SOURCE: "cf-connecting-ip" };

test("CF source requires explicit production Render configuration", () => {
  assert.deepEqual(clientIpRateLimitOptions({ NODE_ENV: "development" }), {});
  assert.deepEqual(clientIpRateLimitOptions({ NODE_ENV: "production", RENDER: "true" }), {});
  for (const env of [{ ...enabled, RENDER: "false" }, { ...enabled, NODE_ENV: "development" },
    { ...enabled, TRUSTED_CLIENT_IP_SOURCE: "x-forwarded-for" }, { ...enabled, TRUST_PROXY: "true" },
    { ...enabled, TRUST_PROXY: "1" }, { ...enabled, TRUST_PROXY: "127.0.0.1" }]) {
    assert.throws(() => clientIpRateLimitOptions(env));
  }
});

test("valid CF addresses, invalid/missing fallback and XFF spoofing", () => {
  const { keyGenerator } = clientIpRateLimitOptions(enabled);
  const request = header => ({ headers: { "cf-connecting-ip": header, "x-forwarded-for": "1.1.1.1" },
    socket: { remoteAddress: "192.0.2.10" }, ip: "203.0.113.99" });
  assert.equal(keyGenerator(request("203.0.113.1")), "203.0.113.1");
  for (const header of [undefined, "", "invalid", "1.2.3.4, 5.6.7.8", ["1.2.3.4"], "::1%zone", "1.2.3.4:80"]) {
    assert.equal(keyGenerator(request(header)), "192.0.2.10");
  }
  assert.equal(keyGenerator(request("2001:db8::1")), ipKeyGenerator("2001:db8::2"));
  assert.equal(keyGenerator(request("::ffff:203.0.113.1")), keyGenerator(request("203.0.113.1")));
  assert.equal(keyGenerator({ headers: {}, socket: {} }), "unidentified-peer");
});

test("Render buckets are client-specific without proxy warnings; local ignores arbitrary headers", async () => {
  for (const render of [true, false]) {
    const errors = [];
    const oldError = console.error;
    console.error = error => errors.push(error.code || String(error));
    const app = express();
    app.set("trust proxy", false);
    app.use(rateLimit({ windowMs: 60000, limit: 2,
      ...clientIpRateLimitOptions(render ? enabled : { NODE_ENV: "development" }) }));
    app.get("/", (req, res) => res.json({ ip: req.ip, secure: req.secure }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    async function call(ip, xff) {
      const headers = { "cf-connecting-ip": ip, "x-forwarded-proto": "https" };
      if (xff) headers["x-forwarded-for"] = xff;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
      const body = await response.text();
      if (response.status === 200) assert.deepEqual(JSON.parse(body), { ip: "127.0.0.1", secure: false });
      return response.status;
    }
    try {
      assert.equal(await call("203.0.113.1", render ? "1.1.1.1" : undefined), 200);
      assert.equal(await call("203.0.113.1", render ? "8.8.8.8" : undefined), 200);
      assert.equal(await call("203.0.113.1"), 429);
      assert.equal(await call("203.0.113.2"), render ? 200 : 429);
      assert.deepEqual(errors, []);
    } finally {
      console.error = oldError;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test("all three production limiters share the same options", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const server = fs.readFileSync(path.resolve(__dirname, "../src/server.js"), "utf8");
  const auth = fs.readFileSync(path.resolve(__dirname, "../src/routes/auth.js"), "utf8");
  assert.equal((server.match(/\.\.\.clientIpRateLimitOptions\(\)/g) || []).length, 1);
  assert.equal((auth.match(/\.\.\.clientIpRateLimitOptions\(\)/g) || []).length, 2);
  assert(!server.includes("validate: false"));
  assert(!auth.includes("validate: false"));
});
