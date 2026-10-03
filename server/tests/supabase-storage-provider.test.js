const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const Provider = require("../src/storage/providers/SupabaseStorageProvider");

const config = { url: "https://storage.example.invalid", secretKey: "test-only-placeholder", bucket: "private-fixture" };
const key = "opaque-prefix/ABC-123.pdf";
const metadata = { size: 6, lastModified: "2026-01-01T00:00:00.000Z", contentType: "application/pdf", etag: "fixture-etag" };
function fixture(options = {}) {
  const calls = [];
  const results = { upload: { data: { path: key }, error: null },
    download: { data: new Blob(["abcdef"]), error: null },
    info: { data: { ...metadata }, error: null }, remove: { data: [{ name: key }], error: null } };
  const api = Object.fromEntries(Object.keys(results).map(method => [method, async (...args) => {
    calls.push({ method, args });
    if (results[method] instanceof Error) throw results[method];
    return results[method];
  }]));
  const buckets = [];
  const client = { storage: { from(bucket) { buckets.push(bucket); return api; } } };
  return { provider: new Provider({ ...config, ...options, client }), calls, results, buckets };
}
const bytes = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); };

test("constructor validates configuration and uses the injected configurable bucket", () => {
  const { buckets, calls, provider } = fixture({ bucket: "another-private-bucket" });
  assert.deepEqual(buckets, ["another-private-bucket"]);
  assert.deepEqual(calls, []);
  assert(!JSON.stringify(provider).includes(config.secretKey));
});

for (const [field, label] of [["url", "SUPABASE_URL"], ["secretKey", "SUPABASE_SECRET_KEY"], ["bucket", "SUPABASE_STORAGE_BUCKET"]]) {
  test(`missing ${field} fails before client creation`, () => {
    for (const value of [undefined, "", " "]) assert.throws(() => new Provider({ ...config, [field]: value }), { message: `${label} is required` });
  });
}

test("invalid or insecure URL fails without exposing configuration", () => {
  for (const url of ["invalid", "http://storage.example.invalid", "https://user:pass@storage.example.invalid", "https://storage.example.invalid?token=value"]) {
    assert.throws(() => new Provider({ ...config, url }), error => !error.message.includes(url));
  }
});

test("put preserves exact key/bytes/type, checks integrity and does not overwrite by default", async () => {
  const { provider, calls } = fixture();
  const checksum = createHash("sha256").update("abcdef").digest("hex");
  const object = await provider.put({ key, stream: Readable.from(["abc", "def"]), contentType: "application/pdf", size: 6, checksum });
  assert.deepEqual(object, { key, size: 6, checksum, contentType: "application/pdf" });
  assert.equal(calls[0].method, "upload");
  assert.equal(calls[0].args[0], key);
  assert.equal(calls[0].args[1].toString(), "abcdef");
  assert.deepEqual(calls[0].args[2], { upsert: false, contentType: "application/pdf" });
  await provider.put({ key, stream: Readable.from(["replacement"]), ifAbsent: false });
  assert.deepEqual(calls[1].args[2], { upsert: true });
});

test("incomplete uploads never call SDK or create a remote object", async () => {
  for (const options of [{ size: 99 }, { checksum: "0".repeat(64) }, { truncated: true }, { size: -1 }, { checksum: "invalid" }]) {
    const { provider, calls } = fixture();
    const stream = Readable.from(["abcdef"]);
    if (options.truncated) stream.truncated = true;
    await assert.rejects(provider.put({ key, stream, ...options }), { code: "STORAGE_INTEGRITY_ERROR" });
    assert.equal(calls.length, 0);
  }
  const { provider, calls } = fixture();
  const stream = Readable.from((async function* () { yield "partial"; throw new Error("stream failed"); })());
  await assert.rejects(provider.put({ key, stream }), /stream failed/);
  assert.equal(calls.length, 0);
});

test("private download becomes a Node readable with inclusive byte ranges", async () => {
  const { provider, calls } = fixture();
  assert.equal(await bytes(await provider.openRead({ key })), "abcdef");
  assert.equal(await bytes(await provider.openRead({ key, start: 1, end: 3 })), "bcd");
  assert.equal(await bytes(await provider.openRead({ key, end: 0 })), "a");
  assert(calls.every(call => call.method === "download" && call.args.length === 1 && call.args[0] === key));
  await assert.rejects(provider.openRead({ key, start: 5, end: 1 }), { code: "INVALID_STORAGE_RANGE" });
});

test("stat uses info for exactly one key and requires real size/timestamp", async () => {
  const { provider, calls, results } = fixture();
  assert.deepEqual(await provider.stat({ key }), { key, size: 6, modifiedAt: new Date(metadata.lastModified), contentType: metadata.contentType, etag: metadata.etag });
  assert.deepEqual(calls, [{ method: "info", args: [key] }]);
  for (const data of [null, {}, { ...metadata, size: -1 }, { ...metadata, lastModified: "invalid" }]) {
    results.info = { data, error: null };
    await assert.rejects(provider.stat({ key }), { code: "INVALID_STORAGE_RESPONSE" });
  }
});

test("delete requests only the specified object and missing delete is idempotent", async () => {
  const { provider, calls, results } = fixture();
  assert.equal(await provider.delete({ key }), true);
  assert.deepEqual(calls, [{ method: "remove", args: [[key]] }]);
  results.remove.data = [];
  assert.equal(await provider.delete({ key }), false);
});

test("only explicit missing-object errors normalize; missing buckets/permissions remain errors", async () => {
  const { provider, results } = fixture();
  for (const method of ["info", "download", "remove"]) results[method] = { data: null, error: { code: "NoSuchKey", message: "Object missing" } };
  assert.equal(await provider.stat({ key }), null);
  assert.equal(await provider.delete({ key }), false);
  await assert.rejects(provider.openRead({ key }), { code: "ENOENT" });
  for (const code of ["NoSuchBucket", "AccessDenied", "not_found", "InvalidJWT"]) {
    results.info.error = { code, message: "Unavailable" };
    await assert.rejects(provider.stat({ key }), { code });
  }
});

for (const [operation, method] of [["put", "upload"], ["openRead", "download"], ["stat", "info"], ["delete", "remove"]]) {
  test(`${operation} preserves returned and thrown SDK failures without secret leakage`, async () => {
    for (const thrown of [false, true]) {
      const { provider, results } = fixture();
      const error = Object.assign(new Error(`Failure ${config.secretKey}`), { code: "AccessDenied", statusCode: "403", request: { key: config.secretKey } });
      results[method] = thrown ? error : { data: null, error };
      await assert.rejects(provider[operation]({ key, stream: Readable.from(["bytes"]) }), actual => {
        assert.equal(actual.code, "AccessDenied");
        assert.equal(actual.statusCode, 403);
        assert(!actual.stack.includes(config.secretKey));
        assert(!JSON.stringify(actual).includes(config.secretKey));
        assert.equal(actual.cause, undefined);
        return true;
      });
    }
  });
}

test("keys are never normalized; SDK-rewritten keys and unsupported versions fail before calls", async () => {
  const { provider, calls } = fixture();
  for (const invalid of ["", "/key", "key/", "a//b", "a/../b", "a?query", "a#hash", "a%2Fb"]) {
    await assert.rejects(provider.stat({ key: invalid }), { code: "INVALID_STORAGE_KEY" });
  }
  for (const method of ["put", "openRead", "stat", "delete"]) {
    await assert.rejects(provider[method]({ key, version: "v1" }), { code: "INVALID_STORAGE_KEY" });
  }
  assert.equal(calls.length, 0);
});

test("installed SDK info/download/upload/remove integrate through a fake fetch with no network", async () => {
  const requests = [];
  const client = createClient(config.url, config.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/object/info/")) return new Response(JSON.stringify({ size: 6, last_modified: metadata.lastModified, content_type: metadata.contentType, etag: metadata.etag }), { headers: { "Content-Type": "application/json" } });
      if (options.method === "GET") return new Response("abcdef");
      if (options.method === "DELETE") return new Response(JSON.stringify([{ name: key }]), { headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ Id: "fixture", Key: key }), { headers: { "Content-Type": "application/json" } });
    } }
  });
  const provider = new Provider({ ...config, client });
  assert.equal((await provider.stat({ key })).modifiedAt.toISOString(), metadata.lastModified);
  assert.equal(await bytes(await provider.openRead({ key })), "abcdef");
  await provider.put({ key, stream: Readable.from(["abcdef"]), contentType: metadata.contentType });
  assert.equal(await provider.delete({ key }), true);
  assert.equal(requests.length, 4);
  assert(requests[0].url.endsWith(`/object/info/${config.bucket}/${key}`));
  assert.equal(requests[2].options.headers.get("x-upsert"), "false");
  assert.deepEqual(JSON.parse(requests[3].options.body), { prefixes: [key] });
});

test("provider imports only SDK/stream/crypto and has no public URL, filesystem, DB or manual HTTP", () => {
  const source = require("node:fs").readFileSync(require.resolve("../src/storage/providers/SupabaseStorageProvider"), "utf8");
  assert.deepEqual([...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]), ["@supabase/supabase-js", "node:stream", "node:crypto"]);
  assert.doesNotMatch(source, /getPublicUrl|createBucket|console\.|fetch\(|\.list\(/);
  assert(!source.includes(config.secretKey));
});
