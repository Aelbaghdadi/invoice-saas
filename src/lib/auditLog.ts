/**
 * Cadena de hash para AuditLog.
 *
 * Cada registro de auditoria contiene el hash del registro anterior y
 * su propio hash. Esto detecta cualquier modificacion o borrado: si
 * alguien retoca una fila o la elimina, el siguiente eslabon ya no
 * cuadra y `verifyInvoiceAuditChain()` lo destapa.
 *
 * Importante: la BD tiene un trigger (PostgreSQL) que prohibe UPDATE
 * y DELETE sobre AuditLog. La cadena de hash es la "segunda capa" —
 * para el caso (improbable) de que alguien con acceso super-admin
 * desactivara el trigger temporalmente.
 *
 * El formato del hash debe coincidir EXACTAMENTE con el del backfill
 * SQL en migrations/20260507120000_audit_hash_chain/migration.sql.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Calcula el hash de un registro dado los campos. Mismo algoritmo
 *  que el del backfill SQL, asi la cadena es consistente entre los
 *  registros sembrados y los nuevos. */
function computeAuditHash(input: {
  id: string;
  invoiceId: string;
  userId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  prevHash: string;
}): string {
  // Formato createdAt fijo (ISO con milis y Z) para que coincida con el
  // backfill SQL que usa to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"').
  const ts = input.createdAt.toISOString(); // "2026-05-07T12:34:56.789Z"
  const payload = [
    input.id,
    input.invoiceId,
    input.userId,
    input.field,
    input.oldValue ?? "",
    input.newValue ?? "",
    ts,
    input.prevHash,
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

type AuditEntry = {
  invoiceId: string;
  userId: string;
  field: string;
  oldValue?: string | null;
  newValue?: string | null;
};

/** Registro de AuditLog ya encadenado, listo para insertar. */
export type AuditRecord = {
  id: string;
  invoiceId: string;
  userId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  prevId: string | null;
  prevHash: string;
  hash: string;
};

/** Eslabon existente, lo justo para saber donde acaba cada cadena. */
export type AuditChainRow = {
  id: string;
  invoiceId: string;
  prevId: string | null;
  hash: string;
  createdAt: Date;
};

export type AuditChainHead = { id: string; hash: string; createdAt: Date };

// Postgres admite 65.535 parametros por consulta: 10 columnas x 1.000 filas
// queda holgado.
const AUDIT_INSERT_CHUNK = 1000;

/**
 * Inserta uno o mas registros de auditoria respetando la cadena de hash
 * de cada factura. Atomic: si algo falla, ningun registro se guarda.
 *
 * Con `db` (el `tx` de un `prisma.$transaction`) escribe dentro de esa
 * transaccion, para que la auditoria entre o se deshaga junto con el cambio
 * que registra. Sin `db` abre su propia transaccion.
 *
 * Sustituye llamadas directas a `prisma.auditLog.create*()`. Si no se
 * usa este helper, el `hash` se queda como NULL y la BD lo rechaza
 * (porque NOT NULL).
 */
export async function appendAuditLogs(
  entries: AuditEntry[],
  db?: Prisma.TransactionClient,
): Promise<void> {
  if (entries.length === 0) return;
  if (db) {
    await writeAuditLogs(db, entries);
    return;
  }
  await prisma.$transaction((tx) => writeAuditLogs(tx, entries), AUDIT_TRANSACTION_OPTIONS);
}

/**
 * Transaccion propia de appendAuditLogs. Con el timeout por defecto de Prisma
 * (5 s), unos miles de entradas con la BD cargada no caben: la llamada lanza
 * despues de que el llamador ya ha escrito su cambio fuera de transaccion
 * (p. ej. el reproceso masivo de «Error OCR», que ya ha pasado las facturas a
 * UPLOADED y se queda sin programar el OCR).
 */
export const AUDIT_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 5_000 } as const;

/**
 * Una consulta para las cabezas de todas las cadenas y un createMany por
 * tanda. Antes eran un findFirst y un create por factura, en serie: con un
 * export de miles de facturas no cabia en el timeout de la transaccion.
 */
async function writeAuditLogs(tx: Prisma.TransactionClient, entries: AuditEntry[]): Promise<void> {
  const invoiceIds = [...new Set(entries.map((e) => e.invoiceId))];
  await lockAuditChains(tx, invoiceIds);
  const existing = await tx.auditLog.findMany({
    where: { invoiceId: { in: invoiceIds } },
    select: { id: true, invoiceId: true, prevId: true, hash: true, createdAt: true },
  });
  const records = planAuditRecords(entries, auditChainHeads(existing), new Date(), createCuid);
  for (let i = 0; i < records.length; i += AUDIT_INSERT_CHUNK) {
    await tx.auditLog.createMany({ data: records.slice(i, i + AUDIT_INSERT_CHUNK) });
  }
}

/**
 * Clave de los bloqueos de la cadena de auditoria (pg_advisory_xact_lock con
 * dos enteros): la primera separa estos bloqueos de cualquier otro que use la
 * app; la segunda es el cubo de la factura (lockAuditChains).
 */
const AUDIT_LOCK_NAMESPACE = 48_048;

/**
 * Una escritura por factura a la vez, hasta el final de la transaccion (F-048).
 * Sin esto, dos escrituras simultaneas leian la misma cabeza y dejaban dos
 * eslabones con el mismo prevId: la cadena se bifurcaba.
 *
 * Por cubos (hashtext(id) & 4095), sin repetir y en orden de cubo: como mucho
 * AUDIT_LOCK_BUCKETS entradas en la tabla de bloqueos por transaccion. Con uno
 * por factura, un export o un reproceso de mas de ~12.800 facturas la agotaba
 * y fallaba siempre (revision 1 del PR #15, punto 6). Dos facturas en el mismo
 * cubo solo se esperan de mas; y como el orden es el del cubo, dos
 * transacciones con varios en comun no se bloquean mutuamente.
 */
export const AUDIT_LOCK_BUCKETS = 4096;

async function lockAuditChains(tx: Prisma.TransactionClient, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
  // executeRaw: pg_advisory_xact_lock devuelve void, que queryRaw no sabe leer.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${AUDIT_LOCK_NAMESPACE}::int, k)
    FROM (SELECT DISTINCT hashtext(id) & ${AUDIT_LOCK_BUCKETS - 1}::int AS k FROM unnest(${invoiceIds}::text[]) AS id ORDER BY k) AS buckets`;
}

/**
 * Ultimo eslabon de cada cadena: el que ningun otro registro de la misma
 * factura tiene como `prevId`. Si hay varios (cadena ya bifurcada) gana el
 * mas reciente, que es lo que hacia el findFirst por createdAt de antes; con
 * el mismo createdAt, el que no tiene sucesor, en vez de uno al azar.
 */
export function auditChainHeads(rows: AuditChainRow[]): Map<string, AuditChainHead> {
  const referenced = new Set<string>();
  for (const r of rows) if (r.prevId) referenced.add(r.prevId);

  const heads = new Map<string, AuditChainHead>();
  for (const r of rows) {
    if (referenced.has(r.id)) continue;
    const current = heads.get(r.invoiceId);
    const newer = !current
      || r.createdAt.getTime() > current.createdAt.getTime()
      || (r.createdAt.getTime() === current.createdAt.getTime() && r.id > current.id);
    if (newer) heads.set(r.invoiceId, { id: r.id, hash: r.hash, createdAt: r.createdAt });
  }
  // Sin ningun registro libre (no deberia pasar: seria un ciclo) se cae al
  // mas reciente, como antes.
  for (const r of rows) {
    if (heads.has(r.invoiceId)) continue;
    const others = rows.filter((o) => o.invoiceId === r.invoiceId);
    const latest = others.reduce((a, b) => (b.createdAt.getTime() > a.createdAt.getTime() ? b : a));
    heads.set(r.invoiceId, { id: latest.id, hash: latest.hash, createdAt: latest.createdAt });
  }
  return heads;
}

/**
 * Encadena las entradas nuevas detras de la cabeza de cada factura, en el
 * orden en que llegan. Mismo `computeAuditHash` y mismos campos que siempre.
 *
 * El createdAt de cada eslabon queda al menos 1 ms por detras del anterior:
 * la verificacion recorre la cadena por createdAt, y dos registros de la
 * misma factura en el mismo milisegundo se leian en cualquier orden y
 * salian como cadena rota sin que nadie la hubiera tocado.
 */
export function planAuditRecords(
  entries: AuditEntry[],
  heads: Map<string, AuditChainHead>,
  now: Date,
  newId: () => string,
): AuditRecord[] {
  const tails = new Map<string, { id: string | null; hash: string; createdAt: Date | null }>();
  const records: AuditRecord[] = [];
  for (const entry of entries) {
    const head = heads.get(entry.invoiceId);
    const prev = tails.get(entry.invoiceId)
      ?? { id: head?.id ?? null, hash: head?.hash ?? "GENESIS", createdAt: head?.createdAt ?? null };
    const createdAt = new Date(Math.max(now.getTime(), (prev.createdAt?.getTime() ?? -Infinity) + 1));
    const id = newId();
    const oldValue = entry.oldValue ?? null;
    const newValue = entry.newValue ?? null;
    const hash = computeAuditHash({
      id,
      invoiceId: entry.invoiceId,
      userId: entry.userId,
      field: entry.field,
      oldValue,
      newValue,
      createdAt,
      prevHash: prev.hash,
    });
    records.push({
      id,
      invoiceId: entry.invoiceId,
      userId: entry.userId,
      field: entry.field,
      oldValue,
      newValue,
      createdAt,
      prevId: prev.id,
      prevHash: prev.hash,
      hash,
    });
    tails.set(entry.invoiceId, { id, hash, createdAt });
  }
  return records;
}

/** Genera un cuid compatible con el del cliente Prisma. Usamos
 *  randomUUID a falta del paquete cuid; cualquier id unico vale ya
 *  que el hash se calcula sobre el id concreto. */
function createCuid(): string {
  // Formato similar: "c" + 24 chars hex (no un cuid real pero unico).
  return "c" + createHash("sha256")
    .update(`${Date.now()}-${Math.random()}-${process.hrtime.bigint()}`)
    .digest("hex")
    .slice(0, 24);
}

export type AuditChainBreak = {
  recordId: string;
  invoiceId: string;
  expectedPrevHash: string;
  actualPrevHash: string;
  /**
   * - hash_mismatch: el registro no da su propio hash (se ha retocado);
   * - prev_hash_mismatch: su prevHash no es el hash del eslabon anterior;
   * - missing_genesis: sin anterior, pero su prevHash no es GENESIS;
   * - broken_link: el anterior no existe o es de otra factura (se ha borrado);
   * - fork: otro registro de la misma factura cuelga del mismo anterior.
   */
  reason: "prev_hash_mismatch" | "hash_mismatch" | "broken_link" | "missing_genesis" | "fork";
};

/** Registros por consulta al verificar. */
const VERIFY_PAGE_SIZE = 5_000;
/** Eslabones rotos que se devuelven como mucho (el recuento es completo). */
const MAX_REPORTED_BREAKS = 100;

type VerifyRow = {
  id: string;
  invoiceId: string;
  userId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  prevId: string | null;
  prevHash: string;
  hash: string;
};

/**
 * Comprueba un registro contra el anterior de su cadena (el de su prevId).
 * `prev` es undefined si el prevId no existe. Mismo computeAuditHash que al
 * escribir.
 */
export function checkAuditRecord(r: VerifyRow, prev: { invoiceId: string; hash: string } | undefined): AuditChainBreak[] {
  const breaks: AuditChainBreak[] = [];
  const at = (reason: AuditChainBreak["reason"], expected: string, actual: string) =>
    breaks.push({ recordId: r.id, invoiceId: r.invoiceId, expectedPrevHash: expected, actualPrevHash: actual, reason });
  if (r.prevId === null) {
    if (r.prevHash !== "GENESIS") at("missing_genesis", "GENESIS", r.prevHash);
  } else if (!prev || prev.invoiceId !== r.invoiceId) {
    at("broken_link", "", r.prevHash);
  } else if (prev.hash !== r.prevHash) {
    at("prev_hash_mismatch", prev.hash, r.prevHash);
  }
  const recomputed = computeAuditHash(r);
  if (recomputed !== r.hash) at("hash_mismatch", recomputed, r.hash);
  return breaks;
}

/**
 * Verifica todas las cadenas de auditoria de una asesoria (F-048), por
 * tandas de VERIFY_PAGE_SIZE registros y siguiendo prevId: cada registro se
 * compara con el suyo anterior, sin cargar la cadena entera en memoria (la
 * version de antes leia todas las de cada factura y las ordenaba por
 * createdAt). Aparte, una consulta busca bifurcaciones: dos registros de la
 * misma factura con el mismo anterior.
 *
 * Borrar el ultimo eslabon de una cadena no se detecta (no queda nada que lo
 * apunte); para eso esta el trigger que impide borrar.
 */
export async function verifyFirmAuditChains(firmId: string, options: { pageSize?: number } = {}): Promise<{
  totalInvoices: number;
  intactChains: number;
  brokenChains: number;
  checkedRecords: number;
  breaks: AuditChainBreak[];
}> {
  const pageSize = options.pageSize ?? VERIFY_PAGE_SIZE;
  const scope = { invoice: { client: { advisoryFirmId: firmId } } };
  const invoiceIds = new Set<string>();
  const brokenInvoiceIds = new Set<string>();
  const breaks: AuditChainBreak[] = [];
  const report = (found: AuditChainBreak[]) => {
    for (const b of found) {
      brokenInvoiceIds.add(b.invoiceId);
      if (breaks.length < MAX_REPORTED_BREAKS) breaks.push(b);
    }
  };

  let checkedRecords = 0;
  let after: string | undefined;
  for (;;) {
    const rows: VerifyRow[] = await prisma.auditLog.findMany({
      where: { ...scope, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: pageSize,
      select: {
        id: true, invoiceId: true, userId: true, field: true, oldValue: true, newValue: true,
        createdAt: true, prevId: true, prevHash: true, hash: true,
      },
    });
    if (rows.length === 0) break;
    const prevIds = [...new Set(rows.flatMap((r) => (r.prevId ? [r.prevId] : [])))];
    const prevs = new Map(
      (await prisma.auditLog.findMany({ where: { id: { in: prevIds } }, select: { id: true, invoiceId: true, hash: true } }))
        .map((p) => [p.id, p]),
    );
    for (const r of rows) {
      invoiceIds.add(r.invoiceId);
      report(checkAuditRecord(r, r.prevId ? prevs.get(r.prevId) : undefined));
    }
    checkedRecords += rows.length;
    after = rows[rows.length - 1].id;
  }

  // Bifurcaciones: el primero (por createdAt) de cada grupo es el bueno.
  const forks = await prisma.$queryRaw<{ invoiceId: string; ids: string[] }[]>`
    SELECT a."invoiceId", array_agg(a.id ORDER BY a."createdAt", a.id) AS ids
    FROM "AuditLog" a
    JOIN "Invoice" i ON i.id = a."invoiceId"
    JOIN "Client" c ON c.id = i."clientId"
    WHERE c."advisoryFirmId" = ${firmId}
    GROUP BY a."invoiceId", a."prevId"
    HAVING count(*) > 1`;
  for (const f of forks) {
    report(f.ids.slice(1).map((id) => ({ recordId: id, invoiceId: f.invoiceId, expectedPrevHash: "", actualPrevHash: "", reason: "fork" as const })));
  }

  return {
    totalInvoices: invoiceIds.size,
    intactChains: invoiceIds.size - brokenInvoiceIds.size,
    brokenChains: brokenInvoiceIds.size,
    checkedRecords,
    breaks,
  };
}

// ─── helper de tipos para callers que ya estan en transaccion ────────

