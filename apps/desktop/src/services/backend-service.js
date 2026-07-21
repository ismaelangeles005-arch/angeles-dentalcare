const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function checkHttp(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 600);
    });
    req.once("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

class BackendService {
  constructor(options) {
    this.name = options.name;
    this.workingDirectory = options.workingDirectory;
    this.script = options.script;
    this.healthUrl = options.healthUrl;
    this.port = options.port;
    this.env = options.env || {};
    this.logPath = options.logPath || null;
    this.logger = options.logger || null;
    this.child = null;
  }

  async ensureStarted() {
    if (await checkHttp(this.healthUrl)) {
      if (this.logger) this.logger.info(`${this.name} ya estaba disponible.`);
      return { started: false, reused: true };
    }
    if (await isPortOpen(this.port)) {
      if (this.logger) this.logger.warn(`${this.name} tiene el puerto ocupado; se reutilizara el proceso existente.`);
      return { started: false, reused: true };
    }

    const stdio = this.logPath
      ? ["ignore", fs.openSync(this.logPath, "a"), fs.openSync(this.logPath, "a")]
      : "ignore";

    this.child = spawn(process.execPath, [this.script], {
      cwd: this.workingDirectory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...this.env },
      windowsHide: true,
      stdio
    });
    this.child.unref();
    if (this.logger) this.logger.info(`${this.name} iniciado por Electron.`);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await checkHttp(this.healthUrl)) return { started: true, reused: false };
      await wait(500);
    }

    throw new Error(`${this.name} no respondio a tiempo.`);
  }

  stopOwnedProcess() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
        if (this.logger) this.logger.info(`${this.name} detenido por Electron.`);
      }
      catch (_error) {}
    }
  }
}

module.exports = { BackendService, checkHttp, isPortOpen };
