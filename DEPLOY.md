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
- Almacenamiento (estado actual, Supabase): `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`.

Opcionales: `RESEND_API_KEY` + `EMAIL_FROM` (emails; sin clave son no-op),
Document AI (`GOOGLE_*`, fallback de OCR), `CRON_SECRET` (ver §5).

## 3. Migraciones

Automáticas: el contenedor ejecuta `prisma migrate deploy` en el arranque
([`docker-entrypoint.sh`](docker-entrypoint.sh)) antes de levantar Next. Es
idempotente; en una BD nueva crea todo el esquema. No hay pasos manuales.

## 4. Primer admin (BD nueva)

Una BD recién creada no tiene usuarios. Tras el primer deploy, ejecuta UNA vez
en el contenedor (Coolify → Terminal/Execute Command):

```sh
ADMIN_EMAIL="admin@msassessors.com" \
ADMIN_PASSWORD="<una-contraseña-fuerte>" \
ADMIN_NAME="Admin" \
FIRM_NAME="MS Assessors" \
FIRM_CIF="<CIF real>" \
node scripts/bootstrap-admin.mjs
```

(Si no pasas variables, crea `admin@demo.com` / `Demo1234!` — cámbiala enseguida
desde Ajustes → Contraseña.) El script es idempotente.

## 5. Crons

Hay dos endpoints que en Vercel disparaba Vercel Cron y aquí hay que disparar
con una **Scheduled Task** de Coolify (o cron externo) con la cabecera
`Authorization: Bearer <CRON_SECRET>`:

- `POST /api/cron/retry-stuck` — reintenta facturas atascadas (p. ej. cada 15 min).
- `POST /api/cron/closure-reminders` — recordatorios de cierre (p. ej. diario).

Si no configuras los crons, la app funciona; solo no se ejecutan esas tareas
periódicas.

## 6. Almacenamiento: Supabase → Garage (pendiente)

**Hoy** la app usa **Supabase Storage** (bucket `invoices`), con subida directa
navegador→Supabase mediante URL firmada. Para usar **Garage** (S3-compatible,
interno) hace falta una migración dedicada, no solo cambiar credenciales:

1. Añadir `@aws-sdk/client-s3` y una capa `lib/storage.ts` que lea
   `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY` con `forcePathStyle: true`.
2. **Re-arquitectura de la subida**: como Garage es interno (el navegador no
   llega a `garage:3900`), la subida directa por URL firmada deja de servir.
   Hay que subir **a través de la app** (un route que hace stream a Garage).
3. Servir/descargar facturas **por proxy** desde la app (valida permisos y hace
   stream), nunca exponiendo Garage públicamente.
4. Sustituir las llamadas Supabase en `processInvoice`, sign/register, preview y
   `demoSeed` por las de S3.

Mientras tanto se puede desplegar manteniendo Supabase Storage (rápido y de bajo
riesgo) y migrar a Garage en una pasada aparte.

## 7. Pendiente después del primer deploy

- Dominio + HTTPS (Coolify + Let's Encrypt) cuando se decida el nombre →
  actualizar `NEXTAUTH_URL`.
- Migración de almacenamiento a Garage (§6).
- Backup offsite del bucket de facturas.
