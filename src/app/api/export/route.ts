import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCsv, generateA3Excel, partitionA3Exportable, suggestFilename, validateForA3Export, type ExportFormat, type ExportConfig } from "@/lib/exportFormats";
import { attachmentContentDisposition } from "@/lib/contentDisposition";
import { commitExportBatch, ExportConflictError, exportStorageKey } from "@/lib/exportBatch";
import { deleteObject, isStorageConfigured, putObject } from "@/lib/storage";
import { appError } from "@/lib/errorCodes";
import { exportInvoiceWhere, parseExportRequest } from "@/lib/exportRequest";

type AdminContext = { userId: string; firmId: string };

async function requireAdmin(): Promise<AdminContext | NextResponse> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const firmId = session.user.advisoryFirmId;
  if (!firmId) {
    return new NextResponse("Forbidden: missing advisory firm", { status: 403 });
  }
  return { userId: session.user.id, firmId };
}

/**
 * Vista previa: recuento y avisos. Solo lectura; la descarga es por POST
 * (F-071): un GET con efectos se dispara con un enlace o una precarga.
 *
 * validateForA3Export existia pero no la llamaba nadie: se calculaban los
 * avisos (NIF vacio, descuadres, total cero, tipo de operacion incompatible
 * con el sentido) y se tiraban. Es el unico punto donde un error fiscal se
 * puede ver ANTES de que el fichero entre en la contabilidad del cliente.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const sp = req.nextUrl.searchParams;
  if (sp.get("preview") !== "1") {
    return NextResponse.json({ error: "La descarga se hace por POST." }, { status: 405, headers: { Allow: "POST" } });
  }
  const parsed = parseExportRequest(Object.fromEntries(sp));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const where = exportInvoiceWhere(parsed.request, admin.firmId);

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

/** Descarga: genera el Excel, lo guarda y marca las facturas como exportadas. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { userId, firmId } = admin;

  // JSON y mismo origen: un formulario de otra web no puede mandar JSON sin
  // preflight, y Sec-Fetch-Site lo dice el navegador, no la pagina.
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Se esperaba JSON." }, { status: 415 });
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json({ error: "Origen no permitido." }, { status: 403 });
  }
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Se esperaba JSON." }, { status: 400 });
  }
  const parsed = parseExportRequest(typeof input === "object" && input !== null ? input as Record<string, unknown> : {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { request } = parsed;
  const { clientId, month, year, periodType } = request;
  const format: ExportFormat = request.format;
  const where = exportInvoiceWhere(request, firmId);

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
      { error: appError("ERR-EXPORT-001", `filters: client=${clientId} ${month}/${year} type=${request.type}`) },
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

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { exportConfig: true },
  });
  const exportConfig = client?.exportConfig && typeof client.exportConfig === "object"
    ? client.exportConfig as ExportConfig
    : undefined;

  // Primero el fichero, en memoria. Hasta que exista no se escribe nada en
  // la BD: un fallo aqui no deja ninguna factura marcada (F-001).
  const filename = suggestFilename(invoices, format, month, year);
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
        clientId,
        periodType,
        periodMonth: month,
        periodYear: year,
        invoiceType: request.type,
        userId,
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
