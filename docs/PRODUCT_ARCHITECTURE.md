# Angeles DentalCare - Arquitectura de Producto Windows

## Analisis del sistema actual

### Frontend
- Aplicacion web estatica con HTML, CSS y JavaScript plano.
- Pantallas principales en la raiz: `index.html`, `dashboard.html`, `pacientes.html`, `citas.html`, `reportes.html`, `usuarios.html`, `facturacion.html`, `procedimientos.html`, `auditoria.html`.
- Cliente API centralizado en `api.js`.
- Control de roles y shell visual en `roles.js`.
- Branding actual en `images/logo.svg` y CSS local.

### Backend
- Node.js + Express en CommonJS.
- Entrada: `server/src/server.js`.
- Rutas REST bajo `/api`.
- Seguridad base: `helmet`, `cors`, `express-rate-limit`, JWT en cookie HTTP-only.
- Autenticacion actual: login tradicional y PIN Login.

### Base de datos
- PostgreSQL.
- Esquema en `server/database/schema.sql`.
- Migraciones idempotentes en `server/database/migration_*.sql`.
- Multi-organizacion ya preparada con tabla `organizations` y `organization_id` en tablas principales.

### Docker
- Docker Compose actual levanta PostgreSQL y Adminer solo para desarrollo.
- Puerto externo DentalCare PostgreSQL: `5433`.
- Puerto interno del contenedor PostgreSQL: `5432`.
- Adminer: `8080`.
- La arquitectura de producto mantiene Docker para desarrollo y prepara PostgreSQL instalado localmente para produccion.

### Variables de entorno
- Backend usa `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `CLIENT_ORIGIN`.
- PIN Login usa `PIN_LOOKUP_SECRET` opcional, con fallback a `JWT_SECRET`.
- `.env` real no debe distribuirse ni subirse a Git.

### Scripts actuales
- `server/start-all.bat`: levanta Docker, backend y frontend local.
- `server/scripts/status.ps1`: diagnostico de servicios.
- `server/scripts/backup.ps1` y `restore.ps1`: base de backups manuales.
- `server/scripts/crear-paquete-usb.ps1`: paquete USB local.

## Arquitectura creada

```text
DentalCare/
  apps/
    desktop/              # Shell Electron seguro
  server/                 # Backend existente Express
  shared/
    config/               # Configuracion central del producto
    contracts/            # Contratos futuros API/IPC/sync
  installer/
    windows/              # Base para instalador Windows
  updater/                # Base para actualizador
  backups/                # Capa de producto para manifiestos de backup
  resources/              # Recursos comerciales: iconos, splash, instalador
  scripts/                # Scripts raiz del producto
  docs/                   # Documentacion de arquitectura
```

## Electron

La app desktop queda en `apps/desktop`.

Decisiones de seguridad:
- `contextIsolation: true`.
- `nodeIntegration: false`.
- `preload.js` expone solo API minima `DentalDesktop`.
- No se expone Node.js al frontend HTML.
- Splash screen separado.
- Ventana principal maximizada.
- Manejo de error de arranque con dialogo amigable.

## Arranque automatico

Electron usa `BackendService` para:
- Revisar si API responde.
- Revisar puerto antes de iniciar proceso.
- Evitar iniciar procesos duplicados.
- Evitar `EADDRINUSE`.

En esta fase Electron levanta:
- Backend Express en `3001` si no esta activo.
- Frontend local en `5500` si no esta activo.

## Servicios desacoplados

Creados como base:
- `BackendService`
- `DatabaseService`
- `BackupService`
- `UpdateService`
- `VersionManager`
- `ReleaseChecker`
- `InstallerService`

Algunos metodos quedan intencionalmente como contratos para fases futuras.

## Modos

### Development
- Usa Docker PostgreSQL en `5433`.
- Usa backend y frontend actuales.
- Permite logs y hot reload desde scripts existentes.

### Production
- Preparado para PostgreSQL instalado localmente como servicio Windows.
- Docker no debe ser requisito final.
- Electron Builder queda preparado para crear instalador, pendiente de icono final, firma y validacion.

## Siguiente fase recomendada

1. Instalar dependencias Electron en la raiz o en `apps/desktop`.
2. Probar `npm run desktop`.
3. Crear icono `.ico` profesional.
4. Definir ruta de datos de produccion en `%ProgramData%` o `%AppData%`.
5. Convertir backend en servicio Windows o proceso administrado por Electron segun modelo comercial.
6. Implementar backup automatico programado.
7. Implementar licencia local firmada.
8. Agregar pipeline de firma digital e instalador.
