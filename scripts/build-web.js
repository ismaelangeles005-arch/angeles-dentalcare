const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const publicFiles = require("../server/src/config/public-web-files");

const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const exists = file => {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

function safeName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_./-]+$/.test(name) ||
      name.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`Unsafe public path: ${name}`);
  }
  const forbidden = /^(server|database|scripts|backups|qa-backups|apps|node_modules|uploads|storage|logs|dumps|signatures)$/i;
  if (name.split("/").some(part => forbidden.test(part)) ||
      !(/\.(html|js|css|svg)$/.test(name) || name === "images/logo_files/css2")) {
    throw new Error(`Non-public file: ${name}`);
  }
  return name;
}

function checkedFile(root, name) {
  safeName(name);
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Public path contains a link: ${name}`);
  }
  if (!fs.statSync(current).isFile() || fs.realpathSync(current) !== current) {
    throw new Error(`Not a regular in-root public file: ${name}`);
  }
  return current;
}

function inventory(root, files) {
  return [...files].sort().map(name => {
    const data = fs.readFileSync(checkedFile(root, name));
    return { name, size: data.length, sha256: hash(data) };
  });
}

function inspectOutput(root, files) {
  if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
    throw new Error("Output must be a real directory");
  }
  const allowed = new Set(files);
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Output contains a link: ${name}`);
      if (entry.isDirectory() && files.some(file => file.startsWith(name + "/"))) {
        walk(path.join(dir, entry.name), name + "/");
      } else if (!entry.isFile() || !allowed.has(name)) {
        throw new Error(`Unexpected output content: ${name}`);
      }
    }
  }
  walk(root);
  return inventory(root, files);
}

function validateReferences(root, files) {
  const allowed = new Set(files);
  let count = 0;
  function reference(raw, owner) {
    const value = raw.trim().replace(/&amp;/g, "&");
    if (!value || value.startsWith("#")) return;
    if (/^https:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.username || url.password) throw new Error(`Credentials in asset URL: ${owner}`);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
      throw new Error(`Unsupported asset URL in ${owner}`);
    }
    const local = decodeURIComponent(value.split(/[?#]/)[0]);
    if (local === "/api" || local.startsWith("/api/")) return;
    if (local.includes("\\") || local.split("/").includes("..")) {
      throw new Error(`Asset traversal in ${owner}`);
    }
    const name = local.startsWith("/") ? local.slice(1) : path.posix.join(path.posix.dirname(owner), local);
    if (!allowed.has(name)) throw new Error(`Missing/non-public asset ${name} in ${owner}`);
    checkedFile(root, name);
    count++;
  }
  function css(source, owner) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of clean.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      reference(match[1] ?? match[2] ?? match[3], owner);
    }
    for (const match of clean.matchAll(/@import\s+["']([^"']+)["']/gi)) reference(match[1], owner);
  }
  for (const name of files) {
    if (!/\.(html|svg|css)$/.test(name) && name !== "images/logo_files/css2") continue;
    const source = fs.readFileSync(checkedFile(root, name), "utf8");
    if (name.endsWith(".css") || name.endsWith("/css2")) { css(source, name); continue; }
    // Static resource tags only: never interpret JavaScript templates as document markup.
    const markup = source.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1</script>");
    for (const match of markup.matchAll(/<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      const tag = match[1].toLowerCase();
      const attrs = {};
      for (const attr of match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
      }
      if (tag === "base") throw new Error(`Base URL requires explicit review: ${name}`);
      if (attrs.srcset) throw new Error(`srcset requires explicit review: ${name}`);
      if (["script", "img", "source", "iframe", "audio", "video", "input"].includes(tag) && attrs.src) reference(attrs.src, name);
      if (tag === "link" && /stylesheet|icon|preload|modulepreload/i.test(attrs.rel || "") && attrs.href) reference(attrs.href, name);
      if (tag === "image" && (attrs.href || attrs["xlink:href"])) reference(attrs.href || attrs["xlink:href"], name);
      if (attrs.style) css(attrs.style, name);
    }
    for (const match of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) css(match[1], name);
  }
  return count;
}

function buildWeb(repoRoot = path.resolve(__dirname, "..")) {
  const root = fs.realpathSync(repoRoot);
  const output = path.resolve(root, "public-web");
  const receipt = path.join(root, ".public-web-build.json");
  if (path.dirname(output) !== root || path.basename(output) !== "public-web" || output === root) {
    throw new Error("Unsafe output directory");
  }
  const files = [...publicFiles];
  if (new Set(files).size !== files.length) throw new Error("Duplicate public filenames");
  files.forEach(safeName);
  // Validate every source and reference before touching any previous artifact.
  const sourceInventory = inventory(root, files);
  validateReferences(root, files);
  if (exists(receipt) && (fs.lstatSync(receipt).isSymbolicLink() || !fs.statSync(receipt).isFile())) {
    throw new Error("Unsafe build receipt");
  }
  if (exists(output)) {
    if (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== output) throw new Error("Unsafe output link");
    const previous = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (previous.generator !== "maelven-public-web-v1" || previous.output !== output || !Array.isArray(previous.files)) {
      throw new Error("Output has no valid build ownership receipt");
    }
    previous.files.forEach(file => safeName(file.name));
    const actual = inspectOutput(output, previous.files.map(file => file.name));
    if (JSON.stringify(actual) !== JSON.stringify(previous.files)) throw new Error("Previous output was modified; refusing deletion");
    // Exact direct child verified above; its entire tree contains only recorded regular files.
    fs.rmSync(output, { recursive: true });
  }
  fs.mkdirSync(output);
  for (const file of files) {
    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(checkedFile(root, file), destination, fs.constants.COPYFILE_EXCL);
  }
  const result = inspectOutput(output, files);
  if (JSON.stringify(result) !== JSON.stringify(sourceInventory)) throw new Error("Copied file verification failed");
  const references = validateReferences(output, files);
  fs.writeFileSync(receipt, JSON.stringify({ generator: "maelven-public-web-v1", output, files: result }, null, 2) + "\n");
  return { files: result, count: result.length, bytes: result.reduce((sum, file) => sum + file.size, 0), references, sha256: hash(JSON.stringify(result)) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildWeb(), null, 2)); } catch (error) {
    console.error(`Public web build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildWeb, safeName, validateReferences, inspectOutput };
