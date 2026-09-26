import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCsv, generateA3Excel, partitionA3Exportable, suggestFilename, validateForA3Export, type ExportFormat, type ExportConfig } from "@/lib/exportFormats";
import { attachmentContentDisposition } from "@/lib/contentDisposition";
import { commitExportBatch, committedBatchState, ExportConflictError, exportStorageKey } from "@/lib/exportBatch";
import { deleteObject, isStorageConfigured, putObject } from "@/lib/storage";
import { appError } from "@/lib/errorCodes";
import { exportInvoiceWhere, exportPostHeadersError, parseExportRequest } from "@/lib/exportRequest";

type AdminContext = { userId: string; firmId: string };

// JSON con AppError, no texto plano: la pantalla tiene que poder decir "tu
// sesion ha caducado" en vez de un error generico que hace pensar que quiza
// se exporto (con un 401 es seguro que no).
async function requireAdmin(): Promise<AdminContext | NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: appError("ERR-AUTH-001") }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: appError("ERR-AUTH-002", `rol ${session.user.role}`) }, { status: 403 });
  }
  const firmId = session.user.advisoryFirmId;
  if (!firmId) {
    return NextResponse.json({ error: appError("ERR-AUTH-002", "admin sin asesoría") }, { status: 403 });
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

  // Solo desde la propia app (ver exportPostHeadersError).
  const headersError = exportPostHeadersError({
    contentType: req.headers.get("content-type"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    forwardedHost: req.headers.get("x-forwarded-host"),
  });
  if (headersError) {
    return NextResponse.json({ error: headersError.error }, { status: headersError.status });
  }
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Se esperaba JSON." }, { status: 400 });
  }
  // Un array tambien es "object": se trata como un cuerpo sin campos.
  const isPlainObject = typeof input === "object" && input !== null && !Array.isArray(input);
  const parsed = parseExportRequest(isPlainObject ? input : {});
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
  const storageKey = isStorageConfigured() ? exportStorageKey(firmId, clientId, batchId, format) : null;
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
    if (err instanceof ExportConflictError) {
      // Se lanzo dentro de la transaccion: se deshizo seguro. Sin lote no hay
      // nada que volver a descargar, fuera la copia.
      if (storageKey) await deleteObject(storageKey);
      console.warn(`[export] ERR-EXPORT-003 batch=${batchId}: ${err.message}`);
      return NextResponse.json(
        { error: appError("ERR-EXPORT-003", `batch=${batchId}: ${err.message}`) },
        { status: 409 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Puede que el COMMIT se confirmara y solo se perdiera la respuesta: la
    // copia no se borra hasta saber que el lote no existe. Un huerfano es
    // mejor que perder la unica copia de un lote registrado.
    const state = await committedBatchState(() =>
      prisma.exportBatch.findUnique({ where: { id: batchId }, select: { id: true } }),
    );
    if (state === "committed") {
      console.error(`[export] batch=${batchId} confirmado pese al error, se entrega el fichero:`, err);
      return fileResponse();
    }
    if (state === "unknown") {
      console.error(`[export] ERR-EXPORT-006 batch=${batchId}: no se sabe si se confirmo:`, err);
      return NextResponse.json(
        { error: appError("ERR-EXPORT-006", `batch=${batchId} format=${format}: ${msg}`) },
        { status: 500 },
      );
    }
    if (storageKey) await deleteObject(storageKey);
    console.error(`[export] ERR-EXPORT-002 batch=${batchId}:`, err);
    return NextResponse.json(
      { error: appError("ERR-EXPORT-002", `batch=${batchId} format=${format}: ${msg}`) },
      { status: 500 },
    );
  }

  return fileResponse();

  function fileResponse() {
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": attachmentContentDisposition(filename),
        // Cuantas se quedaron fuera del fichero sin marcar, para el aviso.
        "X-Export-Excluded": String(excluded.length),
        // Solo con copia guardada: la pantalla enlaza "Volver a descargar"
        // sin depender de que el historial se refresque.
        ...(storageKey ? { "X-Export-Batch-Id": batchId } : {}),
      },
    });
  }
}
