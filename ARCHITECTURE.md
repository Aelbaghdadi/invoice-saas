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
            │ Postgres │     │ Gemini (OCR) │     │    Garage    │
            │          │     │              │     │     (S3)     │
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
| `SupportTicket` / `SupportMessage` | Soporte: un aviso de la asesoría al equipo del producto y su hilo. Cuelga de la asesoría; el equipo (`SUPPORT_USERNAMES`) ve los de todas. |
| `InvoiceArchive` | Archivo de una factura, una fila por factura (la crea un trigger): llegada, electrónico o papel, original en otro formato, nº de registro y «conservar más». Ver [Archivo de facturas](#archivo-de-facturas). |
| `UploadBatch` | Tanda de subida (cada «Subir» del gestor) o taco de papel («Taco 37»), con su caja o su devolución. Cuelga de la asesoría. Ver [Papel: tandas, tacos y cajas](#papel-tandas-tacos-y-cajas). |
| `InvoiceRegisterSeries` | Último nº de registro del archivo por cliente, tipo (R recibidas, E emitidas) y año. |

Columnas del archivo en entidades de antes: `Client.fiscalYearStartMonth`
(inicio del ejercicio del cliente), `AdvisoryFirm.isDemo` (asesoría de
demostración, que solo se marca a mano) y `AdvisoryFirm.paperScanMode` /
`paperBoxMode` (cómo escanea el papel y cómo guarda las cajas, en Ajustes).

### Estados de Invoice

```
UPLOADED   (también mientras espera turno en la cola del OCR)
   │  claim (ocrAttempts + 1)
   ▼
ANALYZING ────► OCR_ERROR (Gemini falló tras sus reintentos o falta GEMINI_API_KEY)
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

1. Cliente sube PDF → `POST /api/uploads` (un fichero por petición).
2. El fichero va al almacenamiento, con una clave única
   (`src/lib/uploadStorageKey.ts`). Se crean `Document`, `Invoice` con
   `status=UPLOADED` y su fila de archivo en una sola transacción; si falla,
   se borra el fichero recién subido (ver [Archivo de facturas](#archivo-de-facturas)
   → «Altas, partes y lectura»).
3. En un `after()` de esa misma petición, `processInvoice()` pide turno en
   la cola del OCR (`ocrQueue.ts`: `OCR_CONCURRENCY` a la vez, 4 por
   defecto). Mientras espera, la factura sigue en `UPLOADED`. Con hueco, el
   claim la pasa a `ANALYZING` (y sube `ocrAttempts`, la valla del OCR).
   «Reprocesar» (`POST /api/invoices/[id]/process`) usa la misma cola, pero
   delante.
4. `processInvoice()` orquesta:
   - `ocrLlm.ts` (Gemini) → extrae campos de PDF e imágenes; `ocr.ts`
     lee los XML Facturae. Reintentos con backoff exponencial y
     `Retry-After`, con un plazo total de 4 minutos. Sin `GEMINI_API_KEY`,
     los PDF e imágenes acaban en `OCR_ERROR` con `ERR-OCR-005`, sin
     reintentos.
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

### 5. Lotes: a cuál va una subida y cómo se juntan

Un lote es cliente + periodo + agrupación (mensual o trimestral) + tipo
(`batchKey`); octubre y T4 son lotes distintos. Ver
[src/lib/batchTarget.ts](src/lib/batchTarget.ts) (puro, también en el
navegador).

- **Subir facturas** (un cliente) enseña los lotes abiertos del cliente
  (`loadOpenBatches`: algo por revisar o validadas sin exportar, últimos
  12 meses, sin cierre) y propone uno (`defaultUploadTarget`): el lote
  abierto del tipo elegido desde el periodo del mes anterior en adelante
  o, sin él, ese periodo con la agrupación de la última subida (las
  facturas llegan un mes después: en noviembre, octubre; en trimestral,
  el T4, no el trimestre anterior que propone Exportar). Si ese periodo
  está cerrado, el que está en curso. Avisa si hay un lote abierto con la
  otra agrupación que comparte meses, y si el periodo elegido está
  cerrado no deja subir. «Clasificar entre varios» no hereda la propuesta
  de ningún cliente: mensual y el mes anterior.
- **Mover a otro lote…** (tarjetas de Lotes, gestor y admin) cambia el
  periodo de las facturas a otro lote del mismo cliente y tipo
  ([src/lib/batchMove.ts](src/lib/batchMove.ts)): las que ya salieron en
  un Excel se quedan, la original de una división va con sus hijas, con
  un cierre activo en origen o destino no se mueve nada y cada factura
  deja una entrada `lote` en la auditoría. El periodo contable no cambia:
  las que ya se guardaron siguen el cierre de su periodo contable, que es
  el del lote de origen (el Excel no cambia: A3 contabiliza por la fecha
  de la factura). Juntar no se deshace por factura.
- **Con Exportar a la vez:** mover no se lleva una factura que un export
  tiene reservada (`exportBatchId: null` en la escritura), y el export
  reserva con su cliente, periodo y tipo (`commitExportBatch` con
  `exportPeriodWhere`): si el lote se movió mientras se generaba el
  Excel, da conflicto (ERR-EXPORT-003) y se reintenta.

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

Desde la migración 12 (archivo) esa llave sola ya no basta para borrar
facturas ni documentos: hace falta además que la asesoría esté marcada
`AdvisoryFirm.isDemo`, cosa que solo se hace a mano en la BD (nunca desde la
app ni desde un script). `reseedDemo` y `scripts/seed-demo.ts` lo comprueban
antes de tocar nada; sin la marca, el reset devuelve «Esta asesoría no es de
demostración: el reset no está permitido.» (409 en `/api/admin/reset-demo`).
Ver [Archivo de facturas](#archivo-de-facturas) → «Triggers».

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

### Por qué las adquisiciones intracomunitarias llevan un IVA que no suma

Una compra con código 3 (bienes) u 8 (servicios) llega al 0 %, pero A3
necesita el % y la cuota para autorrepercutirla: genera la 472 al debe
y la 477 al haber, que se anulan. Con 0 % no sale ninguna. La revisión
propone el 21 % en las líneas a 0 y avisa al gestor para que lo
confirme o lo cambie. La cuota no se paga al proveedor, así que el
cuadre es Σ Bases = Total, sin ella. El export completa al 21 % las que
sigan a 0. Las ventas intracomunitarias van al 0 % como siempre. La
regla está en [src/lib/selfAssessedVat.ts](src/lib/selfAssessedVat.ts).
Lo pidió el asesor el 2026-10-09.

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

### Soporte y ficha de cliente

- **Soporte** (`/dashboard/support`): la asesoría (ADMIN y WORKER, no los
  clientes del portal) abre tickets (fallo, sugerencia, consulta) con un
  adjunto opcional (`support/<firmId>/<ticketId>/<messageId>.<ext>` en el
  almacenamiento). El administrador ve los de su asesoría; el gestor, los
  suyos. No hay rol nuevo: los usuarios de `SUPPORT_USERNAMES` son del
  equipo del producto y ven y contestan los de todas las asesorías en
  `/dashboard/support/team` (la única pantalla que cruza asesorías a
  propósito). Sus respuestas llevan `fromSupport` y ponen el ticket «en
  curso»; la asesoría solo lo da por resuelto o lo reabre (contestar un
  resuelto lo reabre); «cerrado» es del equipo. Avisos: correo a
  `SUPPORT_EMAIL` y webhook `SUPPORT_WEBHOOK_URL` al abrir y al contestar la
  asesoría; correo a quien abrió el ticket cuando contesta el equipo. Todo en
  `after()`: un correo que no sale no tumba la acción. Lógica pura en
  [src/lib/support.ts](src/lib/support.ts).
- **Tickets automáticos** ([src/lib/autoTickets.ts](src/lib/autoTickets.ts)):
  un error inesperado abre un ticket en Soporte con `source = AUTO`, que
  solo ve el equipo. Vienen de tres sitios: `onRequestError`
  (instrumentation.ts, errores del servidor; la sesión sale del cookie de
  NextAuth), el OCR (ERR-OCR-001, -005 y SYS-001 en `processInvoice`; los
  del documento no) y la pantalla «Algo salió mal» del navegador
  (`/api/support/error-report`, solo sin digest para no duplicar los del
  servidor). El mismo fallo (misma huella: ruta, clase y mensaje sin ids ni
  números; en el OCR, código y estado HTTP) suma `occurrences` al ticket que
  siga sin cerrar, con un `pg_advisory_xact_lock` para que dos a la vez no
  abran dos. Cerrado, la siguiente vez abre otro. Como mucho 20 nuevos por
  hora y proceso; aviso al equipo solo al abrirse. Nunca lanza y espera
  como mucho 5 s.
- **Ficha de cliente** (`/dashboard/admin/clients/[id]` y la del gestor):
  cabecera con cifras, y pestañas Resumen, Facturas (mismos filtros y orden
  que el listado), Periodos (por mes/trimestre: cuántas, pendientes,
  exportadas y si está cerrado), Exportaciones (solo admin), Actividad
  (auditoría del cliente) y Ajustes (solo admin: editar razón social, CIF,
  software, contacto, teléfono y notas internas; recargo; cuentas por
  defecto; gestores). Las cifras y los periodos salen de `groupBy` y se
  juntan en [src/lib/clientSheet.ts](src/lib/clientSheet.ts). El acceso al
  portal de un cliente ya creado sigue sin poder cambiarse (aparcado).

## Archivo de facturas

Un archivo por cliente y ejercicio, en el orden del libro: por periodo de
deducción y, dentro de cada periodo, por llegada. Lo forman las migraciones
`00000000000012_archivo` (tablas, relleno de lo que ya existía y triggers) y
`00000000000013_archivo_tacos` (el papel: ajustes, taco entero, anulación y sus
guardas), y los módulos `src/lib/archive*.ts`, `originalMedium.ts` y
`registerNumbers.ts`, más los del papel (abajo). La fase 1 va en dos entregas:

- **Entrega A:** el archivo digital. Nº de registro del archivo al exportar a
  A3; electrónico o papel, que propone la app y se puede cambiar; «conservar
  hasta» y «conservar más»; buscador y original a un clic; originales en Word,
  Excel, OpenDocument o RTF adjuntos a su factura; ZIP del ejercicio con índice
  Excel; y cifras por cliente y ejercicio.
- **Entrega B:** el papel. Tandas y tacos al subir (factura a factura o el taco
  entero en un PDF), cajas, hoja del taco para imprimir (sin QR), ubicación
  «Caja 3 · Taco 37 · Pág. 28» en todas las pantallas, «Era papel», «Poner
  ubicación», «Sacar del taco», anular y completar un taco. Ver [Papel: tandas,
  tacos y cajas](#papel-tandas-tacos-y-cajas).

### Modelo, y por qué va en una tabla aparte

| Qué | Para qué |
|-----|----------|
| `InvoiceArchive` | Una fila por factura (clave `invoiceId`): llegada (`receivedAt`), nº de parte de una división (`splitPart`), electrónico o papel (`originalMedium`, con su origen, su motivo y `pdfProducer`), original en otro formato (`originalDocumentId` → `Document`), nº de registro (serie, número y fecha) y «conservar más» (motivo y nota). |
| `UploadBatch` | Tanda de subida o taco de papel. Cuelga de la asesoría. `InvoiceArchive` la apunta dos veces: la tanda de llegada (`uploadBatchId` y `uploadPosition`, que fijan el orden y no cambian) y el taco donde se guarda el papel (`paperBatchId`, que se puede poner después sin tocar la llegada). La 13 le añade los candidatos de una tanda de varios (`routingCandidateIds`), el taco entero (`wholePdf`, `pdfDocumentId`, `pdfPageCount`, `pdfSplitAt`, `pdfSplitById`) y la anulación (`voidedAt`, `voidedById`, `voidReason`). |
| `AdvisoryFirm.paperScanMode` / `paperBoxMode` | Cómo escanea el papel la asesoría (factura a factura o el taco entero en un PDF) y cómo guarda las cajas (una por cliente y año o todas juntas). Solo cambian lo que la app propone. |
| `InvoiceRegisterSeries` | Último nº de registro por cliente, tipo (R recibidas, E emitidas) y año. |
| `Client.fiscalYearStartMonth` | Mes en que empieza el ejercicio del cliente (1 = año natural). |
| `AdvisoryFirm.isDemo` | Asesoría de demostración: la única en la que el reset puede borrar facturas y documentos. Solo se marca a mano en la BD. |

La 12 también crea el índice `Invoice(splitFromId)`, el de la familia de una
división. `Invoice` no gana ninguna columna, a propósito: `Invoice.updatedAt` es
el testigo de concurrencia de guardar, validar, rechazar, dividir y exportar. Si
el medio, «conservar más» o el original adjunto vivieran en `Invoice`,
cambiarlos haría fallar una revisión abierta (ERR-VALIDATE-003) y dependería de
que el periodo no estuviera cerrado. En `InvoiceArchive` se cambian con el
periodo cerrado o con la factura ya exportada, y la revisión no se entera.

- **La fila la crea el trigger `invoice_archive_row`** al insertar la factura,
  también con `createMany` y en los tests, con la llegada = `Invoice.createdAt`.
  Nunca uséis `archive: { create }` anidado: choca con la fila del trigger.
  Quien crea una factura y tiene que rellenar su fila lo hace con un `update` en
  la misma transacción (`/api/uploads`, la resubida del portal, la división, el
  reset de la demo).
- **Las ediciones del archivo no escriben en `Invoice`**: solo en
  `InvoiceArchive` (más `Document` al adjuntar un original y `AuditLog`).
- **SQL en crudo** sobre estas tablas pone `"updatedAt" = now() AT TIME ZONE
  'UTC'`: Prisma solo rellena `@updatedAt` en sus propias escrituras, la columna
  no tiene DEFAULT y `now()` a secas daría la hora de Madrid en un Postgres local.

### Orden del archivo

`compareArchiveOrder` (`src/lib/archiveRules.ts`) da un solo orden para la
pestaña Archivo, el índice y los originales del ZIP, la numeración al exportar y
el relleno de la 12, que lo repite en SQL (con `COLLATE "C"`, para comparar los
textos como JS):

1. el **periodo de deducción**: el contable o, si no lo tiene, el del lote
   (`invoicePeriod`, `src/lib/period.ts`). Un lote trimestral sin periodo
   contable propio cuenta su primer mes para ordenar y agrupar, y el último para
   conservar;
2. las recibidas antes que las emitidas;
3. las recibidas, por llegada, posición en la tanda, parte de la división y
   alta; las emitidas, por fecha de factura, nº de factura en orden natural
   («F-2» antes que «F-10», con el corte de `parseInvoiceNumber`) y llegada;
4. el id, para que el orden sea estable.

La **llegada** (`receivedAt`) es la creación de la factura (en una tanda, la de
la tanda: entrega B); las partes de una división heredan la de su original. No
cambia nunca. El Excel de A3 conserva su propio orden (ver abajo).

### Nº de registro al exportar

El «Nº de registro del archivo» (R-2026/0153 las recibidas, E-2026/0007 las
emitidas) se pone la primera vez que la factura sale en un Excel de A3, dentro
de la transacción de `commitExportBatch` (`src/lib/archiveRegister.ts`), con la
fecha del lote. Es el número del libro: el RIVA (arts. 64.1 y 69.3) pide
numerar las recibidas de forma correlativa, por periodo de deducción y por orden
de recepción. Numerar al subir daría número a rechazadas y duplicadas, y en orden
de subida; al validar dejaría huecos, porque una validada aún se puede rechazar.
Una exportada ya no se rechaza, no se divide ni se reprocesa: nunca queda un
número suelto.

- Una serie por cliente, tipo y año natural del periodo de deducción (el del
  IVA; el ejercicio del cliente no lo cambia). Dentro del lote, en el orden del
  archivo. El contador (`InvoiceRegisterSeries.lastNumber`) se reserva con
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, que bloquea la fila de la serie
  hasta el COMMIT: otro export de la misma serie espera y sigue desde ahí.
- Si el export se deshace (un conflicto, un fallo de la auditoría), no se gasta
  ningún número. Reexportar no lo cambia. Las que no entran en el Excel (total
  0, originales divididas, bloqueantes) no lo llevan, ni las rechazadas ni las
  del buzón. Si a una factura le falta la fila de archivo (los triggers
  quitados a mano), la numeración la crea antes, en vez de dar un conflicto.
- Orden de bloqueo: facturas (la reserva del export) → sus filas de archivo, en
  orden de factura (como las ediciones del archivo) → series, en orden de clave
  → cadenas de auditoría. El export lleva `lock_timeout` de 10 s, por debajo del
  `statement_timeout`: una espera larga, un deadlock o un 57014 son
  `ExportConflictError` (ERR-EXPORT-003, se puede reintentar).
- **No se renumera nunca.** Una factura que llega tarde toma el siguiente número
  de su serie y sale «Registrada tarde» (`flagLateRegistrations`: tiene un
  número mayor que alguna de un periodo posterior). Si después se corrige su
  tipo o su periodo, el número se queda y se avisa («Numerada como recibida»,
  «Nº de otro año»). Los triggers impiden cambiarlo (ver «Triggers»).
- **Lo exportado antes del archivo** lo numera el relleno de la 12: las
  `VALIDATED` o `EXPORTED` con algún `ExportBatchItem`, por la fecha del primer
  lote en el que salieron y después en el orden del archivo, y deja cada
  contador en el mayor número de su serie (2026 no empieza en 1 a mitad de año).
  Las exportadas en otro estado (rechazadas o divididas después) se quedan sin
  número: DEPLOY.md §10.4 las cuenta para decidirlo.
- **No es el nº que pone A3 al importar** y puede no coincidir: el Excel de A3 no
  cambia (ni su orden ni su contenido) y no lo lleva. En pantalla se llama «Nº de
  registro del archivo» y el LEEME del ZIP lo explica.

### Ejercicio y «conservar hasta»

- **Ejercicio:** el que contiene el primer mes del periodo de deducción, según
  `Client.fiscalYearStartMonth` (Ajustes del cliente, «El ejercicio empieza en»;
  enero = año natural). Se rotula «2026» o, si no empieza en enero, «2025-26».
  Agrupa la pestaña Archivo, el ZIP y las cifras. No cambia los números de
  registro.
- **«Conservar hasta»** (`retainUntil`): el último día del ejercicio que
  contiene lo más tardío entre el final del periodo de deducción y la fecha de la
  factura, más 6 años (`RETENTION_MIN_YEARS`, Código de Comercio, art. 30),
  siempre a fin de mes. Una de 2025 → 31/12/2031; del ejercicio julio-junio
  2025-26 → 30/06/2032. Se calcula al leer, no se guarda.
- **«Conservar más»** (`retentionHold`, con motivo y nota): sin fecha hasta que
  alguien lo quite. Es para el inmovilizado, las bases negativas o deducciones
  pendientes (LGT, arts. 66 bis y 70.3), una inspección o un pleito. En una
  compra con cuenta del grupo 2 se sugiere «Inmovilizado», pero no se marca solo.
  Vale para todas las facturas, también las rechazadas.
- En la fase 1 es informativo: no hay purga. El ejercicio no guarda desde
  cuándo vale: cambiarlo reagrupa hacia atrás (limitación 6).

### Electrónico o papel, y «Por confirmar»

Un PDF escaneado que llega por correo puede ser el original electrónico (RD
1619/2012, art. 9) o la copia de un papel que guarda alguien, y la app no lo
sabe. Por eso la app nunca pone «Papel» por su cuenta fuera de un taco: lo que no
sabe queda «Por confirmar» (`originalMedium` vacío), con su motivo, y no cuenta
como papel en las cifras. `proposeOriginalMedium` (`src/lib/originalMedium.ts`)
decide así (gana la primera fila que casa):

| Caso | Queda | Motivo (`originalMediumReason`) |
|------|-------|---------------------------------|
| XML | Electrónico | `xml` |
| Con un original en otro formato adjunto | Electrónico, a mano | `other_format` |
| Subida en un taco (entrega B) | Papel, del taco | `taco` |
| Imagen | Por confirmar | `image_unconfirmed`: «Foto: falta confirmar si hay papel» |
| PDF hecho por un escáner (aunque traiga texto) | Por confirmar | `scan_unconfirmed`: «Escaneo: falta confirmar si hay papel» |
| Lectura del PDF fallida o cortada | Por confirmar | `pdf_unreadable`: «No se pudo leer el PDF» |
| PDF con capa de texto | Electrónico | `pdf_text` |
| PDF sin capa de texto | Por confirmar | `scan_unconfirmed` |

Capa de texto = más de 100 caracteres sin contar espacios y como mucho un 2 % de
caracteres rotos (los umbrales de `isUsefulPdfText`, que es otro criterio: un PDF
digital sin NIF también es electrónico). Escáner = Producer o Creator que casa
con `SCANNER_PRODUCER_RE`. Además, el relleno de la 12 deja los PDF de antes del
archivo en `backfill_pending` («Pendiente de detectar», ver abajo), las partes
de una división llevan `split` y lo que pone una persona, `manual`. «Lo guarda el
cliente» (`paperHeldByClient`) solo lo pone la subida de un usuario CLIENT y su
resubida, nunca la detección.

- **Dónde se escribe:** `applyAutoMedium` (`src/lib/archiveEdits.ts`) dentro de
  las dos transacciones valladas del análisis (la del resultado y la de
  OCR_ERROR), así que una ejecución que ya no es la dueña no escribe nada. El
  texto del PDF se lee una sola vez por análisis, con la primera descarga, y
  sirve también a Gemini.
- **Quién manda:** el análisis solo escribe si el medio está vacío o es AUTO,
  nunca sobre TACO ni MANUAL, y nunca en una parte de una división: las partes
  heredan de su original, y la propuesta de la original les llega si toda la
  familia está vacía o en AUTO.
- `auto:originalMedium` solo queda en la auditoría cuando un reproceso le da la
  vuelta a un medio que ya había propuesto la app. Un reproceso que no consigue
  leer el PDF (roto o cortado por tiempo) no pisa una propuesta que sí lo leyó.
- Producer y Creator se guardan sin caracteres de control (`cleanPdfInfoText`):
  pdf.js los devuelve tal cual y Postgres no admite un NUL en un texto.
- **Bloqueos de una familia:** primero la fila de archivo de la raíz (el mismo
  bloqueo que toma una división) y después el resto por `invoiceId`. Así la
  familia se lee con las partes que acaba de crear una división a la vez, y nadie
  se espera en cruz con el export, que nunca bloquea una raíz.
- A mano, desde el archivo: ver «Pantallas y ediciones a mano».

### Detección de los PDF de antes del archivo

El relleno de la 12 no lee ningún PDF: los deja «Pendiente de detectar». La capa
de texto y el productor solo salen del fichero, y Garage solo se alcanza desde la
red interna de Coolify. Lo hace la propia app en `/api/cron/archivo-detectar`
(`src/lib/archiveMediumBackfill.ts`):

- `GET` o `POST` con `CRON_SECRET`, como los demás crons, pero **no es
  periódico**: se lanza tras desplegar la 12 hasta que no quede ninguno
  (DEPLOY.md §10.6). `?dryRun=1` solo cuenta lo pendiente, sin descargar ni
  escribir; `?limit=`, cuántas por llamada (50 por defecto, 200 como mucho).
- Toma las facturas en AUTO y `backfill_pending` de todas las asesorías, como
  `retry-stuck` (las partes de una división no: les llega lo de su raíz). Descarga el PDF, aplica `extractPdfTextAndItems`
  y `proposeOriginalMedium` y solo escribe si la fila sigue en AUTO y pendiente:
  lo que haya analizado la app o decidido una persona mientras tanto no se toca.
  Lleva la propuesta a las partes. Sin auditoría: es la primera propuesta.
- Cada factura va en su propia transacción, con `lock_timeout` de 5 s. Una que
  falla (el almacenamiento, una espera larga, un error que se repite) va a
  `errores` y no para a las demás; la siguiente llamada la vuelve a mirar. Un PDF
  que ya no está, o cuyo productor no se puede guardar, queda «No se pudo leer el
  PDF». Responde `{ revisadas, electronicas, porConfirmar, ilegibles, errores,
  quedan }`.

### Triggers: nada se borra, y el bypass solo para la demo

Al final del `migration.sql` de la 12, después del relleno. Todos dan
`check_violation` (23514) con un mensaje que empieza por «Archivo:».

| Trigger | Dónde | Qué impide (o hace) |
|---------|-------|---------------------|
| `invoice_archive_row` | AFTER INSERT en `Invoice` | Crea la fila de archivo de la factura. |
| `archive_no_delete_by_client` | BEFORE DELETE en `Invoice` y en `Document` | Borrar facturas y documentos, salvo el reset de una asesoría `isDemo` con la llave. |
| `archive_row_no_delete` | BEFORE DELETE en `InvoiceArchive` | Borrar la fila con su factura viva: solo se va en cascada con ella. Sin llave. |
| `archive_file_guard` | BEFORE UPDATE OF `storageKey`, `fileHash` en `Invoice` y en `Document` | Cambiar el fichero o una huella ya puesta (rellenar una vacía sí se puede). |
| `invoice_registered_client_guard` | BEFORE UPDATE OF `clientId` en `Invoice` | Que una factura con nº de registro cambie de cliente. |
| `archive_row_guard` | BEFORE UPDATE en `InvoiceArchive` | Un nº de registro a medias (sin serie o sin fecha), en la serie de otro cliente, tipo o año, o que cambie una vez puesto; que cambien la tanda de llegada o la posición ya puestas; que el papel vuelva a quedarse sin taco. El original adjunto sí se puede quitar: queda en la auditoría y el `Document` no se borra. |
| `register_series_guard` | BEFORE UPDATE en `InvoiceRegisterSeries` | Que una serie cambie de cliente, tipo o año, o que su contador baje (la siguiente reserva repetiría números). |
| `taco_number_guard` | BEFORE UPDATE OF `tacoNumber` en `UploadBatch` | Que cambie el nº de un taco ya puesto. |
| `upload_batch_guard` (13) | BEFORE INSERT OR UPDATE en `UploadBatch` | Que cambie lo que fija una tanda (asesoría, cliente, candidatos, origen, creación, lote, tipo, modo y PDF); que baje su nº de ficheros o que crezca fuera de un taco de factura a factura sin anular; un taco entero sin nº, sin PDF, de varios ficheros o sin cliente; dividirlo dos veces; anular sin motivo, dos veces o algo que no sea un taco subido; guardar en caja o devolver una tanda sin nº; cambiar la caja de un taco anulado; un cliente, candidato o PDF de otra asesoría. |
| `archive_batch_firm_guard` (13) | BEFORE UPDATE OF `uploadBatchId`, `paperBatchId` en `InvoiceArchive` | Poner en una factura la tanda o el taco de otra asesoría, o su papel en una tanda sin nº. |

- **La llave es la de la auditoría** (`SET LOCAL app.allow_audit_mutation`,
  dentro de una transacción), pero para borrar facturas y documentos hace falta
  además que la asesoría esté marcada `isDemo`. Solo se marca a mano en la BD
  (DEPLOY.md §10.5), nunca desde la app, un script ni una migración: así el único
  camino que borra, el reset de la demo, no puede tocar una asesoría real.
  `reseedDemo` y `scripts/seed-demo.ts` lo comprueban antes de tocar nada; sin la
  marca, el reset no borra nada y responde «Esta asesoría no es de demostración:
  el reset no está permitido.» (409 en `/api/admin/reset-demo`).
- **Un cliente con facturas o documentos no se puede borrar**, ni en la demo con
  la llave: la cascada llega a esos triggers con el cliente ya borrado y no
  encuentra su asesoría. El reset borra primero facturas y documentos, después los
  clientes. La baja de un cliente exporta, entrega y bloquea; no borra
  ([docs/baja-de-cliente.md](docs/baja-de-cliente.md)).
- Las guardas de UPDATE no tienen llave: ningún camino de la app las necesita.
- `TRUNCATE` (el harness de tests) no dispara triggers de fila. Una restauración
  solo de datos necesita `--disable-triggers` (DEPLOY.md §10.7). El SQL que los
  quita en una emergencia está en DEPLOY.md §10.8.

### Altas, partes y lectura

- **Claves únicas.** `/api/uploads` y la resubida del portal guardan el fichero
  en `{cliente}/{periodo}/{instante}-{UUID}-{nombre}` (`uploadStorageKey`, como
  `splitStorageKey`): con solo el instante, dos subidas del mismo nombre en el
  mismo milisegundo compartían objeto y una sobrescribía el original de la otra.
- **La fila al subir** (`archiveIntakeFields`): un XML es electrónico, una
  imagen queda «Por confirmar» y un PDF espera al análisis. Lo que sube un
  usuario CLIENT (y su resubida) lo guarda el cliente; la app no lo marca así en
  ningún otro caso. `Document`, `Invoice` y la fila van en una transacción; si
  falla, se borra el objeto (su clave es única) y se responde ERR-SYS-001 con
  ticket automático.
- **Partes de una división** (`src/lib/archiveSplit.ts`, desde
  `reserveAndCreateSplit`): heredan de la factura que se divide la llegada, la
  tanda y la posición, el taco del papel, «lo guarda el cliente» y el medio con
  su origen (motivo `split`). El nº de parte es el mayor de toda la familia de
  la raíz + 1, + 2…, como el relleno de la 12; antes de leerlo se bloquea la
  fila de archivo de la raíz, así que dos hermanas que se dividen a la vez no
  repiten número.
- **Acceso** (`src/lib/archiveAccess.ts`): las rutas y páginas del archivo
  comprueban la asesoría también para el ADMIN (no usan `canReadInvoice`). El
  WORKER entra en sus clientes y, en el buzón, si tiene asignado un candidato.
  Sin acceso, 404.
- **Lectura** (`src/lib/archiveData.ts`): el archivo de un cliente se saca por
  ejercicio con el periodo de deducción y se ordena, filtra y pagina en memoria
  (como el listado de facturas), con un subtítulo por periodo de deducción (su
  primer mes; si un lote trimestral lo abarca, «T3 2026»); el buscador suma
  siempre el texto a la interpretación (nº de registro, importe) y pone primero
  lo exacto; las cifras (`archiveMetrics.ts`) no cuentan el buzón, lo que está
  por clasificar ni las originales divididas (sí sus partes), y llevan aparte las
  rechazadas.
- **Original a un clic**: `/api/archive/invoices/[id]/original` sirve el adjunto
  en otro formato si lo hay (siempre como descarga; en una parte, el de su raíz,
  que es el de toda la familia), si no el documento entero de una división, si no
  el de la factura; `?copia=1`, el fichero que lee la app. CSP sandbox y nosniff
  en `next.config.ts`, como `/raw`.

### Pantallas y ediciones a mano

- **Pantallas.** `/dashboard/archivo` (buscador «¿Dónde está?» y resumen por
  cliente y ejercicio), la pestaña «Archivo» de la ficha del cliente (la del
  administrador y la del gestor) y la ficha de archivo de una factura
  (`/dashboard/archivo/facturas/[id]`). Cada página comprueba el rol y el
  acceso ella misma (el proxy deja entrar en `/dashboard` a cualquiera); sin
  acceso, 404. Las del papel, en [Papel: tandas, tacos y
  cajas](#papel-tandas-tacos-y-cajas).
- **Ediciones** (`setOriginalMedium` y `setRetentionHold` en
  `src/lib/archiveEdits.ts`, acciones en `src/app/dashboard/archivo/actions.ts`):
  solo escriben en `InvoiceArchive`, así que no cambian `Invoice.updatedAt` (una
  revisión abierta sigue validando) y valen con el periodo cerrado o la factura
  exportada. Una o varias facturas, siempre del mismo cliente; auditoría por
  factura (`originalMedium`, `retentionHold`) en la misma transacción.
- **Electrónico o papel a mano** («Electrónico», «Papel» o «Por confirmar»)
  cambia toda la familia de cada división (es el mismo papel), con origen MANUAL
  y motivo `manual`, que el análisis ya no pisa; «Por confirmar» a mano es el
  medio vacío con origen MANUAL. No se puede mientras alguna de la familia se
  analiza (UPLOADED o ANALYZING). Bloquea como la división: primero las raíces,
  después el resto por `invoiceId`. En la ficha, lo que propuso la app se fija
  con «Confirmar «Electrónico»» (mismo medio, origen MANUAL); en la tabla, desde
  «todas las de esta página» se pueden elegir todas las de lo filtrado, hasta
  las 200 que admiten las acciones.
- **Las partes de una división** con motivo `split` enseñan el motivo de su raíz
  («Foto: falta confirmar si hay papel (todo el documento dividido)») mientras
  la raíz tenga el mismo medio.
- **La llegada** se llama «Recibida el» en una recibida y «Subida el» en una
  emitida (ficha, cabecera de la tabla e índice del ZIP); con las dos mezcladas,
  «Recibida o subida el».
- **Las acciones nunca lanzan**: la comprobación de acceso va dentro del mismo
  `try` que la edición, así que un fallo de la BD ahí también acaba en «No se ha
  podido guardar».
- **Esperas**: `lock_timeout` de 5 s (`ARCHIVE_EDIT_WAITS`); un conflicto o una
  espera larga (40P01, 40001, 55P03, 57014) no lanza: la acción devuelve «Otra
  persona estaba cambiando estas facturas; vuelve a intentarlo.».
- **Ejercicio del cliente**: «El ejercicio empieza en» (Ajustes, de enero a
  diciembre; enero = año natural). Si el cliente ya tiene facturas, el
  formulario avisa antes de guardar de que reagrupa todo su archivo y su
  «conservar hasta» (limitación 6).

### Originales en otros formatos y ZIP del ejercicio

- **Original en Word, Excel, OpenDocument o RTF.** No se sube como factura
  (`validateUploadedFile` sigue sin admitirlo): se adjunta desde la ficha de
  archivo a una factura cuyo PDF ya está subido, y la app sigue leyendo el PDF.
  `validateOriginalAttachment` (`fileValidation.ts`) mira el contenido y no el
  nombre: OLE2 con el flujo `WordDocument` (.doc) o `Workbook`/`Book` (.xls) en
  su directorio (leído con `XLSX.CFB`, sin distinguir mayúsculas, como Office;
  con macros —`Macros`, `_VBA_PROJECT_CUR`, `VBA`, `_VBA_PROJECT`, o una hoja de
  macros de Excel 4.0— no), ZIP con `[Content_Types].xml` (.docx, .xlsx; con
  macros —`macroEnabled` o `vbaProject.bin`— no), ZIP con la entrada `mimetype`
  de OpenDocument (.odt, .ods; con `Basic/` o `Scripts/`, salvo los índices
  vacíos de las bibliotecas, no) o `{\rtf` (.rtf); la extensión tiene que ser
  la del contenido. Del ZIP solo se lee el índice y como mucho 1 MB de esas dos
  entradas.
- `attachOriginalDocument` (`archiveEdits.ts`) sube el fichero a
  `{cliente}/originales/{instante}-{UUID}-{nombre}` (bajo el prefijo del
  cliente, que es lo que borra el reset de la demo), crea un `Document` del
  cliente y apunta la fila a él; el medio pasa a electrónico (MANUAL, motivo
  `other_format`). En una división va a la raíz y el medio, a toda la familia.
  Si la transacción falla, se borra el objeto. Un adjunto anterior se queda
  (Document, objeto y auditoría). «Quitar el original adjunto» solo pone
  `originalDocumentId` a NULL, con la auditoría «nombre → —»: no borra nada y el
  medio no cambia.
- **ZIP del ejercicio** (`/api/archive/clients/[id]/zip`; solo ADMIN de la
  asesoría): `archiveExport.ts` decide una vez qué lleva (`checkArchiveExport`,
  con `loadArchiveYearRows` y `planArchiveZip`) y la comprobación (`?check=1`),
  el rastro `archiveExport` (antes del primer byte) y la escritura usan lo mismo.
  Carpetas `recibidas/`, `emitidas/` (por la serie del nº de registro),
  `sin-registrar/` y, si se piden, `rechazadas/`, y dentro el periodo de
  deducción (AAAA-MM). Cada objeto del almacenamiento va una vez: un Word con
  su «(copia).pdf»; de una división, el documento entero donde cae su primera
  parte. El SHA-256 se calcula al pasar y se compara, factura por factura, con
  el `fileHash` que se guardó para ESA factura (`checkArchiveFiles`); si no
  coincide, o el original falta, va a ERRORES.txt y el ZIP sigue. Dos facturas
  antiguas con la misma clave (subidas antes de `uploadStorageKey`) comparten un
  objeto: las dos llevan el aviso y ERRORES.txt dice cuáles son. `indice.xlsx`
  (`archiveIndexXlsx.ts`) va en el orden del archivo, con los importes como
  número, las fechas como fecha y los textos siempre como texto (sin fórmulas).
  Tiene los límites de la descarga de datos (`CLIENT_EXPORT_LIMITS`), sumando
  cada fichero una vez; si no cabe, 413 y «por trimestres» (del ejercicio). Sin
  auditoría, notas internas ni nombres o correos del personal: es lo que se
  entrega al cliente que lo pide o se da de baja.
- `zipStream.ts` es el ZIP en streaming de las dos descargas (contrapresión,
  corte antes de 4 GiB sin ZIP64, entrada cortada que se cierra). La descarga de
  datos del cliente lleva también los adjuntos en `originales/` y en
  `facturas.csv` las columnas «Nº de registro», «Original en otro formato» y
  «Original electrónico o en papel» («Original» sigue siendo la ruta del
  fichero).

### Papel: tandas, tacos y cajas

La entrega B: dónde está el papel que escanea la asesoría. Módulos:
`uploadBatches.ts` (crear tandas y tacos, nº de taco, el taco entero al subirlo),
`uploadListState.ts` y `uploadOrder.ts` (la lista de la subida, puros),
`tacos.ts` (guardar, «Era papel», «Poner ubicación», anular y completar),
`tacoSplit.ts`, `tacoSplitPlan.ts` y `pdfPieces.ts` (dividir el taco entero),
`paperLocation.ts` y `boxProposal.ts` (ubicación, huecos y caja propuesta,
puros) y `tacoData.ts` (lectura de la pestaña Tacos, el detalle y los avisos).

- **Dos ajustes de la asesoría** (Ajustes → Papel, solo el ADMIN):
  «Cómo escaneáis el papel» (factura a factura, por defecto, o el taco entero en
  un PDF) y «Cómo guardáis las cajas» (una por cliente y año, por defecto, o
  todas juntas). Solo cambian lo que la app propone: el modo que sale marcado al
  subir papel y la caja que se propone. Nada de lo hecho cambia.
- **Una tanda en cada «Subir» del gestor**, también digital (`startUploadBatch`
  antes de subir; una subida digital de más de 500 ficheros va en tandas de 500).
  Fija la llegada (`receivedAt` = creación de la tanda) y el orden de lo que se
  subió junto, y es lo que permite después «Era papel». El portal sigue subiendo
  sin tanda. Cada fichero lleva su tanda y su posición; `/api/uploads` comprueba
  que casan cliente, lote y tipo (ERR-UPLOAD-008), que la página está libre (un
  reintento que ya llegó responde 200 `alreadyUploaded`, otro fichero 409
  ERR-UPLOAD-009) y que un XML no va en un taco (ERR-UPLOAD-010). Una tanda
  digital caduca a las 24 h; un taco, no.
- **Nº de taco** («Taco 37», «T37»): correlativo por asesoría, el mismo contador
  para todos los tacos, nunca se reutiliza ni cambia. Se reserva en la
  transacción que lo pone con `pg_advisory_xact_lock(48049, hashtext(firmId))`
  y después `MAX + 1`, en dos sentencias (en una sola, la foto sería anterior al
  bloqueo). El bloqueo para los «Subir» de toda la asesoría, así que va **el
  último**, justo antes de escribir la tanda (B-R21): las escrituras de varias
  filas bloquean primero la tanda, después las raíces de división y el resto de
  filas, vuelven a leer y validan, y solo entonces toman el de la asesoría.
- **La página es la posición** (`uploadPosition`). Factura a factura, «Pág. 28»
  es la factura 28.ª del montón aunque tenga varias hojas (un fichero, una
  página). En el taco entero es la página **del PDF** donde empieza la factura
  («Pág. 27 del PDF»), y el detalle y la hoja llevan además su orden («12.ª»):
  con un escáner a dos caras la página del PDF no es la hoja. En el papel se
  cuentan facturas, no hojas. Las partes de una división comparten la página de
  su factura.
- **El taco entero en un PDF** se crea al subir su PDF (`createWholeTaco`, de
  hasta 20 MB y 500 páginas; si la subida falla, no se gasta ningún nº). Hasta
  que se marca dónde empieza cada factura es un `Document` colgado de la tanda
  (`pdfDocumentId`), **sin `Invoice`**: así no entra en la cola de revisión, ni
  en los contadores, ni lo coge `retry-stuck` ni el OCR. Lo pendiente se ve en la
  tarjeta de la subida, en Tacos («Por dividir»), en el Resumen y en los paneles,
  y el periodo de su lote no se cierra ni desde Lotes ni desde Cierres. Se divide
  una vez (`splitWholeTaco`, hasta 300 facturas): corta el PDF con
  `pdfPieces.ts` (los trozos se suben igual que en «Dividir PDF» de la revisión y
  en la separación automática, `invoiceSplit.ts`) y crea
  **facturas independientes**, no partes de una división: una familia es un solo
  papel (R11), y con 52 facturas colgando de una raíz cambiar el medio o adjuntar
  un Word a una lo cambiaría en todas. Vuelve a mirar el cierre del periodo
  dentro de la transacción, después de reservar.
- **Con la separación automática** (`autoSplit.ts`, un PDF con varias facturas
  que Gemini separa al analizarlo): no toca las facturas de un taco entero, que
  ya marcó una persona. En una subida factura a factura sí separa, y las hijas
  heredan tanda, página y nº de parte como en «Dividir». Si su transacción se
  cruza con «Guardar en caja», «Era papel» o «Anular» (bloquean la tanda y luego
  sus filas; ella, al revés) y Postgres la aborta (40P01), se repite.
- **Caja** (`fileTaco`): etiqueta libre de 2 a 80 caracteres, o «Devuelto al
  cliente» con la fecha de hoy; se puede cambiar cuantas veces haga falta y cada
  cambio deja `paperLocation` en la auditoría de cada factura cuyo papel está en
  el taco. La propuesta (`proposeBoxLabels`) solo rellena el campo: «una por
  cliente y año» propone la última caja de ese cliente y ejercicio («Panadería
  López · 2026 · Caja 3»; sin cliente, «Varios clientes · 2026 · Caja 1»), «todas
  juntas» la última de la asesoría («Caja 12»), y solo cuentan las etiquetas del
  modo actual, para que cambiar el ajuste no mezcle cajas. «Caja nueva» la
  calcula **el servidor** al guardar, con el bloqueo de la asesoría, para que
  dos a la vez no den la misma; el número es el que va detrás de «caja», no el
  año del final de una etiqueta escrita a mano. Las sugerencias del campo solo
  llevan cajas de tacos que quien pregunta ve (B-R20): con «una por cliente y
  año» la etiqueta lleva el nombre del cliente. La propuesta y «Caja nueva» sí
  cuentan todas.
- **Ubicación** (`paperLocationOf`): el taco del papel es `paperBatch` si lo hay;
  si no, la tanda de llegada si es un taco. «Panadería López · 2026 · Caja 3 ·
  Taco 37 · Pág. 28», «Devuelto al cliente el 21/11/2026 · Taco 37 · Pág. 28»,
  «Taco 37 · Pág. 28 (sin guardar)», «(taco anulado)», «{caja} · papel ubicado a
  mano», «Lo guarda el cliente», «Original electrónico», «Por confirmar» o «Sin
  ubicación». Sale en la pestaña Archivo del cliente (forma corta, sin el
  «{cliente} · {ejercicio} · » que ahí ya se sabe), en la ficha, en el buscador
  (que encuentra por «T37», «taco 37 pág 28», «caja 3» y las palabras de una
  etiqueta) y en el `indice.xlsx` del ZIP («Ubicación del papel»). Las palabras
  de una etiqueta (`boxLabelMatchesWords`) cuentan como texto, no como exactas, y
  alguna tiene que estar fuera del «{cliente} · {ejercicio} · » de la caja: el
  nombre del cliente o el año solos traerían todo su papel guardado. El filtro
  de texto de la pestaña del cliente entiende lo mismo que el buscador.
- **Papel sin ubicación** = PAPER, no rechazada, sin taco y sin «lo guarda el
  cliente». El papel de un taco sin guardar no cuenta (es otro aviso: «tacos sin
  guardar en caja»). Al lado va siempre **«Por confirmar» sin ubicación**: fuera
  de un taco un escaneo nunca se da por papel, así que todo el papel de antes del
  archivo está «Por confirmar» y sin esa cifra la métrica saldría 0. En las
  cifras, `located` (paperHeldByClient, `paperBatchId` o tanda de llegada con
  nº, lo mismo que `paperLocationOf`). Lo «Por confirmar» que espera su análisis
  o se está analizando (`IN_ANALYSIS`) no cuenta: el análisis aún puede decir
  que es electrónico.
- **«Poner ubicación»** (`placePaper`) sobre una selección (200), sobre todo lo
  sin ubicación de un cliente y ejercicio (2.000; con «Incluir las por
  confirmar») o **«Sacar del taco»** de una factura: en una caja (un taco ARCHIVE
  por cliente, ejercicio y caja, que se reutiliza; sin páginas), «Se lo
  devolvemos hoy» o «Lo tiene el cliente». Amplía a la familia de división, pero
  solo a lo del mismo cliente: una subida «entre varias» que se separa sola deja
  hijas de varios clientes (y la raíz en el buzón) en una familia, y el papel de
  cada una es de su cliente. Se salta lo que no se puede ubicar y lo cuenta antes (`previewPlacePaper`); lo
  «Por confirmar» pasa a PAPER/MANUAL, que el análisis ya no cambia, así que se
  salta («se está analizando») si alguna de su familia espera su análisis o se
  analiza, como en `setOriginalMedium`. **«Era papel: crear taco»**
  (`convertToTaco`) da nº a una tanda digital y pasa su «Por confirmar» a
  PAPER/TACO; las electrónicas se quedan como están.
- **`writeAutoMedium` solo da «taco» a una fila con el medio vacío**: una
  propuesta electrónica que «Era papel» dejó como estaba no pasa a papel al
  reprocesarla.
- **Anular un taco** (`voidTaco`, con motivo): solo uno subido y sin facturas
  vivas ni papel puesto desde fuera (un taco entero al cliente o lote
  equivocados, uno vacío, uno con todo rechazado). Conserva su nº y su historia,
  sale de los avisos, no bloquea el cierre, no cuenta como duplicado del PDF ni
  para la propuesta de caja. La subida toma la tanda `FOR SHARE`, así que una
  factura y una anulación a la vez no dejan un taco anulado con una factura viva.
- **Completar un taco** (`extendTaco` + «Completar el taco» en su detalle): los
  ficheros que faltan van a sus páginas vacías o al final (el `fileCount` solo
  sube, con el valor leído como testigo). El navegador calcula la huella de cada
  fichero y reconoce lo que ya está, así que se puede soltar otra vez todo el
  montón. Con el periodo del lote cerrado no se hace sitio: la subida no
  entraría y las páginas nuevas quedarían «sin factura» para siempre.
- **La hoja del taco** (`/imprimir/taco/[id]`): fuera del dashboard (sin barra
  lateral), A4 en blanco y negro, «TACO 37» en grande, cliente, lote, caja (o una
  línea para escribirla), «Conservar hasta (como mínimo)» y la lista por página
  con los huecos; mientras una factura se analiza, el nombre de su fichero. La
  página comprueba ella misma sesión, rol y acceso (el proxy solo exige sesión
  fuera de `/dashboard`). Sin QR: necesitaría un paquete.
- **Acceso** (B-R20, una sola definición: `uploadBatchVisibleWhere` en
  `archiveAccess.ts`, que usan `canAccessUploadBatch`, los listados y los
  avisos). El ADMIN, todas las de su asesoría. El WORKER, una tanda con cliente
  solo si lo tiene asignado, **aunque la creara él**: si le quitan el cliente,
  deja de ver su PDF, de dividirlo y de guardarlo. Una tanda de varios, si la
  creó, si tiene alguno de sus candidatos (mientras esperan el ruteo sus
  facturas están en el buzón) o el cliente de alguna de sus facturas; en el
  detalle y en la hoja, las de clientes que no tiene salen como «Factura de otra
  empresa».
- **Guardas de la 13** (`upload_batch_guard`, `archive_batch_firm_guard`, en la
  tabla de triggers): lo que fija una tanda no cambia, el taco entero se divide
  una vez, se anula una vez y con motivo, y la tanda y el taco de una fila de
  archivo son de su asesoría. Sin llave: ningún camino de la app la necesita.
- **Reset de la demo**: borra facturas, después tandas y después documentos (la
  FK de `pdfDocumentId` es RESTRICT: el PDF de un taco entero no se puede borrar
  mientras exista su tanda).
- **Descarga de datos del cliente** (F-044): lleva el PDF de cada taco entero del
  cliente en `tacos/` (anulados incluidos: es un documento suyo).

### Pendiente (fuera de la fase 1)

- **Mejoras del papel** (entrega B): QR en la hoja que abra el taco (necesita un
  paquete); proponer los cortes del taco entero (texto de cada página, NIF y
  totales); «Corregir las marcas» de un taco entero ya dividido (rechazar las
  afectadas y crear las nuevas con `splitPart` libre en su página, sin
  migración); «Rechazar el taco» de una vez; elegir la fecha de «Devuelto al
  cliente»; un taco entero en varios PDF y PDF de más de 20 MB; la ubicación en
  la pantalla de revisión y en `facturas.csv` de la descarga de datos; «+ Taco 38
  por dividir» en la tarjeta del lote; arrastrar y soltar filas en la lista de la
  subida; el nº de hojas de cada fichero en la hoja del taco; encolar el OCR de
  un taco grande detrás de lo que ya espera; y el acceso del cliente (portal) a
  su archivo.
- **Clientes que no se exportan desde la app.** El nº de registro solo se pone en
  `commitExportBatch`: un cliente que la asesoría lleva en otro programa, o que
  mete a mano en A3, no tendrá nunca número y todo su archivo saldrá «sin
  registrar». Hará falta otro disparador con la misma función
  (`assignRegisterNumbers`): al cerrar el periodo o con un «Registrar el periodo»
  explícito.
- **Tabla de eventos por cliente.** `AuditLog` exige factura, así que no queda
  rastro de un cambio de `fiscalYearStartMonth`, de un ZIP de un ejercicio sin
  facturas ni, con la entrega B, de guardar en caja un taco sin facturas. Necesita
  migración.
- **Rendimiento con muchos años.** La pestaña, el ZIP y el buscador trabajan en
  memoria por cliente y ejercicio (el buscador, con todo el ámbito por
  `matchingInvoiceIds`), como el listado de facturas. Si crece: ordenar y paginar
  sobre una consulta ligera y llevar el texto a `unaccent` o `pg_trgm`.
- **Alinear el nº de registro con el de A3.** Hoy pueden no coincidir. Si el
  asesor lo necesita: fijar el primer número de cada serie
  (`InvoiceRegisterSeries.lastNumber`) o sacar las filas del Excel en el orden del
  archivo.
- **«Anular lote»** (aparcado): si algún día existe, no debe liberar números de
  registro. Un número dado no vuelve: los triggers no dejan quitarlo.
- Limitaciones conocidas 5, 6 y 7 (borrados futuros, ejercicio sin vigencias y
  adjuntos sustituidos), abajo.

## Cron jobs

Se disparan con una Scheduled Task de Coolify (DEPLOY.md §5):

- `/api/cron/retry-stuck` — relanza las facturas que llevan más de 5 min
  en `UPLOADED` sin empezar (p. ej. la cola perdida en un redeploy) o
  atascadas en `ANALYZING`, y pasa a `OCR_ERROR` las que agotaron los
  reintentos.
- `/api/cron/closure-reminders` — recuerda cerrar el periodo el
  día 1 de cada mes.
- `/api/cron/archivo-detectar` — no es periódico: mira si los PDF de antes
  del archivo son electrónicos o escaneos. Se lanza a mano tras desplegar la
  migración 12 hasta que no quede ninguno (ver [Archivo de
  facturas](#archivo-de-facturas) y DEPLOY.md §10.6).

Los tres requieren header `Authorization: Bearer $CRON_SECRET`.

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

Cuánto tarda depende de la máquina: de unos 25-30 s en Linux a unos 100 s en
Windows con un Postgres local. Lo que más pesa es el lote de 3.000 facturas.

**Qué hace el harness.**
- `globalSetup` aplica las migraciones con `prisma migrate deploy` contra
  `TEST_DATABASE_URL` (las mismas que en producción; nunca `reset`).
- Antes de cada test se vacían (TRUNCATE) solo las tablas de los modelos de
  Prisma (`Prisma.ModelName`), tras comprobar otra vez el marcador. Los
  ficheros corren uno detrás de otro: comparten la BD. Un test no puede borrar
  facturas, documentos ni filas de archivo (triggers de la migración 12) salvo
  en una asesoría `isDemo` con la llave del reset; para vaciar una tabla, TRUNCATE.
- Solo se simulan la sesión (`@/lib/auth`, con `signInAs`), `next/cache`,
  `next/navigation`, `after()` (se encola; el test lo ejecuta con
  `runAfterCallbacks`), el OCR (Gemini, con `stubOcr`; el
  parser Facturae es el real) y S3 (un servidor en memoria por fichero, que
  puede ir lento o caerse con `fakeS3().setMode(...)`). Prisma y Postgres son
  los reales. Sin `RESEND_API_KEY`, el correo no sale.
- Factorías (`helpers/factories.ts`): `makeFirm("A")` crea una asesoría con
  admin, gestor asignado, cliente con portal y facturas (`makeFirm("A", {
  demo: true })`, marcada `isDemo`, la única que el reset de la demo puede
  borrar); `makeTwoFirms()`, dos, para los tests de aislamiento entre
  asesorías.
- Carreras: `holdLock(sql)` (`helpers/locks.ts`) abre una transacción que
  bloquea (`LOCK TABLE`, `SELECT … FOR UPDATE`) y la mantiene hasta
  `release()`, para parar una acción a mitad y cruzarle otra. Para parar una
  acción entre su lectura y su escritura sirve
  `LOCK TABLE "PeriodClosure" IN ACCESS EXCLUSIVE MODE` (la comprobación de
  periodo cerrado va justo antes del UPDATE). Nada de esperas por tiempo: se
  espera con `vi.waitFor` a algo observable (`sessionsWaitingForLock()`, las
  claves del S3 falso, el estado), y el S3 falso retiene lecturas con
  `setMode("hold")` hasta `releaseGets()`.
- Lo que se lanza sin `await` va envuelto en `inFlight(...)`
  (`helpers/inflight.ts`). Al acabar cada test, pase o falle, se sueltan los
  bloqueos (la transacción caduca sola a los 20 s) y se espera a lo que quedó
  en vuelo, para que nada escriba en los datos del test siguiente.
- Cada carrera se ha comprobado con un mutante: quitando del código la
  condición que protege (el `updatedAt` del rechazo, `reviewTargetWhere`,
  el token `ocrAttempts`, `assertInvoiceAccess`...), su test falla.

## Limitaciones conocidas / deuda

1. **Rate limiter en memoria**: ver `src/lib/rateLimit.ts`. Si la
   app pasa a multi-instancia, hay que migrar a Redis/Upstash.
2. **`Invoice.vatRate`**: denormalizado de las `InvoiceVatLine`.
   Solo es significativo cuando hay 1 línea; con multi-IVA es
   `null`. Tenedlo en cuenta al hacer queries.
3. **`STATUS_LABELS` duplicado**: `src/lib/invoiceStatuses.ts` tiene
   los labels canónicos, pero
   `src/app/dashboard/admin/invoices/[id]/page.tsx` tiene su propia
   copia local. Consolidar.
4. **Reset demo + auditoría**: el bypass via `SET LOCAL` funciona,
   pero es un cuchillo: si alguien lo usa fuera de `demoSeed.ts`,
   se carga la inmutabilidad. Hay que mantenerlo restringido. Para
   facturas y documentos, además, solo vale en una asesoría `isDemo`.
5. **Borrados legítimos futuros** (baja con borrado, purga tras el plazo
   de conservación): los triggers del archivo los impiden. Tendrán su
   propio camino, con su rastro, cuando se diseñen.
6. **Ejercicio del cliente sin vigencias**: `Client.fiscalYearStartMonth`
   es un solo mes, sin fecha desde la que vale. Cambiarlo en Ajustes
   reagrupa hacia atrás todo el archivo del cliente (pestaña, cifras, ZIP)
   y su «conservar hasta», y no queda en la auditoría (`AuditLog` exige
   factura). El formulario avisa si el cliente ya tiene facturas. Hoy es
   informativo; la purga futura tendrá que guardar la vigencia (un
   ejercicio corto de transición, por ejemplo) antes de apoyarse en él.
7. **Adjuntos sustituidos o quitados**: el Word anterior sigue en el
   almacenamiento y en `Document`, pero ya no lo apunta ninguna factura, así
   que no sale en el ZIP del ejercicio ni en la descarga de datos del
   cliente (los dos van por las facturas). Se encuentra por la auditoría
   `originalDocument`.

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
