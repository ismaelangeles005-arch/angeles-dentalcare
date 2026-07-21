# Angeles DentalCare API

Backend de produccion para mover la app desde `localStorage` hacia PostgreSQL.

## Requisitos

- Node.js 18 o superior
- PostgreSQL 14 o superior

## Instalacion

```bash
cd server
cp .env.example .env
npm install
```

En Windows tambien puedes abrir:

```txt
start-api.bat
```

Si Node.js o npm no estan instalados, el archivo te lo indicara.

Edita `.env` y cambia:

```env
DATABASE_URL=postgres://usuario:password@localhost:5433/dentalcare
JWT_SECRET=usa-un-secreto-largo-y-privado
CLIENT_ORIGIN=http://localhost:5500
```


> Nota de puertos: Angeles DentalCare usa PostgreSQL Docker publicado en `localhost:5433`, mapeado al puerto interno `5432` del contenedor. No reviertas esta separación: Foodie RMS o un PostgreSQL local de Windows pueden usar `5432` al mismo tiempo.
## Base de datos

Con Docker:

```bash
docker compose up -d
```

En Windows tambien puedes abrir:

```txt
setup-db-docker.bat
```

Eso levanta PostgreSQL para Angeles DentalCare en `localhost:5433` por fuera de Docker. Dentro del contenedor PostgreSQL sigue usando el puerto interno `5432`:

```txt
database: dentalcare
user: postgres
password: postgres
```

Sin Docker, crear base manualmente:

Crear base:

```sql
CREATE DATABASE dentalcare;
```

Ejecutar tablas:

```bash
psql "postgres://usuario:password@localhost:5433/dentalcare" -f database/schema.sql
```

Crear usuarios iniciales:

```bash
npm run seed
```

Usuarios iniciales:

- `admin` / `1234`
- `doctor1` / `1234`
- `recepcion` / `1234`

Cambia esas contrasenas antes de usar en produccion.

## Ejecutar

```bash
npm run dev
```

La API queda en:

```txt
http://localhost:3001/api
```

Prueba rapida:

```txt
GET http://localhost:3001/api/health
```

Importante: `http://localhost:3001/api` no es una pagina web visual. Para comprobar que el servidor esta funcionando abre:

```txt
http://localhost:3001/api/health
```

Debe responder algo parecido a:

```json
{"ok":true,"service":"Angeles DentalCare API"}
```

## Como saber donde esta la base de datos

La ubicacion de la base se define en el archivo `.env`, en esta linea:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5433/dentalcare
```

Eso significa:

- Motor: PostgreSQL
- Usuario: `postgres`
- Password: `postgres`
- Host: `localhost`
- Puerto externo DentalCare: `5433`
- Puerto interno del contenedor PostgreSQL: `5432`
- Base de datos: `dentalcare`

Si usas Docker Compose desde esta carpeta, los datos no quedan dentro de los HTML. Actualmente quedan guardados en el volumen:

```txt
server_dentalcare_postgres
```

Ese volumen se monta internamente en:

```txt
/var/lib/postgresql/data
```

Si usas PostgreSQL instalado normal en Windows, los datos quedan en la carpeta de datos de PostgreSQL que configuraste al instalarlo, pero la app se conecta igual por `DATABASE_URL`.

Si usas una base remota, por ejemplo Supabase, Render, Railway o Neon, `DATABASE_URL` debe apuntar al host remoto que te da ese proveedor.

## Verificar estado en Windows

Puedes abrir:

```txt
check-status.bat
```

Te dira:

- si Node.js esta instalado
- si npm esta instalado
- si Docker esta instalado
- si existe `.env`
- si existen `node_modules`
- si la API escucha en puerto `3001`
- si PostgreSQL de Angeles DentalCare escucha en puerto `5433`

Para iniciar todo después de reiniciar Windows puedes abrir:

```txt
start-all.bat
```

## Ver la base de datos

Adminer está disponible solamente desde esta computadora:

```txt
http://127.0.0.1:8080
```

Datos de conexión local:

```txt
Sistema: PostgreSQL
Servidor: postgres
Usuario: postgres
Contraseña: postgres
Base de datos: dentalcare
```

Adminer es una herramienta administrativa local. No debe publicarse en Internet.

## Backups

Crear backup manual en Windows:

```txt
backup-now.bat
```

Restaurar un backup:

```txt
restore-backup.bat
```

Guia completa:

```txt
BACKUP.md
```

## Endpoints principales

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/doctors`
- `GET /api/patients`
- `POST /api/patients`
- `PATCH /api/patients/:id/status`
- `DELETE /api/patients/:id`
- `GET /api/appointments`
- `POST /api/appointments`
- `PATCH /api/appointments/:id/status`
- `DELETE /api/appointments/:id`
- `GET /api/reports/summary`
