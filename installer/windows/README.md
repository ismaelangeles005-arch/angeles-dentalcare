# Instalador Windows

El instalador profesional se genera con:

```powershell
npm run installer:build
```

Salida esperada:

```text
installer/windows/dist/AngelesDentalCare-Setup-1.0.0.exe
```

Aplicacion instalada:

```text
AngelesDentalCare.exe
```

Datos conservados fuera de la carpeta de instalacion:

- `C:\ProgramData\AngelesDentalCare\config`
- `C:\ProgramData\AngelesDentalCare\documents`
- `C:\ProgramData\AngelesDentalCare\media`
- `C:\ProgramData\AngelesDentalCare\backups`
- `C:\ProgramData\AngelesDentalCare\logs`

El desinstalador no debe eliminar datos clinicos, base de datos, documentos, imagenes ni backups.

## Firma digital

El instalador todavia no esta firmado. Windows puede mostrar SmartScreen o advertencias de editor desconocido.

Para la fase comercial se necesita un certificado de firma de codigo para Windows. Con electron-builder se integrara mediante variables de entorno seguras, sin subir certificados ni contrasenas a Git.

## Pendiente de validacion limpia

Probar en una segunda PC o VM:

- Instalacion sin Node.js ni npm.
- Equipo con PostgreSQL existente.
- Equipo sin PostgreSQL.
- Primer inicio y configuracion inicial.
- Reinstalacion encima.
- Desinstalacion confirmando que los datos permanecen.
