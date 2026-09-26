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
  await prisma.$transaction((tx) => writeAuditLogs(tx, entries));
}

/**
 * Una consulta para las cabezas de todas las cadenas y un createMany por
 * tanda. Antes eran un findFirst y un create por factura, en serie: con un
 * export de miles de facturas no cabia en el timeout de la transaccion.
 */
async function writeAuditLogs(tx: Prisma.TransactionClient, entries: AuditEntry[]): Promise<void> {
  const invoiceIds = [...new Set(entries.map((e) => e.invoiceId))];
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
  reason: "prev_hash_mismatch" | "hash_mismatch" | "broken_link" | "missing_genesis";
};

/**
 * Verifica la integridad de la cadena de auditoria de una factura.
 * Devuelve la lista de eslabones rotos. Si la cadena esta intacta
 * devuelve [].
 */
async function verifyInvoiceAuditChain(
  invoiceId: string,
): Promise<AuditChainBreak[]> {
  const records = await prisma.auditLog.findMany({
    where: { invoiceId },
    orderBy: { createdAt: "asc" },
  });

  const breaks: AuditChainBreak[] = [];
  let expectedPrevHash = "GENESIS";
  let expectedPrevId: string | null = null;

  for (const r of records) {
    // El primer registro debe tener prevHash="GENESIS" y prevId=null.
    // Los siguientes deben encadenar con el anterior.
    if (r.prevHash !== expectedPrevHash) {
      breaks.push({
        recordId: r.id,
        invoiceId,
        expectedPrevHash,
        actualPrevHash: r.prevHash,
        reason: expectedPrevHash === "GENESIS" ? "missing_genesis" : "prev_hash_mismatch",
      });
    }
    if (r.prevId !== expectedPrevId) {
      breaks.push({
        recordId: r.id,
        invoiceId,
        expectedPrevHash,
        actualPrevHash: r.prevHash,
        reason: "broken_link",
      });
    }

    // Recalculamos el hash y comparamos con el almacenado.
    const recomputed = computeAuditHash({
      id: r.id,
      invoiceId: r.invoiceId,
      userId: r.userId,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      createdAt: r.createdAt,
      prevHash: r.prevHash,
    });
    if (recomputed !== r.hash) {
      breaks.push({
        recordId: r.id,
        invoiceId,
        expectedPrevHash: recomputed,
        actualPrevHash: r.hash,
        reason: "hash_mismatch",
      });
    }

    expectedPrevHash = r.hash;
    expectedPrevId = r.id;
  }

  return breaks;
}

/** Verifica TODAS las cadenas de auditoria de una firma. Util para el
 *  panel admin: "verificar integridad" muestra el numero de cadenas
 *  rotas y los eslabones afectados. */
export async function verifyFirmAuditChains(firmId: string): Promise<{
  totalInvoices: number;
  intactChains: number;
  brokenChains: number;
  breaks: AuditChainBreak[];
}> {
  // Tomamos solo invoices con al menos un AuditLog (las que aun no han
  // sido tocadas no tienen cadena).
  const invoices = await prisma.invoice.findMany({
    where: {
      client: { advisoryFirmId: firmId },
      auditLogs: { some: {} },
    },
    select: { id: true },
  });

  const allBreaks: AuditChainBreak[] = [];
  for (const inv of invoices) {
    const b = await verifyInvoiceAuditChain(inv.id);
    allBreaks.push(...b);
  }

  // Una factura tiene cadena rota si tiene >=1 break.
  const brokenInvoiceIds = new Set(allBreaks.map((b) => b.invoiceId));

  return {
    totalInvoices: invoices.length,
    intactChains: invoices.length - brokenInvoiceIds.size,
    brokenChains: brokenInvoiceIds.size,
    breaks: allBreaks,
  };
}

// ─── helper de tipos para callers que ya estan en transaccion ────────

