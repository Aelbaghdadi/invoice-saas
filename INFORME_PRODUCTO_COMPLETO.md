# FacturOCR - Informe Completo del Producto

**Fecha**: 14 de abril de 2026
**Version**: MVP v3
**Estado**: Desarrollo activo - Pre-produccion

---

## 1. Resumen Ejecutivo

FacturOCR es una plataforma SaaS de gestion inteligente de facturas disenada para asesorias contables espanolas. Automatiza el ciclo completo de la factura: desde la subida del documento por el cliente hasta la exportacion de asientos contables compatibles con los principales programas de contabilidad (A3asesor, Sage 50, Contasol).

### Propuesta de valor

- **De la factura al asiento en menos de 2 minutos**: OCR con IA (Google Document AI) extrae automaticamente los datos de facturas PDF, imagenes y XML FacturaE.
- **Multi-tenant**: Cada asesoria opera con datos aislados; los clientes suben sus propias facturas y los gestores las revisan.
- **Trazabilidad completa**: Cada modificacion queda registrada en un audit log inmutable con historial de estados.
- **Exportacion directa**: Genera ficheros CSV/XLSX compatibles con A3asesor, Sage 50 y Contasol.

---

## 2. Stack Tecnologico

| Capa | Tecnologia | Version |
|------|-----------|---------|
| **Framework** | Next.js (App Router) | 16.2.1 |
| **Runtime** | React (Server Components + Client) | 19.2.4 |
| **Lenguaje** | TypeScript | 5.x |
| **Estilos** | Tailwind CSS v4 | 4.x |
| **ORM** | Prisma con PostgreSQL adapter | 7.5.0 |
| **Base de datos** | PostgreSQL (Supabase) | - |
| **Almacenamiento** | Supabase Storage (bucket `invoices`) | - |
| **OCR / IA** | Google Document AI Invoice Parser | v1 API |
| **Autenticacion** | NextAuth v5 (JWT, credentials) | 5.0.0-beta.30 |
| **Email** | Resend | 6.9.4 |
| **Validacion** | Zod | 4.3.6 |
| **XML Parser** | fast-xml-parser | 5.5.10 |
| **Excel** | SheetJS (xlsx) | 0.18.5 |
| **PDF Viewer** | react-pdf | 10.4.1 |
| **Iconos** | Lucide React | 0.577.0 |
| **Deploy** | Vercel | - |

### Dependencias clave

- `bcryptjs` (3.0.3) — Hash de contrasenas (12 rounds)
- `jose` (6.2.2) — Manejo de JWT
- `google-auth-library` (9.15.1) — Auth para Document AI
- `pg` (8.20.0) — Driver PostgreSQL nativo
- `playwright` (1.58.2, dev) — Testing E2E (disponible, no integrado)

---

## 3. Metricas del Codigo

| Metrica | Valor |
|---------|-------|
| **Archivos TypeScript** | 117 |
| **Lineas de codigo (TS/TSX)** | 12.159 |
| **Modelos Prisma** | 14 |
| **API Routes** | 7 |
| **Server Actions** | 12 archivos |
| **Componentes UI** | 9 compartidos |
| **Plantillas de email** | 6 |
| **Formatos de exportacion** | 4 (sage50, contasol, a3con, a3excel) |
| **Cron jobs** | 2 |
| **Migraciones** | 4 |

### Top 10 archivos mas grandes

| Archivo | Lineas | Descripcion |
|---------|--------|-------------|
| `worker/review/ReviewForm.tsx` | 719 | Formulario de revision de facturas |
| `lib/email.ts` | 421 | Plantillas HTML de email |
| `admin/invoices/InvoicesTable.tsx` | 383 | Tabla de facturas con filtros y acciones |
| `admin/page.tsx` | 382 | Dashboard principal admin |
| `worker/review/actions.ts` | 348 | Server actions de revision |
| `admin/settings/SettingsForm.tsx` | 324 | Formulario de ajustes |
| `client/upload/UploadForm.tsx` | 289 | Formulario upload cliente |
| `admin/export/ExportForm.tsx` | 275 | Formulario de exportacion |
| `lib/ocr.ts` | 273 | Integracion Google Document AI |
| `worker/upload/WorkerUploadForm.tsx` | 267 | Formulario upload trabajador |

---

## 4. Arquitectura del Sistema

### 4.1 Estructura de directorios

```
invoice-saas/
├── prisma/
│   ├── schema.prisma              # 14 modelos, 7 enums
│   └── migrations/                # 4 migraciones
├── scripts/
│   ├── backfill-hardening.ts      # Migracion de datos
│   ├── generate-report-v3.py      # Generador PDF informe
│   └── capture-screenshots*.ts    # Captura UI para documentacion
├── src/
│   ├── app/
│   │   ├── page.tsx               # Redirect a /login
│   │   ├── layout.tsx             # Root layout (Geist font, SEO)
│   │   ├── login/                 # Auth: login, forgot/reset password
│   │   ├── legal/                 # Pagina legal
│   │   ├── api/
│   │   │   ├── auth/              # NextAuth route handler
│   │   │   ├── cron/              # 2 cron jobs (retry, reminders)
│   │   │   ├── export/            # Exportacion CSV/XLSX
│   │   │   ├── invoices/[id]/     # Preview + reprocess
│   │   │   └── search/            # Busqueda global
│   │   └── dashboard/
│   │       ├── layout.tsx         # Auth guard + shell
│   │       ├── error.tsx          # Error boundary
│   │       ├── not-found.tsx      # 404
│   │       ├── admin/             # 10 secciones admin
│   │       ├── worker/            # 7 secciones worker
│   │       └── client/            # 4 secciones client
│   ├── components/
│   │   ├── layout/                # DashboardShell, Sidebar, Topbar
│   │   └── ui/                    # Badge, Skeleton, Toast, Select...
│   ├── lib/
│   │   ├── auth.ts                # NextAuth config + brute-force
│   │   ├── prisma.ts              # Singleton Prisma client
│   │   ├── supabase.ts            # Server-side Supabase client
│   │   ├── ocr.ts                 # Document AI + XML extraction
│   │   ├── processInvoice.ts      # Pipeline OCR orquestador
│   │   ├── issueDetector.ts       # Deteccion de problemas
│   │   ├── exportFormats.ts       # CSV/XLSX generators
│   │   ├── validators.ts          # NIF/CIF/NIE validation
│   │   └── email.ts               # Resend + plantillas HTML
│   └── types/
│       └── next-auth.d.ts         # Type augmentation
├── vercel.json                    # Cron schedules
├── next.config.ts                 # Security headers
└── package.json
```

### 4.2 Modelo de datos (14 modelos)

```
AdvisoryFirm (1) ──── (*) User
     │                      │
     │                      ├── AuditLog
     │                      └── WorkerClientAssignment
     │
     └──── (*) Client
                │
                ├── Document
                ├── AccountEntry (Plan de cuentas)
                ├── PeriodClosure
                └── Invoice
                      │
                      ├── InvoiceExtraction (OCR raw data)
                      ├── InvoiceStatusHistory
                      ├── InvoiceIssue
                      ├── AuditLog
                      └── ExportBatchItem → ExportBatch
```

#### Enums del sistema

| Enum | Valores |
|------|---------|
| **Role** | ADMIN, WORKER, CLIENT |
| **InvoiceType** | PURCHASE, SALE |
| **InvoiceStatus** | UPLOADED, ANALYZING, ANALYZED, PENDING_REVIEW, NEEDS_ATTENTION, OCR_ERROR, VALIDATED, REJECTED, EXPORTED |
| **RejectionCategory** | ILLEGIBLE, INCOMPLETE, WRONG_PERIOD, DUPLICATE, OTHER |
| **IssueType** | OCR_FAILED, LOW_CONFIDENCE, POSSIBLE_DUPLICATE, MATH_MISMATCH, MANUAL |
| **IssueStatus** | OPEN, RESOLVED, DISMISSED |

#### Politica de eliminacion en cascada

| Relacion | onDelete | Justificacion |
|----------|----------|---------------|
| Invoice -> Client | Cascade | Operacional: borrar cliente borra sus facturas |
| InvoiceExtraction -> Invoice | Cascade | Datos OCR vinculados a factura |
| Document -> Client | Cascade | Documentos del cliente |
| AccountEntry -> Client | Cascade | Plan de cuentas del cliente |
| PeriodClosure -> Client | Cascade | Cierres del cliente |
| WorkerClientAssignment -> Client | Cascade | Asignaciones del cliente |
| InvoiceStatusHistory -> Invoice | **Restrict** | Trazabilidad: no se puede borrar historial |
| InvoiceIssue -> Invoice | **Restrict** | Trazabilidad: incidencias preservadas |
| AuditLog -> Invoice | **Restrict** | Auditoria: registros inmutables |
| ExportBatchItem -> Invoice | **Restrict** | Trazabilidad: snapshots de exportacion |
| ExportBatchItem -> ExportBatch | **Restrict** | Integridad del lote de exportacion |

#### Indices de rendimiento

```prisma
Invoice     @@index([clientId, status])
Invoice     @@index([issuerCif])
Invoice     @@index([periodMonth, periodYear])
AccountEntry @@index([clientId])
```

---

## 5. Flujos Funcionales

### 5.1 Flujo de autenticacion

```
Usuario → Login (email + password)
  ├── Zod valida formato
  ├── Busca usuario en BD
  ├── Verifica cuenta no bloqueada (< 3 intentos fallidos)
  ├── Compara bcrypt hash
  ├── Exito: reset intentos, genera JWT
  └── Fallo: incrementa intentos
       └── 3 fallos → bloqueo 15 minutos
```

**Caracteristicas de seguridad**:
- JWT con claims: `id`, `role`, `advisoryFirmId`
- Bloqueo tras 3 intentos fallidos (15 min)
- Reset de password por token (1 hora expiracion)
- Invitacion de clientes por email (72 horas)
- Session strategy: JWT (no database sessions)

**Flujo de password reset**:
1. Usuario solicita reset → genera `crypto.randomUUID()` token
2. Token almacenado en `PasswordResetToken` (expira 1h)
3. Email enviado con link: `/login/reset-password?token=UUID`
4. Al resetear: transaccion atomica (validar token + actualizar password + borrar token)

### 5.2 Flujo de subida de facturas

```
Cliente/Worker → Selecciona cliente + periodo + tipo
  ├── Arrastra/selecciona archivos (PDF/XML/JPG/PNG/WEBP/HEIC)
  ├── Validacion client-side (tipo, tamano)
  └── Server Action:
       ├── Verifica autorizacion (rol + asignacion)
       ├── Comprueba periodo no cerrado
       ├── Por cada archivo:
       │    ├── Calcula SHA-256 hash
       │    ├── Comprueba duplicado por hash
       │    ├── Sube a Supabase: {clientId}/{year}-{month}/{ts}-{file}
       │    ├── Crea Document (fuente de verdad del archivo)
       │    └── Crea Invoice (status: UPLOADED)
       └── after(): lanza processInvoice() asincronamente
```

**Almacenamiento**: Supabase Storage, bucket `invoices`, paths namespacedados por cliente y periodo.

**Deduplicacion por hash**: SHA-256 del contenido del archivo. Si ya existe una factura con el mismo hash para el mismo cliente, se omite con warning.

### 5.3 Pipeline de OCR

```
processInvoice(invoiceId)
  │
  ├── 1. Atomic status check: UPLOADED → ANALYZING
  │    └── Incrementa ocrAttempts
  │
  ├── 2. Descarga archivo de Supabase
  │
  ├── 3. Extraccion segun tipo:
  │    ├── XML → extractInvoiceFromXml() [fast-xml-parser, determinista]
  │    ├── PDF → extractInvoiceFromPdf() [Document AI, 60s timeout]
  │    └── Image → extractInvoiceFromImage() [Document AI]
  │
  ├── 4. Validacion matematica: |Base + IVA - Total| <= 2 centimos
  │
  ├── 5. Guardar InvoiceExtraction:
  │    ├── Datos brutos OCR + raw response
  │    ├── Confidence scores por campo
  │    ├── Metricas: ocrStartedAt, ocrFinishedAt, ocrDurationMs
  │    └── Flag isReprocess
  │
  ├── 6. Deteccion de incidencias (issueDetector):
  │    ├── OCR_FAILED: todos los campos clave nulos
  │    ├── LOW_CONFIDENCE: campo < 70% confianza
  │    ├── MATH_MISMATCH: descuadre Base + IVA != Total
  │    └── POSSIBLE_DUPLICATE:
  │         ├── Estrategia A: CIF + numero factura (fuerte)
  │         └── Estrategia B: CIF + total + fecha (fuzzy)
  │
  ├── 7. Copiar datos OCR a Invoice (editables por gestor)
  │
  ├── 8. Routing de estado:
  │    ├── Con incidencias → NEEDS_ATTENTION
  │    └── Sin incidencias → PENDING_REVIEW
  │
  └── Error → OCR_ERROR (con mensaje guardado)
```

**Document AI**:
- API REST con autenticacion OAuth2 (Google Auth Library)
- Token cacheado en memoria (singleton)
- Procesador: Invoice Parser (facturas espanolas)
- Campos extraidos: issuerName/CIF, receiverName/CIF, invoiceNumber, invoiceDate, taxBase, vatRate, vatAmount, totalAmount
- IRPF: no soportado por Document AI (siempre null para PDF/imagenes)
- Timeout: 60 segundos por llamada

**XML FacturaE**:
- Parse nativo con fast-xml-parser (sin OCR)
- Soporta v3.2 y v3.2.2 (case-insensitive navigation)
- Extrae todos los campos incluyendo IRPF
- Confidence: 1.0 para todos los campos (determinista)

### 5.4 Flujo de revision

```
Gestor → Abre factura para revision
  │
  ├── Carga split-screen:
  │    ├── Izquierda: PDF viewer (signed URL, 10 min TTL)
  │    └── Derecha: formulario editable con datos OCR
  │
  ├── Badges de confianza OCR por campo
  ├── Warning si CIF invalido (isValidNIF)
  ├── Comparacion OCR vs. valores actuales (tabla colapsable)
  ├── Validacion matematica en tiempo real (semaforo Base + IVA = Total)
  │
  ├── Navegacion secuencial dentro del lote:
  │    └── ← Anterior | Factura 3 de 15 | Siguiente →
  │
  └── Acciones:
       ├── Guardar: persiste cambios, audit log
       ├── Validar: status → VALIDATED, email al cliente
       └── Rechazar: status → REJECTED, motivo + categoria, email al cliente
```

**Validaciones del formulario**:
- vatRate: 0-100%
- taxBase, vatAmount, totalAmount: >= 0
- Concurrencia: optimistic locking por updatedAt
- CIF: warning visual si no pasa isValidNIF() (no bloquea)

**Sugerencia de cuentas contables**:
- Si el CIF del emisor coincide con una entrada del plan de cuentas del cliente, se sugieren automaticamente las cuentas de proveedor y gasto.

### 5.5 Flujo de exportacion

```
Admin → Selecciona cliente + periodo + formato + tipo
  │
  ├── Preview: cuenta facturas VALIDATED que matchean filtros
  │
  └── Exportar:
       ├── Consulta facturas VALIDATED (scoped by firmId)
       ├── Crea ExportBatch (trazabilidad):
       │    ├── formato, clientId, periodo, tipo
       │    └── invoiceCount, userId
       ├── Crea ExportBatchItem por factura:
       │    └── Snapshot JSON de datos al momento de exportar
       ├── Vincula facturas al batch (exportBatchId)
       ├── Registra audit log
       └── Genera archivo:
            ├── sage50: CSV (11 cols, con IRPF)
            ├── contasol: CSV (11 cols, con IRPF)
            ├── a3con: CSV (9 cols, sin IRPF)
            └── a3excel: XLSX (13 cols, sin IRPF)
```

**Formato A3 Excel (plantilla oficial)**:
13 columnas: Fecha Expedicion, Fecha Contabilizacion, Concepto, Numero Factura, NIF, Nombre, Tipo Operacion, Cuenta Proveedor, Cuenta Gasto, Base, % IVA, Cuota IVA, Enlace Factura.

**Validaciones pre-exportacion (A3)**:
- NIF vacio
- Fecha vacia
- Sin cuenta proveedor/gasto asignada
- Descuadre Base + IVA vs Total (warning, no bloquea)

### 5.6 Sistema de lotes (Batches)

El concepto de "lote" es **implicito**: no existe un modelo `Batch` en la BD. Un lote es el conjunto de facturas que comparten `clientId + periodMonth + periodYear`.

```
Lote = { clientId, periodYear, periodMonth }

Vista de lotes:
  ├── Agrupacion por Map: key = "clientId-year-month"
  ├── Por grupo:
  │    ├── Conteo por estado (9 estados)
  │    ├── Barra de progreso segmentada
  │    │    ├── Verde: validadas
  │    │    ├── Rojo: rechazadas
  │    │    ├── Azul: en revision
  │    │    ├── Naranja: OCR en curso/error
  │    │    └── Gris: exportadas
  │    ├── % completado = (validated + exported) / total
  │    └── Botones: "Revisar (N)" → primera pendiente, "Ver todas"
  └── Worker: filtrado por clientes asignados
```

### 5.7 Cierres de periodo

```
Admin → Cierra periodo para un cliente
  ├── PeriodClosure: { clientId, month, year, closedBy }
  ├── Efecto: bloquea subida de facturas al periodo cerrado
  └── Puede reabrirse (reopenedAt, reopenedBy)

Cron mensual (dia 5, 9:00 UTC):
  └── Envia recordatorio por email a clientes con periodo previo abierto
```

### 5.8 Re-subida de facturas rechazadas

```
Cliente ve factura rechazada → boton "Re-subir"
  ├── Sube nuevo archivo
  ├── Crea nueva Invoice con replacesId → invoice original
  └── La factura original queda como REJECTED con link al reemplazo
```

---

## 6. Sistema de Roles y Permisos

### 6.1 Matriz de permisos

| Funcionalidad | ADMIN | WORKER | CLIENT |
|---------------|:-----:|:------:|:------:|
| Ver dashboard con metricas | Si | Si (limitado) | Si (propio) |
| Gestionar clientes (CRUD) | Si | No | No |
| Gestionar trabajadores | Si | No | No |
| Ver todos los clientes | Si | Solo asignados | Solo propio |
| Subir facturas | Si (cualquier cliente) | Si (asignados) | Si (propio) |
| Revisar/validar facturas | Si | Si (asignados) | No |
| Rechazar facturas | Si | Si (asignados) | No |
| Exportar a contabilidad | Si | No | No |
| Ver audit log | Si | No | No |
| Cerrar periodos | Si | No | No |
| Gestionar plan de cuentas | Si | No | No |
| Configurar firma/perfil | Si | No | No |
| Busqueda global | Si | Si (scope) | Si (propio) |
| Re-subir facturas rechazadas | No | No | Si |
| Ver incidencias | Si | Si | No |

### 6.2 Aislamiento multi-tenant

Todas las queries estan filtradas por `advisoryFirmId`:
- Admin: ve todos los clientes de su firma
- Worker: ve solo clientes asignados via `WorkerClientAssignment`
- Client: ve solo sus propias facturas via `userId` -> `Client.userId`

---

## 7. APIs del Sistema

### 7.1 API Routes

| Ruta | Metodo | Auth | Descripcion |
|------|--------|------|-------------|
| `/api/auth/[...nextauth]` | GET/POST | Publica | NextAuth handler |
| `/api/export` | GET | ADMIN | Exportar facturas CSV/XLSX |
| `/api/invoices/[id]/preview` | GET | ADMIN/WORKER/CLIENT | URL firmada para previsualizar archivo |
| `/api/invoices/[id]/process` | POST | ADMIN/WORKER | Reprocesar OCR |
| `/api/search` | GET | Todos | Busqueda global (clientes + facturas) |
| `/api/cron/retry-stuck` | GET | CRON_SECRET | Reintentar facturas atascadas en UPLOADED |
| `/api/cron/closure-reminders` | GET | CRON_SECRET | Recordatorios mensuales de cierre |

### 7.2 Cron Jobs (Vercel)

| Job | Schedule | Funcion |
|-----|----------|---------|
| `retry-stuck` | `0 8 * * *` (diario, 8:00 UTC) | Reprocesa facturas UPLOADED > 5 min con < 3 intentos |
| `closure-reminders` | `0 9 5 * *` (dia 5 mensual, 9:00 UTC) | Email recordatorio a clientes con mes previo sin cerrar |

**Seguridad Cron**: Verificacion timing-safe del header `Authorization: Bearer {CRON_SECRET}`.

### 7.3 Server Actions (12 archivos)

| Archivo | Acciones |
|---------|----------|
| `login/actions.ts` | loginAction |
| `login/forgot-password/actions.ts` | requestPasswordReset |
| `login/reset-password/actions.ts` | resetPassword |
| `admin/clients/actions.ts` | createClient |
| `admin/clients/[id]/accounts/actions.ts` | importAccountsFromExcel, create/update/deleteAccountEntry |
| `admin/invoices/actions.ts` | bulkValidateInvoices |
| `admin/workers/actions.ts` | createWorker |
| `admin/closures/actions.ts` | closePeriod, reopenPeriod, isPeriodClosed |
| `admin/settings/actions.ts` | updateFirm, changePassword, updateProfile |
| `worker/upload/actions.ts` | workerUploadInvoicesAction |
| `worker/review/[id]/actions.ts` | saveInvoiceFields, validateInvoice, rejectInvoice, dismissIssue |
| `worker/issues/actions.ts` | resolveIssue, dismissIssue |
| `client/upload/actions.ts` | clientUploadInvoicesAction |
| `client/invoices/reupload-actions.ts` | reuploadInvoice |

---

## 8. Sistema de Email

### 8.1 Proveedor y configuracion

- **Proveedor**: Resend (`RESEND_API_KEY`)
- **Remitente**: configurable via `EMAIL_FROM`, default `FacturOCR <noreply@facturocr.com>`
- **Fallback dev**: Si no hay API key, logs a consola
- **Proteccion XSS**: Helper `escapeHtml()` para todos los inputs

### 8.2 Plantillas de email (6)

| Plantilla | Trigger | Destinatario |
|-----------|---------|-------------|
| **Factura validada** | Worker valida factura | Cliente |
| **Factura rechazada** | Worker rechaza factura | Cliente |
| **Reset de password** | Usuario solicita reset | Usuario |
| **Invitacion cliente** | Admin crea cliente | Nuevo cliente |
| **Recordatorio cierre** | Cron mensual (dia 5) | Clientes sin cerrar |
| **Nuevas facturas** | Cliente sube facturas | Workers asignados |

Todas las plantillas usan un template HTML responsive con:
- Logo FacturOCR con icono azul
- Icono hero con color contextual (verde/rojo/azul/naranja)
- Tarjeta de detalles estilizada
- Boton CTA con link al portal
- Footer con disclaimer
- Soporte MSO (Outlook)
- Preheader text (preview text)

---

## 9. Seguridad

### 9.1 Medidas implementadas

| Medida | Estado | Detalle |
|--------|--------|---------|
| Autenticacion JWT | Implementado | NextAuth v5, credentials provider |
| Hash de password | Implementado | bcryptjs, 12 salt rounds |
| Bloqueo por intentos | Implementado | 3 intentos, 15 min lockout |
| RBAC | Implementado | 3 roles, verificacion en cada endpoint |
| Multi-tenant isolation | Implementado | advisoryFirmId scope en todas las queries |
| Security headers | Implementado | X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |
| Proteccion XSS emails | Implementado | escapeHtml() en todos los templates |
| Cron auth | Implementado | Timing-safe comparison de CRON_SECRET |
| File hash dedup | Implementado | SHA-256 contra re-subida |
| Optimistic locking | Implementado | updatedAt en revision concurrente |
| SQL injection | Mitigado | Prisma ORM (queries parametrizadas) |
| Atomic status transitions | Implementado | updateMany con WHERE status check |

### 9.2 Gaps identificados

| Severidad | Gap | Impacto |
|-----------|-----|---------|
| **Alta** | Sin rate limiting en login | Brute-force 3 passwords/15min/IP |
| **Alta** | Sin Content-Security-Policy (CSP) | Riesgo XSS |
| **Alta** | Sin HSTS header | SSL stripping posible |
| **Media** | Sin MFA/2FA | Cuentas admin vulnerables a credential compromise |
| **Media** | Session maxAge no configurado | Default 30 dias (muy largo) |
| **Media** | Sin validacion de magic bytes en uploads | Extension check solamente |
| **Media** | Password reset token en URL | Visible en browser history/referrer |
| **Baja** | Sin admin unlock de cuentas | Solo timeout de 15 min |
| **Baja** | Sin politica de retencion de audit logs | Crecimiento ilimitado |

### 9.3 Recomendaciones de seguridad (por prioridad)

1. **Implementar rate limiting** en endpoint de login (middleware o wrapper)
2. **Agregar CSP header** en `next.config.ts`
3. **Agregar HSTS header** (`Strict-Transport-Security: max-age=31536000`)
4. **Configurar session.maxAge** (8-12 horas recomendado)
5. **Implementar MFA opcional** para rol ADMIN (TOTP)
6. **Validar magic bytes** de archivos subidos (no solo extension)
7. **Acortar expiracion de password reset** a 15-30 minutos

---

## 10. Validacion de Datos

### 10.1 Validacion CIF/NIF/NIE

Implementada en `src/lib/validators.ts`:

| Tipo | Formato | Algoritmo |
|------|---------|-----------|
| **NIF** (persona) | 8 digitos + 1 letra | Letra = NIF_LETTERS[numero % 23] |
| **NIE** (extranjero) | X/Y/Z + 7 digitos + 1 letra | Prefijo mapeado a digito, mismo checksum |
| **CIF** (empresa) | Letra + 7 digitos + digito/letra | Variante Luhn: pares + dobles impares |

**Uso**:
- Creacion de cliente: bloquea si CIF invalido
- Import plan de cuentas: warning (no bloquea)
- ReviewForm: warning visual (badge naranja)

### 10.2 Validacion matematica

Formula: `Base Imponible + Cuota IVA = Total Factura`

Tolerancia: 2 centimos (para errores de redondeo).

Se aplica en:
1. `processInvoice.ts` — tras OCR (determina isValid)
2. `issueDetector.ts` — genera MATH_MISMATCH issue
3. `ReviewForm.tsx` — semaforo en tiempo real
4. `actions.ts` — validacion server-side antes de guardar
5. `exportFormats.ts` — warning pre-exportacion A3

### 10.3 Validacion de formularios

| Campo | Regla | Donde |
|-------|-------|-------|
| vatRate | 0-100 | Client + Server |
| taxBase | >= 0 | Client + Server |
| vatAmount | >= 0 | Client + Server |
| totalAmount | >= 0 | Client + Server |
| Email | Formato valido | Zod schema |
| Password | Min 8 chars | Zod schema |
| CIF | 9 chars + checksum | isValidNIF() |
| Nombre | Min 2 chars | Zod schema |

---

## 11. Componentes UI

### 11.1 Layout

| Componente | Archivo | Descripcion |
|-----------|---------|-------------|
| **DashboardShell** | `components/layout/DashboardShell.tsx` | Layout responsive: sidebar + topbar + content. Sidebar oculto en movil con overlay |
| **Sidebar** | `components/layout/Sidebar.tsx` | Navegacion por rol. Logo, nav items con iconos, avatar usuario, boton CTA ("Nuevo lote"), logout |
| **Topbar** | `components/layout/Topbar.tsx` | Busqueda global (debounce 250ms, Ctrl+K shortcut), notificaciones (placeholder), settings |

### 11.2 UI Components compartidos

| Componente | Descripcion |
|-----------|-------------|
| **Badge** | Status badges con colores por estado |
| **ConfidenceBadge** | Indicador de confianza OCR (verde/amarillo/rojo) |
| **EmptyState** | Estado vacio con icono, mensaje y CTA |
| **PageHeader** | Header de pagina con titulo, descripcion y acciones |
| **PdfViewer** | Visor PDF con react-pdf (lazy loaded) |
| **PdfViewerDynamic** | Wrapper dynamic import para PdfViewer |
| **Select** | Dropdown select estilizado |
| **Skeleton** | Loading placeholder (shimmer) |
| **Toast** | Notificaciones temporales |

### 11.3 Loading states

Cada seccion del dashboard tiene su `loading.tsx` con Skeleton:
- Admin: 10 loading pages
- Worker: 6 loading pages
- Client: 3 loading pages

---

## 12. Paginas del Dashboard

### 12.1 Admin (10 secciones)

| Seccion | Ruta | Descripcion |
|---------|------|-------------|
| **Panel** | `/admin` | Metricas KPI, facturas recientes, progreso por cliente |
| **Clientes** | `/admin/clients` | CRUD clientes, busqueda, invitacion por email |
| **Detalle cliente** | `/admin/clients/[id]` | Info, workers asignados, facturas recientes |
| **Plan de cuentas** | `/admin/clients/[id]/accounts` | CRUD cuentas, import Excel |
| **Gestores** | `/admin/workers` | CRUD workers, asignacion a clientes |
| **Facturas** | `/admin/invoices` | Tabla con filtros (estado, tipo), paginacion, bulk validate |
| **Detalle factura** | `/admin/invoices/[id]` | Viewer + datos + historial estados + audit |
| **Lotes** | `/admin/batch` | Vista agrupada por cliente+periodo con progreso |
| **Exportar** | `/admin/export` | Form exportacion con preview + historial exports |
| **Cierres** | `/admin/closures` | Cerrar/reabrir periodos, historial |
| **Auditoria** | `/admin/audit` | Filtros: usuario, campo, fecha. Ultimos 200 cambios |
| **Ajustes** | `/admin/settings` | Datos firma, cambio password, perfil |

### 12.2 Worker (7 secciones)

| Seccion | Ruta | Descripcion |
|---------|------|-------------|
| **Panel** | `/worker` | Stats, clientes asignados, facturas recientes |
| **Clientes** | `/worker/clients` | Lista clientes asignados |
| **Facturas** | `/worker/invoices` | Tabla facturas (filtrable por cliente) |
| **Subir** | `/worker/upload` | Form upload con drag-drop |
| **Lotes** | `/worker/batch` | Vista lotes (solo clientes asignados) |
| **Revision** | `/worker/review/[id]` | Split-screen: PDF + formulario revision |
| **Incidencias** | `/worker/issues` | Lista issues abiertas con acciones |

### 12.3 Client (4 secciones)

| Seccion | Ruta | Descripcion |
|---------|------|-------------|
| **Panel** | `/client` | Stats propias, upload CTA, facturas recientes |
| **Facturas** | `/client/invoices` | Lista facturas con estado + re-subida |
| **Subir** | `/client/upload` | Form upload simplificado (sin selector cliente) |

---

## 13. Deteccion de Incidencias

### 13.1 Tipos de incidencias

| Tipo | Trigger | Severidad | Bloquea? |
|------|---------|-----------|----------|
| **OCR_FAILED** | Todos los campos clave son null | Critica | Ruta a NEEDS_ATTENTION |
| **LOW_CONFIDENCE** | Campo con confianza < 70% (y > 0%) | Media | Ruta a NEEDS_ATTENTION |
| **MATH_MISMATCH** | Base + IVA != Total (> 2 centimos) | Alta | Ruta a NEEDS_ATTENTION |
| **POSSIBLE_DUPLICATE** | CIF+numero duplicado O CIF+total+fecha | Media | Ruta a NEEDS_ATTENTION |
| **MANUAL** | Creada manualmente por gestor | Variable | No |

### 13.2 Ciclo de vida de incidencias

```
OPEN → RESOLVED (por gestor, con resolvedBy + resolvedAt)
OPEN → DISMISSED (descartada, sin accion)
```

---

## 14. Sistema de Exportacion

### 14.1 Formatos soportados

| Formato | Tipo archivo | Columnas | IRPF | Destinatario |
|---------|-------------|----------|------|-------------|
| **sage50** | CSV (`;`) | 11 | Si | Sage 50 Contabilidad |
| **contasol** | CSV (`;`) | 11 | Si | Contasol |
| **a3con** | CSV (`;`) | 9 | No | A3asesor (importacion CSV) |
| **a3excel** | XLSX | 13 | No | A3asesor (plantilla Excel) |

### 14.2 Trazabilidad de exportaciones

Cada exportacion crea:
- `ExportBatch`: metadatos (formato, periodo, tipo, count, userId)
- `ExportBatchItem` por factura: snapshot JSON de datos al momento de exportar
- `AuditLog` por factura exportada
- Las facturas se vinculan al batch via `exportBatchId`

**Nota**: El status de la factura NO cambia a EXPORTED tras la exportacion. Esta decision fue tomada para evitar que un cambio de estado irreversible bloquee re-exportaciones.

---

## 15. Diagrama de Estados de Factura

```
                                    ┌──────────┐
                                    │ UPLOADED  │ ← Estado inicial
                                    └────┬─────┘
                                         │ processInvoice()
                                    ┌────▼─────┐
                                    │ ANALYZING │
                                    └────┬─────┘
                                         │
                           ┌─────────────┼──────────────┐
                           │             │              │
                      ┌────▼─────┐ ┌────▼──────┐ ┌────▼────────┐
                      │OCR_ERROR │ │PENDING    │ │NEEDS        │
                      │          │ │_REVIEW    │ │_ATTENTION   │
                      └────┬─────┘ └────┬──────┘ └────┬────────┘
                           │             │              │
                    reprocess│     ┌──────┴──────┐      │
                           │     │             │      │ (gestor resuelve)
                           ▼     ▼             ▼      ▼
                      UPLOADED  VALIDATED   REJECTED  PENDING_REVIEW
                                   │
                                   │ (exportar)
                                   ▼
                              [vinculado a ExportBatch]
```

**Transiciones validas**:
- UPLOADED → ANALYZING (automatico, processInvoice)
- ANALYZING → PENDING_REVIEW | NEEDS_ATTENTION | OCR_ERROR
- OCR_ERROR → UPLOADED (reprocess manual)
- PENDING_REVIEW → VALIDATED | REJECTED (gestor)
- NEEDS_ATTENTION → VALIDATED | REJECTED (gestor)
- REJECTED → reemplazo por re-subida (nuevo Invoice con replacesId)

---

## 16. Responsive y Accesibilidad

### 16.1 Responsive

| Componente | Movil (<768px) | Tablet (768-1024px) | Desktop (>1024px) |
|-----------|----------------|---------------------|-------------------|
| Sidebar | Oculto, slide-in overlay | Oculto, slide-in | Visible fijo |
| Tablas facturas | Columnas ocultas (periodo, tipo, fecha) | Parcial | Completo |
| Tabla cuentas | Columnas ocultas (cuenta gasto, IVA%) | Parcial | Completo |
| ReviewForm | Split vertical? | Split reducido | Split 40/60 |
| Cards dashboard | Stack vertical | Grid 2 cols | Grid 3-4 cols |

### 16.2 Gaps de accesibilidad

- Sin ARIA labels en elementos interactivos del Topbar
- Sin skip-to-content link
- Notificaciones Toast pueden no ser accesibles para screen readers
- Colores de badges pueden no tener suficiente contraste

---

## 17. Testing

### 17.1 Estado actual

| Tipo | Estado | Herramienta |
|------|--------|-------------|
| Unit tests | No implementado | - |
| Integration tests | No implementado | - |
| E2E tests | Disponible (Playwright instalado) | Playwright 1.58.2 |
| Type checking | Integrado en build | `tsc` via `next build` |
| Linting | Configurado | ESLint 9 + eslint-config-next |

### 17.2 Recomendaciones

1. **Tests unitarios prioritarios**:
   - `validators.ts` (isValidNIF) — funcion pura, facil de testear
   - `issueDetector.ts` — logica de negocio critica
   - `exportFormats.ts` — generacion de CSV/XLSX
   - `ocr.ts` (mapEntities, extractInvoiceFromXml) — parsing

2. **Tests E2E prioritarios**:
   - Flujo completo: upload → OCR → review → validate → export
   - Login con bloqueo de cuenta
   - Busqueda global

---

## 18. Deployment y Operaciones

### 18.1 Configuracion Vercel

- **Build command**: `prisma generate && next build`
- **Crons**: 2 jobs configurados en `vercel.json`
- **Environment variables requeridas**:

| Variable | Uso |
|----------|-----|
| `DATABASE_URL` | PostgreSQL connection string (Supabase pooler) |
| `NEXTAUTH_SECRET` | Secreto JWT |
| `NEXTAUTH_URL` | URL base de la app |
| `NEXT_PUBLIC_SUPABASE_URL` | URL Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Key admin Supabase |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Service account JSON |
| `GOOGLE_CLOUD_PROJECT_ID` | Proyecto GCP |
| `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | Processor ID |
| `GOOGLE_DOCUMENT_AI_LOCATION` | Region (default: `eu`) |
| `RESEND_API_KEY` | API key email |
| `EMAIL_FROM` | Remitente email |
| `CRON_SECRET` | Secreto para cron jobs |

### 18.2 Limites y consideraciones

| Aspecto | Limite | Nota |
|---------|--------|------|
| Tamano archivo | 20 MB | Validado server-side |
| Tipos archivo | PDF, XML, JPG, JPEG, PNG, WEBP, HEIC | Extension + MIME check |
| OCR timeout | 60 segundos | Document AI |
| OCR reintentos | 3 maximo | `ocrAttempts < 3` |
| Signed URL TTL | 10 minutos | Preview de archivos |
| Password reset token | 1 hora | Expiracion |
| Client invitation token | 72 horas | Expiracion |
| Account lockout | 15 minutos | Tras 3 intentos |
| Paginacion tablas | 20 items/pagina | Client-side |
| Audit log vista | 200 registros | Sin paginacion |
| Busqueda resultados | 5 por tipo | Max 10 total |

---

## 19. Problemas Conocidos y Deuda Tecnica

### 19.1 Criticos (P0)

| # | Problema | Impacto |
|---|----------|---------|
| 1 | Sin rate limiting en login | Vulnerable a brute-force |
| 2 | Sin CSP ni HSTS headers | Vulnerabilidades web basicas |
| 3 | 404 page redirige siempre a /admin | Usuarios worker/client van a ruta incorrecta |

### 19.2 Importantes (P1)

| # | Problema | Impacto |
|---|----------|---------|
| 4 | Sin paginacion server-side en tablas grandes | Escalabilidad con muchos datos |
| 5 | Codigo duplicado batch admin/worker | Mantenibilidad |
| 6 | `(inv as any).supplierAccount` en A3 export | Cuentas contables no llegan al export |
| 7 | Texto "Max 10 MB" en client upload vs 20 MB real | UX confusa |
| 8 | Sin tests automatizados | Regresiones no detectadas |
| 9 | Session timeout no configurado (30 dias default) | Seguridad |
| 10 | Email errors silenciosos (.catch sin retry) | Notificaciones perdidas |

### 19.3 Moderados (P2)

| # | Problema | Impacto |
|---|----------|---------|
| 11 | No hay modelo Batch explicito en BD | Sin trazabilidad de "que se subio junto" |
| 12 | Confidence 1.0 para XML con campos null | Falsa confianza en datos incompletos |
| 13 | Audit log limitado a 200 sin paginacion | Datos historicos no visibles |
| 14 | Boton notificaciones en Topbar sin funcionalidad | UX incompleta |
| 15 | Sin validacion magic bytes en uploads | Archivos maliciosos potenciales |
| 16 | Subida parcial no es atomica | Facturas huerfanas si falla a mitad |
| 17 | IRPF no extraido por Document AI | Campo siempre vacio para PDF/imagenes |

### 19.4 Menores (P3)

| # | Problema | Impacto |
|---|----------|---------|
| 18 | Busqueda solo client-side en Clientes y Workers | Lento con muchos registros |
| 19 | Worker "Gestionar" boton placeholder | Feature no implementada |
| 20 | Progress bar "Exportadas" color gris poco visible | Visual |
| 21 | Admin batch "Revisar" enlaza a ruta worker | Inconsistencia de rutas |
| 22 | Sin encodings alternativos (Windows-1252) en CSV | ExportConfig.encoding ignorado |
| 23 | Detalle cliente solo muestra 10 facturas | Sin paginacion |

---

## 20. Roadmap Sugerido

### Fase 1: Hardening (1-2 semanas)

- [ ] Rate limiting en login (middleware)
- [ ] CSP + HSTS headers
- [ ] Session timeout (8h)
- [ ] Fix 404 page role-aware
- [ ] Fix texto "10 MB" en client upload
- [ ] Fix `(inv as any).supplierAccount` en export
- [ ] Extraer logica batch a utilidad compartida

### Fase 2: Testing y Calidad (2-3 semanas)

- [ ] Tests unitarios: validators, issueDetector, exportFormats, ocr
- [ ] Tests E2E: flujo completo upload → export
- [ ] Paginacion server-side en tablas (facturas, clientes, audit)
- [ ] Retry con backoff en emails
- [ ] Error boundary mejorado con logging

### Fase 3: Features v4 (4+ semanas)

- [ ] MFA/2FA para administradores
- [ ] Notificaciones in-app (reemplazar placeholder)
- [ ] Dashboard analytics (graficos, tendencias)
- [ ] Modelo Batch explicito en BD
- [ ] Multi-formato FacturaE (paths tipados PDF/XML/signed-XML)
- [ ] Estado EXPORTED como evento (no como estado final)
- [ ] Import masivo de facturas historicas

---

## 21. Conclusion

FacturOCR es un MVP funcional y bien estructurado que cubre el flujo completo de gestion de facturas para asesorias espanolas. La arquitectura basada en Next.js App Router con Server Components y Server Actions proporciona una base solida con buena separacion de responsabilidades.

**Fortalezas principales**:
- Pipeline OCR robusto con Document AI + XML nativo
- Sistema de roles bien implementado con aislamiento multi-tenant
- Trazabilidad completa (audit log, status history, export snapshots)
- Emails profesionales con plantillas responsive
- Deteccion inteligente de incidencias (duplicados, math, confianza)
- Exportacion a los 3 principales programas contables espanoles
- Validacion NIF/CIF/NIE con checksum

**Areas de mejora prioritarias**:
- Seguridad: rate limiting, CSP, HSTS, session timeout
- Testing: ausencia total de tests automatizados
- Escalabilidad: paginacion server-side, optimizacion de queries
- UX: inconsistencias menores en textos y rutas

El producto esta en un estado adecuado para despliegue en entorno de pruebas con clientes beta, pero requiere hardening de seguridad antes de un lanzamiento a produccion abierto.

---

*Informe generado el 14 de abril de 2026.*
*Basado en revision exhaustiva de 117 archivos TypeScript (12.159 lineas de codigo) + configuracion.*
