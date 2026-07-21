const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function getConfigPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "shared", "config", "product-config.json");
  }
  return path.resolve(__dirname, "..", "..", "..", "shared", "config", "product-config.json");
}

function loadProductConfig() {
  const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));

  if (app.isPackaged) {
    config.runtime.mode = "production";
    config.database.port = config.database.productionPort || config.database.port;
    config.frontend.mode = "backend-static";
    config.frontend.url = `http://${config.backend.host}:${config.backend.port}/index.html`;
  }

  if (process.env.DENTALCARE_BACKEND_PORT) {
    config.backend.port = Number(process.env.DENTALCARE_BACKEND_PORT);
    config.backend.healthUrl = `http://127.0.0.1:${config.backend.port}/api/health`;
    if (app.isPackaged) {
      config.frontend.url = `http://127.0.0.1:${config.backend.port}/index.html`;
    }
  }

  if (process.env.DENTALCARE_FRONTEND_PORT) {
    config.frontend.port = Number(process.env.DENTALCARE_FRONTEND_PORT);
    config.frontend.url = `http://127.0.0.1:${config.frontend.port}/index.html`;
  }

  if (process.env.DENTALCARE_DB_PORT) {
    config.database.port = Number(process.env.DENTALCARE_DB_PORT);
  }

  if (process.env.NODE_ENV === "production" || app.isPackaged) {
    config.runtime.mode = "production";
  }

  return config;
}

module.exports = { loadProductConfig };
