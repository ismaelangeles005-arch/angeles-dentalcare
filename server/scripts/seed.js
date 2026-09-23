require("dotenv").config();

if (process.env.NODE_ENV === "production") {
  console.error("Seed de desarrollo bloqueado en produccion. Usa provision-review.js.");
  process.exit(1);
}

const bcrypt = require("bcryptjs");
const db = require("../src/db");

async function seed() {
  const doctors = [
    ["Dra. Martinez", "Ortodoncia"],
    ["Dr. Gomez", "Odontologia general"],
    ["Dra. Fernandez", "Endodoncia"]
  ];

  const doctorIds = {};

  for (const [name, specialty] of doctors) {
    const result = await db.query(`
      INSERT INTO doctors (name, specialty)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING id, name
    `, [name, specialty]);

    if (result.rows[0]) {
      doctorIds[name] = result.rows[0].id;
    }
    else {
      const existing = await db.query("SELECT id FROM doctors WHERE name = $1", [name]);
      doctorIds[name] = existing.rows[0].id;
    }
  }

  const passwordHash = await bcrypt.hash("1234", 12);
  const users = [
    ["admin", "head_admin", "Administrador principal", null],
    ["doctor1", "doctor", "Dr. Gomez", doctorIds["Dr. Gomez"]],
    ["recepcion", "recepcion", "Recepcion", null]
  ];

  for (const [username, role, fullName, doctorId] of users) {
    await db.query(`
      INSERT INTO users (username, password_hash, role, full_name, doctor_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username)
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        full_name = EXCLUDED.full_name,
        doctor_id = EXCLUDED.doctor_id,
        active = true,
        updated_at = NOW()
    `, [username, passwordHash, role, fullName, doctorId]);
  }

  console.log("Seed completado. Usuarios: admin / doctor1 / recepcion. Password: 1234");
  await db.pool.end();
}

seed().catch(async error => {
  console.error(error);
  await db.pool.end();
  process.exit(1);
});

