const { createClient } = require("@supabase/supabase-js");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");

function failure(message, code) { return Object.assign(new Error(message), { code }); }

class SupabaseStorageProvider {
  #files;
  #secretKey;

  constructor({ url, secretKey, bucket, client } = {}) {
    for (const [name, value] of Object.entries({ SUPABASE_URL: url, SUPABASE_SECRET_KEY: secretKey, SUPABASE_STORAGE_BUCKET: bucket })) {
      if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
    }
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("Invalid SUPABASE_URL"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("SUPABASE_URL must be an HTTPS URL without credentials or query parameters");
    }
    this.#secretKey = secretKey;
    try {
      const supabase = client || createClient(url, secretKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
      });
      this.#files = supabase.storage.from(bucket);
      for (const method of ["upload", "download", "info", "remove"]) {
        if (typeof this.#files?.[method] !== "function") throw new Error(`Storage client must implement ${method}`);
      }
    } catch (error) { throw this.#safeError(error); }
  }

  #safeError(error) {
    const redact = value => String(value).split(this.#secretKey).join("[REDACTED]");
    const safe = new Error(redact(error?.message || "Supabase storage operation failed"));
    if (typeof error?.code === "string") safe.code = redact(error.code);
    if (/^\d{3}$/.test(String(error?.statusCode))) safe.statusCode = Number(error.statusCode);
    return safe;
  }

  async #call(method, ...args) {
    try {
      const result = await this.#files[method](...args);
      if (result.error) throw result.error;
      return result.data;
    } catch (error) { throw this.#safeError(error); }
  }

  #validate(key, version) {
    if (version != null) throw failure("Supabase provider does not support explicit versions", "INVALID_STORAGE_KEY");
    // Reject keys the SDK/URL layer would rewrite; never normalize object identity.
    if (typeof key !== "string" || !key || /[\\?#%\x00-\x1f]/.test(key)
      || key.split("/").some(part => !part || part === "." || part === "..")) {
      throw failure("Invalid storage key", "INVALID_STORAGE_KEY");
    }
  }

  async put({ key, stream, contentType, size, checksum, ifAbsent = true, version }) {
    this.#validate(key, version);
    if (size != null && (!Number.isSafeInteger(size) || size < 0)) throw failure("Invalid expected size", "STORAGE_INTEGRITY_ERROR");
    if (checksum != null && !/^[a-f0-9]{64}$/i.test(checksum)) throw failure("Expected SHA256 checksum", "STORAGE_INTEGRITY_ERROR");
    if (typeof ifAbsent !== "boolean") throw failure("Invalid ifAbsent", "STORAGE_INTEGRITY_ERROR");
    // Buffer before publication so failed/truncated input never creates a remote object.
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const digest = createHash("sha256").update(body).digest("hex");
    if (stream.truncated || (size != null && size !== body.length) || (checksum != null && checksum.toLowerCase() !== digest)) {
      throw failure("Incomplete or invalid storage upload", "STORAGE_INTEGRITY_ERROR");
    }
    await this.#call("upload", key, body, { upsert: !ifAbsent, ...(contentType ? { contentType } : {}) });
    return { key, size: body.length, checksum: digest, contentType };
  }

  async openRead({ key, version, start, end }) {
    this.#validate(key, version);
    if ([start, end].some(value => value != null && (!Number.isSafeInteger(value) || value < 0))
      || (end != null && end < (start ?? 0))) throw failure("Invalid byte range", "INVALID_STORAGE_RANGE");
    let blob;
    try { blob = await this.#call("download", key); }
    catch (error) {
      if (error.code === "NoSuchKey") throw failure("Storage object not found", "ENOENT");
      throw error;
    }
    if (!(blob instanceof Blob)) throw failure("Invalid storage download response", "INVALID_STORAGE_RESPONSE");
    return Readable.fromWeb(blob.slice(start ?? 0, end == null ? blob.size : end + 1).stream());
  }

  async stat({ key, version }) {
    this.#validate(key, version);
    let data;
    try { data = await this.#call("info", key); }
    catch (error) { if (error.code === "NoSuchKey") return null; throw error; }
    const modifiedAt = new Date(data?.lastModified);
    if (!Number.isSafeInteger(data?.size) || data.size < 0 || typeof data.lastModified !== "string" || !Number.isFinite(modifiedAt.getTime())) {
      throw failure("Storage metadata requires valid size and lastModified", "INVALID_STORAGE_RESPONSE");
    }
    return { key, size: data.size, modifiedAt,
      ...(data.contentType ? { contentType: data.contentType } : {}),
      ...(data.etag ? { etag: data.etag } : {}) };
  }

  async delete({ key, version }) {
    this.#validate(key, version);
    let data;
    try { data = await this.#call("remove", [key]); }
    catch (error) { if (error.code === "NoSuchKey") return false; throw error; }
    if (!Array.isArray(data)) throw failure("Invalid storage removal response", "INVALID_STORAGE_RESPONSE");
    return data.length > 0;
  }
}

module.exports = SupabaseStorageProvider;
