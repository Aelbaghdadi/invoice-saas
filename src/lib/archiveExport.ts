/**
 * Descarga del archivo de un ejercicio (R20): un ZIP con los originales de
 * verdad por carpeta y periodo, indice.xlsx en el orden del archivo, LEEME.txt
 * y, si algo falla, ERRORES.txt. Es lo que se entrega al cliente o a una
 * inspección: sin auditoría, notas internas ni nombres o correos del personal.
 *
 * Se escribe en streaming, como la descarga de datos del cliente (F-044), y
 * con sus mismos límites (CLIENT_EXPORT_LIMITS: sin ZIP64).
 */
import { createHash, type Hash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs, AUDIT_TRANSACTION_OPTIONS } from "@/lib/auditLog";
import { getObjectChunks } from "@/lib/storage";
import { formatDateTimeEs } from "@/lib/dates";
import { CLIENT_EXPORT_LIMITS, UNKNOWN_FILE_BYTES } from "@/lib/clientDataExport";
import { formatBytes } from "@/lib/clientDataExportFormat";
import { loadArchiveYearRows, type ClientArchiveRow } from "@/lib/archiveData";
import { fiscalQuarterLabel, fiscalYearRange, type FiscalYear } from "@/lib/archiveRules";
import { MAX_IDS_IN_QUERY } from "@/lib/invoiceSearch";
import { invoicePeriod, periodIndex } from "@/lib/period";
import {
  archiveIndexSheets,
  archiveReadme,
  archiveZipBytes,
  archiveZipFolder,
  checkArchiveFiles,
  planArchiveZip,
  type ArchiveFileRead,
  type ArchiveIndexInput,
  type ArchiveStoredFile,
  type ArchiveZipInvoice,
  type ArchiveZipPlan,
} from "@/lib/archiveExportFormat";
import { archiveIndexXlsx } from "@/lib/archiveIndexXlsx";
import { counted, storageFailure, zipWriter } from "@/lib/zipStream";

export type ArchiveExportOptions = {
  /** Año en que empieza el ejercicio. */
  fiscalYear: number;
  /** Trimestre del ejercicio (1 a 4), o null para el ejercicio entero. */
  quarter: number | null;
  /** Solo las que tienen nº de registro (para una inspección). */
  onlyRegistered: boolean;
  includeRejected: boolean;
};

type ExportInvoice = {
  row: ClientArchiveRow;
  zip: ArchiveZipInvoice;
  taxBase: number | null;
  vatAmount: number | null;
  irpfAmount: number | null;
};

/** Lo que va en el ZIP, decidido una vez: la comprobación y la descarga
 *  usan lo mismo. */
export type ArchiveExport = {
  client: { id: string; name: string; cif: string; fiscalYearStartMonth: number };
  fiscalYear: FiscalYear;
  options: ArchiveExportOptions;
  /** En el orden del archivo. */
  invoices: ExportInvoice[];
  plan: ArchiveZipPlan;
  /** Nº de los tacos enteros del cliente sin dividir ni anular cuyo lote cae en el periodo del ZIP. */
  pendingWholeTacos: number[];
};

/**
 * Los tacos enteros del cliente sin dividir ni anular cuyo lote cae en el
 * ejercicio (o en el trimestre) del ZIP: sus facturas aún no existen, y el
 * LEEME lo dice.
 */
async function pendingWholeTacosIn(
  clientId: string,
  firmId: string,
  fiscalYear: FiscalYear,
  startMonth: number,
  quarter: number | null,
): Promise<number[]> {
  const tacos = await prisma.uploadBatch.findMany({
    where: { clientId, advisoryFirmId: firmId, wholePdf: true, pdfSplitAt: null, voidedAt: null },
    select: { tacoNumber: true, periodMonth: true, periodYear: true },
    orderBy: { tacoNumber: "asc" },
  });
  const [yearFrom, yearTo] = fiscalYearRange(fiscalYear.startYear, startMonth);
  const [from, to] = quarter ? [yearFrom + 3 * (quarter - 1), yearFrom + 3 * quarter - 1] : [yearFrom, yearTo];
  return tacos
    .filter((taco) => taco.tacoNumber != null && taco.periodMonth != null)
    .filter((taco) => {
      const index = periodIndex(taco.periodYear, taco.periodMonth as number);
      return index >= from && index <= to;
    })
    .map((taco) => taco.tacoNumber as number);
}

export type ArchiveExportCheck =
  | { ok: true; archive: ArchiveExport }
  | { ok: false; status: 404 | 413; error: string };

const FILE_SELECT = {
  id: true,
  storageKey: true,
  fileType: true,
  filename: true,
  fileHash: true,
  createdAt: true,
  periodMonth: true,
  periodYear: true,
  accountingPeriodMonth: true,
  accountingPeriodYear: true,
  taxBase: true,
  vatAmount: true,
  irpfAmount: true,
  document: { select: { sizeBytes: true } },
  archive: {
    select: {
      registerNumber: true,
      registerSeries: { select: { type: true, year: true } },
      originalDocument: {
        select: { storageKey: true, fileType: true, filename: true, fileHash: true, sizeBytes: true, createdAt: true },
      },
    },
  },
} satisfies Prisma.InvoiceSelect;

type InvoiceFile = Prisma.InvoiceGetPayload<{ select: typeof FILE_SELECT }>;

/** Los ficheros de esas facturas, por trozos, dentro de la asesoría. */
async function invoiceFiles(ids: readonly string[], firmId: string): Promise<Map<string, InvoiceFile>> {
  const unique = [...new Set(ids)];
  const found: InvoiceFile[] = [];
  for (let start = 0; start < unique.length; start += MAX_IDS_IN_QUERY) {
    found.push(...await prisma.invoice.findMany({
      where: { id: { in: unique.slice(start, start + MAX_IDS_IN_QUERY) }, client: { advisoryFirmId: firmId } },
      select: FILE_SELECT,
    }));
  }
  return new Map(found.map((invoice) => [invoice.id, invoice]));
}

function ownFile(invoice: InvoiceFile): ArchiveStoredFile {
  return {
    storageKey: invoice.storageKey,
    fileType: invoice.fileType,
    filename: invoice.filename,
    fileHash: invoice.fileHash,
    sizeBytes: invoice.document?.sizeBytes ?? null,
    createdAt: invoice.createdAt,
  };
}

const amount = (value: { toString(): string } | null) => (value == null ? null : Number(value));

/** «ejercicio 2026», «ejercicio 2025-26, T2 (Octubre – Diciembre 2025)». */
function scopeLabel(fiscalYear: FiscalYear, startMonth: number, quarter: number | null): string {
  return `ejercicio ${fiscalYear.label}${quarter ? `, ${fiscalQuarterLabel(fiscalYear.startYear, startMonth, quarter)}` : ""}`;
}

/**
 * Qué lleva el ZIP de un ejercicio (o de un trimestre suyo) de un cliente de
 * la asesoría, y si cabe en una descarga (los límites de la de datos). Suma
 * cada fichero una vez: los originales, los adjuntos en otro formato y el
 * documento entero de las divisiones (anexo C8); sin tamaño guardado, 20 MB.
 * 404 si el cliente no es de la asesoría (o es el buzón).
 */
export async function checkArchiveExport(
  clientId: string,
  firmId: string,
  options: ArchiveExportOptions,
): Promise<ArchiveExportCheck> {
  const year = await loadArchiveYearRows({ firmId, clientId, fiscalYear: options.fiscalYear, quarter: options.quarter });
  if (!year) return { ok: false, status: 404, error: "Cliente no encontrado." };
  const { client, fiscalYear } = year;
  const scope = scopeLabel(fiscalYear, client.fiscalYearStartMonth, options.quarter);
  // Por trimestres, si aún no se ha pedido uno.
  const advice = options.quarter ? "Pide la exportación a soporte." : "Descárgalo por trimestres.";

  const rows = year.rows.filter((row) =>
    (row.status !== "REJECTED" || (options.includeRejected && !options.onlyRegistered))
    && (!options.onlyRegistered || row.registerNumber != null));
  const { maxInvoices, maxBytes } = CLIENT_EXPORT_LIMITS;
  if (rows.length > maxInvoices) {
    return {
      ok: false,
      status: 413,
      error: `El ${scope} tiene ${rows.length.toLocaleString("es-ES")} facturas y se pueden descargar como mucho ${maxInvoices.toLocaleString("es-ES")} de una vez. ${advice}`,
    };
  }

  const files = await invoiceFiles(rows.map((row) => row.invoiceId), firmId);
  const roots = await invoiceFiles(rows.flatMap((row) => (row.split ? [row.split.rootId] : [])), firmId);
  const invoices: ExportInvoice[] = [];
  for (const row of rows) {
    const file = files.get(row.invoiceId);
    if (!file) continue;
    const root = row.split ? roots.get(row.split.rootId) ?? null : null;
    const series = file.archive?.registerSeries;
    const number = file.archive?.registerNumber;
    invoices.push({
      row,
      zip: {
        invoiceId: row.invoiceId,
        status: row.status,
        type: row.type,
        register: series && number != null ? { ...series, number } : null,
        period: invoicePeriod(file),
        invoiceNumber: row.invoiceNumber,
        thirdPartyName: row.thirdPartyName,
        own: ownFile(file),
        otherFormat: file.archive?.originalDocument ?? root?.archive?.originalDocument ?? null,
        splitRoot: root ? ownFile(root) : null,
        splitRootId: row.split?.rootId ?? null,
      },
      taxBase: amount(file.taxBase),
      vatAmount: amount(file.vatAmount),
      irpfAmount: amount(file.irpfAmount),
    });
  }

  const plan = planArchiveZip(invoices.map((invoice) => invoice.zip));
  const bytes = archiveZipBytes(plan, UNKNOWN_FILE_BYTES);
  if (bytes > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `Los originales del ${scope} ocupan ${formatBytes(bytes)} y se pueden descargar como mucho ${formatBytes(maxBytes)} de una vez. ${advice}`,
    };
  }
  const pendingWholeTacos = await pendingWholeTacosIn(client.id, firmId, fiscalYear, client.fiscalYearStartMonth, options.quarter);
  return { ok: true, archive: { client, fiscalYear, options, invoices, plan, pendingWholeTacos } };
}

/** Lo que dice la auditoría de la descarga: «ZIP del ejercicio 2026, T2 (…), solo registradas». */
function archiveExportAuditValue(archive: ArchiveExport): string {
  const { options } = archive;
  return [
    `ZIP del ${scopeLabel(archive.fiscalYear, archive.client.fiscalYearStartMonth, options.quarter)}`,
    options.onlyRegistered ? "solo registradas" : null,
    options.includeRejected && !options.onlyRegistered ? "con las rechazadas" : null,
  ].filter(Boolean).join(", ");
}

/**
 * Rastro en la auditoría (archiveExport) de cada factura del ZIP, en una sola
 * transacción: quien llama lo deja antes de enviar el primer byte.
 */
export async function recordArchiveExport(archive: ArchiveExport, userId: string): Promise<void> {
  if (archive.invoices.length === 0) return;
  const newValue = archiveExportAuditValue(archive);
  await prisma.$transaction(
    (tx) => appendAuditLogs(
      archive.invoices.map(({ row }) => ({ invoiceId: row.invoiceId, userId, field: "archiveExport", oldValue: null, newValue })),
      tx,
    ),
    AUDIT_TRANSACTION_OPTIONS,
  );
}

type OpenObject = (key: string) => Promise<AsyncIterable<Uint8Array>>;

/** Los mismos trozos, sumándolos a la huella. */
async function* hashed(chunks: AsyncIterable<Uint8Array>, hash: Hash): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) {
    hash.update(chunk);
    yield chunk;
  }
}

async function* once<T>(value: T): AsyncIterable<T> {
  yield value;
}

/**
 * Escribe el ZIP de un ejercicio ya comprobado con checkArchiveExport.
 * Primero los originales, con su SHA-256 calculado al pasar: si falta uno, se
 * corta o su huella no es la que se guardó al subirlo (checkArchiveFiles), va
 * a ERRORES.txt y el ZIP sigue. Después indice.xlsx, LEEME.txt y ERRORES.txt.
 */
export async function writeArchiveZip(
  archive: ArchiveExport,
  sink: (chunk: Uint8Array) => Promise<void>,
  openObject: OpenObject = (key) => getObjectChunks(key, { idleMs: CLIENT_EXPORT_LIMITS.storageIdleMs }),
): Promise<void> {
  const out = zipWriter(sink, CLIENT_EXPORT_LIMITS.maxZipBytes);
  const read = new Map<string, ArchiveFileRead>();

  for (const file of archive.plan.files) {
    let received = 0;
    const hash = createHash("sha256");
    try {
      // Se abre antes de añadir la entrada: un original que no está no deja
      // una entrada vacía en el ZIP.
      const chunks = await openObject(file.storageKey);
      await out.binary(file.path, hashed(counted(chunks, (n) => (received += n)), hash), file.createdAt);
      read.set(file.storageKey, { sha256: hash.digest("hex") });
    } catch (err) {
      if (out.closed) throw err;
      console.error(`[archiveExport] ${archive.client.id}: no se pudo descargar ${file.storageKey}:`, err);
      read.set(file.storageKey, { missing: storageFailure(err, received) });
    }
  }
  const { originals, errors } = checkArchiveFiles(archive.invoices.map(({ zip }) => zip), archive.plan, read);
  if (errors.length > 0) console.error(`[archiveExport] ${archive.client.id}: ${errors.length} originales con problemas (ERRORES.txt)`);

  const fileTypes = new Map(archive.plan.files.map((file) => [file.path, file.fileType]));
  const index: ArchiveIndexInput[] = archive.invoices.map(({ row, zip, taxBase, vatAmount, irpfAmount }) => {
    const placement = archive.plan.placements.get(row.invoiceId)!;
    const result = originals.get(row.invoiceId) ?? { sha256: null, problems: ["missing" as const] };
    return {
      folder: archiveZipFolder(zip),
      registerNumber: row.registerNumber,
      periodLabel: row.periodLabel,
      type: row.type,
      status: row.status,
      receivedAt: row.receivedAt,
      invoiceDate: row.invoiceDate,
      invoiceNumber: row.invoiceNumber,
      thirdPartyName: row.thirdPartyName,
      thirdPartyCif: row.thirdPartyCif,
      taxBase,
      vatAmount,
      irpfAmount,
      totalAmount: row.totalAmount,
      currency: row.currency,
      medium: row.medium,
      mediumReasonLabel: row.mediumReasonLabel,
      location: row.location.text,
      original: { fileType: fileTypes.get(placement.original) ?? zip.own.fileType, path: placement.original, ...result },
      copyFileType: placement.copy ? fileTypes.get(placement.copy) ?? null : null,
      retainUntil: row.retainUntil,
      retentionHoldReason: row.retentionHoldReason,
      warnings: row.warnings.map((warning) => warning.label),
      rejectionReason: row.rejectionReason,
    };
  });
  const sheets = archiveIndexSheets(index, archive.options);
  const now = new Date();
  await out.binary("indice.xlsx", once(new Uint8Array(archiveIndexXlsx(sheets))), now);

  await out.text("LEEME.txt", once(archiveReadme({
    clientName: archive.client.name,
    clientCif: archive.client.cif,
    fiscalYearLabel: archive.fiscalYear.label,
    quarterLabel: archive.options.quarter
      ? fiscalQuarterLabel(archive.fiscalYear.startYear, archive.client.fiscalYearStartMonth, archive.options.quarter)
      : null,
    onlyRegistered: archive.options.onlyRegistered,
    includeRejected: archive.options.includeRejected,
    generatedAt: formatDateTimeEs(now),
    invoiceCount: archive.invoices.length,
    fileCount: [...read.values()].filter((result) => "sha256" in result).length,
    errorCount: errors.length,
    sheets: sheets.map((sheet) => sheet.name),
    pendingWholeTacos: archive.pendingWholeTacos,
  })));

  if (errors.length > 0) {
    await out.text("ERRORES.txt", once(
      "Originales que faltan o que no coinciden con lo que se subió (ruta y motivo):\r\n\r\n" + errors.join("\r\n") + "\r\n",
    ));
  }
  await out.end();
}
