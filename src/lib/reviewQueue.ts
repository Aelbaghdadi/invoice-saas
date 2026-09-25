import { prisma } from "@/lib/prisma";
import type { Invoice, InvoiceStatus, InvoiceType, Prisma } from "@prisma/client";
import { neighbours, nextPendingAfter } from "@/lib/reviewNavigation";
export { parseBackHref } from "@/lib/reviewNavigation";

/**
 * Helper centralizado de la "cola de revision".
 *
 * El lote es el conjunto de facturas que comparten contexto con la actual
 * (mismo cliente, mismo periodo, mismo tipo). Las flechas lo recorren entero;
 * los buckets solo deciden cual es la siguiente PENDIENTE a la que saltar al
 * validar, rechazar o posponer. Orden: QUEUE_ORDER.
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
 * Orden de la cola: las pospuestas al final y, dentro de cada grupo, por
 * orden de subida. El id desempata: sin el, dos facturas subidas en el mismo
 * instante podian salir en distinto orden entre dos consultas y las flechas
 * saltarse una o repetirla. Una sola constante para todo lo que ordena la cola.
 */
export const QUEUE_ORDER: Prisma.InvoiceOrderByWithRelationInput[] = [
  { deferredAt: { sort: "asc", nulls: "first" } },
  { createdAt: "asc" },
  { id: "asc" },
];

/** Estados que no son una factura que revisar: el original de una division
 *  (sus hijas si lo son) y las que esperan clasificar en otro cliente. */
const FUERA_DEL_LOTE: InvoiceStatus[] = ["SPLIT_SOURCE", "PENDING_ROUTING"];

/** Estados de una factura ya terminada (para el progreso del lote). */
const HECHAS: InvoiceStatus[] = ["VALIDATED", "REJECTED", "EXPORTED"];

/** Facturas del lote en el orden de la cola (la actual siempre incluida,
 *  aunque sea una SPLIT_SOURCE abierta a mano). */
async function batchInOrder(filter: QueueFilter, currentInvoiceId: string) {
  return prisma.invoice.findMany({
    where: {
      OR: [
        { id: currentInvoiceId },
        {
          clientId: filter.clientId,
          periodMonth: filter.periodMonth,
          periodYear: filter.periodYear,
          type: filter.type,
          status: { notIn: FUERA_DEL_LOTE },
        },
      ],
    },
    orderBy: QUEUE_ORDER,
    select: { id: true, status: true },
  });
}

/** Ids pendientes del bucket (lo que Validar/Rechazar/Posponer van recorriendo). */
async function pendingIdsInBucket(filter: QueueFilter): Promise<Set<string>> {
  const rows = await prisma.invoice.findMany({ where: buildWhere(filter), select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

export type QueuePosition = {
  ids: string[];
  index: number; // 0-based position of currentInvoiceId, -1 if not in queue
  /** Anterior y siguiente del LOTE, en cualquier estado (flechas "<" ">"). */
  prevId: string | null;
  nextId: string | null;
  /** Siguiente PENDIENTE despues de la actual: a donde van Validar,
   *  Rechazar y Posponer. */
  nextPendingId: string | null;
  total: number;
  /** Ya terminadas (validadas, rechazadas, exportadas): el progreso real. */
  doneCount: number;
  /** Pendientes que quedan en el bucket actual (la actual incluida). */
  pendingInBucket: number;
};

/**
 * Posicion de la factura en su lote (mismo cliente, periodo y tipo).
 *
 * "X de N" y las flechas salen de la MISMA lista: todas las facturas del lote
 * en cualquier estado, en el orden de la cola. Antes el contador contaba el
 * lote entero y las flechas solo las pendientes, asi que con las anteriores
 * validadas "<" salia deshabilitado y no se podia volver a una factura recien
 * validada para corregirla (lo pidio un gestor, Miquel).
 *
 * El bucket (incidencias / listas para validar) ya no limita las flechas:
 * solo decide cual es la siguiente pendiente.
 */
export async function getQueuePosition(
  currentInvoiceId: string,
  filter: QueueFilter,
): Promise<QueuePosition> {
  const [lote, pendientes] = await Promise.all([
    batchInOrder(filter, currentInvoiceId),
    pendingIdsInBucket(filter),
  ]);
  const ids = lote.map((r) => r.id);
  const { index, prevId, nextId } = neighbours(ids, currentInvoiceId);
  return {
    ids,
    index,
    prevId,
    nextId,
    nextPendingId: nextPendingAfter(ids, pendientes, currentInvoiceId),
    total: ids.length,
    doneCount: lote.filter((r) => HECHAS.includes(r.status)).length,
    pendingInBucket: pendientes.size,
  };
}

/**
 * Siguiente pendiente del bucket DESPUES de la actual (dando la vuelta si no
 * queda ninguna por detras), o null si no queda ninguna. Lo usan Validar,
 * Rechazar, Posponer y Dividir para saltar a la siguiente.
 *
 * Antes devolvia la primera pendiente del lote: si el gestor saltaba con ">"
 * a la 32 y la validaba, volvia a la 31.
 */
export async function getNextInQueue(
  currentInvoiceId: string,
  filter: QueueFilter,
): Promise<string | null> {
  const [lote, pendientes] = await Promise.all([
    batchInOrder(filter, currentInvoiceId),
    pendingIdsInBucket(filter),
  ]);
  return nextPendingAfter(lote.map((r) => r.id), pendientes, currentInvoiceId);
}

/**
 * Serializa el filtro como querystring para meterlo en la URL de review.
 * Mantiene el contexto al navegar entre facturas: la cola y el listado del
 * que se vino (a donde lleva "Volver").
 */
export function queueToSearchParams(
  filter: Pick<QueueFilter, "bucket"> & { back?: string | null },
): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.bucket && filter.bucket !== "all") p.set("bucket", filter.bucket);
  if (filter.back) p.set("back", filter.back);
  return p;
}

/** Parsea `bucket` desde searchParams de la review page. */
export function parseBucket(value: unknown): QueueBucket {
  if (value === "clean" || value === "attention") return value;
  return "all";
}
