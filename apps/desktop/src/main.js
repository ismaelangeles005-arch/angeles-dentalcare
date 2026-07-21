const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const { BackendService } = require("./services/backend-service");
const { DatabaseService } = require("./services/database-service");
const { createLogger } = require("./services/logger");
const { ensureRuntimeDirectories, ensureProductionEnv } = require("./services/runtime-paths");
const { loadProductConfig } = require("./config-loader");

const config = loadProductConfig();
let splashWindow;
let mainWindow;
let backendService;
let frontendService;
let desktopLogger;

const isDevelopment = process.env.DENTALCARE_DESKTOP_MODE === "development" || !app.isPackaged;

function getProjectRoot() {
  return app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..", "..", "..");
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: "#f4f8fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  splashWindow.loadFile(path.join(__dirname, "ui", "splash.html"));
  splashWindow.once("ready-to-show", () => splashWindow.show());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: config.product.name,
    show: false,
    backgroundColor: "#f4f8fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.maximize();
  mainWindow.loadURL(config.frontend.url);
  mainWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    mainWindow.show();
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (desktopLogger) desktopLogger.error(`Render process cerrado: ${details.reason}`);
    dialog.showErrorBox(config.product.name, `La interfaz se cerro inesperadamente: ${details.reason}`);
  });
}

function buildBackendEnv(projectRoot, runtimePaths) {
  if (isDevelopment) {
    return {
      NODE_ENV: "development",
      PORT: String(config.backend.port),
      CLIENT_ORIGIN: config.frontend.url
    };
  }

  const productionEnv = ensureProductionEnv(config, runtimePaths);
  productionEnv.NODE_ENV = "production";
  productionEnv.PORT = String(config.backend.port);
  productionEnv.API_PORT = String(config.backend.port);
  productionEnv.CLIENT_ORIGIN = `http://${config.backend.host}:${config.backend.port}`;
  productionEnv.FRONTEND_ROOT = path.join(projectRoot, "frontend");
  productionEnv.COOKIE_SECURE = "false";
  return productionEnv;
}

async function bootstrap() {
  const projectRoot = getProjectRoot();
  const runtimePaths = ensureRuntimeDirectories();
  desktopLogger = createLogger(runtimePaths.desktopLogPath, "desktop");
  desktopLogger.info(`Iniciando ${config.product.name} en modo ${isDevelopment ? "development" : "production"}.`);

  createSplashWindow();

  backendService = new BackendService({
    name: "Backend API",
    projectRoot,
    workingDirectory: path.join(projectRoot, "server"),
    script: path.join(projectRoot, "server", "src", "server.js"),
    healthUrl: config.backend.healthUrl,
    port: config.backend.port,
    logPath: runtimePaths.backendLogPath,
    logger: desktopLogger,
    env: buildBackendEnv(projectRoot, runtimePaths)
  });

  await backendService.ensureStarted();

  if (isDevelopment) {
    frontendService = new BackendService({
      name: "Frontend Local",
      projectRoot,
      workingDirectory: path.join(projectRoot, "server"),
      script: path.join(projectRoot, "server", "scripts", "frontend-server.js"),
      healthUrl: config.frontend.url,
      port: config.frontend.port,
      logger: desktopLogger,
      env: {
        NODE_ENV: "development"
      }
    });
    await frontendService.ensureStarted();
  }

  const database = new DatabaseService(config.database);
  const dbStatus = await database.checkFromApi(config.backend.healthUrl);
  if (!dbStatus.ok) {
    desktopLogger.error("No se pudo conectar con PostgreSQL desde /api/health.");
    throw new Error("No se pudo conectar con la base de datos. Verifica PostgreSQL y la configuracion local.");
  }

  createMainWindow();
}

function showStartupError(error) {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  const action = dialog.showMessageBoxSync({
    type: "error",
    buttons: ["Reintentar", "Cerrar"],
    defaultId: 0,
    cancelId: 1,
    title: config.product.name,
    message: "No se pudo iniciar Angeles DentalCare",
    detail: error.message || "No se pudo iniciar la aplicacion."
  });

  if (action === 0) {
    bootstrap().catch(showStartupError);
    return;
  }

  app.quit();
}

app.whenReady().then(() => {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:get-config", () => ({
    name: config.product.name,
    mode: isDevelopment ? "development" : "production",
    clinicName: config.clinic.name,
    organizationType: config.clinic.type
  }));

  bootstrap().catch(showStartupError);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendService) backendService.stopOwnedProcess();
  if (frontendService) frontendService.stopOwnedProcess();
});
