// Keys are storage-relative identifiers, never client-supplied physical paths.
class StorageAdapter {
  // Returns { key, size, checksum, contentType } after publication.
  async put({ key, stream, contentType, size, checksum, ifAbsent }) { throw new Error("Not implemented"); }
  // Returns a readable stream. Optional start/end support HTTP byte ranges.
  async openRead({ key, version, start, end }) { throw new Error("Not implemented"); }
  // Returns { key, size, modifiedAt }, or null when missing.
  async stat({ key, version }) { throw new Error("Not implemented"); }
  // Missing objects are not errors.
  async delete({ key, version }) { throw new Error("Not implemented"); }
}

module.exports = StorageAdapter;
