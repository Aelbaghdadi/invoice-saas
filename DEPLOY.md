# Despliegue en Coolify (Hetzner)

Guía operativa para desplegar la app en Coolify con build pack **Dockerfile**.
Los secretos van en Coolify (Environment Variables), nunca en el repo.

## 1. Recurso en Coolify

- **Build Pack:** Dockerfile (ya hay uno en la raíz).
- **Port:** `3000`.
- **Connect To Predefined Network: ON** — para que la app resuelva por nombre
  a Postgres y (cuando se migre) a Garage en la red interna de Docker.
- **Health check:** path `/api/health`, puerto 3000 (ver §8). Antes era
  `/login`, que responde 200 aunque la base de datos o Garage estén caídos.

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
Document AI (`GOOGLE_*`, fallback de OCR), `CRON_SECRET` (ver §5),
`ALERT_WEBHOOK_URL` (avisos de errores, ver §8).

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

- `GET` o `POST /api/cron/retry-stuck` — reintenta facturas atascadas y pasa a «Error OCR» las que ya agotaron los reintentos (p. ej. cada 15 min).
- `GET` o `POST /api/cron/closure-reminders` — recordatorios de cierre: **una vez al mes** (p. ej. el día 5 a las 9:00, como estaba en `vercel.json`). No lleva la cuenta de lo enviado: cada ejecución vuelve a mandar el recordatorio a todos los clientes con el mes anterior sin cerrar, así que programado a diario les llegaría un correo al día.

Los dos aceptan GET y POST con la misma comprobación del secreto: usa el que
permita la Scheduled Task.

Si no configuras los crons, la app funciona; solo no se ejecutan esas tareas
periódicas. Una factura con el análisis parado (un redeploy a mitad del OCR)
no se relanza sola: en la revisión sale «El análisis se ha parado» con un
botón «Reprocesar».

## 5 bis. Parada y Redeploy: periodo de gracia de al menos 120 s

El OCR de las facturas recién subidas corre en segundo plano (`after()`)
dentro del propio proceso de Next. Al parar el contenedor (Redeploy,
reinicio), Coolify manda SIGTERM y, pasado el periodo de gracia, SIGKILL.
Con SIGTERM, Next deja de aceptar peticiones y espera a que terminen los
`after()` en curso; con SIGKILL se cortan a medias y esas facturas se quedan
«analizándose» hasta que alguien pulse «Reprocesar» o pase el cron.

- **Dónde:** en Coolify 4.1.0 o posterior, la aplicación → *Advanced* →
  *Operations* → **«Stop Grace Period»** (por defecto, 30 s). Ponlo en
  **120 s como mínimo**: un OCR con reintentos puede tardar más de un
  minuto. En versiones anteriores de Coolify la parada son 30 s fijos.
- **Qué cubre:** 120 s bastan para terminar un OCR en curso, no un lote
  entero: el Reprocesar masivo y `retry-stuck` procesan las facturas en
  serie. Lo que quede sin terminar lo recoge `retry-stuck` en su siguiente
  ejecución, así que conviene tenerlo programado (§5).
- `docker-entrypoint.sh` arranca con `exec node node_modules/next/dist/bin/next start`:
  Node es el PID 1 y recibe el SIGTERM sin depender de que npm lo reenvíe
  (con `npx next start` npm también lo reenviaba y esperaba; no era lo que
  cortaba las facturas). Lo que corta los `after()` es el SIGKILL al acabar el
  periodo de gracia.

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

## 8. Salud del servicio y alertas

### `/api/health`

`GET /api/health` comprueba Postgres (`SELECT 1`) y Garage (`HeadBucket`),
cada uno con un timeout de 2 s, y responde:

- **200** `{"db":true,"storage":true}` si los dos responden;
- **503** con el que falle a `false` en cuanto uno no responda o tarde más.

No pide sesión y no dice nada interno (ni hosts ni mensajes de error; el
detalle va al log del contenedor con el prefijo `[health]`).

- **En Coolify:** el health check del recurso (§1) apunta a `/api/health`. Con
  la BD caída el contenedor sale como no sano, en vez de verde con `/login`.
- **Monitor externo** (Uptime Kuma, UptimeRobot, Better Stack…): un chequeo
  HTTP cada 1–5 min a `https://<dominio>/api/health` que avise si no es 200.
  Es lo único que avisa si se cae el servidor entero, porque entonces Coolify
  tampoco puede avisar.

### Errores del servidor

[`src/instrumentation.ts`](src/instrumentation.ts) (`onRequestError`) escribe
cada error del servidor (páginas, route handlers, server actions) como una
línea JSON en el log: `level`, `time`, `path` (sin la query), `method`,
`routePath`, `routeType`, `digest`, `name` y `message`. El mensaje se limpia de
correos, NIF/CIF/NIE, IBAN y números largos, y no se guardan cabeceras ni
cookies. El `digest` es el que ve el usuario en la pantalla de error: con él se
encuentra la línea en el log.

- **`ALERT_WEBHOOK_URL`** (opcional): si está, cada error se manda también por
  POST a esa URL, como mucho 10 cada 5 minutos por proceso (los que se callan
  se cuentan en el siguiente aviso). El JSON lleva `text` (Slack, Mattermost),
  `content` (Discord) y los campos de arriba.
- **Servicio de errores (GlitchTip, Sentry…):** por decidir. No hay SDK
  instalado; cuando se elija, se engancha en `onRequestError` o se apunta su
  webhook de entrada a `ALERT_WEBHOOK_URL`.

### Alertas que conviene tener

| Alerta | Umbral orientativo | Cómo |
|---|---|---|
| Facturas en «Error OCR» | más de 5 en una hora | consulta de abajo, desde el monitor o una Scheduled Task |
| Facturas atascadas analizándose | alguna más de 15 min | consulta de abajo; si pasa a menudo, mira que `retry-stuck` (§5) corre |
| Fallos de correo | cualquiera | líneas `[NOTIFY]` en el log y el panel de Resend |
| Disco del servidor | por encima del 80 % | métricas del servidor en Coolify o Hetzner (Postgres y Garage comparten disco) |

Consultas de solo lectura:

```sql
-- Error OCR en la última hora
SELECT count(*) FROM "Invoice"
WHERE status = 'OCR_ERROR' AND "updatedAt" > now() - interval '1 hour';

-- Atascadas: subidas o analizándose desde hace más de 15 min
SELECT count(*) FROM "Invoice"
WHERE status IN ('UPLOADED', 'ANALYZING') AND "updatedAt" < now() - interval '15 minutes';
```

