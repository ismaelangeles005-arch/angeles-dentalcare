# Backups de Angeles DentalCare

Este sistema guarda datos sensibles: pacientes, citas, evoluciones clinicas y archivos del expediente. Los backups deben protegerse igual que la base de datos.

## Que se debe respaldar

- Base de datos PostgreSQL `dentalcare`.
- Archivos clinicos en `server/storage/patient-files`.
- Archivo `.env` solamente en un lugar seguro, nunca en Git.

## Crear un backup manual

Opcion facil en Windows:

```txt
server\backup-now.bat
```

O desde PowerShell:

```powershell
cd C:\Users\marlo\OneDrive\Escritorio\dentalcare\server
powershell -ExecutionPolicy Bypass -File .\scripts\backup.ps1
```

El backup queda por defecto en:

```txt
server\backups\backup-YYYYMMDD-HHMMSS
```

La carpeta contiene:

- `dentalcare-YYYYMMDD-HHMMSS.sql`: copia de PostgreSQL.
- `patient-files-YYYYMMDD-HHMMSS.zip`: archivos clinicos, si existen.
- `manifest.json`: informacion del backup.

## Restaurar un backup

Restaurar puede reemplazar datos actuales. Hazlo solo si estas seguro.

Opcion facil en Windows:

```txt
server\restore-backup.bat
```

O desde PowerShell:

```powershell
cd C:\Users\marlo\OneDrive\Escritorio\dentalcare\server
powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 `
  -SqlFile ".\backups\backup-YYYYMMDD-HHMMSS\dentalcare-YYYYMMDD-HHMMSS.sql" `
  -FilesZip ".\backups\backup-YYYYMMDD-HHMMSS\patient-files-YYYYMMDD-HHMMSS.zip"
```

El script pide escribir `RESTAURAR` antes de aplicar cambios. Para restauraciones automatizadas existe `-Force`, pero no lo uses por error en una base real.

## Frecuencia recomendada

- Diario: backup de base de datos.
- Diario o semanal: backup de archivos clinicos, segun volumen.
- Antes de cambios grandes: backup manual.
- Antes de migraciones: backup manual obligatorio.

## Regla 3-2-1

- 3 copias de la informacion.
- 2 medios distintos, por ejemplo PC y disco externo.
- 1 copia fuera de la PC, por ejemplo nube privada o disco externo guardado aparte.

## Seguridad de backups

- No subir `server/backups` a Git.
- No enviar backups por WhatsApp o correo sin cifrar.
- Usar BitLocker, VeraCrypt, 7-Zip con AES-256 o almacenamiento cloud con cifrado.
- Probar restauracion periodicamente en una copia local, no directamente en produccion.

## Automatizacion en Windows

Puedes crear una tarea en el Programador de tareas de Windows que ejecute:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\marlo\OneDrive\Escritorio\dentalcare\server\scripts\backup.ps1"
```

Recomendacion inicial: todos los dias al cerrar la clinica.
