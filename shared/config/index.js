const fs = require("fs");
const path = require("path");

function loadProductConfig() {
  const configPath = path.join(__dirname, "product-config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  if (process.env.DENTALCARE_BACKEND_PORT) {
    config.backend.port = Number(process.env.DENTALCARE_BACKEND_PORT);
    config.backend.healthUrl = `http://127.0.0.1:${config.backend.port}/api/health`;
  }

  if (process.env.DENTALCARE_FRONTEND_PORT) {
    config.frontend.port = Number(process.env.DENTALCARE_FRONTEND_PORT);
    config.frontend.url = `http://127.0.0.1:${config.frontend.port}/index.html`;
  }

  if (process.env.DENTALCARE_DB_PORT) {
    config.database.port = Number(process.env.DENTALCARE_DB_PORT);
  }

  if (process.env.NODE_ENV === "production") {
    config.runtime.mode = "production";
  }

  return config;
}

module.exports = { loadProductConfig };
