const fs = require("fs");
const path = require("path");
const net = require("net");
const publicWebFiles = require("./public-web-files");

function integer(env, key, fallback, min, max) {
  const value = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

function poolOptions(env = process.env) {
  let localDatabase = false;
  if (env.DATABASE_URL) {
    let url;
    try { url = new URL(env.DATABASE_URL); } catch { throw new Error("Invalid DATABASE_URL"); }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid DATABASE_URL protocol");
    localDatabase = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    // pg connection-string SSL options override the explicit ssl object.
    for (const key of url.searchParams.keys()) {
      if (/^(ssl|uselibpqcompat)/i.test(key)) throw new Error("Use PG_TLS / PG_TLS_CA_FILE, not SSL options in DATABASE_URL");
    }
  }
  // Remote production verifies TLS by default; require is an explicit private-network opt-in.
  const tls = env.PG_TLS || (env.NODE_ENV === "production" && !localDatabase ? "verify-full" : "disable");
  if (!["verify-full", "require", "disable"].includes(tls)) throw new Error("Invalid PG_TLS");
  if (env.NODE_ENV === "production" && !localDatabase && tls === "disable") {
    throw new Error("Remote production requires PG_TLS=require or verify-full");
  }
  if (env.PG_TLS_CA_FILE && tls !== "verify-full") throw new Error("PG_TLS_CA_FILE requires PG_TLS=verify-full");
  return {
    connectionString: env.DATABASE_URL,
    ssl: tls !== "disable" ? {
      rejectUnauthorized: tls === "verify-full",
      ...(env.PG_TLS_CA_FILE ? { ca: fs.readFileSync(env.PG_TLS_CA_FILE, "utf8") } : {})
    } : false,
    max: integer(env, "PG_POOL_MAX", 10, 1, 100),
    connectionTimeoutMillis: integer(env, "PG_CONNECTION_TIMEOUT_MS", 10000, 1, 120000),
    idleTimeoutMillis: integer(env, "PG_IDLE_TIMEOUT_MS", 30000, 1000, 3600000)
  };
}

function patientFilesDirectory(env = process.env) {
  const production = env.NODE_ENV === "production";
  if (production && (!env.PATIENT_FILES_DIR || !path.isAbsolute(env.PATIENT_FILES_DIR))) {
    throw new Error("Production requires an absolute persistent PATIENT_FILES_DIR");
  }
  const directory = path.resolve(env.PATIENT_FILES_DIR || path.join(__dirname, "../../storage/patient-files"));
  if (!production) fs.mkdirSync(directory, { recursive: true });
  if (!fs.statSync(directory).isDirectory()) throw new Error("PATIENT_FILES_DIR must be a directory");
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  return fs.realpathSync(directory);
}

function trustProxy(env = process.env) {
  if (!env.TRUST_PROXY || env.TRUST_PROXY === "false") return false;
  const entries = env.TRUST_PROXY.split(",").map(value => value.trim());
  for (const entry of entries) {
    const [ip, prefix, extra] = entry.split("/");
    const version = net.isIP(ip);
    if (!version || extra !== undefined || (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error("TRUST_PROXY requires explicit proxy IPs/CIDRs, not true or a hop count");
    }
    if (ip === "0.0.0.0" || ip === "::") throw new Error("TRUST_PROXY cannot trust all addresses");
  }
  return entries;
}

function frontendDirectory(env = process.env) {
  if (!env.FRONTEND_ROOT) return "";
  const directory = fs.realpathSync(path.resolve(env.FRONTEND_ROOT));
  if (env.NODE_ENV !== "production") return directory;
  const repo = fs.realpathSync(path.resolve(__dirname, "../../.."));
  const contains = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
  };
  if (contains(directory, repo)) throw new Error("FRONTEND_ROOT cannot be the repository or an ancestor");
  // Production artifacts may contain only existing public assets; dev list stays unchanged.
  const allowed = new Set(publicWebFiles);
  if (directory.split(path.sep).some(part => /^(server|database|backups|qa-backups|logs|storage)$/i.test(part))) {
    throw new Error("FRONTEND_ROOT points to an internal directory");
  }
  function inspect(current, prefix = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error("FRONTEND_ROOT cannot contain links");
      if (entry.isDirectory() && [...allowed].some(file => file.startsWith(name + "/"))) {
        inspect(path.join(current, entry.name), name + "/");
      } else if (!entry.isFile() || !allowed.has(name)) throw new Error("FRONTEND_ROOT contains non-public files");
    }
  }
  inspect(directory);
  if (!fs.existsSync(path.join(directory, "index.html"))) throw new Error("FRONTEND_ROOT requires index.html");
  if (env.PATIENT_FILES_DIR) {
    const storage = fs.realpathSync(env.PATIENT_FILES_DIR);
    if (contains(directory, storage) || contains(storage, directory)) {
      throw new Error("Public frontend and private storage must not overlap");
    }
  }
  return directory;
}

module.exports = { poolOptions, patientFilesDirectory, trustProxy, frontendDirectory };
