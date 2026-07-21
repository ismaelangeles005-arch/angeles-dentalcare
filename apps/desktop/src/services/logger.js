const fs = require("fs");
const path = require("path");

const MAX_LOG_BYTES = 1024 * 1024;

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_BYTES) return;

    const rotatedPath = `${filePath}.1`;
    if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
    fs.renameSync(filePath, rotatedPath);
  }
  catch (_error) {}
}

function createLogger(filePath, component) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function write(level, message) {
    rotateIfNeeded(filePath);
    const line = JSON.stringify({
      time: new Date().toISOString(),
      component,
      level,
      message
    });
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
  }

  return {
    info(message) { write("INFO", message); },
    warn(message) { write("WARN", message); },
    error(message) { write("ERROR", message); }
  };
}

module.exports = { createLogger };
