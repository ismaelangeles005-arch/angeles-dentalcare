require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const db = require("./db");

const authRoutes = require("./routes/auth");
const doctorRoutes = require("./routes/doctors");
const patientRoutes = require("./routes/patients");
const appointmentRoutes = require("./routes/appointments");
const reportRoutes = require("./routes/reports");
const notificationRoutes = require("./routes/notifications");
const patientFileRoutes = require("./routes/patientFiles");
const userRoutes = require("./routes/users");
const auditLogRoutes = require("./routes/auditLogs");
const availabilityRoutes = require("./routes/availability");
const clinicalNoteRoutes = require("./routes/clinicalNotes");
const procedureRoutes = require("./routes/procedures");
const billingRoutes = require("./routes/billing");
const odontogramRoutes = require("./routes/odontogram");
const treatmentPlanRoutes = require("./routes/treatmentPlans");

const app = express();
const port = process.env.PORT || 3001;
const frontendRoot = process.env.FRONTEND_ROOT || "";
const requiredEnv = ["DATABASE_URL", "JWT_SECRET", "CLIENT_ORIGIN"];
const missingEnv = requiredEnv.filter(name => !process.env[name]);

if (missingEnv.length) {
  throw new Error(`Faltan variables de entorno: ${missingEnv.join(", ")}`);
}

if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres");
}

const allowedOrigins = process.env.CLIENT_ORIGIN
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: frontendRoot ? false : undefined
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    const error = new Error("Origen no permitido por CORS");
    error.status = 403;
    return callback(error);
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 600
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

app.get("/api/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({
      ok: true,
      service: "Angeles DentalCare API",
      database: "connected"
    });
  }
  catch (error) {
    res.status(503).json({
      ok: false,
      service: "Angeles DentalCare API",
      database: "disconnected"
    });
  }
});

app.get("/api", (req, res) => {
  res.json({
    ok: true,
    service: "Angeles DentalCare API",
    health: "/api/health"
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/patients/:patientId/files", patientFileRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/users", userRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/clinical-notes", clinicalNoteRoutes);
app.use("/api/procedures", procedureRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/odontogram", odontogramRoutes);
app.use("/api/treatment-plans", treatmentPlanRoutes);

if (frontendRoot) {
  app.use(express.static(frontendRoot, {
    extensions: ["html"],
    index: "index.html",
    maxAge: 0
  }));

  app.get("/", (req, res) => {
    res.sendFile(path.join(frontendRoot, "index.html"));
  });
}

app.use((req, res) => {
  res.status(404).json({ message: "Ruta no encontrada" });
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = error.status || error.statusCode || 500;
  const message = status < 500
    ? error.message
    : "Error interno del servidor";

  res.status(status).json({ message });
});

app.listen(port, () => {
  console.log(`API lista en http://localhost:${port}`);
});
