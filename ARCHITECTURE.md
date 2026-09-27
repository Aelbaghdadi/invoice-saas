# Arquitectura — FacturOCR

Documento de referencia para entender **por qué** el código está
estructurado así. No reproduce lo que ya es evidente leyendo el
código (estructura de carpetas, nombres de funciones); se centra en
las decisiones no obvias y en los invariantes que hay que respetar
si se toca algo.

## Visión general

```
┌─────────┐    upload PDF     ┌──────────────┐
│ CLIENT  │ ─────────────────►│  Next.js     │
└─────────┘                   │  Server      │
                              │  Actions     │
┌─────────┐    review UI      │              │
│ WORKER  │ ─────────────────►│              │
└─────────┘                   │              │
                              │              │
┌─────────┐    export Excel   │              │
│ ADMIN   │ ─────────────────►│              │
└─────────┘                   └──────┬───────┘
                                     │
                  ┌──────────────────┼────────────────────┐
                  ▼                  ▼                    ▼
            ┌──────────┐     ┌──────────────┐     ┌──────────────┐
            │ Postgres │     │  Document AI │     │   Supabase   │
            │(Supabase)│     │  (OCR)       │     │   Storage    │
            └──────────┘     └──────────────┘     └──────────────┘
```

**Una sola aplicación Next.js** (no hay backend separado). Toda la
lógica de negocio vive como Server Actions o Route Handlers; el
frontend invoca server actions directamente, no hay capa REST formal
salvo el subset bajo `src/app/api/`.

## Modelo de datos (resumen)

Ver [prisma/schema.prisma](prisma/schema.prisma) para detalle. Lo
importante:

### Entidades principales

| Entidad | Rol |
|---------|-----|
| `AdvisoryFirm` | Asesoría (tenant top-level). Aísla todos los datos. |
| `User` | Persona con `role` ∈ {ADMIN, WORKER, CLIENT}. Pertenece a una `AdvisoryFirm`. |
| `Client` | Cliente final (la empresa cuyas facturas se procesan). Tiene un `User` con `role=CLIENT`. |
| `WorkerClientAssignment` | Quién (WORKER) ve qué (Client). ADMIN ve todos. |
| `Invoice` | La factura. Estados: ver [src/lib/invoiceStatuses.ts](src/lib/invoiceStatuses.ts). |
| `InvoiceVatLine` | Desglose multi-IVA de una factura. Una factura puede tener N tipos de IVA. |
| `AuditLog` | Hash chain inmutable de cambios. Trigger SQL prohíbe UPDATE/DELETE. |
| `PeriodClosure` | Cierre de periodo (mes/año/cliente). Bloquea modificaciones. |
| `AccountEntry` | Plan de cuentas aprendido por NIF. Acelera la siguiente factura del mismo proveedor. |
| `ExportBatch` | Lote exportado. Las facturas se marcan vía `Invoice.exportBatchId`. |

### Estados de Invoice

```
UPLOADED
   │
   ▼
ANALYZING ────► OCR_ERROR (Document AI falló)
   │
   ▼
PENDING_REVIEW ◄────► NEEDS_ATTENTION
                       (con incidencias: duplicado, periodo distinto...)
   │
   ▼
VALIDATED  /  REJECTED
```

Hay dos estados legacy en el enum (`ANALYZED`, `EXPORTED`) que ya
**no escribe** el código actual pero que pueden existir en BD por
historial. Los helpers en [src/lib/invoiceStatuses.ts](src/lib/invoiceStatuses.ts)
los tratan en los recuentos.

La exportación **no cambia el estado** (`VALIDATED` sigue siendo
`VALIDATED` tras exportar). Se registra en `ExportBatch` /
`ExportBatchItem`. `Invoice.exportBatchId` es un puntero al último
export para mostrar "ya exportada" en la UI sin perder el estado.

## Flujos clave

### 1. Subida y procesado

1. Cliente sube PDF → `POST /api/invoices/upload`.
2. PDF va a Supabase Storage. Se crea `Invoice` con `status=UPLOADED`.
3. `POST /api/invoices/[id]/process` (llamado por el upload, no por
   cron) cambia a `ANALYZING` y llama a `processInvoice()`.
4. `processInvoice()` orquesta:
   - `ocr.ts` (Document AI) → extrae campos.
   - `parseTaxId()` normaliza NIFs (quita guiones, detecta prefijo
     país).
   - **Pre-rellena la parte cliente**: en `PURCHASE`, el receptor =
     `Client`; en `SALE`, el emisor = `Client`. No se acepta lo que
     diga el OCR para los campos del cliente.
   - **Aprende del histórico** de `AccountEntry` por NIF del emisor:
     plan de cuentas, `operationType`, retención.
   - Auto-detecta **operationType** por NIF (`ES* = INTERIOR`, `FR* =
     INTRACOM`, etc.) y **retentionType** si emisor es persona física
     (DNI/NIE pattern).
   - **Detecta rectificativa** (abono): cualquier base/cuota negativa
     o `totalAmount < 0`.
5. Status pasa a `PENDING_REVIEW` / `NEEDS_ATTENTION` / `OCR_ERROR`.

### 2. Revisión y validación

1. Gestor abre `/dashboard/worker/review/[id]`.
2. Visor PDF con **bounding boxes** del OCR (campo enfocado → caja
   resaltada). Ver [src/lib/boundingBoxes.ts](src/lib/boundingBoxes.ts).
3. Gestor corrige campos. **Los campos del cliente están bloqueados**
   server-side: aunque manipule el form con devtools, el server fuerza
   los valores de `Client`.
4. Submit → `validateInvoice` action en
   [src/app/dashboard/worker/review/[id]/actions.ts](src/app/dashboard/worker/review/[id]/actions.ts).
5. Cálculos:
   - `taxBase`, `vatAmount` son **sumas** de las `InvoiceVatLine`.
   - `vatRate` denormalizado solo existe si hay 1 línea.
   - `irpfAmount` se calcula como `base × rate / 100` si no viene.
   - **Math validation**: `Σbases + Σcuotas − IRPF ≈ Total` (tolerancia
     2 céntimos) → `isValid`.
6. `auditEntries` se construyen comparando `invoice` (antes) vs
   `newData` (ahora) campo por campo y se envían a `appendAuditLogs`.
7. Si hay `AccountEntry` para el NIF del proveedor, se actualiza con
   las cuentas y `operationType` introducidos (aprendizaje).
8. `redirect` al siguiente de la cola (ver §siguiente). Antes del
   redirect llamamos a `revalidatePath` para invalidar el prefetch
   de Next.js — si no, el contador X/N queda obsoleto.

### 3. Cola de revisión ("siguiente factura")

Ver [src/lib/reviewQueue.ts](src/lib/reviewQueue.ts).

- La cola se filtra por `client + period(month, year) + type + bucket`.
- **Buckets**: `clean` (status PENDING_REVIEW), `attention`
  (NEEDS_ATTENTION + OCR_ERROR), `all` (los tres).
- `getQueuePosition()` incluye la factura actual aunque ya esté
  validada (`OR: [{ id: currentInvoiceId }, buildWhere(filter)]`)
  para que el contador "X de N" no salte al validar.
- `getNextInQueue()` excluye la actual y devuelve la siguiente por
  `createdAt asc`.

### 4. Exportación A3

Ver [src/lib/exportFormats.ts](src/lib/exportFormats.ts).

- Formato: Excel A3 Asesor (xlsx via librería `xlsx`).
- 16 columnas exactas según plantilla oficial (incluyendo el typo
  "Cutoa Rec. Equiv." que viene de la plantilla A3 — no es un bug
  nuestro).
- Filtra facturas con `Math.abs(total) < 0.005` (excluye total = 0).
- Rectificativas: sufijo `_R` en `Nº Factura` y signos preservados
  en Base / Cuota IVA / Cuota Retención.
- Una `Invoice` con N `InvoiceVatLine` produce N filas (una por
  tipo de IVA). "Fecha Contabilización" es obligatoria y va en
  columna F.

## Decisiones no obvias

### Por qué `@prisma/adapter-pg` y no el binario nativo

Vercel Functions ejecuta en un runtime sin binarios nativos. El
adapter puro JavaScript funciona ahí; el cliente Prisma estándar
no. Ver [src/lib/prisma.ts](src/lib/prisma.ts).

### Por qué los campos del cliente se fuerzan server-side

`parseAndSave()` ignora `data.issuerName/Cif` (o `receiverName/Cif`,
según `type`) y los sustituye por `invoice.client.name/cif`. Razón:
evitar que un gestor con devtools sustituya los datos del Cliente
por otros distintos en una factura concreta. Ver [src/app/dashboard/worker/review/[id]/actions.ts:170-179](src/app/dashboard/worker/review/[id]/actions.ts#L170-L179).

### Por qué hash chain Y triggers SQL

Cumplimiento contable: la auditoría debe ser inmutable. Dos capas:

1. **Trigger PostgreSQL** (en `prisma/migrations/20260507120000_audit_hash_chain/migration.sql`)
   prohíbe `UPDATE` y `DELETE` sobre `AuditLog`. Cualquier intento
   tira un `RAISE EXCEPTION`.
2. **Hash chain SHA-256**: cada registro guarda `prevHash` (del
   anterior) y `hash` (el suyo). Si alguien con super-admin
   desactiva el trigger temporalmente y modifica una fila, la cadena
   se rompe y `verifyFirmAuditChains()` lo destapa.

El formato del hash (string concatenado con `|`, timestamp ISO con
ms y Z) **debe coincidir EXACTAMENTE** con el del backfill SQL
(`migrations/20260507120000_audit_hash_chain/migration.sql`), o los
registros pre-existentes no verifican.

### Por qué `app.allow_audit_mutation` en el reset demo

El reseed de demo necesita borrar `AuditLog` legítimamente. La
migración `20260507160000_audit_bypass_for_demo_reset` añade un
escape: si la sesión tiene `current_setting('app.allow_audit_mutation', true) = 'true'`,
el trigger no bloquea. `demoSeed.ts` lo activa **dentro de una
transacción** (`SET LOCAL`), así solo aplica a esa transacción y
no fuga a otras.

### Por qué `revalidatePath` antes del redirect en validate/reject

Next.js prefetch la página de la siguiente factura mientras el
gestor está revisando la actual. Si la actual aún está PENDING,
ese prefetch calcula la cola con N elementos. Tras validar, el
redirect lleva a la siguiente, **pero Next.js sirve la versión
prefetched** (contador desfasado: "2/8" en lugar de "2/7").
`revalidatePath` invalida tanto el data cache server como el
router cache client. Ver [src/app/dashboard/worker/review/[id]/actions.ts:415-425](src/app/dashboard/worker/review/[id]/actions.ts).

### Por qué `OperationType` separado del país

`operationType` (INTERIOR / INTRACOM / IMPORTACION / AGRARIA /
INVERSION_SP / IVA_NO_DEDUCIBLE) es lo que va en la columna A3.
Aunque correlaciona fuertemente con el país del NIF, hay casos
donde no: una factura con NIF español puede ser INVERSION_SP
(Art. 84.Uno.2º LIVA). Por eso `issuerCountry` y `operationType`
son campos distintos.

### Por qué `RectificativeType` y `art80Tres`

Las rectificativas tienen dos tipos contables (BOE Real Decreto
1496/2003):
- `BY_DIFFERENCE` (diferencias) — modifica la base imponible.
- `BY_SUBSTITUTION` (sustitución) — reemplaza la factura entera.

Y `art80Tres` (Art. 80.Tres LIVA) marca rectificativas por
concurso de acreedores/quita — tiene tratamiento fiscal especial.

### Cuentas SaaS por asesoría (multitenancy)

Todo dato cuelga de `AdvisoryFirm`. No hay queries sin `firmId`
en el `WHERE` (directa o transitivamente). Si añades una entidad
nueva, **asegúrate de filtrar por firma** en cualquier query no
trivial. Una query rota aquí es un leak entre asesorías.

## Cron jobs

Configurados en `vercel.json`:

- `/api/cron/retry-stuck` — re-procesa facturas atascadas en
  `ANALYZING` durante > 10 min. Cada 5 min.
- `/api/cron/closure-reminders` — recuerda cerrar el periodo el
  día 1 de cada mes.

Ambos requieren header `Authorization: Bearer $CRON_SECRET`.

## Testing

- **Unit (Vitest)**: en `tests/unit/`. Foco en `lib/`: validators,
  exportFormats, auditLog, reviewQueue. **Corren en el build de la imagen
  Docker** (`RUN npx vitest run tests/unit`, F-032), sin `.env` ni base de
  datos: si uno falla, no hay imagen. Por eso en `tests/unit` no puede haber
  tests que necesiten Postgres, variables de entorno o red.
- **Integración contra Postgres (F-033)**: en `tests/integration/`, fuera de
  la barrera del build y del `include` de `vitest.config.ts`, que solo recoge
  `tests/unit/**`. Tienen su propia config (`vitest.integration.config.ts`) y
  se lanzan con `npm run test:integration` (ver abajo).
- **E2E (Playwright)**: en `tests/e2e/`. Flujos críticos: login,
  subir factura, validar, exportar.

Convención: tests **no mockean Prisma**. Los que usan Prisma van contra
una DB Postgres de test y por eso fuera de `tests/unit`.

### Tests de integración

**Base de datos.** Solo usan `TEST_DATABASE_URL`, nunca `DATABASE_URL` (en
local apunta a Supabase). Cada test la vacía, así que el harness no arranca
si:
- falta o no es Postgres;
- el nombre de la base de datos no es de pruebas, con límite de palabra
  (`facturocr_test`, `test`, `tests-local`; no `latest` ni `facturas`), esté
  donde esté: un túnel SSH o un volcado de producción en localhost también
  son «locales»;
- la URL lleva parámetros que cambian el destino (`?host=`, `?dbname=`…);
- la base de datos a la que conecta de verdad no se llama así;
- tiene tablas y no es del harness. La primera vez, sobre una base de datos
  vacía, se crea el marcador `"_facturocr_test"."marker"` (en su propio
  schema: Prisma no migra un `public` con tablas ajenas); después solo se
  toca si lo tiene. Una BD de tests creada antes de este marcador hay que
  borrarla y crearla de nuevo.

Al arrancar dice por stderr a qué host y base de datos va.

**Zona horaria.** Las fechas de Prisma son `timestamp(3)` sin zona, en UTC.
Los tests no pueden depender de la zona del Postgres (uno instalado en
Windows suele ir en hora de Madrid): en SQL crudo, «hace n minutos» es
`utcMinutesAgoSql(n)` (`(now() AT TIME ZONE 'UTC') - interval …`), nunca
`now()` a secas.

Un Postgres local, por ejemplo con Docker:

```bash
docker run -d --name facturocr-test -p 55432:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=facturocr_test postgres:16
export TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/facturocr_test
npm run test:integration
```

(o con un Postgres instalado: `createdb facturocr_test` y la URL
correspondiente).

**Qué hace el harness.**
- `globalSetup` aplica las migraciones con `prisma migrate deploy` contra
  `TEST_DATABASE_URL` (las mismas que en producción; nunca `reset`).
- Antes de cada test se vacían todas las tablas menos `_prisma_migrations`
  (TRUNCATE). Los ficheros corren uno detrás de otro: comparten la BD.
- Solo se simulan la sesión (`@/lib/auth`, con `signInAs`), `next/cache`,
  `next/navigation`, `after()` (se encola; el test lo ejecuta con
  `runAfterCallbacks`), el OCR (Document AI y Gemini, con `stubOcr`; el
  parser Facturae es el real) y S3 (un servidor en memoria por fichero, que
  puede ir lento o caerse con `fakeS3().setMode(...)`). Prisma y Postgres son
  los reales. Sin `RESEND_API_KEY`, el correo no sale.
- Factorías (`helpers/factories.ts`): `makeFirm("A")` crea una asesoría con
  admin, gestor asignado, cliente con portal y facturas; `makeTwoFirms()`,
  dos, para los tests de aislamiento entre asesorías.
- Carreras: `holdLock(sql)` (`helpers/locks.ts`) abre una transacción que
  bloquea (`LOCK TABLE`, `SELECT … FOR UPDATE`) y la mantiene hasta
  `release()`, para parar una acción a mitad y cruzarle otra.

## Limitaciones conocidas / deuda

1. **OCR multi-IVA mixto**: Document AI Invoice Parser agrupa líneas
   con tipos de IVA distintos. Workaround: el gestor las separa
   manualmente. Solución pendiente: parser custom.
2. **Rate limiter en memoria**: ver `src/lib/rateLimit.ts`. Si la
   app pasa a multi-instancia, hay que migrar a Redis/Upstash.
3. **`Invoice.vatRate`**: denormalizado de las `InvoiceVatLine`.
   Solo es significativo cuando hay 1 línea; con multi-IVA es
   `null`. Tenedlo en cuenta al hacer queries.
4. **`STATUS_LABELS` duplicado**: `src/lib/invoiceStatuses.ts` tiene
   los labels canónicos, pero
   `src/app/dashboard/admin/invoices/[id]/page.tsx` tiene su propia
   copia local. Consolidar.
5. **Reset demo + auditoría**: el bypass via `SET LOCAL` funciona,
   pero es un cuchillo: si alguien lo usa fuera de `demoSeed.ts`,
   se carga la inmutabilidad. Hay que mantenerlo restringido.

## Glosario fiscal mínimo (para devs no españoles)

| Término | Qué es |
|---------|--------|
| **NIF / CIF / DNI / NIE** | Identificador fiscal. CIF para empresas, DNI para personas físicas españolas, NIE para extranjeros. |
| **IVA** | Impuesto sobre el Valor Añadido (VAT). Tipos: 21% (general), 10% (reducido), 4% (super-reducido), 0% (exento). |
| **IRPF / Retención** | Impuesto sobre la Renta. Las facturas a profesionales (Modelo 111) llevan retención del 15%. Los alquileres (Modelo 115), 19%. |
| **Modelo 111 / 115** | Declaraciones trimestrales de retenciones. |
| **Factura rectificativa / abono** | Corrige o anula una factura previa. Lleva signos negativos. |
| **A3 Asesor** | Software contable muy común en asesorías españolas. Importa Excel con un formato concreto (las 16 columnas). |
| **Sage 50 / Contasol / Cegid** | Otros softwares contables. Pendiente reactivar exporters. |
| **Inversión del Sujeto Pasivo (ISP)** | Régimen donde el receptor liquida el IVA (no el emisor). Típico en construcción, chatarra, móviles, gas. |
| **Art. 80.Tres LIVA** | Rectificativa por concurso de acreedores. |
