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

/**
 * Inserta uno o mas registros de auditoria respetando la cadena de hash
 * de cada factura. Atomic: si algo falla, ningun registro se guarda.
 *
 * Sustituye llamadas directas a `prisma.auditLog.create*()`. Si no se
 * usa este helper, el `hash` se queda como NULL y la BD lo rechaza
 * (porque NOT NULL).
 */
export async function appendAuditLogs(entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;

  // Agrupamos por factura porque cada factura tiene su propia cadena.
  const byInvoice = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    const arr = byInvoice.get(e.invoiceId) ?? [];
    arr.push(e);
    byInvoice.set(e.invoiceId, arr);
  }

  await prisma.$transaction(async (tx) => {
    for (const [invoiceId, group] of byInvoice) {
      // Cabeza actual de la cadena para esta factura
      const last = await tx.auditLog.findFirst({
        where: { invoiceId },
        orderBy: { createdAt: "desc" },
        select: { id: true, hash: true },
      });

      let prevId: string | null = last?.id ?? null;
      let prevHash: string = last?.hash ?? "GENESIS";

      for (const entry of group) {
        const id = createCuid();
        const createdAt = new Date();
        const hash = computeAuditHash({
          id,
          invoiceId,
          userId: entry.userId,
          field: entry.field,
          oldValue: entry.oldValue ?? null,
          newValue: entry.newValue ?? null,
          createdAt,
          prevHash,
        });

        await tx.auditLog.create({
          data: {
            id,
            invoiceId,
            userId: entry.userId,
            field: entry.field,
            oldValue: entry.oldValue ?? null,
            newValue: entry.newValue ?? null,
            createdAt,
            prevId,
            prevHash,
            hash,
          },
        });

        prevId = id;
        prevHash = hash;
      }
    }
  });
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

