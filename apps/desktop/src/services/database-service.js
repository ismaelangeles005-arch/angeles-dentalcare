const http = require("http");
const { isPortOpen } = require("./backend-service");

function getJson(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
        catch (_error) { resolve({ statusCode: res.statusCode, data: null }); }
      });
    });
    req.once("error", () => resolve({ statusCode: 0, data: null }));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ statusCode: 0, data: null });
    });
  });
}

class DatabaseService {
  constructor(config) {
    this.host = config.host;
    this.port = config.port;
  }

  async checkPort() {
    return isPortOpen(this.port, this.host || "127.0.0.1");
  }

  async checkFromApi(apiHealthUrl) {
    const response = await getJson(apiHealthUrl);
    return {
      ok: response.statusCode === 200 && response.data && response.data.ok === true && response.data.database === "connected",
      source: "api",
      statusCode: response.statusCode,
      database: response.data ? response.data.database : "unknown"
    };
  }
}

module.exports = { DatabaseService };
