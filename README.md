# FacturOCR

SaaS de **OCR + contabilización** de facturas para asesorías españolas.
Los clientes suben los PDFs de sus facturas, el sistema extrae los campos
fiscales (NIF, fechas, IVA, IRPF...) y los gestores los validan antes de
exportar a programas contables tipo **A3 Asesor**.

> ⚠️ Este Next.js está **modificado respecto a la versión estándar**.
> Antes de tocar APIs internas, lee la guía relevante en
> `node_modules/next/dist/docs/` o consulta [AGENTS.md](AGENTS.md).

## Stack

| Capa | Tecnología |
|------|------------|
| Frontend / Backend | Next.js 16 (App Router, Server Actions) |
| Lenguaje | TypeScript (strict) |
| Estilos | Tailwind CSS 4 |
| ORM | Prisma 7.5 + `@prisma/adapter-pg` |
| Base de datos | PostgreSQL (Supabase) |
| Auth | NextAuth v5 (credentials + bcryptjs) |
| OCR | Gemini; Google Document AI (Invoice Parser) solo si no hay clave de Gemini |
| Storage de PDFs | Supabase Storage |
| Email | Resend |
| Deploy | Vercel |
| Tests | Vitest (unit) + Playwright (e2e) |

## Roles

- **ADMIN** — Pertenece a una asesoría (`AdvisoryFirm`). Acceso total
  (clientes, gestores, lotes, exportar, auditoría, ajustes).
- **WORKER** — Gestor de la asesoría. Solo ve los clientes que tiene
  asignados (`WorkerClientAssignment`).
- **CLIENT** — Cliente final. Solo sube facturas y ve las suyas.

## Setup

### Requisitos
- Node 20+
- Cuenta Supabase (DB + Storage)
- Clave de Gemini (`GEMINI_API_KEY`), o, sin ella, una cuenta Google Cloud
  con Document AI habilitado y un processor de tipo *Invoice Parser* en la
  región `eu`.
- Cuenta Resend (opcional en dev — si falta, los emails se loguean
  en consola).

### Instalación

```bash
git clone <repo>
cd invoice-saas
npm install
cp .env.example .env       # rellenar las variables
npx prisma migrate deploy  # aplicar migraciones a la BD
npx tsx scripts/bootstrap-admin.ts  # crear primer admin
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000) y entrar con
las credenciales del admin que creó el script.

### Variables de entorno

Las explica en detalle [.env.example](.env.example). Resumen:

| Variable | Para qué |
|----------|----------|
| `DATABASE_URL` | Conexión a Postgres |
| `AUTH_SECRET` | Firma de JWTs de NextAuth |
| `NEXTAUTH_URL` | URL pública (emails, callbacks) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` | Storage de PDFs (Garage / S3-compatible) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | OCR (Gemini) |
| `OCR_CONCURRENCY` | Análisis a la vez en el proceso (4 por defecto); lo demás espera en «Subida» |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`, `GOOGLE_DOCUMENT_AI_LOCATION` | OCR con Document AI, **solo si no hay `GEMINI_API_KEY`**. No es un fallback: si Gemini falla, no se prueba con Document AI |
| `RESEND_API_KEY`, `EMAIL_FROM` | Emails transaccionales |
| `CRON_SECRET` | Protege endpoints `/api/cron/*` |

## Comandos

```bash
npm run dev          # dev server (puerto 3000)
npm run build        # prisma generate + next build
npm start            # producción local

npm run lint         # ESLint
npm test             # Vitest (unit, tests/unit; sin BD, corren en el build de Docker)
npm run test:watch   # Vitest watch
npm run test:integration  # Vitest contra un Postgres de pruebas (ver abajo)
npm run test:e2e     # Playwright (tests/e2e)

# Prisma
npx prisma migrate dev      # crear y aplicar nueva migración
npx prisma migrate deploy   # aplicar migraciones existentes
npx prisma studio           # GUI de la BD
```

## Estructura del repo

```
src/
├── app/                       # App Router
│   ├── (login)/               # Login, forgot/reset password
│   ├── dashboard/
│   │   ├── admin/             # Vistas de ADMIN
│   │   ├── worker/            # Vistas de WORKER (gestores)
│   │   └── client/            # Vistas de CLIENT
│   ├── api/
│   │   ├── invoices/          # CRUD facturas + procesado OCR
│   │   ├── export/            # Generación de Excel A3
│   │   ├── admin/             # Verify audit, reset demo
│   │   └── cron/              # Cron jobs (Vercel)
│   └── legal/                 # Aviso legal
├── components/                # UI reutilizable
├── lib/
│   ├── auth.ts                # Config NextAuth
│   ├── prisma.ts              # Cliente Prisma singleton
│   ├── ocr.ts                 # Wrapper Document AI (NO TOCAR)
│   ├── processInvoice.ts      # Orquesta OCR → BD + pre-fill
│   ├── auditLog.ts            # Cadena de hash SHA-256
│   ├── exportFormats.ts       # Generador Excel A3
│   ├── reviewQueue.ts         # Cola "siguiente factura"
│   ├── validators.ts          # parseTaxId, retentions, etc.
│   ├── invoiceStatuses.ts     # Estados canonicos del flujo
│   ├── boundingBoxes.ts       # Resaltado OCR en visor PDF
│   ├── demoSeed.ts            # Reset demo
│   ├── email.ts               # Plantillas Resend
│   ├── rateLimit.ts           # Limit en memoria (login)
│   └── supabase.ts            # Cliente Storage admin
├── hooks/                     # React hooks
└── types/                     # Tipos compartidos

prisma/
├── schema.prisma              # Modelo de datos
└── migrations/                # Migraciones SQL

scripts/                       # Scripts operacionales (bootstrap admin,
                                # seed demo, capturar screenshots...)

tests/
├── unit/                      # Vitest, sin BD (barrera del build)
├── integration/               # Vitest contra Postgres de pruebas
└── e2e/                       # Playwright
```

## Tests de integración

Van contra un Postgres de pruebas, nunca contra el de `DATABASE_URL` (en
local, Supabase): la URL sale solo de `TEST_DATABASE_URL`. Cada test la
vacía, así que tiene que ser una base de datos **vacía la primera vez** y con
nombre de pruebas (`facturocr_test`); si no, el harness no arranca.

```bash
# Postgres local con Docker (o createdb facturocr_test en uno instalado)
docker run -d --name facturocr-test -p 55432:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=facturocr_test postgres:16

export TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/facturocr_test
npm run test:integration   # aplica las migraciones y ejecuta tests/integration
```

Detalles (qué se simula, factorías, carreras): ARCHITECTURE.md → Testing.

## Flujo de una factura

```
Cliente sube PDF (un fichero por petición)
    ↓
POST /api/uploads
    ↓ status: UPLOADED
    ↓
after(): processInvoice.ts
    espera turno en la cola del OCR (OCR_CONCURRENCY a la vez), sin salir de UPLOADED
    ↓ claim → status: ANALYZING
    ↓
ocrLlm.ts (Gemini), u ocr.ts (Document AI) si no hay GEMINI_API_KEY
    (reintentos con backoff exponencial y Retry-After; al agotarlos, OCR_ERROR)
    ↓
parseTaxId + pre-fill cliente + aprendizaje de cuentas
    ↓ status: PENDING_REVIEW (o NEEDS_ATTENTION / OCR_ERROR)
    ↓
Gestor valida en /dashboard/worker/review/[id]
    ↓ status: VALIDATED  (auditoría blindada)
    ↓
Admin exporta Excel A3 desde /dashboard/admin/exportar
    ↓ status: EXPORTED (legacy, ya no se escribe; se registra en ExportBatch)
```

Más detalle en [ARCHITECTURE.md](ARCHITECTURE.md).

## Auditoría

Cada cambio sobre una factura validada se registra en `AuditLog` con
**hash chain SHA-256**, y la tabla tiene **triggers PostgreSQL** que
prohíben UPDATE/DELETE. Si alguien retoca la BD por la cara, la cadena
se rompe y `/api/admin/verify-audit` lo destapa.

Detalle: ver [src/lib/auditLog.ts](src/lib/auditLog.ts) y
[ARCHITECTURE.md#auditor%C3%ADa](ARCHITECTURE.md).

## Demo / reset

Hay un dataset demo (`src/lib/demoSeedData.ts`) que se siembra al crear
una asesoría. El admin puede resetearlo desde **Ajustes → Reset demo**
(o `POST /api/admin/reset-demo` con `{ "confirm": "RESET" }`).

## Deploy

Vercel toma el repo directamente. Necesita:
- Todas las env vars de [`.env.example`](.env.example) en el proyecto Vercel.
- Las migraciones se aplican manualmente con `npx prisma migrate deploy`
  contra la BD de producción **antes** del primer build que las requiera.
- `maxDuration` ya está ajustado a 60s donde aplica (OCR, reset demo,
  verify audit).

## Limitaciones conocidas

- **OCR multi-IVA mixto**: Document AI a veces agrega líneas en vez de
  separarlas. El gestor lo corrige a mano en la pantalla de revisión.
- **Rate limiter en memoria** (`src/lib/rateLimit.ts`): funciona en una
  sola instancia. Si se escala horizontal hay que migrar a Redis/Upstash.
- **`@prisma/adapter-pg`**: en lugar del binario nativo de Prisma porque
  Vercel Functions necesita driver puro JS.
