import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCsv, generateA3Excel, suggestFilename, validateForA3Export, type ExportFormat, type ExportConfig } from "@/lib/exportFormats";
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
  const VALID_FORMATS = ["sage50", "contasol", "a3con", "a3excel"];
  const VALID_TYPES = ["ALL", "PURCHASE", "SALE"];
  const formatRaw = sp.get("format") ?? "sage50";
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

  // Export only VALIDATED invoices scoped to the admin's firm
  const where = {
    status: "VALIDATED" as InvoiceStatus,
    client: { advisoryFirmId: firmId ?? undefined },
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

  // Download mode
  const invoices = await prisma.invoice.findMany({
    where,
    include: { client: true },
    orderBy: [
      { periodYear:  "asc" },
      { periodMonth: "asc" },
      { invoiceDate: "asc" },
    ],
  });

  if (!invoices.length) {
    return new NextResponse(
      JSON.stringify({ error: "No hay facturas validadas con esos filtros." }),
      { status: 404, headers: { "Content-Type": "application/json" } },
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
        supplierAccount: inv.supplierAccount,
        expenseAccount: inv.expenseAccount,
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

  // Audit log for exported invoices
  await prisma.auditLog.createMany({
    data: invoices.map((i) => ({
      invoiceId: i.id,
      userId: session.user.id,
      field: "export",
      oldValue: null,
      newValue: `Exportada (batch: ${batch.id}, formato: ${format})`,
    })),
  });

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
}
