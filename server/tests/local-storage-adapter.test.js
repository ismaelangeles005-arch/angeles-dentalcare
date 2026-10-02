const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable, PassThrough } = require("node:stream");
const { once } = require("node:events");
const LocalStorageAdapter = require("../src/storage/LocalStorageAdapter");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage: new LocalStorageAdapter(root) };
}

async function bytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test("local adapter reads legacy stored_name without renaming and deletes idempotently", async t => {
  const { root, storage } = fixture(t);
  const key = "5aaaac0a-0339-40c1-b340-f1d9d55be11e.pdf";
  fs.writeFileSync(path.join(root, key), "legacy fixture");
  assert.equal(await bytes(await storage.openRead({ key })), "legacy fixture");
  assert.equal((await storage.stat({ key })).size, 14);
  assert.equal(await bytes(await storage.openRead({ key, start: 0, end: 5 })), "legacy");
  assert.equal(await storage.delete({ key }), true);
  assert.equal(await storage.delete({ key }), false);
  assert.equal(await storage.stat({ key }), null);
  await assert.rejects(storage.openRead({ key }), { code: "ENOENT" });
});

test("put checks bytes/checksum and atomically publishes only complete files", async t => {
  const { root, storage } = fixture(t);
  const input = new PassThrough();
  const promise = storage.put({ key: "new.pdf", stream: input, size: 6,
    checksum: crypto.createHash("sha256").update("abcdef").digest("hex"), contentType: "application/pdf" });
  input.write("abc");
  assert.equal(fs.existsSync(path.join(root, "new.pdf")), false);
  input.end("def");
  const result = await promise;
  assert.equal(result.size, 6);
  assert.equal(result.contentType, "application/pdf");
  assert.equal(await bytes(await storage.openRead({ key: "new.pdf" })), "abcdef");
  assert.deepEqual(fs.readdirSync(root), ["new.pdf"]);
});

test("concurrent ifAbsent writes publish one object without overwriting", async t => {
  const { root, storage } = fixture(t);
  const results = await Promise.allSettled(["first", "second"].map(value =>
    storage.put({ key: "same.pdf", stream: Readable.from([value]), ifAbsent: true })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "EEXIST");
  const previous = fs.readFileSync(path.join(root, "same.pdf"));
  await assert.rejects(storage.put({ key: "same.pdf", stream: Readable.from(["replacement"]), ifAbsent: true }), { code: "EEXIST" });
  assert.deepEqual(fs.readFileSync(path.join(root, "same.pdf")), previous);
  assert.deepEqual(fs.readdirSync(root), ["same.pdf"]);
});

test("size/checksum/truncation and stream failures remove all temporary objects", async t => {
  const { root, storage } = fixture(t);
  for (const extra of [{ size: 99 }, { checksum: "0".repeat(64) }, { truncated: true }]) {
    const stream = Readable.from(["content"]);
    if (extra.truncated) stream.truncated = true;
    await assert.rejects(storage.put({ key: "failed.pdf", stream, ...extra }), { code: "STORAGE_INTEGRITY_ERROR" });
    assert.deepEqual(fs.readdirSync(root), []);
  }
  const stream = Readable.from((async function* () { yield "partial"; throw new Error("fixture read failure"); })());
  await assert.rejects(storage.put({ key: "failed.pdf", stream }), /fixture read failure/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("all operations reject traversal, absolute paths and Windows path aliases", async t => {
  const { storage } = fixture(t);
  const invalid = ["../outside.pdf", "a/../outside.pdf", "/outside.pdf", "C:\\outside.pdf",
    "C:outside.pdf", "\\\\host\\share\\file.pdf", "a\\..\\file.pdf", "a//b.pdf", "./file.pdf",
    "file.pdf:stream", ".. /file.pdf", "file.pdf.", "NUL.pdf", "file\u0000.pdf"];
  for (const key of invalid) {
    for (const operation of ["stat", "openRead", "delete"]) {
      await assert.rejects(storage[operation]({ key }), { code: "INVALID_STORAGE_KEY" });
    }
    await assert.rejects(storage.put({ key, stream: Readable.from(["x"]) }), { code: "INVALID_STORAGE_KEY" });
  }
});

test("symlink/junction parent cannot expose, modify or delete external files", async t => {
  const { root, storage } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "maelven-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "private.pdf"), "private");
  fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  for (const operation of ["stat", "openRead", "delete"]) {
    await assert.rejects(storage[operation]({ key: "escape/private.pdf" }), { code: "INVALID_STORAGE_KEY" });
  }
  await assert.rejects(storage.put({ key: "escape/new.pdf", stream: Readable.from(["x"]) }), { code: "INVALID_STORAGE_KEY" });
  assert.equal(fs.readFileSync(path.join(outside, "private.pdf"), "utf8"), "private");
  assert.deepEqual(fs.readdirSync(outside), ["private.pdf"]);
});

test("cancelled reads close their handles and cancelled uploads clean temporary files", async t => {
  const { root, storage } = fixture(t);
  await storage.put({ key: "read.pdf", stream: Readable.from([Buffer.alloc(1024 * 1024)]) });
  const read = await storage.openRead({ key: "read.pdf" });
  const closed = once(read, "close");
  read.destroy();
  await closed;
  assert.equal(read.closed, true);
  await storage.delete({ key: "read.pdf" });
  const input = new PassThrough();
  const writing = storage.put({ key: "cancelled.pdf", stream: input });
  const rejected = assert.rejects(writing, /cancelled/);
  input.write("partial");
  setTimeout(() => input.destroy(new Error("cancelled")), 20);
  await rejected;
  assert.deepEqual(fs.readdirSync(root), []);
});
