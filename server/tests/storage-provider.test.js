const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const createStorageAdapter = require("../src/storage/createStorageAdapter");
const LocalStorageAdapter = require("../src/storage/LocalStorageAdapter");
const StorageAdapter = require("../src/storage/StorageAdapter");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-provider-"));
  const localRoot = path.join(directory, "root");
  fs.mkdirSync(localRoot);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, localRoot };
}

for (const provider of ["local", undefined]) {
  test(`provider ${provider ?? "omitted"} returns the existing local adapter and contract`, t => {
    const { localRoot } = fixture(t);
    const adapter = createStorageAdapter({ localRoot, ...(provider === undefined ? {} : { provider }) });
    assert(adapter instanceof LocalStorageAdapter);
    assert(adapter instanceof StorageAdapter);
    assert.equal(adapter.root, fs.realpathSync(localRoot));
    for (const method of ["put", "openRead", "stat", "delete"]) {
      assert.equal(typeof adapter[method], "function");
      assert.equal(adapter[method], LocalStorageAdapter.prototype[method]);
    }
    assert.deepEqual(Object.getOwnPropertyNames(StorageAdapter.prototype), ["constructor", "put", "openRead", "stat", "delete"]);
    assert.deepEqual(fs.readdirSync(localRoot), []);
  });
}

test("unsupported providers fail explicitly before accessing a local root", () => {
  for (const provider of ["unknown", "s3", "r2", "supabase", "LOCAL", "", null]) {
    assert.throws(() => createStorageAdapter({ provider }), { message: `Unsupported storage provider: ${provider}` });
  }
});

test("cloud selection fails without configuration and never falls back to local", () => {
  assert.throws(() => createStorageAdapter({ provider: "cloud", env: {} }), {
    message: "SUPABASE_URL is required"
  });
});

test("cloud factory composes Supabase from explicit environment without a network call", () => {
  const vm = require("node:vm");
  const { createRequire } = require("node:module");
  const CloudStorageAdapter = require("../src/storage/CloudStorageAdapter");
  const providerFile = require.resolve("../src/storage/providers/SupabaseStorageProvider");
  const providerModule = { exports: {} };
  const env = { SUPABASE_URL: "https://storage.example.invalid", SUPABASE_SECRET_KEY: "test-only-placeholder", SUPABASE_STORAGE_BUCKET: "test-private" };
  const calls = [];
  const actualRequire = createRequire(providerFile);
  vm.runInNewContext(fs.readFileSync(providerFile, "utf8"), { module: providerModule, URL,
    require(name) {
      if (name === "@supabase/supabase-js") return { createClient(url, key, options) {
        calls.push({ url, key, options });
        return { storage: { from(bucket) { assert.equal(bucket, env.SUPABASE_STORAGE_BUCKET);
          return { upload() {}, download() {}, info() {}, remove() {} }; } } };
      } };
      return actualRequire(name);
    }
  });
  const factoryModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/storage/createStorageAdapter"), "utf8"), {
    module: factoryModule, require(name) {
      if (name === "./LocalStorageAdapter") return LocalStorageAdapter;
      if (name === "./CloudStorageAdapter") return CloudStorageAdapter;
      if (name === "./providers/SupabaseStorageProvider") return providerModule.exports;
      throw new Error("Unexpected dependency");
    }
  });
  const storage = factoryModule.exports({ provider: "cloud", env });
  assert(storage instanceof CloudStorageAdapter);
  assert(storage.provider instanceof providerModule.exports);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, env.SUPABASE_URL);
  assert.equal(calls[0].key, env.SUPABASE_SECRET_KEY);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
});

test("local provider preserves put/read/range/stat/delete behavior within the supplied root", async t => {
  const { localRoot } = fixture(t);
  const adapter = createStorageAdapter({ localRoot });
  const object = await adapter.put({ key: "sample.pdf", stream: Readable.from(["abcdef"]), contentType: "application/pdf" });
  assert.equal(object.key, "sample.pdf");
  assert.equal(object.size, 6);
  assert.equal(object.contentType, "application/pdf");
  assert.equal((await adapter.stat({ key: object.key })).size, 6);
  const chunks = [];
  for await (const chunk of await adapter.openRead({ key: object.key, start: 1, end: 3 })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "bcd");
  assert.deepEqual(fs.readdirSync(localRoot), ["sample.pdf"]);
  assert.equal(await adapter.delete({ key: object.key }), true);
  assert.equal(await adapter.stat({ key: object.key }), null);
  assert.deepEqual(fs.readdirSync(localRoot), []);
});

test("factory adapter cannot read, overwrite or delete outside the supplied root", async t => {
  const { directory, localRoot } = fixture(t);
  const outside = path.join(directory, "outside.pdf");
  fs.writeFileSync(outside, "unchanged");
  const adapter = createStorageAdapter({ localRoot });
  for (const key of ["../outside.pdf", outside]) {
    for (const method of ["stat", "openRead", "delete"]) {
      await assert.rejects(adapter[method]({ key }), { code: "INVALID_STORAGE_KEY" });
    }
    await assert.rejects(adapter.put({ key, stream: Readable.from(["overwrite"]) }), { code: "INVALID_STORAGE_KEY" });
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
  assert.deepEqual(fs.readdirSync(localRoot), []);
});
