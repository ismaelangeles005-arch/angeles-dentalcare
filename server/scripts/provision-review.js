const { validateStrongPassword } = require("../src/utils/passwordPolicy");

function reviewConfig(env) {
  const required = ["DATABASE_URL", "REVIEW_ORGANIZATION_NAME", "REVIEW_ADMIN_USERNAME",
    "REVIEW_ADMIN_NAME", "REVIEW_ADMIN_PASSWORD"];
  const missing = required.filter(key => typeof env[key] !== "string" || !env[key].trim());
  if (missing.length) throw new Error(`Missing required variables: ${missing.join(", ")}`);
  const username = env.REVIEW_ADMIN_USERNAME.trim().toLowerCase();
  const role = env.REVIEW_ADMIN_ROLE || "admin";
  if (!/^[a-z0-9][a-z0-9._@+-]{2,79}$/.test(username)) throw new Error("Invalid REVIEW_ADMIN_USERNAME");
  if (!["admin", "head_admin"].includes(role)) throw new Error("Invalid REVIEW_ADMIN_ROLE");
  const password = env.REVIEW_ADMIN_PASSWORD;
  if (validateStrongPassword(password) || password.length < 12 || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error("Review password requires 12-200 characters, letters, numbers and a symbol");
  }
  const organization = env.REVIEW_ORGANIZATION_NAME.trim();
  const name = env.REVIEW_ADMIN_NAME.trim();
  if (organization.length > 200 || name.length > 200) throw new Error("Review names must not exceed 200 characters");
  return { organization, username, name, role, password };
}

async function provision(config, pool, hashPassword) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize competing provisioning attempts without new tables or constraints.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["maelven-review-provision"]);
    let org = (await client.query(
      "SELECT id, active FROM organizations WHERE LOWER(name) = LOWER($1) FOR UPDATE",
      [config.organization]
    )).rows[0];
    const existing = (await client.query(
      "SELECT id, organization_id, role, active, deleted_at FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE",
      [config.username]
    )).rows;
    if (existing.length) {
      const user = existing[0];
      if (existing.length !== 1 || !org?.active || user.organization_id !== org.id ||
          user.role !== config.role || !user.active || user.deleted_at) {
        throw new Error("Existing account conflicts with requested organization/role/state; no changes made");
      }
      await client.query("COMMIT");
      return { created: false, userId: user.id, organizationId: org.id };
    }
    if (org && !org.active) throw new Error("Organization is inactive; no changes made");
    if (!org) {
      org = (await client.query(
        "INSERT INTO organizations (name, organization_type) VALUES ($1, 'CLINIC') RETURNING id",
        [config.organization]
      )).rows[0];
    }
    const hash = await hashPassword(config.password, 12);
    const user = (await client.query(`
      INSERT INTO users (organization_id, username, password_hash, role, full_name, must_change_password)
      VALUES ($1, $2, $3, $4, $5, true) RETURNING id
    `, [org.id, config.username, hash, config.role, config.name])).rows[0];
    await client.query("COMMIT");
    return { created: true, userId: user.id, organizationId: org.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  require("dotenv").config();
  const config = reviewConfig(process.env);
  if (process.argv.includes("--validate-only")) {
    console.log("Review variables valid; no database connection made.");
    return;
  }
  const { pool } = require("../src/db");
  try {
    const result = await provision(config, pool, require("bcryptjs").hash);
    console.log(result.created ? "Review organization/admin ready; password change required." : "Account already exists; password and permissions unchanged.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(() => {
  // Never print pg error details, environment values or passwords.
  console.error("Review provisioning failed. Check required variables, account conflicts and database schema/TLS.");
  process.exitCode = 1;
});

module.exports = { reviewConfig, provision };
