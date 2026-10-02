const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const StorageAdapter = require("./StorageAdapter");

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_STORAGE_KEY" });
}

class LocalStorageAdapter extends StorageAdapter {
  constructor(root) {
    super();
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory()) throw invalid("Storage root must be a directory");
  }

  async confinedPath(key, version) {
    if (version != null) throw invalid("Local storage does not support versions");
    if (typeof key !== "string" || !key || path.isAbsolute(key) || path.win32.isAbsolute(key)
      || /[\\:\x00-\x1f]/.test(key)) throw invalid("Invalid storage key");
    const segments = key.split("/");
    if (segments.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid("Invalid storage key");
    const rootInfo = await fs.promises.lstat(this.root);
    if (rootInfo.isSymbolicLink() || await fs.promises.realpath(this.root) !== this.root) {
      throw invalid("Storage root changed");
    }
    let target = this.root;
    for (let i = 0; i < segments.length; i++) {
      target = path.join(target, segments[i]);
      let info;
      try { info = await fs.promises.lstat(target); }
      catch (error) {
        if (error.code === "ENOENT" && i === segments.length - 1) return target;
        throw error;
      }
      if (info.isSymbolicLink() || (i < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw invalid("Storage links and non-regular objects are not allowed");
      }
      const relative = path.relative(this.root, await fs.promises.realpath(target));
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw invalid("Storage key escapes root");
      }
    }
    return target;
  }

  async put({ key, stream, contentType, size, checksum, ifAbsent = true }) {
    const target = await this.confinedPath(key);
    if (size != null && (!Number.isSafeInteger(size) || size < 0)) throw invalid("Invalid expected size");
    if (checksum != null && !/^[a-f0-9]{64}$/i.test(checksum)) throw invalid("Expected SHA256 checksum");
    const temporary = path.join(this.root, `.upload-${crypto.randomUUID()}.tmp`);
    let bytes = 0;
    const hash = crypto.createHash("sha256");
    const meter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(stream, meter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const digest = hash.digest("hex");
      if (stream.truncated || (size != null && size !== bytes)
        || (checksum != null && checksum.toLowerCase() !== digest)) {
        throw Object.assign(new Error("Incomplete or invalid storage upload"), { code: "STORAGE_INTEGRITY_ERROR" });
      }
      await this.confinedPath(key);
      // A hard link publishes the completed inode atomically without replacing another object.
      if (ifAbsent) await fs.promises.link(temporary, target);
      else await fs.promises.rename(temporary, target);
      return { key, size: bytes, checksum: digest, contentType };
    } finally {
      await fs.promises.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async openRead({ key, version, start, end }) {
    const target = await this.confinedPath(key, version);
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      await this.confinedPath(key, version);
      const current = await fs.promises.lstat(target);
      if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) throw invalid("Storage object changed");
      return handle.createReadStream({ autoClose: true, start, end });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async stat({ key, version }) {
    const target = await this.confinedPath(key, version);
    try {
      const info = await fs.promises.lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw invalid("Invalid storage object");
      return { key, size: info.size, modifiedAt: info.mtime };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async delete({ key, version }) {
    const target = await this.confinedPath(key, version);
    try { await fs.promises.unlink(target); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
}

module.exports = LocalStorageAdapter;
