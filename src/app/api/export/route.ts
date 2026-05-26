import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCsv, generateA3Excel, suggestFilename, validateForA3Export, type ExportFormat, type ExportConfig } from "@/lib/exportFormats";
import { appendAuditLogs } from "@/lib/auditLog";
import { appError } from "@/lib/errorCodes";
import type { InvoiceType, InvoiceStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const sp       = req.nextUrl.searchParams;
  const clientId = sp.get("clientId") || undefined;
  const month    = parseInt(sp.get("month") ?? "0", 10) || undefined;
  const year     = parseInt(sp.get("year")  ?? "0", 10) || undefined;
  const VALID_FORMATS = ["a3excel"];
  const VALID_TYPES = ["ALL", "PURCHASE", "SALE"];
  const formatRaw = sp.get("format") ?? "a3excel";
  const typeParam = sp.get("type") ?? "ALL";
  if (!VALID_FORMATS.includes(formatRaw)) {
    return new NextResponse("Formato no válido", { status: 400 });
  }
  if (!VALID_TYPES.includes(typeParam)) {
    return new NextResponse("Tipo no válido", { status: 400 });
  }
  const format = formatRaw as ExportFormat;
  const preview  = sp.get("preview") === "1";

  const firmId = session.user.advisoryFirmId;
  if (!firmId) {
    return new NextResponse("Forbidden: missing advisory firm", { status: 403 });
  }

  // Export only VALIDATED invoices scoped to the admin's firm
  const where = {
    status: "VALIDATED" as InvoiceStatus,
    client: { advisoryFirmId: firmId },
    ...(clientId    ? { clientId }              : {}),
    ...(month       ? { periodMonth: month }    : {}),
    ...(year        ? { periodYear:  year }     : {}),
    ...(typeParam !== "ALL" ? { type: typeParam as InvoiceType } : {}),
  };

  // Preview mode: just return count
  if (preview) {
    const count = await prisma.invoice.count({ where });
    return NextResponse.json({ count });
  }

  // Download mode — incluimos vatLines para que el exportador pueda emitir
  // una fila por tipo de IVA en facturas con desglose multiple.
  const invoices = await prisma.invoice.findMany({
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

  if (!invoices.length) {
    return NextResponse.json(
      { error: appError("ERR-EXPORT-001", `filters: client=${clientId} ${month}/${year} type=${typeParam}`) },
      { status: 404 },
    );
  }

  // Create ExportBatch for traceability
  const batch = await prisma.exportBatch.create({
    data: {
      format,
      clientId: clientId ?? null,
      periodMonth: month ?? null,
      periodYear: year ?? null,
      invoiceType: typeParam,
      invoiceCount: invoices.length,
      userId: session.user.id,
    },
  });

  // Create ExportBatchItem with snapshot for each invoice (no status change)
  await prisma.exportBatchItem.createMany({
    data: invoices.map((inv) => ({
      exportBatchId: batch.id,
      invoiceId: inv.id,
      snapshot: JSON.stringify({
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
        })),
        supplierAccount: inv.supplierAccount,
        expenseAccount: inv.expenseAccount,
        operationType: inv.operationType,
        retentionType: inv.retentionType,
        retentionBase: inv.retentionBase,
        issuerCountry: inv.issuerCountry,
        isRectificative: inv.isRectificative,
        rectifiedInvoiceSeries: inv.rectifiedInvoiceSeries,
        rectifiedInvoiceNumber: inv.rectifiedInvoiceNumber,
        rectificativeType: inv.rectificativeType,
        art80Tres: inv.art80Tres,
        type: inv.type,
        clientName: inv.client.name,
        clientCif: inv.client.cif,
      }),
    })),
  });

  // Link invoices to batch (but do NOT change status)
  const invoiceIds = invoices.map((i) => i.id);
  await prisma.invoice.updateMany({
    where: { id: { in: invoiceIds } },
    data: { exportBatchId: batch.id },
  });

  // Audit log for exported invoices (cadena de hash via appendAuditLogs)
  await appendAuditLogs(
    invoices.map((i) => ({
      invoiceId: i.id,
      userId: session.user.id,
      field: "export",
      oldValue: null,
      newValue: `Exportada (batch: ${batch.id}, formato: ${format})`,
    })),
  );

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

  const filename = suggestFilename(invoices, format, month ?? 0, year ?? 0);

  try {
    if (format === "a3excel") {
      const xlsxData = generateA3Excel(invoices, exportConfig);
      return new NextResponse(new Uint8Array(xlsxData), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const csv = generateCsv(invoices, format, exportConfig);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    // Cualquier fallo en la generacion del archivo (libreria xlsx,
    // datos invalidos, etc) cae aqui. Devolvemos ERR-EXPORT-002 para
    // que el frontend lo muestre con su codigo y el batch quede
    // registrado igualmente (no rebobinamos la BD).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[export] ERR-EXPORT-002 batch=${batch.id}:`, err);
    return NextResponse.json(
      { error: appError("ERR-EXPORT-002", `batch=${batch.id} format=${format}: ${msg}`) },
      { status: 500 },
    );
  }
}
