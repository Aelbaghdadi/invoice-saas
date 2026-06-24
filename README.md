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
| OCR | Google Document AI (Invoice Parser) |
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
- Cuenta Google Cloud con Document AI habilitado y un processor de
  tipo *Invoice Parser* en la región `eu`.
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
| `GEMINI_API_KEY`, `GEMINI_MODEL` | OCR principal (Gemini) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`, `GOOGLE_DOCUMENT_AI_LOCATION` | OCR fallback (Document AI) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Emails transaccionales |
| `CRON_SECRET` | Protege endpoints `/api/cron/*` |

## Comandos

```bash
npm run dev          # dev server (puerto 3000)
npm run build        # prisma generate + next build
npm start            # producción local

npm run lint         # ESLint
npm test             # Vitest (unit, en src/lib y similares)
npm run test:watch   # Vitest watch
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
├── unit/                      # Vitest
└── e2e/                       # Playwright
```

## Flujo de una factura

```
Cliente sube PDF
    ↓
POST /api/invoices/upload
    ↓ status: UPLOADED
    ↓
POST /api/invoices/[id]/process  (background)
    ↓ status: ANALYZING
    ↓
processInvoice.ts → ocr.ts (Document AI)
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
