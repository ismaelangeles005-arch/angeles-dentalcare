const { validateStrongPassword } = require("../src/utils/passwordPolicy");

function platformConfig(env) {
  const required = [
    "DATABASE_URL",
    "PLATFORM_ADMIN_USERNAME",
    "PLATFORM_ADMIN_NAME",
    "PLATFORM_ADMIN_PASSWORD"
  ];

  const missing = required.filter(
    key => typeof env[key] !== "string" || !env[key].trim()
  );

  if (missing.length) {
    throw new Error(`Missing required variables: ${missing.join(", ")}`);
  }

  const username = env.PLATFORM_ADMIN_USERNAME.trim().toLowerCase();
  const name = env.PLATFORM_ADMIN_NAME.trim();
  const password = env.PLATFORM_ADMIN_PASSWORD;

  if (!/^[a-z0-9][a-z0-9._@+-]{2,79}$/.test(username)) {
    throw new Error("Invalid PLATFORM_ADMIN_USERNAME");
  }

  if (!name || name.length > 200) {
    throw new Error("PLATFORM_ADMIN_NAME must contain 1-200 characters");
  }

  if (
    validateStrongPassword(password) ||
    password.length < 12 ||
    password.length > 200 ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      "Platform password requires 12-200 characters, letters, numbers and a symbol"
    );
  }

  return { username, name, password };
}

async function provision(config, pool, hashPassword) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      ["maelven-platform-admin-provision"]
    );

    const usernameRows = (await client.query(`
      SELECT
        id,
        username,
        organization_id,
        role,
        active,
        deleted_at
      FROM users
      WHERE LOWER(username) = LOWER($1)
      FOR UPDATE
    `, [config.username])).rows;

    const platformAdmins = (await client.query(`
      SELECT
        id,
        username,
        organization_id,
        role,
        active,
        deleted_at
      FROM users
      WHERE role = 'PLATFORM_SUPER_ADMIN'
      FOR UPDATE
    `)).rows;

    if (usernameRows.length) {
      if (usernameRows.length !== 1) {
        throw new Error("Existing username is ambiguous; no changes made");
      }

      const user = usernameRows[0];

      const validExisting =
        user.role === "PLATFORM_SUPER_ADMIN" &&
        user.organization_id === null &&
        user.active === true &&
        user.deleted_at === null;

      const malformedPlatformAdmin = platformAdmins.some(
        platformUser => platformUser.organization_id !== null
      );

      if (!validExisting || malformedPlatformAdmin) {
        throw new Error(
          "Existing account conflicts with platform bootstrap requirements; no changes made"
        );
      }

      await client.query("COMMIT");

      return {
        created: false,
        userId: user.id
      };
    }

    if (platformAdmins.length) {
      throw new Error(
        "A PLATFORM_SUPER_ADMIN already exists with another username; no changes made"
      );
    }

    const passwordHash = await hashPassword(config.password, 12);

    const user = (await client.query(`
      INSERT INTO users (
        organization_id,
        username,
        password_hash,
        role,
        full_name,
        must_change_password
      )
      VALUES (
        NULL,
        $1,
        $2,
        'PLATFORM_SUPER_ADMIN',
        $3,
        true
      )
      RETURNING id
    `, [
      config.username,
      passwordHash,
      config.name
    ])).rows[0];

    await client.query(`
      INSERT INTO audit_logs (
        organization_id,
        user_id,
        action,
        entity,
        entity_id,
        payload
      )
      VALUES (
        NULL,
        $1,
        'platform_bootstrap',
        'users',
        $1,
        $2::jsonb
      )
    `, [
      user.id,
      JSON.stringify({ source: "provision-platform-admin" })
    ]);

    await client.query("COMMIT");

    return {
      created: true,
      userId: user.id
    };
  }
  catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  finally {
    client.release();
  }
}

async function main() {
  require("dotenv").config();

  const config = platformConfig(process.env);

  if (process.argv.includes("--validate-only")) {
    console.log("Platform bootstrap variables valid; no database connection made.");
    return;
  }

  const { pool } = require("../src/db");

  try {
    const result = await provision(
      config,
      pool,
      require("bcryptjs").hash
    );

    console.log(
      result.created
        ? "Platform administrator created; password change required."
        : "Platform administrator already exists; password and permissions unchanged."
    );
  }
  finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    // Never print database details, environment values or passwords.
    console.error(
      "Platform provisioning failed. Check variables, account conflicts and database connectivity."
    );
    process.exitCode = 1;
  });
}

module.exports = {
  platformConfig,
  provision
};
