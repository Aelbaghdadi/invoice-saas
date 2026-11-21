import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs, AUDIT_TRANSACTION_OPTIONS } from "@/lib/auditLog";
import { getObjectChunks } from "@/lib/storage";
import { formatDateTimeEs } from "@/lib/dates";
import { CSV_BOM, csvAmount, csvDate, csvRow, formatBytes, originalPath, readmeText } from "@/lib/clientDataExportFormat";
import { mediumLabel } from "@/lib/originalMedium";
import { formatRegisterNumber } from "@/lib/registerNumbers";
import { counted, storageFailure, zipWriter } from "@/lib/zipStream";

/**
 * Descarga de todos los datos de un cliente en un ZIP (F-044): facturas con
 * sus lineas de IVA, originales, auditoria y lotes exportados. No borra nada.
 *
 * Se escribe en streaming: los originales pasan de Garage al ZIP por trozos y
 * las consultas grandes van por tandas, asi que la memoria no crece con el
 * cliente. `sink` aplica la contrapresion: no se lee el trozo siguiente hasta
 * que el anterior ha salido.
 */

/** Limites de una descarga. Los tests los bajan. */
export const CLIENT_EXPORT_LIMITS = {
  maxInvoices: 5_000,
  /** Suma de los originales, segun lo que se guardo al subirlos. */
  maxBytes: 1024 ** 3,
  /**
   * Bytes escritos en el ZIP, como mucho: fflate no escribe ZIP64, y por
   * encima de 4 GiB los offsets de 32 bits dejan el ZIP corrupto. Salta solo
   * si la suma de arriba se queda corta.
   */
  maxZipBytes: 4 * 1024 ** 3 - 64 * 1024 ** 2,
  /** Por original: tiempo sin recibir nada de Garage mientras se le pide. */
  storageIdleMs: 30_000,
};

const PAGE_SIZE = 2_000;

/** Un original sin tamaño guardado cuenta como el maximo de subida (20 MB). */
export const UNKNOWN_FILE_BYTES = 20 * 1024 * 1024;

export type ClientExportCheck =
  | { ok: true; client: { id: string; name: string; cif: string } }
  | { ok: false; status: 404 | 413; error: string };

/** El cliente es de la asesoria y cabe en una descarga. */
export async function checkClientExport(clientId: string, firmId: string): Promise<ClientExportCheck> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, advisoryFirmId: firmId },
    select: { id: true, name: true, cif: true },
  });
  if (!client) return { ok: false, status: 404, error: "Cliente no encontrado." };
  // Por las facturas del cliente: un documento subido en modo «clasificar»
  // sigue con el clientId del buzon despues de rutearlo. Tambien los
  // originales en otro formato (Word, Excel…) adjuntos a sus facturas, que no
  // son el documento de ninguna (anexo C8); cada documento, una vez. Lo que no
  // tiene tamaño guardado cuenta como una subida del maximo.
  const documents: Prisma.DocumentWhereInput = {
    OR: [{ invoices: { some: { clientId } } }, { archiveOriginals: { some: { invoice: { clientId } } } }],
  };
  const [invoiceCount, sizes, unsized, withoutDocument] = await Promise.all([
    prisma.invoice.count({ where: { clientId } }),
    prisma.document.aggregate({ where: documents, _sum: { sizeBytes: true } }),
    prisma.document.count({ where: { ...documents, sizeBytes: null } }),
    prisma.invoice.count({ where: { clientId, documentId: null } }),
  ]);
  const { maxInvoices, maxBytes } = CLIENT_EXPORT_LIMITS;
  // Para la entrega o una inspección suele bastar el archivo de un ejercicio.
  const alternative = "Descarga el archivo de cada ejercicio (ficha del cliente → Archivo) o pide la exportación completa a soporte.";
  if (invoiceCount > maxInvoices) {
    return {
      ok: false,
      status: 413,
      error: `El cliente tiene ${invoiceCount.toLocaleString("es-ES")} facturas y se pueden descargar como mucho ${maxInvoices.toLocaleString("es-ES")} de una vez. ${alternative}`,
    };
  }
  const bytes = (sizes._sum.sizeBytes ?? 0) + (unsized + withoutDocument) * UNKNOWN_FILE_BYTES;
  if (bytes > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `Los originales del cliente ocupan ${formatBytes(bytes)} y se pueden descargar como mucho ${formatBytes(maxBytes)} de una vez. ${alternative}`,
    };
  }
  return { ok: true, client };
}

/**
 * Rastro en la auditoria: quien descargo los datos y cuando, en cada factura
 * del cliente (la auditoria es por factura: un cliente sin facturas no deja
 * rastro, ver el PR de F-044).
 */
export async function recordClientExport(clientId: string, userId: string): Promise<void> {
  const invoices = await prisma.invoice.findMany({ where: { clientId }, select: { id: true } });
  if (invoices.length === 0) return;
  await prisma.$transaction(
    (tx) => appendAuditLogs(
      invoices.map((inv) => ({ invoiceId: inv.id, userId, field: "dataExport", oldValue: null, newValue: "Datos del cliente descargados (ZIP)" })),
      tx,
    ),
    AUDIT_TRANSACTION_OPTIONS,
  );
}

type OpenObject = (key: string) => Promise<AsyncIterable<Uint8Array>>;

/** Escribe el ZIP de un cliente ya comprobado con checkClientExport. */
export async function writeClientDataZip(
  client: { id: string; name: string; cif: string },
  generatedBy: string,
  sink: (chunk: Uint8Array) => Promise<void>,
  openObject: OpenObject = (key) => getObjectChunks(key, { idleMs: CLIENT_EXPORT_LIMITS.storageIdleMs }),
): Promise<void> {
  const out = zipWriter(sink, CLIENT_EXPORT_LIMITS.maxZipBytes);
  const invoices = await prisma.invoice.findMany({
    where: { clientId: client.id },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      vatLines: { orderBy: { position: "asc" } },
      // Su fila del archivo: nº de registro, electrónico o papel y el original
      // en otro formato (Word, Excel…) si lo tiene.
      archive: {
        include: {
          registerSeries: { select: { type: true, year: true } },
          originalDocument: { select: { storageKey: true, filename: true, fileType: true, createdAt: true } },
        },
      },
    },
  });

  // Originales primero: los que fallen salen en ERRORES.txt y en el LEEME.
  // Cada objeto, una vez; un Word adjunto va junto al PDF de su factura.
  const paths = new Map<string, string>();
  const missing: string[] = [];
  const files = invoices.flatMap((inv) => {
    const own = { storageKey: inv.storageKey, path: originalPath(inv), createdAt: inv.createdAt };
    const document = inv.archive?.originalDocument;
    return document
      ? [own, { storageKey: document.storageKey, path: originalPath({ ...inv, filename: document.filename, fileType: document.fileType }), createdAt: document.createdAt }]
      : [own];
  });
  for (const file of files) {
    if (paths.has(file.storageKey)) continue;
    const { path } = file;
    paths.set(file.storageKey, path);
    let received = 0;
    try {
      // Se abre antes de añadir la entrada: un original que no está no deja
      // una entrada vacía en el ZIP.
      const chunks = await openObject(file.storageKey);
      await out.binary(path, counted(chunks, (n) => (received += n)), file.createdAt);
    } catch (err) {
      if (out.closed) throw err;
      console.error(`[clientDataExport] ${client.id}: no se pudo descargar ${file.storageKey}:`, err);
      missing.push(`${path}\t${storageFailure(err, received)}`);
      paths.set(file.storageKey, `${path} (incompleto o ausente, ver ERRORES.txt)`);
    }
  }

  await out.text("facturas.json", (async function* () {
    yield "[\n";
    for (let i = 0; i < invoices.length; i++) {
      yield JSON.stringify(invoices[i], null, 2) + (i < invoices.length - 1 ? ",\n" : "\n");
    }
    yield "]\n";
  })());

  await out.text("facturas.csv", (async function* () {
    // «Original» es la ruta del fichero en este ZIP; si es electrónico o papel
    // va en otra columna, con otro nombre (anexo C10).
    yield CSV_BOM + csvRow([
      "Id", "Estado", "Tipo", "Periodo", "Nº de registro", "Nº factura", "Fecha", "Emisor", "CIF emisor", "Receptor", "CIF receptor",
      "Base imponible", "% IVA", "Cuota IVA", "% IRPF", "Cuota IRPF", "Total", "Moneda",
      "Cuenta de proveedor o cliente", "Cuenta de gasto o ingreso", "Motivo del rechazo", "Original", "Original en otro formato",
      "Original electrónico o en papel", "Subida el",
    ]);
    for (const inv of invoices) {
      const archive = inv.archive;
      yield csvRow([
        inv.id, inv.status, inv.type === "SALE" ? "Emitida" : "Recibida",
        inv.periodType === "QUARTERLY" ? `${inv.periodYear}-T${Math.ceil(inv.periodMonth / 3)}` : `${inv.periodYear}-${String(inv.periodMonth).padStart(2, "0")}`,
        archive?.registerSeries && archive.registerNumber != null ? formatRegisterNumber(archive.registerSeries, archive.registerNumber) : null,
        inv.invoiceNumber, csvDate(inv.invoiceDate), inv.issuerName, inv.issuerCif, inv.receiverName, inv.receiverCif,
        csvAmount(inv.taxBase), csvAmount(inv.vatRate), csvAmount(inv.vatAmount), csvAmount(inv.irpfRate), csvAmount(inv.irpfAmount),
        csvAmount(inv.totalAmount), inv.currency, inv.supplierAccount, inv.expenseAccount, inv.rejectionReason,
        paths.get(inv.storageKey),
        archive?.originalDocument ? paths.get(archive.originalDocument.storageKey) : null,
        mediumLabel(archive?.originalMedium),
        formatDateTimeEs(inv.createdAt),
      ]);
    }
  })());

  await out.text("lineas_iva.csv", (async function* () {
    yield CSV_BOM + csvRow(["Id de la factura", "Nº factura", "Línea", "Base imponible", "% IVA", "Cuota IVA", "% recargo", "Cuota recargo"]);
    for (const inv of invoices) {
      for (const line of inv.vatLines) {
        yield csvRow([
          inv.id, inv.invoiceNumber, line.position + 1, csvAmount(line.taxBase), csvAmount(line.vatRate), csvAmount(line.vatAmount),
          csvAmount(line.equivalenceSurchargeRate), csvAmount(line.equivalenceSurchargeAmount),
        ]);
      }
    }
  })());

  let auditCount = 0;
  const numbers = new Map(invoices.map((inv) => [inv.id, inv.invoiceNumber]));
  await out.text("auditoria.csv", (async function* () {
    // La fecha en hora de Madrid para leerla; la exacta en UTC es la que
    // entra en el hash, para quien quiera comprobar la cadena.
    yield CSV_BOM + csvRow(["Fecha", "Usuario", "Email", "Id del usuario", "Id de la factura", "Nº factura", "Campo", "Antes", "Después", "Id del registro", "Anterior", "Hash del anterior", "Hash", "Fecha exacta (UTC)"]);
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof auditPage>> = await auditPage(client.id, after);
      if (page.length === 0) break;
      for (const r of page) {
        yield csvRow([
          formatDateTimeEs(r.createdAt), r.user.name, r.user.email, r.userId, r.invoiceId, numbers.get(r.invoiceId), r.field, r.oldValue, r.newValue,
          r.id, r.prevId, r.prevHash, r.hash, r.createdAt,
        ]);
      }
      auditCount += page.length;
      after = page[page.length - 1];
    }
  })());

  // Lotes con alguna factura del cliente; de cada lote, solo las suyas.
  const batches = await prisma.exportBatch.findMany({
    where: { items: { some: { invoice: { clientId: client.id } } } },
    orderBy: { createdAt: "asc" },
  });
  const exporters = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...new Set(batches.map((b) => b.userId))] } }, select: { id: true, name: true, email: true } }))
      .map((u) => [u.id, u]),
  );
  await out.text("lotes_exportados.json", (async function* () {
    yield "[\n";
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const items = await prisma.exportBatchItem.findMany({
        where: { exportBatchId: batch.id, invoice: { clientId: client.id } },
        orderBy: { createdAt: "asc" },
        select: { invoiceId: true, snapshot: true, createdAt: true },
      });
      const entry = {
        id: batch.id,
        formato: batch.format,
        exportadoEl: batch.createdAt,
        exportadoPor: exporters.has(batch.userId) ? `${exporters.get(batch.userId)!.name} <${exporters.get(batch.userId)!.email}>` : null,
        periodo: { tipo: batch.periodType, mes: batch.periodMonth, año: batch.periodYear },
        facturas: items.map((item) => ({ id: item.invoiceId, datosExportados: parseSnapshot(item.snapshot) })),
      };
      yield JSON.stringify(entry, null, 2) + (b < batches.length - 1 ? ",\n" : "\n");
    }
    yield "]\n";
  })());

  if (missing.length > 0) {
    await out.text("ERRORES.txt", (async function* () {
      yield "Originales que no se pudieron descargar del almacenamiento (ruta y motivo):\r\n\r\n";
      yield missing.join("\r\n") + "\r\n";
    })());
  }

  await out.text("LEEME.txt", (async function* () {
    yield readmeText({
      clientName: client.name,
      clientCif: client.cif,
      generatedAt: formatDateTimeEs(new Date()),
      generatedBy,
      invoiceCount: invoices.length,
      originalCount: paths.size - missing.length,
      auditCount,
      batchCount: batches.length,
      missingOriginals: missing.length,
    });
  })());

  await out.end();
}

function auditPage(clientId: string, after: { createdAt: Date; id: string } | null) {
  return prisma.auditLog.findMany({
    where: {
      invoice: { clientId },
      ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: PAGE_SIZE,
    include: { user: { select: { name: true, email: true } } },
  });
}

/** El snapshot como objeto; si no se puede leer, el texto tal cual. */
function parseSnapshot(snapshot: string): unknown {
  try {
    return JSON.parse(snapshot);
  } catch {
    return snapshot;
  }
}
