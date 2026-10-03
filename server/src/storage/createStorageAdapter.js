const LocalStorageAdapter = require("./LocalStorageAdapter");

function createStorageAdapter({ provider = "local", localRoot, env = process.env } = {}) {
  if (provider === "cloud") {
    const CloudStorageAdapter = require("./CloudStorageAdapter");
    const SupabaseStorageProvider = require("./providers/SupabaseStorageProvider");
    return new CloudStorageAdapter({ provider: new SupabaseStorageProvider({
      url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY, bucket: env.SUPABASE_STORAGE_BUCKET
    }) });
  }
  if (provider !== "local") throw new Error(`Unsupported storage provider: ${provider}`);
  return new LocalStorageAdapter(localRoot);
}

module.exports = createStorageAdapter;
