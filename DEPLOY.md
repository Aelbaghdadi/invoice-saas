# Despliegue en Coolify (Hetzner)

Guía operativa para desplegar la app en Coolify con build pack **Dockerfile**.
Los secretos van en Coolify (Environment Variables), nunca en el repo.

## 1. Recurso en Coolify

- **Build Pack:** Dockerfile (ya hay uno en la raíz).
- **Port:** `3000`.
- **Connect To Predefined Network: ON** — para que la app resuelva por nombre
  a Postgres y (cuando se migre) a Garage en la red interna de Docker.
- **Health check** (opcional): path `/login`, puerto 3000.

## 2. Variables de entorno

Cópialas de [`.env.example`](.env.example) a Coolify y rellénalas. Mínimas para
arrancar:

- `DATABASE_URL` — la "Postgres URL interna" del recurso Postgres de Coolify.
- `AUTH_SECRET` — `openssl rand -base64 32`.
- `NEXTAUTH_URL` — la URL autogenerada por Coolify (luego el dominio).
- `GEMINI_API_KEY` — extractor OCR principal.
- Almacenamiento (Garage): `S3_ENDPOINT` (`http://garage:3900`), `S3_REGION`
  (`garage`), `S3_BUCKET` (`facturas`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `S3_FORCE_PATH_STYLE=true`. Requiere "Connect To Predefined Network: ON"
  para que `garage` resuelva en la red interna.

Opcionales: `RESEND_API_KEY` + `EMAIL_FROM` (emails; sin clave son no-op),
Document AI (`GOOGLE_*`, fallback de OCR), `CRON_SECRET` (ver §5).

## 3. Migraciones

Automáticas: el contenedor ejecuta `prisma migrate deploy` en el arranque
([`docker-entrypoint.sh`](docker-entrypoint.sh)) antes de levantar Next. Es
idempotente; en una BD nueva crea todo el esquema. No hay pasos manuales.

El historial se **regeneró a un baseline limpio** (`00000000000000_init` =
esquema completo + `00000000000001_audit_immutability` = triggers de auditoría),
porque el historial antiguo tenía deriva (4 tablas creadas con `db push` que no
estaban en ninguna migración → fallaba al aplicar desde cero con 42P01/P3009).

### Si la BD quedó en estado fallido (P3009 / P3018)

Le pasó al primer deploy: aplicó migraciones a medias y dejó una marcada como
fallida. Como la BD **no tiene datos reales**, resetéala y vuelve a desplegar.
En la terminal del contenedor de la app (DATABASE_URL ya está en el entorno):

```sh
npx prisma migrate reset --force --skip-seed
```

(Borra el esquema y re-aplica las 2 migraciones limpias.) Luego un deploy normal
ya es no-op. Alternativa equivalente: borrar y recrear el recurso Postgres en
Coolify (BD nueva vacía) y redeploy.

## 4. Primer admin (BD nueva)

Una BD recién creada no tiene usuarios. Tras el primer deploy, ejecuta UNA vez
en el contenedor (Coolify → Terminal/Execute Command):

```sh
ADMIN_USERNAME="admin" \
ADMIN_EMAIL="admin@msassessors.com" \
ADMIN_PASSWORD="<una-contraseña-fuerte>" \
ADMIN_NAME="Admin" \
FIRM_NAME="MS Assessors" \
FIRM_CIF="<CIF real>" \
node scripts/bootstrap-admin.mjs
```

El **login es por `username`** (no por email). `ADMIN_USERNAME` es con lo que se
inicia sesión; si lo omites, se deriva de la parte local del email
(`admin@msassessors.com` → `admin`). El email se conserva para recuperación de
contraseña. (Si no pasas variables, crea usuario `admin` / `Demo1234!` —
cámbiala enseguida desde Ajustes → Contraseña.) El script es idempotente.

## 5. Crons

Hay dos endpoints que en Vercel disparaba Vercel Cron y aquí hay que disparar
con una **Scheduled Task** de Coolify (o cron externo) con la cabecera
`Authorization: Bearer <CRON_SECRET>`:

- `POST /api/cron/retry-stuck` — reintenta facturas atascadas (p. ej. cada 15 min).
- `POST /api/cron/closure-reminders` — recordatorios de cierre (p. ej. diario).

Si no configuras los crons, la app funciona; solo no se ejecutan esas tareas
periódicas.

## 6. Almacenamiento (Garage)

La app usa **Garage** (S3-compatible, red interna) vía `@aws-sdk/client-s3`
([`src/lib/storage.ts`](src/lib/storage.ts), `forcePathStyle: true`). Como
Garage no es público, todo pasa por la app:

- **Subida**: el navegador envía el binario a `POST /api/uploads` y la app lo
  sube a Garage (proxy). Ya no hay subida directa navegador→storage.
- **Servir/descargar**: `GET /api/invoices/<id>/preview` devuelve una URL
  same-origin `/api/invoices/<id>/raw`, que valida permisos y hace stream del
  fichero desde Garage. Garage nunca se expone público.
- OCR (`processInvoice`), splits, re-subida de cliente y el seed de demo
  leen/escriben por la misma capa.

Requiere el bucket `facturas` (privado) + credenciales `S3_*` (§2) y la red
interna ("Connect To Predefined Network: ON" para que `garage` resuelva).

> Smoke test tras el primer deploy: sube una factura, ábrela en revisión
> (debe verse el PDF), y comprueba que el OCR la procesa. Eso valida
> subida + stream + descarga contra Garage de punta a punta.

## 7. Pendiente después del primer deploy

- Dominio + HTTPS (Coolify + Let's Encrypt) cuando se decida el nombre →
  actualizar `NEXTAUTH_URL`.
- Backup offsite del bucket de facturas (Garage).
