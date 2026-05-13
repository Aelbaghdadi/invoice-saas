<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# FacturOCR — guía para agentes

Idioma del proyecto: **español** (UI, comentarios, mensajes de error,
commits). Mantenedlo así; no traduzcáis a inglés cosas existentes.

## Lo que NO debéis tocar

- **`src/lib/ocr.ts`** y todo lo relacionado con la extracción Document AI
  (incluido `src/lib/boundingBoxes.ts`). Ese código lo mantiene otro
  miembro del equipo. Si necesitáis modificar el comportamiento OCR
  → hacedlo en la capa de orquestación (`src/lib/processInvoice.ts`).
- **El typo "Cutoa Rec. Equiv." en `exportFormats.ts`** — viene de la
  plantilla oficial A3 Asesor. No lo "corrijáis".
- **Las migraciones aplicadas** en `prisma/migrations/`. Si necesitáis
  cambiar el schema, generad una nueva migración (`prisma migrate dev`).
  Nunca editéis SQL ya aplicado en producción.
- **Los comentarios sin tildes existentes** (`asi`, `tambien`, `numero`).
  Limpiarlos uno a uno es churn sin valor; deja la convención como esté.

## Reglas de estilo

- **Tildes y ñ en strings de usuario**: SIEMPRE. La UI es para
  asesores españoles, "razon social" o "ano" es inaceptable. En
  comentarios da igual.
- **Comentarios**: solo donde el "por qué" no sea obvio. Nada de
  `// suma las bases` justo encima de `sumBase = ...`.
- **No abreviaturas inventadas**: usad `clientId`, no `cId`. Prisma
  ya lo nombra largo, seguidle.
- **Server actions**: devuelven `{ error: string } | null` o un
  estado tipado. Nunca lanzan excepciones a la UI.
- **Validación**: en el límite del sistema (form input, API entrante).
  No en cada función interna.

## Reglas operativas

- **No hagas `git commit` ni `git push` sin permiso explícito** del
  usuario. Si ves cambios sin commitear al inicio de la sesión, son
  trabajo en curso suyo — no los toques.
- **No ejecutes destructivo sin pedir**: `prisma migrate reset`,
  `git reset --hard`, `rm -rf` de directorios grandes... preguntad.
- **No instales paquetes nuevos sin razón clara**. Si el stack ya
  resuelve algo, úsalo. Si añadís uno, justificadlo en el commit.
- **No mockéis Prisma en tests**. Usad la DB de test real.

## Multitenancy (importante)

Todo cuelga de `AdvisoryFirm`. Cualquier query no trivial debe
filtrar por `firmId` directa o transitivamente (vía `Client` o
`User`). Una query sin ese filtro es un leak entre asesorías. El
linter no lo detecta — está en vuestra responsabilidad.

## Cómo añadir una feature

1. Lee [ARCHITECTURE.md](ARCHITECTURE.md) para entender el flujo y
   las decisiones existentes.
2. Si toca el schema → crea migración con `npx prisma migrate dev
   --name <slug>`.
3. Lógica de negocio en `src/lib/` (testable, sin Next imports).
4. Server actions o route handlers como capa fina sobre `lib/`.
5. UI en `src/app/dashboard/<role>/`.
6. Tests unit para la lógica en `lib/`; e2e solo para flujos
   críticos.

## Pistas rápidas

- ¿Estados de Invoice? → [src/lib/invoiceStatuses.ts](src/lib/invoiceStatuses.ts)
- ¿Cómo se valida una factura? → [src/app/dashboard/worker/review/[id]/actions.ts](src/app/dashboard/worker/review/[id]/actions.ts)
- ¿Cola "siguiente factura"? → [src/lib/reviewQueue.ts](src/lib/reviewQueue.ts)
- ¿Exportar a A3? → [src/lib/exportFormats.ts](src/lib/exportFormats.ts)
- ¿Auditoría inmutable? → [src/lib/auditLog.ts](src/lib/auditLog.ts) +
  `prisma/migrations/20260507120000_audit_hash_chain/`
- ¿Reset demo? → [src/lib/demoSeed.ts](src/lib/demoSeed.ts) +
  `prisma/migrations/20260507160000_audit_bypass_for_demo_reset/`
- ¿Glosario fiscal? → [ARCHITECTURE.md#glosario-fiscal-m%C3%ADnimo-para-devs-no-espa%C3%B1oles](ARCHITECTURE.md)
