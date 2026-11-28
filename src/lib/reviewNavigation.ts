/**
 * Navegacion de la pantalla de revision, sin Prisma (se prueba sola).
 *
 * Dos cosas distintas que antes eran la misma:
 *  - Las flechas "<" ">" recorren el LOTE entero en el orden del contador
 *    "31 de 103", tambien las ya validadas o rechazadas. Antes solo se movian
 *    entre las pendientes: con las 30 primeras validadas, la 31 no tenia
 *    anterior y no se podia volver a revisar lo que se acababa de validar.
 *  - Validar, Rechazar y Posponer llevan a la siguiente PENDIENTE despues de
 *    la actual, que es lo que el gestor espera al ir terminando facturas.
 */

export type Neighbours = {
  /** Posicion de la actual (0-based), -1 si no esta en la lista. */
  index: number;
  prevId: string | null;
  nextId: string | null;
};

/**
 * Listado desde el que se abrio la revision (con sus filtros y su pagina),
 * para que "Volver" y el final del lote lleven ahi y no a la lista sin
 * filtros. Solo rutas del panel: el valor viene en la URL y no puede
 * convertirse en una redireccion a otra web.
 */
export function parseBackHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  if (!value.startsWith("/dashboard/") || value.includes("\\")) return null;
  return value;
}

/** Enlace a la revision de una factura desde un listado, recordando la cola
 *  (bucket) y el listado al que volver. */
export function reviewHref(
  invoiceId: string,
  opts: { bucket?: string | null; back?: string | null } = {},
): string {
  const p = new URLSearchParams();
  if (opts.bucket && opts.bucket !== "all") p.set("bucket", opts.bucket);
  if (opts.back) p.set("back", opts.back);
  const qs = p.toString();
  return `/dashboard/worker/review/${invoiceId}${qs ? `?${qs}` : ""}`;
}

/** Estados que abren la revision desde «Facturas» del administrador, con el
 *  texto del boton. ANALYZED es antiguo: se revisa como una «Por revisar». */
const ADMIN_LIST_REVIEW_LABEL: Record<string, string> = {
  PENDING_REVIEW: "Revisar",
  NEEDS_ATTENTION: "Revisar",
  ANALYZED: "Revisar",
  VALIDATED: "Ver / Corregir",
  EXPORTED: "Ver / Corregir",
};

/**
 * El boton de una factura en «Facturas» del administrador. Las que se revisan
 * o se corrigen van a la revision, que es donde se hace; el resto (subiendo,
 * analizandose, rechazadas…), a la ficha de solo lectura. Antes las «Por
 * revisar» y «Con incidencias» decian «Ver» y llevaban a la ficha, y las que se
 * estaban analizando decian «Revisar». El error del OCR tiene sus propios
 * botones en la tabla.
 */
export function adminListLink(invoiceId: string, status: string, back: string): { href: string; label: string } {
  const label = ADMIN_LIST_REVIEW_LABEL[status];
  if (label) return { href: reviewHref(invoiceId, { back }), label };
  return { href: `/dashboard/admin/invoices/${invoiceId}`, label: "Ver" };
}

/** Anterior y siguiente de la actual en la lista del lote. */
export function neighbours(ids: string[], currentId: string): Neighbours {
  const index = ids.indexOf(currentId);
  if (index < 0) return { index, prevId: null, nextId: null };
  return {
    index,
    prevId: index > 0 ? ids[index - 1] : null,
    nextId: index < ids.length - 1 ? ids[index + 1] : null,
  };
}

/**
 * Siguiente pendiente despues de la actual, en el orden del lote. Si ya no
 * queda ninguna por detras, se da la vuelta y se busca por delante (las que
 * el gestor se dejo atras). Nunca devuelve la actual.
 *
 * Antes se devolvia la PRIMERA pendiente del lote: si el gestor saltaba con
 * ">" de la 31 a la 32 y la validaba, volvia a la 31.
 */
export function nextPendingAfter(
  ids: string[],
  pendingIds: ReadonlySet<string>,
  currentId: string,
): string | null {
  const index = ids.indexOf(currentId);
  const n = ids.length;
  for (let k = 1; k <= n; k++) {
    const i = ((index < 0 ? -1 : index) + k + n) % n;
    const id = ids[i];
    if (id !== currentId && pendingIds.has(id)) return id;
  }
  return null;
}
