import { Prisma } from "@prisma/client";

/**
 * Cuándo una escritura se ha cruzado con otra: el export (ExportConflictError,
 * ERR-EXPORT-003) y las ediciones del archivo lo convierten en «vuelve a
 * intentarlo» en vez de un error del servidor. Aparte de exportBatch.ts para
 * que lo usen archiveRegister.ts y archiveEdits.ts sin importarse en círculo.
 */

/** Otra exportacion o una correccion se ha cruzado con esta: no se escribe nada. */
export class ExportConflictError extends Error {
  constructor(readonly invoiceIds: string[], reason: string) {
    super(reason);
    this.name = "ExportConflictError";
  }
}

/**
 * SQLSTATE de un error de Postgres que llega por Prisma con adapter-pg. En las
 * consultas de Prisma es un DriverAdapterError con el codigo en
 * `cause.originalCode`; en las de SQL en crudo ($queryRaw, $executeRaw), un
 * P2010 que lleva ese mismo error en `meta.driverAdapterError`.
 */
export function postgresErrorCode(err: unknown): string | null {
  const direct = (err as { cause?: { originalCode?: unknown } } | null)?.cause?.originalCode;
  if (typeof direct === "string") return direct;
  const raw = (err as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)
    ?.meta?.driverAdapterError?.cause?.originalCode;
  return typeof raw === "string" ? raw : null;
}

// 40P01 deadlock; 40001 fallo de serializacion.
const CONFLICT_SQLSTATES = new Set(["40P01", "40001"]);

/**
 * ¿Postgres ha abortado la transaccion por cruzarse con otra?
 *
 * La transaccion va en READ COMMITTED, asi que lo habitual entre dos exports
 * es un deadlock 40P01 (bloquean las mismas facturas en distinto orden), no
 * un 40001. Con adapter-pg el 40P01 no se traduce: llega como
 * DriverAdapterError con `code` undefined y el SQLSTATE en
 * `cause.originalCode` (o en un P2010 si salta en SQL en crudo, como la
 * numeracion del archivo). El 40001 si se traduce a P2034.
 */
export function isTransactionConflictError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") return true;
  const code = postgresErrorCode(err);
  return code != null && CONFLICT_SQLSTATES.has(code);
}

// 55P03: se paso el lock_timeout; 57014: el statement_timeout (F-080).
const LOCK_WAIT_SQLSTATES = new Set(["55P03", "57014"]);

/**
 * ¿Se cansó de esperar un bloqueo que tenía otra transacción? Es la misma
 * carrera que un conflicto y se puede reintentar: con 57014 la pantalla daba
 * ERR-EXPORT-002 («error al generar») en vez de ERR-EXPORT-003.
 */
export function isLockWaitError(err: unknown): boolean {
  const code = postgresErrorCode(err);
  return code != null && LOCK_WAIT_SQLSTATES.has(code);
}
