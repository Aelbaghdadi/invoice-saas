import { Prisma, type InvoiceVatLine } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs } from "@/lib/auditLog";
import { exportFingerprint, type FingerprintInvoice } from "@/lib/exportFingerprint";
import { exportExtension, type ExportFormat, type InvoiceWithClient } from "@/lib/exportFormats";

/**
 * Registro de una exportacion a A3: lote, items con snapshot, puntero
 * `exportBatchId` en cada factura y auditoria, todo en una transaccion y
 * DESPUES de tener el fichero generado (F-001). Si algo falla, no queda
 * ninguna factura marcada sin que el usuario tenga su Excel.
 */

/** Pensado para ~3.000 facturas en un lote: seis o siete consultas en bloque,
 *  muy lejos de 30 s. Los 5 s por defecto de Prisma se quedaban cortos. */
export const EXPORT_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 5_000 } as const;

// Postgres admite 65.535 parametros por consulta.
const ITEM_INSERT_CHUNK = 1000;

export type ExportInvoice = InvoiceWithClient & { vatLines: InvoiceVatLine[] };

/** Otra exportacion o una correccion se ha cruzado con esta: no se escribe nada. */
export class ExportConflictError extends Error {
  constructor(readonly invoiceIds: string[], reason: string) {
    super(reason);
    this.name = "ExportConflictError";
  }
}

/**
 * Snapshot de ExportBatchItem: lo que se mando a A3. El formato (claves y
 * orden) no se toca: la revision lo compara con exportFingerprint para saber
 * si una correccion tiene que volver a exportarse.
 */
export function buildExportSnapshot(inv: ExportInvoice): string {
  return JSON.stringify({
    issuerName: inv.issuerName,
    issuerCif: inv.issuerCif,
    receiverName: inv.receiverName,
    receiverCif: inv.receiverCif,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    taxBase: inv.taxBase,
    vatRate: inv.vatRate,
    vatAmount: inv.vatAmount,
    irpfRate: inv.irpfRate,
    irpfAmount: inv.irpfAmount,
    totalAmount: inv.totalAmount,
    vatLines: inv.vatLines.map((l) => ({
      position:  l.position,
      taxBase:   l.taxBase,
      vatRate:   l.vatRate,
      vatAmount: l.vatAmount,
      equivalenceSurchargeRate: l.equivalenceSurchargeRate,
      equivalenceSurchargeAmount: l.equivalenceSurchargeAmount,
    })),
    supplierAccount: inv.supplierAccount,
    expenseAccount: inv.expenseAccount,
    operationType: inv.operationType,
    intracomGoodsType: inv.intracomGoodsType,
    retentionType: inv.retentionType,
    retentionBase: inv.retentionBase,
    issuerCountry: inv.issuerCountry,
    receiverCountry: inv.receiverCountry,
    isRectificative: inv.isRectificative,
    rectifiedInvoiceSeries: inv.rectifiedInvoiceSeries,
    rectifiedInvoiceNumber: inv.rectifiedInvoiceNumber,
    rectificativeType: inv.rectificativeType,
    art80Tres: inv.art80Tres,
    type: inv.type,
    clientName: inv.client.name,
    clientCif: inv.client.cif,
  });
}

/**
 * Facturas cuyo contenido para A3 ya no es el que se metio en el fichero:
 * alguien la corrigio entre la lectura y la reserva. La reserva por
 * `exportBatchId: null` no lo ve, porque corregir no cambia ni el estado ni
 * el puntero de una factura que nunca se exporto.
 */
export function invoicesChangedSince(
  generated: (FingerprintInvoice & { id: string })[],
  current: (FingerprintInvoice & { id: string })[],
): string[] {
  const currentById = new Map(current.map((inv) => [inv.id, inv]));
  return generated
    .filter((inv) => {
      const now = currentById.get(inv.id);
      return !now || exportFingerprint(now) !== exportFingerprint(inv);
    })
    .map((inv) => inv.id);
}

/** Carpeta de las copias de una asesoria: la baja o el reset la borran entera. */
export function exportStoragePrefix(firmId: string): string {
  return `exports/${firmId}/`;
}

/**
 * Donde se guarda el fichero de un lote. Sale del lote, sin columna nueva:
 * los lotes antiguos no tienen objeto y salen como "No disponible". Una
 * carpeta por cliente, para poder borrar lo de un cliente por prefijo.
 */
export function exportStorageKey(
  firmId: string,
  clientId: string,
  batchId: string,
  format: ExportFormat,
): string {
  return `${exportStoragePrefix(firmId)}${clientId}/${batchId}.${exportExtension(format)}`;
}

/**
 * Un lote de esta asesoria. ExportBatch no tiene asesoria: sale de sus
 * facturas (items -> factura -> cliente -> advisoryFirmId), igual que en el
 * historial de Exportar.
 */
export function firmExportBatchWhere(batchId: string, firmId: string): Prisma.ExportBatchWhereInput {
  return { id: batchId, items: { some: { invoice: { client: { advisoryFirmId: firmId } } } } };
}

export type ExportBatchData = {
  id: string;
  format: string;
  clientId: string | null;
  periodType: Prisma.ExportBatchCreateInput["periodType"];
  periodMonth: number | null;
  periodYear: number | null;
  invoiceType: string;
  userId: string;
};

/**
 * Deja constancia de un fichero ya generado con `invoices`. Reserva las
 * facturas con `exportBatchId: null` y `status: VALIDATED`: si otra
 * exportacion simultanea se ha llevado alguna, el recuento no cuadra y se
 * aborta la transaccion entera (F-049).
 */
export async function commitExportBatch(
  batch: ExportBatchData,
  invoices: ExportInvoice[],
): Promise<void> {
  const invoiceIds = invoices.map((i) => i.id);
  try {
    await prisma.$transaction(async (tx) => {
      // El lote va primero: exportBatchId es una FK a ExportBatch.
      await tx.exportBatch.create({ data: { ...batch, invoiceCount: invoices.length } });

      const reserved = await tx.invoice.updateMany({
        where: { id: { in: invoiceIds }, exportBatchId: null, status: "VALIDATED" },
        data: { exportBatchId: batch.id },
      });
      if (reserved.count !== invoiceIds.length) {
        throw new ExportConflictError(
          invoiceIds,
          `reservadas ${reserved.count} de ${invoiceIds.length}`,
        );
      }

      // Ya con las filas bloqueadas por el UPDATE: lo que hay ahora es lo que
      // queda. Si no coincide con lo que lleva el fichero, fuera.
      const current = await tx.invoice.findMany({
        where: { id: { in: invoiceIds } },
        include: { vatLines: { orderBy: { position: "asc" } } },
      });
      const changed = invoicesChangedSince(invoices, current);
      if (changed.length > 0) {
        throw new ExportConflictError(changed, `corregidas durante la exportacion: ${changed.join(",")}`);
      }

      const items = invoices.map((inv) => ({
        exportBatchId: batch.id,
        invoiceId: inv.id,
        snapshot: buildExportSnapshot(inv),
      }));
      for (let i = 0; i < items.length; i += ITEM_INSERT_CHUNK) {
        await tx.exportBatchItem.createMany({ data: items.slice(i, i + ITEM_INSERT_CHUNK) });
      }

      await appendAuditLogs(
        invoiceIds.map((invoiceId) => ({
          invoiceId,
          userId: batch.userId,
          field: "export",
          oldValue: null,
          newValue: `Exportada (batch: ${batch.id}, formato: ${batch.format})`,
        })),
        tx,
      );
    }, EXPORT_TRANSACTION_OPTIONS);
  } catch (err) {
    // P2034: Postgres ha abortado una de dos transacciones que se bloqueaban
    // (deadlock o conflicto de escritura). Es la misma carrera de F-049.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
      throw new ExportConflictError(invoiceIds, `P2034: ${err.message}`);
    }
    throw err;
  }
}
