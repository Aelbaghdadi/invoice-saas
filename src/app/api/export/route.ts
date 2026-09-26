import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCsv, generateA3Excel, partitionA3Exportable, suggestFilename, validateForA3Export, type ExportFormat, type ExportConfig } from "@/lib/exportFormats";
import { attachmentContentDisposition } from "@/lib/contentDisposition";
import { commitExportBatch, ExportConflictError, exportStorageKey } from "@/lib/exportBatch";
import { deleteObject, isStorageConfigured, putObject } from "@/lib/storage";
import { appError } from "@/lib/errorCodes";
import type { InvoiceType, InvoiceStatus, PeriodType } from "@prisma/client";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const sp         = req.nextUrl.searchParams;
  const clientId   = sp.get("clientId") || undefined;
  const month      = parseInt(sp.get("month") ?? "0", 10) || undefined;
  const year       = parseInt(sp.get("year")  ?? "0", 10) || undefined;
  const periodTypeParam = sp.get("periodType") ?? "MONTHLY";
  const VALID_FORMATS = ["a3excel"];
  const VALID_TYPES = ["ALL", "PURCHASE", "SALE"];
  const VALID_PERIOD_TYPES = ["MONTHLY", "QUARTERLY"];
  const formatRaw = sp.get("format") ?? "a3excel";
  const typeParam = sp.get("type") ?? "ALL";
  if (!VALID_FORMATS.includes(formatRaw)) {
    return new NextResponse("Formato no válido", { status: 400 });
  }
  if (!VALID_TYPES.includes(typeParam)) {
    return new NextResponse("Tipo no válido", { status: 400 });
  }
  if (!VALID_PERIOD_TYPES.includes(periodTypeParam)) {
    return new NextResponse("Tipo de periodo no válido", { status: 400 });
  }
  const format = formatRaw as ExportFormat;
  const preview  = sp.get("preview") === "1";

  const firmId = session.user.advisoryFirmId;
  if (!firmId) {
    return new NextResponse("Forbidden: missing advisory firm", { status: 403 });
  }

  // Para trimestral: filtramos por rango de meses (mes inicial a mes inicial+2).
  const monthFilter =
    month && periodTypeParam === "QUARTERLY"
      ? { gte: month, lte: month + 2 }
      : month
        ? month
        : undefined;

  // Export only VALIDATED invoices scoped to the admin's firm.
  // exportBatchId: null — exportar no cambia el estado (sigue VALIDATED),
  // asi que sin este filtro cada exportacion del mismo periodo repetia las
  // facturas ya exportadas en un lote anterior.
  const where = {
    status: "VALIDATED" as InvoiceStatus,
    exportBatchId: null,
    client: { advisoryFirmId: firmId },
    ...(clientId ? { clientId } : {}),
    ...(monthFilter !== undefined
      ? { periodMonth: monthFilter }
      : {}),
    ...(year ? { periodYear: year } : {}),
    ...(typeParam !== "ALL" ? { type: typeParam as InvoiceType } : {}),
  };

  // Preview mode: recuento + avisos de validacion.
  //
  // validateForA3Export existia pero no la llamaba nadie: se calculaban los
  // avisos (NIF vacio, descuadres, total cero, tipo de operacion incompatible
  // con el sentido) y se tiraban. Es el unico punto donde un error fiscal se
  // puede ver ANTES de que el fichero entre en la contabilidad del cliente.
  if (preview) {
    const previewInvoices = await prisma.invoice.findMany({
      where,
      include: { client: true, vatLines: { orderBy: { position: "asc" } } },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }, { invoiceDate: "asc" }],
    });
    const allWarnings = validateForA3Export(previewInvoices);
    // Cuantas se quedan fuera por haber salido ya en un Excel anterior. Sin
    // este numero, un trimestre ya exportado sale como "0 facturas" y parece
    // que el programa no las encuentra.
    const alreadyExported = await prisma.invoice.count({
      where: { ...where, exportBatchId: { not: null } },
    });
    // Las que el Excel deja fuera (total 0) no cuentan como exportables:
    // no se van a marcar.
    const { exportable, excluded } = partitionA3Exportable(previewInvoices);
    return NextResponse.json({
      count: exportable.length,
      excluded: excluded.length,
      alreadyExported,
      warningCount: allWarnings.length,
      // Se recorta la lista: con un lote grande no tiene sentido volcar
      // cientos de avisos al navegador, el gestor arranca por los primeros.
      warnings: allWarnings.slice(0, 20),
    });
  }

  // Download mode — incluimos vatLines para que el exportador pueda emitir
  // una fila por tipo de IVA en facturas con desglose multiple.
  const candidates = await prisma.invoice.findMany({
    where,
    include: {
      client: true,
      vatLines: { orderBy: { position: "asc" } },
    },
    orderBy: [
      { periodYear:  "asc" },
      { periodMonth: "asc" },
      { invoiceDate: "asc" },
    ],
  });

  if (!candidates.length) {
    return NextResponse.json(
      { error: appError("ERR-EXPORT-001", `filters: client=${clientId} ${month}/${year} type=${typeParam}`) },
      { status: 404 },
    );
  }

  // Solo lo que va en el fichero se marca y entra en el lote. Las excluidas
  // siguen pendientes, y el aviso de la vista previa ya lo dice (F-009).
  const { exportable: invoices, excluded } = partitionA3Exportable(candidates);
  if (!invoices.length) {
    return NextResponse.json(
      { error: appError("ERR-EXPORT-004", `excluidas=${excluded.length} (${excluded[0].reason})`) },
      { status: 422 },
    );
  }

  // Read client export config if exporting for a single client
  let exportConfig: ExportConfig | undefined;
  if (clientId) {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { exportConfig: true },
    });
    if (client?.exportConfig && typeof client.exportConfig === "object") {
      exportConfig = client.exportConfig as ExportConfig;
    }
  }

  // Primero el fichero, en memoria. Hasta que exista no se escribe nada en
  // la BD: un fallo aqui no deja ninguna factura marcada (F-001).
  const filename = suggestFilename(invoices, format, month ?? 0, year ?? 0);
  let body: Uint8Array<ArrayBuffer>;
  let contentType: string;
  try {
    if (format === "a3excel") {
      body = new Uint8Array(generateA3Excel(invoices, exportConfig));
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else {
      body = new TextEncoder().encode(generateCsv(invoices, format, exportConfig));
      contentType = "text/csv; charset=utf-8";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[export] ERR-EXPORT-002 al generar:", err);
    return NextResponse.json(
      { error: appError("ERR-EXPORT-002", `format=${format}: ${msg}`) },
      { status: 500 },
    );
  }

  // La copia se guarda ANTES de marcar nada: cuando las facturas constan
  // exportadas, el fichero ya se puede volver a descargar desde el
  // historial aunque esta respuesta no llegue (pestaña cerrada, red).
  // Sin almacenamiento configurado (desarrollo) se exporta sin copia.
  const batchId = randomUUID();
  const storageKey = isStorageConfigured() ? exportStorageKey(firmId, batchId, format) : null;
  if (storageKey) {
    try {
      await putObject(storageKey, body, contentType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[export] ERR-EXPORT-002 al guardar la copia batch=${batchId}:`, err);
      return NextResponse.json(
        { error: appError("ERR-EXPORT-002", `batch=${batchId} copia: ${msg}`) },
        { status: 500 },
      );
    }
  }

  try {
    await commitExportBatch(
      {
        id: batchId,
        format,
        clientId: clientId ?? null,
        periodType: periodTypeParam as PeriodType,
        periodMonth: month ?? null,
        periodYear: year ?? null,
        invoiceType: typeParam,
        userId: session.user.id,
      },
      invoices,
    );
  } catch (err) {
    // Sin lote no hay nada que volver a descargar: fuera la copia.
    if (storageKey) await deleteObject(storageKey);
    if (err instanceof ExportConflictError) {
      console.warn(`[export] ERR-EXPORT-003 batch=${batchId}: ${err.message}`);
      return NextResponse.json(
        { error: appError("ERR-EXPORT-003", `batch=${batchId}: ${err.message}`) },
        { status: 409 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[export] ERR-EXPORT-002 batch=${batchId}:`, err);
    return NextResponse.json(
      { error: appError("ERR-EXPORT-002", `batch=${batchId} format=${format}: ${msg}`) },
      { status: 500 },
    );
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": attachmentContentDisposition(filename),
      // Cuantas se quedaron fuera del fichero sin marcar, para el aviso.
      "X-Export-Excluded": String(excluded.length),
    },
  });
}
