# Seguridad de Angeles DentalCare

## Protecciones activas

- Las contrasenas se almacenan con bcrypt.
- La API valida roles en el servidor.
- La sesion usa una cookie `HttpOnly` y `SameSite=Strict`.
- El JWT ya no se guarda en `localStorage`.
- El login tiene limite de intentos.
- La API tiene limite general de solicitudes.
- CORS solo permite los origenes definidos en `CLIENT_ORIGIN`.
- Helmet agrega cabeceras HTTP de seguridad.
- PostgreSQL solo se publica en `127.0.0.1`.
- Adminer solo se publica en `127.0.0.1`.
- Las consultas usan parametros SQL.
- Los registros se eliminan de forma logica.
- Existe auditoria para acciones administrativas y clinicas importantes.

## Antes de publicar en Internet

1. Cambiar las contrasenas iniciales `1234`.
2. Usar una contrasena fuerte y distinta para PostgreSQL.
3. Configurar `NODE_ENV=production`.
4. Usar HTTPS obligatorio.
5. Servir frontend y API bajo el mismo dominio.
6. No publicar Adminer.
7. Configurar copias de seguridad automaticas.
8. Probar restauracion de backups al menos una vez al mes.
9. Mantener auditoria para altas, cambios y eliminaciones.
10. Agregar recuperacion segura de contrasena.
11. Definir una politica de privacidad y cumplimiento para datos clinicos.

## Datos sensibles

No deben guardarse en Git:

- `.env`
- contrasenas
- copias de la base
- backups de PostgreSQL
- tokens
- radiografias o documentos clinicos

`fetch()` solamente debe comunicarse con la API. El navegador nunca debe conectarse directamente a PostgreSQL.

## Backups

Los scripts de backup estan en:

```txt
server\backup-now.bat
server\restore-backup.bat
server\scripts\backup.ps1
server\scripts\restore.ps1
```

La guia completa esta en:

```txt
server\BACKUP.md
```

Los backups contienen informacion clinica y deben guardarse cifrados o en una ubicacion privada. La carpeta `server/backups/` esta ignorada por Git.
