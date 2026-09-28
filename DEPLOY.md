# Despliegue en Coolify (Hetzner)

Guía operativa para desplegar la app en Coolify con build pack **Dockerfile**.
Los secretos van en Coolify (Environment Variables), nunca en el repo.

## 1. Recurso en Coolify

- **Build Pack:** Dockerfile (ya hay uno en la raíz).
- **Port:** `3000`.
- **Connect To Predefined Network: ON** — para que la app resuelva por nombre
  a Postgres y (cuando se migre) a Garage en la red interna de Docker.
- **Health check:** path `/api/health/live`, puerto 3000, con un *start
  period* generoso (60–120 s: el contenedor corre `prisma migrate deploy`
  antes de `next start`). Ver §8: no uses `/api/health` aquí.

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
Document AI (`GOOGLE_*`; **solo se usa si no hay `GEMINI_API_KEY`**, no es
un fallback: si Gemini falla, se reintenta con Gemini y la factura acaba en
«Error OCR»), `OCR_CONCURRENCY` (análisis a la vez, 4 por defecto; ver §5 bis),
`CRON_SECRET` (ver §5),
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
periódicas. Pero `retry-stuck` es **lo único** que recoge lo que un redeploy
deja a medias: las facturas que estaban analizándose y las que esperaban en la
cola del OCR (§5 bis), que siguen en «Subida». Sin el cron no se relanzan
solas: en la revisión sale «El análisis se ha parado» con un botón
«Reprocesar».

**Excepción:** `retry-stuck` no relanza las que ya llevan 3 análisis o más
(`ocrAttempts ≥ 3`, p. ej. una reprocesada varias veces). Si una de esas se
queda en «Subida» tras un redeploy, hay que pulsar «Reprocesar» a mano.

## 5 bis. Parada y Redeploy: periodo de gracia de al menos 240 s

El OCR de las facturas recién subidas corre en segundo plano (`after()`)
dentro del propio proceso de Next. Al parar el contenedor (Redeploy,
reinicio), Coolify manda SIGTERM y, pasado el periodo de gracia, SIGKILL.
Con SIGTERM, Next deja de aceptar peticiones y espera a que terminen los
`after()` en curso; con SIGKILL se cortan a medias y esas facturas se quedan
«analizándose» hasta que alguien pulse «Reprocesar» o pase el cron.

- **Dónde:** en Coolify 4.1.0 o posterior, la aplicación → *Advanced* →
  *Operations* → **«Stop Grace Period»** (por defecto, 30 s). Ponlo en
  **240 s como mínimo** (300 s si se usa Document AI): un OCR con reintentos
  no empieza otro intento pasados 4 minutos, pero con Gemini (30 s por
  llamada) cuatro intentos ya son unos 2 minutos, y con Document AI (60 s por
  llamada), más. En versiones anteriores de Coolify la parada son 30 s fijos.
- **Qué cubre:** ese margen basta para terminar los OCR en curso, no un lote
  entero: el Reprocesar masivo y `retry-stuck` procesan las facturas en
  serie. Lo que quede sin terminar lo recoge `retry-stuck` en su siguiente
  ejecución, así que conviene tenerlo programado (§5).
- **La cola del OCR:** como mucho `OCR_CONCURRENCY` análisis a la vez (4 por
  defecto); en una subida de 200 PDFs, el resto espera en «Subida». Con
  SIGTERM la cola deja de arrancar análisis: los que ya corren terminan y los
  que esperan siguen en «Subida» sin gastar intento. La cola vive en memoria:
  con el redeploy se pierde, y esas facturas las relanza `retry-stuck` cuando
  llevan 5 minutos sin empezar.
- **La cola es una para todas las asesorías del proceso,** en orden de
  llegada: una subida de 200 PDF de una asesoría retrasa unos 8 minutos el OCR
  de las demás (con 4 a la vez y unos 10 s por factura). Con una sola asesoría
  en producción no importa; con varias, sube `OCR_CONCURRENCY` si el
  proveedor lo admite. «Reprocesar» a mano va siempre delante.
- **Avisos de subida a los gestores:** se juntan en memoria (un aviso por
  subida, no por fichero) y salen al pasar 1 minuto sin ficheros nuevos, o a
  los 5 minutos de la primera. Un redeploy pierde los que estaban esperando:
  no se reintentan; las facturas siguen en Lotes y en el panel.
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

- **En Coolify, `/api/health/live`** (§1): solo el proceso y Postgres
  (`{"db":true}`). Con el health check activo, Traefik deja de enrutar a un
  contenedor *unhealthy*: todo el dominio da 404, `/login` incluido, y un
  Redeploy que no pasa el health check se revierte. Por eso Coolify no mira
  Garage: una caída o lentitud de Garage (compartido entre dev y prod en el
  mismo servidor) tumbaría la app entera, también las pantallas que no lo
  usan. Antes era `/login`, que responde 200 aunque la BD esté caída.
- **Monitor externo, `/api/health`** (Uptime Kuma, UptimeRobot, Better
  Stack…): el completo, BD y Garage. Un chequeo HTTP cada 1–5 min a
  `https://<dominio>/api/health` que avise si no es 200. Avisa de Garage sin
  sacar la app de Traefik, y es lo único que avisa si se cae el servidor
  entero, porque entonces Coolify tampoco puede avisar.

### Errores del servidor

[`src/instrumentation.ts`](src/instrumentation.ts) (`onRequestError`) escribe
cada error del servidor (páginas, route handlers, server actions) como una
línea JSON en el log: `level`, `time`, `path` (sin la query), `method`,
`routePath`, `routeType`, `digest`, `name` y `message`. El mensaje se limpia
(lo entrecomillado, correos, NIF/CIF/NIE, IBAN, teléfonos y números largos) y
no se guardan cabeceras ni cookies. El `digest` es el que ve el usuario en la
pantalla de error: con él se encuentra la línea en el log.

> La limpieza protege lo que sale **fuera** (el webhook). El log del
> contenedor no queda limpio: Next escribe además el error completo con
> `console.error`, con los datos que lleve. Trata el log como dato personal
> (acceso restringido, retención limitada).

- **`ALERT_WEBHOOK_URL`** (opcional): si está, cada error se manda también por
  POST a esa URL (webhook entrante de Slack, Discord o Mattermost), como mucho
  10 en cualquier ventana de 5 minutos por proceso; los que se callan se
  cuentan en el siguiente aviso. El JSON lleva `text` (Slack, Mattermost),
  `content` (Discord), `allowed_mentions` vacío y los campos de arriba. El
  aviso sale sin esperar respuesta, así que no retrasa la página de error.
- **Servicio de errores (GlitchTip, Sentry…):** por decidir. No aceptan este
  JSON: se enganchan con su propio protocolo (su SDK o su endpoint de
  ingesta) dentro de `onRequestError`, no con `ALERT_WEBHOOK_URL`.

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

