const http = require("http");
const fs = require("fs");
const path = require("path");

const host = "127.0.0.1";
const port = 5500;
const root = path.resolve(__dirname, "../..");

const publicFiles = new Set([
  "index.html",
  "dashboard.html",
  "pacientes.html",
  "citas.html",
  "reportes.html",
  "usuarios.html",
  "auditoria.html",
  "facturacion.html",
  "procedimientos.html",
  "doctor.html",
  "styles.css",
  "roles.js",
  "api.js"
]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const fileName = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");

  if (!publicFiles.has(fileName)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Archivo no encontrado");
    return;
  }

  const filePath = path.join(root, fileName);
  const extension = path.extname(fileName);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No se pudo cargar la aplicación");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`Frontend listo en http://${host}:${port}`);
});
