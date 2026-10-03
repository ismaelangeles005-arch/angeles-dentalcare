const LocalStorageAdapter = require("./LocalStorageAdapter");

function createStorageAdapter({ provider = "local", localRoot } = {}) {
  if (provider !== "local") throw new Error(`Unsupported storage provider: ${provider}`);
  return new LocalStorageAdapter(localRoot);
}

module.exports = createStorageAdapter;
