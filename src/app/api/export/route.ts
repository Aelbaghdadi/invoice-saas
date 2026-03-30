import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCsv, suggestFilename, type ExportFormat } from "@/lib/exportFormats";
import type { InvoiceType } from "@prisma/client";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const sp       = req.nextUrl.searchParams;
  const clientId = sp.get("clientId") || undefined;
  const month    = parseInt(sp.get("month") ?? "0", 10) || undefined;
  const year     = parseInt(sp.get("year")  ?? "0", 10) || undefined;
  const format   = (sp.get("format") ?? "sage50") as ExportFormat;
  const typeParam = sp.get("type") ?? "ALL";
  const preview  = sp.get("preview") === "1";

  const where = {
    status: "VALIDATED" as const,
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

  // Mark as EXPORTED and link to batch
  const invoiceIds = invoices.map((i) => i.id);
  await prisma.invoice.updateMany({
    where: { id: { in: invoiceIds } },
    data: { status: "EXPORTED", exportBatchId: batch.id },
  });

  // Record status history for each invoice
  await prisma.invoiceStatusHistory.createMany({
    data: invoiceIds.map((invoiceId) => ({
      invoiceId,
      fromStatus: "VALIDATED" as const,
      toStatus: "EXPORTED" as const,
      changedBy: session.user.id,
    })),
  });

  // Audit log for each invoice
  await prisma.auditLog.createMany({
    data: invoiceIds.map((invoiceId) => ({
      invoiceId,
      userId: session.user.id,
      field: "status",
      oldValue: "VALIDATED",
      newValue: "EXPORTED",
    })),
  });

  const csv      = generateCsv(invoices, format);
  const filename = suggestFilename(invoices, format, month ?? 0, year ?? 0);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
