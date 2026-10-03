const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const vm = require("node:vm");
const CloudStorageAdapter = require("../src/storage/CloudStorageAdapter");
const StorageAdapter = require("../src/storage/StorageAdapter");

function fakeProvider() {
  return {
    objects: new Map(), calls: [],
    async put(options) {
      this.calls.push(["put", options]);
      const chunks = [];
      for await (const chunk of options.stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const metadata = { key: options.key, size: bytes.length, contentType: options.contentType,
        checksum: options.checksum, modifiedAt: new Date("2026-01-01T00:00:00Z") };
      this.objects.set(options.key, { bytes, metadata });
      return metadata;
    },
    async openRead(options) {
      this.calls.push(["openRead", options]);
      const object = this.objects.get(options.key);
      if (!object) throw Object.assign(new Error("Object not found"), { code: "ENOENT" });
      return Readable.from([object.bytes.subarray(options.start ?? 0, options.end == null ? undefined : options.end + 1)]);
    },
    async stat(options) {
      this.calls.push(["stat", options]);
      return this.objects.get(options.key)?.metadata ?? null;
    },
    async delete(options) {
      this.calls.push(["delete", options]);
      return this.objects.delete(options.key);
    }
  };
}

test("valid injected provider constructs a StorageAdapter without I/O", () => {
  const provider = fakeProvider();
  assert(new CloudStorageAdapter({ provider }) instanceof StorageAdapter);
  assert.deepEqual(provider.calls, []);
});

test("missing and invalid providers fail explicitly", () => {
  assert.throws(() => new CloudStorageAdapter(), /provider is required/);
  assert.throws(() => new CloudStorageAdapter({ provider: null }), /provider is required/);
  for (const provider of ["cloud", true, 7]) {
    assert.throws(() => new CloudStorageAdapter({ provider }), /Invalid cloud storage provider/);
  }
});

test("each missing provider operation is rejected at construction", () => {
  for (const method of ["put", "openRead", "stat", "delete"]) {
    const provider = fakeProvider();
    provider[method] = null;
    assert.throws(() => new CloudStorageAdapter({ provider }), {
      message: `Cloud storage provider must implement ${method}()`
    });
  }
});

test("in-memory lifecycle preserves opaque keys, metadata, ranges and missing-object semantics", async () => {
  const provider = fakeProvider();
  const adapter = new CloudStorageAdapter({ provider });
  const key = "objects/opaque-id%2F+ Mixed_CASE";
  const options = { key, stream: Readable.from(["abcdef"]), contentType: "application/pdf", size: 6,
    checksum: "fixture-checksum", ifAbsent: true };
  const result = await adapter.put(options);
  assert.strictEqual(provider.calls[0][1], options);
  assert.equal(result.key, key);
  assert.equal(result.size, 6);
  assert.equal(result.contentType, options.contentType);
  assert.equal(result.checksum, options.checksum);
  assert.strictEqual(await adapter.stat({ key }), result);
  const chunks = [];
  for await (const chunk of await adapter.openRead({ key, start: 1, end: 3 })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "bcd");
  assert.equal(await adapter.delete({ key }), true);
  assert.equal(await adapter.delete({ key }), false);
  assert.equal(await adapter.stat({ key }), null);
  await assert.rejects(adapter.openRead({ key }), { code: "ENOENT" });
  assert(provider.calls.every(([, args]) => args.key === key));
});

for (const method of ["put", "openRead", "stat", "delete"]) {
  test(`${method} preserves options, provider this and exact result`, async () => {
    const provider = fakeProvider();
    const options = { key: "opaque", version: "v1", start: 0, end: 5, ifAbsent: false };
    const result = method === "openRead" ? Readable.from(["bytes"]) : { marker: method };
    provider[method] = function (received) {
      assert.strictEqual(this, provider);
      assert.strictEqual(received, options);
      return result;
    };
    assert.strictEqual(await new CloudStorageAdapter({ provider })[method](options), result);
  });
  test(`${method} propagates sync and async provider errors without fallback`, async () => {
    for (const asyncFailure of [false, true]) {
      const provider = fakeProvider();
      const error = Object.assign(new Error("Provider unavailable"), { code: "PROVIDER_FAILURE" });
      provider[method] = () => { if (asyncFailure) return Promise.reject(error); throw error; };
      const adapter = new CloudStorageAdapter({ provider });
      const promise = adapter[method]({ key: "opaque" });
      assert(promise instanceof Promise);
      await assert.rejects(promise, actual => actual === error);
      assert.equal(provider.calls.length, 0);
    }
  });
}

test("adapter loads and delegates with no filesystem, network, DB or SDK dependencies", async () => {
  const source = fs.readFileSync(require.resolve("../src/storage/CloudStorageAdapter"), "utf8");
  const imports = [];
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require(name) {
    imports.push(name);
    assert.equal(name, "./StorageAdapter");
    return StorageAdapter;
  } });
  const adapter = new module.exports({ provider: fakeProvider() });
  await adapter.put({ key: "opaque", stream: Readable.from(["bytes"]) });
  assert.equal((await adapter.stat({ key: "opaque" })).size, 5);
  for await (const chunk of await adapter.openRead({ key: "opaque" })) assert.equal(chunk.toString(), "bytes");
  assert.equal(await adapter.delete({ key: "opaque" }), true);
  assert.deepEqual(imports, ["./StorageAdapter"]);
});
