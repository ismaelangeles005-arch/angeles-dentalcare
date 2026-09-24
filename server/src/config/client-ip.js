const { isIP } = require("node:net");
const { ipKeyGenerator } = require("express-rate-limit");

function clientIpRateLimitOptions(env = process.env) {
  const source = env.TRUSTED_CLIENT_IP_SOURCE;
  if (!source) return {};
  if (source !== "cf-connecting-ip") throw new Error("Invalid TRUSTED_CLIENT_IP_SOURCE");
  if (env.NODE_ENV !== "production" || env.RENDER !== "true") {
    throw new Error("CF client IP requires production on Render");
  }
  if (env.TRUST_PROXY && env.TRUST_PROXY !== "false") {
    throw new Error("CF client IP requires TRUST_PROXY=false");
  }
  return {
    // Deployment must restrict ingress to Render's trusted edge. Headers are not credentials.
    keyGenerator(request) {
      const header = request.headers["cf-connecting-ip"];
      const candidate = typeof header === "string" ? header.trim() : "";
      const ip = candidate && !candidate.includes("%") && isIP(candidate)
        ? candidate : request.socket?.remoteAddress;
      return ip && isIP(ip) ? ipKeyGenerator(ip) : "unidentified-peer";
    }
  };
}

module.exports = { clientIpRateLimitOptions };
