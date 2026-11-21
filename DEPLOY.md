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

## 2 bis. Conexiones a la BD

La app abre **como mucho 20 conexiones** a su Postgres (`max` del pool, en
[`src/lib/prisma.ts`](src/lib/prisma.ts)), y ninguna consulta puede pasar de
**15 s** (`statement_timeout`): una colgada se corta en vez de retener su
conexión. Pedir conexión espera como mucho 10 s.

dev y prod están en el mismo servidor, cada una con su Postgres. En cada uno:

| Quién | Conexiones, como mucho |
|---|---|
| La app (un proceso `next start`) | 20 |
| `prisma migrate deploy` al arrancar (no usa el pool) | 1, unos segundos |
| Reservadas para superusuario (`superuser_reserved_connections`) | 3 |
| `psql`, backups, un script a mano | unas pocas |

El `max_connections` del Postgres de Coolify (100 por defecto) lo cubre con
margen. Si algún día se levantan varias réplicas de la app contra el mismo
Postgres, son 20 por réplica: súbelo o baja el `max`.

## 3. Migraciones

Automáticas: el contenedor ejecuta `prisma migrate deploy` en el arranque
([`docker-entrypoint.sh`](docker-entrypoint.sh)) antes de levantar Next. Es
idempotente; en una BD nueva crea todo el esquema. No hay pasos manuales,
salvo en la 12 (archivo), que los tiene antes y después del Redeploy (§10).

El historial se **regeneró a un baseline limpio** (`00000000000000_init` =
esquema completo + `00000000000001_audit_immutability` = triggers de auditoría),
porque el historial antiguo tenía deriva (4 tablas creadas con `db push` que no
estaban en ninguna migración → fallaba al aplicar desde cero con 42P01/P3009).

### Si la BD quedó en estado fallido (P3009 / P3018)

> Esto es solo para una BD **sin datos reales**. Con datos (producción, y dev
> hoy) nunca `migrate reset`: borra todo. Ver §10.3.

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

Uno más, con el mismo secreto, que no es periódico: `GET` o `POST
/api/cron/archivo-detectar` mira si los PDF de antes del archivo son
electrónicos o escaneos. Se lanza tras desplegar la migración 12 hasta que no
quede ninguno (§10.6).

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


## 9. Cadena de auditoría

Desde F-048, cada escritura en la auditoría bloquea la cadena de su factura
(`pg_advisory_xact_lock`) hasta el final de la transacción del cambio: dos
escrituras a la vez ya no dejan dos eslabones con el mismo anterior. Las que
se escribieron antes pueden estar bifurcadas.

**Antes de pensar en un índice único**, el equipo tiene que ejecutar esta
consulta (solo lectura) en producción. Si da más de 0 en cualquiera de las
dos columnas, el índice no se puede crear sin decidir antes qué hacer con
esos eslabones:

```sql
-- Eslabones que cuelgan del mismo anterior que otro de la misma factura.
--   con_anterior: dos o más con el mismo prevId;
--   genesis:      dos o más primeros eslabones (prevId NULL) en una factura.
SELECT
  count(*) FILTER (WHERE "prevId" IS NOT NULL)                       AS grupos_con_anterior,
  coalesce(sum(n - 1) FILTER (WHERE "prevId" IS NOT NULL), 0)        AS eslabones_de_mas_con_anterior,
  count(*) FILTER (WHERE "prevId" IS NULL)                           AS facturas_con_genesis_repetido,
  coalesce(sum(n - 1) FILTER (WHERE "prevId" IS NULL), 0)            AS genesis_de_mas
FROM (
  SELECT "invoiceId", "prevId", count(*) AS n
  FROM "AuditLog"
  GROUP BY "invoiceId", "prevId"
  HAVING count(*) > 1
) AS bifurcaciones;
```

Un `UNIQUE ("prevId")` a secas no cubre los génesis repetidos: en Postgres
los NULL son distintos entre sí. El índice que cubre los dos casos sería
`UNIQUE ("invoiceId", "prevId") NULLS NOT DISTINCT` (Postgres 15 o más), en
una migración nueva.

El botón «Verificar la cadena» de Auditoría (admin) recorre la de su asesoría
y dice qué eslabón falla, bifurcaciones incluidas.

## 10. Archivo (migración 12)

La `00000000000012_archivo` crea las tablas del archivo (`InvoiceArchive`,
`UploadBatch`, `InvoiceRegisterSeries`) y dos columnas
(`Client.fiscalYearStartMonth`, `AdvisoryFirm.isDemo`), rellena lo que ya
existía (el bloque entre `-- archivo:backfill:inicio` y
`-- archivo:backfill:fin` de su `migration.sql`, idempotente: se puede volver a
lanzar tal cual) y añade diez triggers: el que crea la fila de archivo de cada
factura nueva y los que impiden borrar facturas y documentos, cambiar un fichero
o tocar un nº de registro ya puesto (ARCHITECTURE.md → Archivo de facturas).

**Producción está en la 9 y aplicará la 10, la 11 y la 12 en el mismo
arranque.** La 10 y la 11 (soporte, ficha del cliente y tickets automáticos)
solo crean tablas y columnas, sin datos; lo que piden son las variables
`SUPPORT_USERNAMES`, `SUPPORT_EMAIL` y `SUPPORT_WEBHOOK_URL` en Coolify
(ARCHITECTURE.md → Soporte). Todo lo que hay que hacer a mano es de la 12, en
este orden: §10.1 a §10.6. Las consultas son de solo lectura salvo las que lo
dicen.

### 10.1 Primero en dev

Dev ya tiene la 10 y la 11: allí solo entra la 12. Se hace entero en dev
(§10.2 a §10.6) y se miran las pantallas del archivo (Archivo en la barra
lateral, la pestaña Archivo de un cliente, la ficha de archivo de una factura y
el ZIP de un ejercicio) antes de tocar producción.

**Ensayo con una copia de producción (recomendado).** Se restaura la copia de
producción de §10.2 en un Postgres local vacío (`pg_restore --no-owner
--no-privileges -d <bd local> antes-de-la-12.dump`), se aplica `npx prisma
migrate deploy` con `DATABASE_URL` apuntando a esa BD (entran la 10, la 11 y la
12, como en producción) y se lanzan la segunda pasada y las consultas de §10.4.
Así se ven, antes de tocar producción, las cifras con los datos reales: cuántas
exportadas se quedan sin número y cómo queda el reparto. Lo que numera el
relleno ya no cambia (los triggers lo impiden), así que lo que haya que decidir
sobre las exportadas sin número conviene decidirlo con estas cifras delante. La
copia lleva datos de los clientes: en un disco cifrado, y se borra al acabar.

### 10.2 Copia fuera del servidor, antes del Redeploy

En cada entorno, justo antes de pulsar Redeploy: un `pg_dump` completo, que se
pueda leer, y **copiado fuera del servidor**. Una copia en el mismo disco no
sirve si cae el servidor, y ese disco lo comparten las BD de dev y producción y
Garage (mira antes que hay sitio con `df -h /`). Desde el servidor:

```sh
docker exec <contenedor de Postgres> pg_dump -U <usuario> -d <base> -Fc > /root/antes-de-la-12.dump
docker exec -i <contenedor de Postgres> pg_restore --list < /root/antes-de-la-12.dump | head
```

La segunda orden solo lee el índice de la copia: si sale una lista de tablas,
se puede leer. Después, desde tu ordenador, `scp` de ese fichero, y comprueba
que ha llegado entero (mismo tamaño). Es la vuelta atrás de todo lo demás.

### 10.3 Redeploy y segunda pasada del relleno

El Redeploy aplica la migración al arrancar el contenedor nuevo (§3).

**Si `migrate deploy` falla con la 12**, el contenedor nuevo no arranca
(`set -e` en `docker-entrypoint.sh`) y el viejo sigue sirviendo. **No uses
`migrate reset`** (lo de §3 era para una BD sin datos: borra todo). El error está
en el log del despliegue; no se toca nada a mano sin entenderlo antes, y la
vuelta segura es la copia de §10.2.

**Segunda pasada, con el contenedor viejo ya parado.** Con el health check, el
Redeploy es un relevo: el contenedor viejo sigue sirviendo mientras el nuevo
aplica la migración y arranca. Lo que suba, divida o exporte el código viejo en
ese rato se queda sin medio, sin nº de parte o sin nº de registro, y ninguna
exportación posterior lo numera. Por eso, **cuando el contenedor viejo ya esté
parado**, se copia el bloque entre las marcas del `migration.sql` y se ejecuta
tal cual en `psql`, dentro de `BEGIN; … COMMIT;`: solo completa lo que falta y lo
demás no cambia. Mejor en un rato sin exportaciones: si se cruza con una y da
una clave duplicada (23505), se deshace entero y basta con volver a lanzarlo. Lo
mismo tras cualquier vuelta atrás del código. **Solo después**, las
comprobaciones de §10.4.

### 10.4 Comprobaciones

**Filas, partes y series.** Tiene que salir `facturas` = `filas_de_archivo` y 0
en las otras tres columnas. `series_descuadradas` cuenta las series en las que no
se cumple COUNT = MAX = `lastNumber` (tantas facturas numeradas como el mayor
número, que es el contador: sin huecos ni números de más).

```sql
SELECT
  (SELECT count(*) FROM "Invoice") AS facturas,
  (SELECT count(*) FROM "InvoiceArchive") AS filas_de_archivo,
  (SELECT count(*) FROM "Invoice" i JOIN "InvoiceArchive" a ON a."invoiceId" = i.id
     WHERE i."splitFromId" IS NOT NULL AND a."splitPart" = 0) AS partes_sin_numero,
  (SELECT count(*) FROM "Invoice" i JOIN "InvoiceArchive" a ON a."invoiceId" = i.id
     WHERE i.status IN ('VALIDATED', 'EXPORTED') AND a."registerNumber" IS NULL
       AND EXISTS (SELECT 1 FROM "ExportBatchItem" e WHERE e."invoiceId" = i.id)) AS exportadas_sin_numero,
  (SELECT count(*) FROM "InvoiceRegisterSeries" s
     WHERE s."lastNumber" <> (SELECT count(*) FROM "InvoiceArchive" a WHERE a."registerSeriesId" = s.id)
        OR s."lastNumber" <> (SELECT coalesce(max(a."registerNumber"), 0) FROM "InvoiceArchive" a WHERE a."registerSeriesId" = s.id)
  ) AS series_descuadradas;
```

Si `series_descuadradas` no es 0, esta dice cuáles:

```sql
SELECT s."clientId", s.type, s.year, s."lastNumber",
       count(a."invoiceId") AS numeradas, max(a."registerNumber") AS mayor
FROM "InvoiceRegisterSeries" s
LEFT JOIN "InvoiceArchive" a ON a."registerSeriesId" = s.id
GROUP BY s.id
HAVING s."lastNumber" <> count(a."invoiceId") OR s."lastNumber" <> coalesce(max(a."registerNumber"), 0)
ORDER BY s."clientId", s.type, s.year;
```

**Exportadas sin nº de registro, en cualquier estado.** El relleno numera solo
las facturas `VALIDATED` o `EXPORTED` con algún `ExportBatchItem`. Antes de las
guardas de hoy pudo exportarse una factura que ahora está rechazada o dividida:
está en los libros de A3 y se queda sin número. Esta consulta las cuenta por
estado. `VALIDATED` y `EXPORTED` tienen que dar 0; el resto se decide con el
usuario (numerarlas o dejarlas como excepción conocida):

```sql
SELECT i.status, count(*) AS facturas
FROM "Invoice" i
JOIN "InvoiceArchive" a ON a."invoiceId" = i.id
WHERE a."registerNumber" IS NULL
  AND EXISTS (SELECT 1 FROM "ExportBatchItem" e WHERE e."invoiceId" = i.id)
GROUP BY i.status
ORDER BY i.status;
```

**Exportadas sin ningún `ExportBatchItem`.** Una factura que salió en un lote
(`exportBatchId`) antes de que existieran los items, y a la que
`scripts/backfill-hardening.ts` no se lo creó, tampoco se numera, y la consulta
de arriba no la ve. Esta las cuenta por estado; si da algo, se decide con el
usuario como las de arriba:

```sql
SELECT i.status, count(*) AS facturas
FROM "Invoice" i
WHERE i."exportBatchId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "ExportBatchItem" e WHERE e."invoiceId" = i.id)
GROUP BY i.status
ORDER BY i.status;
```

El relleno numera cada serie por la fecha del lote en el que la factura salió
por primera vez (`ExportBatch.createdAt`, que es también su `registeredAt`), no
por la de sus items: los que creó `backfill-hardening.ts` llevan la fecha del
script.

**Reparto del medio.** Justo después del relleno, cada XML sale `ELECTRONIC`
con motivo `xml`; cada imagen, vacío («Por confirmar») con `image_unconfirmed`;
cada PDF, vacío con `backfill_pending`; y las partes de una división, lo de su
raíz con motivo `split`. Todo con origen `AUTO`. Tras la detección (§10.6) no
queda ningún `backfill_pending`: los PDF pasan a `ELECTRONIC`/`pdf_text` o a
«Por confirmar» con `scan_unconfirmed` o `pdf_unreadable`. Ninguna sale `PAPER`:
la app no la pone por su cuenta fuera de un taco.

```sql
SELECT a."originalMedium", a."originalMediumSource", a."originalMediumReason", count(*) AS facturas
FROM "InvoiceArchive" a
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

### 10.5 Marcar a mano la asesoría de demo (solo en dev)

El reset de la demo (`POST /api/admin/reset-demo`) solo borra en una asesoría
con `isDemo`; sin la marca responde 409 «Esta asesoría no es de demostración: el
reset no está permitido.» y no toca nada. **Se marca solo la asesoría de
demostración de dev, y nunca una con datos reales**: con la marca, el reset
borra todas sus facturas, documentos y originales del almacenamiento. En
producción no se marca ninguna.

El reset borra del almacenamiento por el prefijo de cada cliente de la demo, y
dev y producción comparten Garage: antes, comprueba en Coolify que el
`S3_BUCKET` de dev no es el de producción.

Primero se identifica (la de demo es la que tiene los gestores `@demo.com`):

```sql
SELECT f.id, f.name, f.cif, f."isDemo",
       count(u.id) FILTER (WHERE u.email LIKE '%@demo.com') AS usuarios_de_la_demo
FROM "AdvisoryFirm" f
LEFT JOIN "User" u ON u."advisoryFirmId" = f.id
GROUP BY f.id
ORDER BY f."createdAt";
```

Y se marca por su id (esta sí escribe):

```sql
UPDATE "AdvisoryFirm"
SET "isDemo" = true, "updatedAt" = now() AT TIME ZONE 'UTC'
WHERE id = '<id de la asesoría de demo>';
```

Comprobación: `SELECT count(*) FROM "AdvisoryFirm" WHERE "isDemo";` da 1 en dev
y **0 en producción**. Después, un reset de la demo en dev tiene que salir bien.

Para lanzar ese reset:

- La ruta solo existe con `ALLOW_DEMO_RESET=true` en las variables del entorno
  de dev (en Coolify), **nunca en producción**. Sin ella responde 404 «No
  encontrado» aunque la asesoría esté marcada; el 409 de arriba solo sale con la
  variable puesta. Si se añade, hace falta un Redeploy para que la coja.
- Ya no hay botón en Ajustes: es un `POST` con la sesión de un ADMIN de la demo y
  el cuerpo `{"confirm":"RESET"}` (sin él, 400). Lo más sencillo es entrar en la
  app de dev como ese administrador y ejecutar en la consola del navegador:

  ```js
  fetch("/api/admin/reset-demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESET" }),
  }).then(async (r) => console.log(r.status, await r.json()));
  ```

  Tiene que dar 200 con los recuentos. 409: la asesoría de esa sesión no está
  marcada (y no se ha tocado nada); 403: la sesión no es de un ADMIN.

### 10.6 Electrónico o papel de los PDF de antes del archivo

El relleno deja cada PDF «Por confirmar» con motivo `backfill_pending`
(«Pendiente de detectar»): la capa de texto y el productor solo se leen del
fichero, y Garage solo se alcanza desde la red de Coolify. Lo hace la propia
app, después de la segunda pasada, con la URL pública y la cabecera
`Authorization: Bearer <CRON_SECRET>` (como los crons de §5):

1. `GET /api/cron/archivo-detectar?dryRun=1` responde `{ "dryRun": true,
   "quedan": N }`, sin descargar ni escribir nada.
2. `GET /api/cron/archivo-detectar` repasa 50 por llamada (`?limit=` hasta 200);
   se repite, por tandas, hasta que `quedan` sea 0. Cada respuesta dice cuántas
   ha revisado y cómo han quedado (`electronicas`, `porConfirmar`, `ilegibles`),
   y cuántas se han quedado como estaban por un fallo (`errores`), que la
   siguiente llamada vuelve a mirar: el almacenamiento no responde, otra
   escritura retiene la factura más de 5 s (un export grande, una división) o un
   error que se repite. Una factura que falla no para a las demás. Si `quedan`
   deja de bajar y `errores` sigue igual, son siempre las mismas: el log del
   contenedor dice cuáles y por qué (líneas `[archivo-detectar]`).

Solo escribe en las filas que siguen en automático y pendientes: lo que la app
haya analizado mientras tanto, o lo que haya decidido una persona, no se toca.
La propuesta llega a las partes de una factura dividida. No deja auditoría (es
la primera propuesta). Un PDF que ya no está en el almacenamiento queda «No se
pudo leer el PDF», y también uno cuyo productor no se puede guardar en la BD. Al
acabar, el reparto de §10.4 ya no tiene ningún `backfill_pending`.

### 10.7 Restaurar una copia

Una restauración completa (`pg_restore` de un `pg_dump` sobre una BD vacía)
funciona: los triggers se crean después de cargar los datos. Una restauración
**solo de datos** sobre una BD que ya tiene la 12 se hace con `pg_restore
--data-only --disable-triggers`. Sin esa opción, el trigger que crea la fila de
archivo de cada factura salta al cargar `Invoice` y choca con las filas de
`InvoiceArchive` del volcado (23505 en `InvoiceArchive_pkey`); y como
`pg_restore` deja vacío el `search_path`, el error que se ve es `relation
"InvoiceArchive" does not exist` (42P01), que parece una migración que falta y
no lo es. `--disable-triggers` necesita superusuario y apaga también las claves
foráneas mientras carga: solo sobre una BD con la 12 aplicada y vacía.

### 10.8 Reversión de emergencia: quitar los triggers

Solo si un trigger del archivo impide algo que la app tiene que poder hacer (el
error empieza por «Archivo:» y es un `check_violation`, 23514) y no se puede
esperar a una corrección. Antes, la copia de §10.2 y avisar. Las tablas, las
columnas y las funciones se quedan (`DROP TRIGGER` no borra la función), y el
código de antes de la 12 las ignora.

**Las guardas** (nueve: borrar, cambiar el fichero, el nº de registro, la serie
o el taco), en `psql` (escribe):

```sql
BEGIN;
DROP TRIGGER IF EXISTS archive_no_delete_by_client ON "Invoice";
DROP TRIGGER IF EXISTS archive_no_delete_by_client ON "Document";
DROP TRIGGER IF EXISTS archive_row_no_delete ON "InvoiceArchive";
DROP TRIGGER IF EXISTS archive_file_guard ON "Invoice";
DROP TRIGGER IF EXISTS archive_file_guard ON "Document";
DROP TRIGGER IF EXISTS invoice_registered_client_guard ON "Invoice";
DROP TRIGGER IF EXISTS archive_row_guard ON "InvoiceArchive";
DROP TRIGGER IF EXISTS register_series_guard ON "InvoiceRegisterSeries";
DROP TRIGGER IF EXISTS taco_number_guard ON "UploadBatch";
COMMIT;
```

Sin ellas nada impide borrar facturas y originales ni cambiar un nº de registro:
es para salir del paso, no para quedarse así.

**El décimo, `invoice_archive_row`** (el que crea la fila de archivo), **no se
quita mientras corra esta versión de la app**: la subida de un XML o una imagen,
la del portal, la resubida, la división y el reset de la demo actualizan esa
fila en la misma transacción y, sin ella, fallan. Solo si se vuelve a la imagen de antes de la 12
y el problema es justo ese trigger:

```sql
DROP TRIGGER IF EXISTS invoice_archive_row ON "Invoice";
```

**Volver a ponerlos.** `prisma migrate deploy` no los vuelve a crear (la 12 ya
consta como aplicada) y una migración aplicada no se edita. Se ejecutan en
`psql`, dentro de `BEGIN; … COMMIT;`, los `CREATE TRIGGER` del final del
`migration.sql` de la 12 que se quitaron (las funciones siguen en la BD). Si se
quitó `invoice_archive_row`, eso va **antes** de volver a desplegar esta
versión. Después, la segunda pasada del relleno (§10.3), que crea las filas de
las facturas que se subieron sin el trigger, y las comprobaciones de §10.4.

**Deshacer la 12 entera** es restaurar la copia de §10.2 en una BD vacía y
volver a la imagen anterior; se pierde todo lo que se hizo después de la copia.
