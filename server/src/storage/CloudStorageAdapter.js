const StorageAdapter = require("./StorageAdapter");

// The injected provider implements StorageAdapter's options and results unchanged:
// put publishes complete bytes and honors size/checksum/ifAbsent;
// openRead returns a readable stream honoring version/start/end (missing: ENOENT);
// stat returns { key, size, modifiedAt: Date } or null; delete tolerates missing keys.
// Providers must reject unsupported options, not silently ignore them.
class CloudStorageAdapter extends StorageAdapter {
  constructor({ provider } = {}) {
    super();
    if (provider == null) throw new Error("Cloud storage provider is required");
    if (typeof provider !== "object") throw new Error("Invalid cloud storage provider");
    for (const method of ["put", "openRead", "stat", "delete"]) {
      if (typeof provider[method] !== "function") {
        throw new Error(`Cloud storage provider must implement ${method}()`);
      }
    }
    this.provider = provider;
  }

  async put(options) { return this.provider.put(options); }
  async openRead(options) { return this.provider.openRead(options); }
  async stat(options) { return this.provider.stat(options); }
  async delete(options) { return this.provider.delete(options); }
}

module.exports = CloudStorageAdapter;
