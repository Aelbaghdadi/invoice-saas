import { prisma } from "@/lib/prisma";
import type { Invoice, InvoiceStatus, InvoiceType, Prisma } from "@prisma/client";

/**
 * Helper centralizado de la "cola de revision".
 *
 * La cola representa el conjunto de facturas que comparten contexto con
 * la actual (mismo cliente, mismo periodo, mismo tipo) y que siguen
 * pendientes de revisar. Se ordena por createdAt asc para mantener el
 * orden cronologico de subida.
 *
 * Tenemos dos "buckets" conceptuales (fase 3):
 *  - "clean": PENDING_REVIEW sin incidencias abiertas → cola rapida.
 *  - "attention": NEEDS_ATTENTION / OCR_ERROR / PENDING_REVIEW con
 *    issues abiertas → cola de resolucion.
 *  - "all" (default): los dos juntos, para no romper el flujo actual.
 *
 * Todas las funciones devuelven solo IDs; el caller hace el Prisma
 * include que necesite.
 */

export type QueueBucket = "clean" | "attention" | "all";

/** Estados que se consideran "pendientes de revision humana". */
const PENDING_STATUSES: InvoiceStatus[] = [
  "PENDING_REVIEW",
  "NEEDS_ATTENTION",
  "OCR_ERROR",
];

export type QueueFilter = {
  clientId: string;
  periodMonth: number;
  periodYear: number;
  type: InvoiceType;
  bucket?: QueueBucket;
};

/** Extrae el filtro de una factura (sirve para queue contextual "igual que esta"). */
export function filterFromInvoice(
  invoice: Pick<Invoice, "clientId" | "periodMonth" | "periodYear" | "type">,
  bucket: QueueBucket = "all",
): QueueFilter {
  return {
    clientId: invoice.clientId,
    periodMonth: invoice.periodMonth,
    periodYear: invoice.periodYear,
    type: invoice.type,
    bucket,
  };
}

/** Construye el `where` Prisma en funcion del bucket. */
function buildWhere(filter: QueueFilter): Prisma.InvoiceWhereInput {
  const base: Prisma.InvoiceWhereInput = {
    clientId: filter.clientId,
    periodMonth: filter.periodMonth,
    periodYear: filter.periodYear,
    type: filter.type,
  };

  const bucket = filter.bucket ?? "all";
  if (bucket === "clean") {
    // Solo PENDING_REVIEW sin issues abiertas. La ausencia de issues se
    // comprueba via relation filter (ninguna OPEN).
    return {
      ...base,
      status: "PENDING_REVIEW",
      issues: { none: { status: "OPEN" } },
    };
  }
  if (bucket === "attention") {
    return {
      ...base,
      OR: [
        { status: { in: ["NEEDS_ATTENTION", "OCR_ERROR"] } },
        { status: "PENDING_REVIEW", issues: { some: { status: "OPEN" } } },
      ],
    };
  }
  // "all": pendientes, sin distincion de bucket.
  return { ...base, status: { in: PENDING_STATUSES } };
}

/**
 * Devuelve los IDs de la cola en orden cronologico.
 * Incluye la factura actual aunque ya este VALIDATED/REJECTED para que
 * el indice "X de N" siga teniendo sentido.
 */
async function getQueueIds(
  filter: QueueFilter,
  currentInvoiceId?: string,
): Promise<string[]> {
  const where: Prisma.InvoiceWhereInput = currentInvoiceId
    ? { OR: [{ id: currentInvoiceId }, buildWhere(filter)] }
    : buildWhere(filter);

  const rows = await prisma.invoice.findMany({
    where,
    // Las pospuestas (`deferredAt != null`) van al final. Dentro de
    // cada grupo, orden cronologico de subida.
    orderBy: [{ deferredAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export type QueuePosition = {
  ids: string[];
  index: number; // 0-based position of currentInvoiceId, -1 if not in queue
  prevId: string | null;
  nextId: string | null;
  total: number;
};

/**
 * Devuelve la cola y la posicion del actual.
 *
 * El contador "X de N" usa el TAMANO ORIGINAL del lote (todas las
 * facturas del cliente+periodo+tipo, en cualquier estado), no solo las
 * pendientes. De esta forma al validar "1/8" se ve "2/8", "3/8"... sin
 * que el total decrezca conforme se completan — la percepcion natural
 * del usuario.
 *
 * La navegacion prev/next sigue saltando solo entre facturas del bucket
 * activo (pendientes), saltandose las ya completadas en el sentido
 * "avanza" — uses getNextInQueue para eso.
 */
export async function getQueuePosition(
  currentInvoiceId: string,
  filter: QueueFilter,
): Promise<QueuePosition> {
  // Total e indice se calculan sobre el lote entero (mismo cliente +
  // periodo + tipo, todos los estados). Asi el "X/N" no fluctua.
  // Ordenacion: pospuestas al final para que el "X de N" coincida con
  // el orden visual de la cola.
  const allInBatch = await prisma.invoice.findMany({
    where: {
      clientId: filter.clientId,
      periodMonth: filter.periodMonth,
      periodYear: filter.periodYear,
      type: filter.type,
    },
    orderBy: [{ deferredAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true },
  });
  const ids = allInBatch.map((r) => r.id);
  const index = ids.indexOf(currentInvoiceId);

  // Para prev/next nos quedamos solo con los del bucket (pendientes),
  // mas la actual para que prev funcione si estamos en una "done".
  const bucketIds = await getQueueIds(filter, currentInvoiceId);
  const bucketIndex = bucketIds.indexOf(currentInvoiceId);
  const prevId = bucketIndex > 0 ? bucketIds[bucketIndex - 1] : null;
  const nextId = bucketIndex >= 0 && bucketIndex < bucketIds.length - 1
    ? bucketIds[bucketIndex + 1]
    : null;

  return { ids, index, prevId, nextId, total: ids.length };
}

/**
 * Devuelve el siguiente ID pendiente (saltando el actual y los ya
 * procesados), o null si no queda ninguno en la cola. Lo usamos tras
 * validar/rechazar para saltar directamente al siguiente.
 */
export async function getNextInQueue(
  currentInvoiceId: string,
  filter: QueueFilter,
): Promise<string | null> {
  const where = buildWhere(filter);
  // Excluir la factura actual y buscar el siguiente cronologico,
  // respetando el orden de la cola (pospuestas al final).
  const row = await prisma.invoice.findFirst({
    where: { ...where, id: { not: currentInvoiceId } },
    orderBy: [{ deferredAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Serializa el filtro como querystring para meterlo en la URL de review.
 * Mantiene el contexto al navegar entre facturas.
 */
export function queueToSearchParams(
  filter: Pick<QueueFilter, "bucket">,
): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.bucket && filter.bucket !== "all") p.set("bucket", filter.bucket);
  return p;
}

/** Parsea `bucket` desde searchParams de la review page. */
export function parseBucket(value: unknown): QueueBucket {
  if (value === "clean" || value === "attention") return value;
  return "all";
}
