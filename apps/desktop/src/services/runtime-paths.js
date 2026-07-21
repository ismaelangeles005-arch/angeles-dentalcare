const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRODUCT_DIR = "AngelesDentalCare";

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function getProgramDataRoot() {
  const base = process.env.ProgramData || "C:\\ProgramData";
  return path.join(base, PRODUCT_DIR);
}

function getLocalAppDataRoot() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || getProgramDataRoot();
  return path.join(base, PRODUCT_DIR);
}

function getRuntimePaths() {
  const dataRoot = getProgramDataRoot();
  const configRoot = path.join(dataRoot, "config");
  const logsRoot = path.join(dataRoot, "logs");

  return {
    dataRoot,
    configRoot,
    logsRoot,
    backupsRoot: path.join(dataRoot, "backups"),
    documentsRoot: path.join(dataRoot, "documents"),
    mediaRoot: path.join(dataRoot, "media"),
    tempRoot: path.join(getLocalAppDataRoot(), "temp"),
    backendEnvPath: path.join(configRoot, "backend.local.env"),
    desktopLogPath: path.join(logsRoot, "desktop.log"),
    backendLogPath: path.join(logsRoot, "backend.log"),
    databaseLogPath: path.join(logsRoot, "database.log"),
    installerLogPath: path.join(logsRoot, "installer.log")
  };
}

function ensureRuntimeDirectories() {
  const runtimePaths = getRuntimePaths();
  [
    runtimePaths.dataRoot,
    runtimePaths.configRoot,
    runtimePaths.logsRoot,
    runtimePaths.backupsRoot,
    runtimePaths.documentsRoot,
    runtimePaths.mediaRoot,
    runtimePaths.tempRoot
  ].forEach(ensureDirectory);

  return runtimePaths;
}

function randomSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function parseEnvFile(content) {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .reduce((env, line) => {
      const separator = line.indexOf("=");
      if (separator > 0) {
        env[line.slice(0, separator)] = line.slice(separator + 1);
      }
      return env;
    }, {});
}

function writeEnvFile(filePath, env) {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
}

function ensureProductionEnv(config, runtimePaths) {
  if (fs.existsSync(runtimePaths.backendEnvPath)) {
    return parseEnvFile(fs.readFileSync(runtimePaths.backendEnvPath, "utf8"));
  }

  const dbPort = config.database.port || config.database.productionPort || 5432;
  const dbHost = config.database.host || "127.0.0.1";
  const dbName = config.database.databaseName || "dentalcare";
  const dbUser = config.database.user || "postgres";
  const dbPassword = config.database.password || "postgres";

  const env = {
    APP_ENV: "production",
    APP_VERSION: config.product.version,
    API_HOST: config.backend.host,
    API_PORT: String(config.backend.port),
    PORT: String(config.backend.port),
    DB_HOST: dbHost,
    DB_PORT: String(dbPort),
    DB_NAME: dbName,
    DB_USER: dbUser,
    DATABASE_URL: `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`,
    DATA_PATH: runtimePaths.dataRoot,
    DOCUMENTS_PATH: runtimePaths.documentsRoot,
    PATIENT_FILES_DIR: runtimePaths.documentsRoot,
    MEDIA_PATH: runtimePaths.mediaRoot,
    BACKUPS_PATH: runtimePaths.backupsRoot,
    LOGS_PATH: runtimePaths.logsRoot,
    JWT_SECRET: randomSecret(),
    PIN_LOOKUP_SECRET: randomSecret(),
    JWT_EXPIRES_IN: "8h",
    CLIENT_ORIGIN: `http://${config.backend.host}:${config.backend.port}`,
    COOKIE_SECURE: "false",
    FRONTEND_ROOT: ""
  };

  writeEnvFile(runtimePaths.backendEnvPath, env);
  return env;
}

module.exports = {
  ensureRuntimeDirectories,
  ensureProductionEnv,
  getRuntimePaths,
  parseEnvFile
};
