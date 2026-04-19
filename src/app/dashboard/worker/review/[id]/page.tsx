import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { ReviewForm } from "./ReviewForm";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role))
    redirect("/login");

  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { client: true },
  });
  if (!invoice) notFound();

  // Workers can only review invoices of their assigned clients
  if (session.user.role === "WORKER") {
    const assignment = await prisma.workerClientAssignment.findUnique({
      where: {
        workerId_clientId: {
          workerId: session.user.id,
          clientId: invoice.clientId,
        },
      },
    });
    if (!assignment) notFound();
  }

  // Load latest extraction (for confidence scores and OCR comparison)
  const latestExtraction = await prisma.invoiceExtraction.findFirst({
    where: { invoiceId: id },
    orderBy: { createdAt: "desc" },
  });

  // Load open issues for this invoice
  const issues = await prisma.invoiceIssue.findMany({
    where: { invoiceId: id },
    orderBy: { createdAt: "desc" },
  });

  // Get all invoices in the same batch (same client + period + type), ordered by createdAt.
  // Only include invoices still pending review; always include the current one so the
  // counter stays correct even if this invoice is already validated.
  const batchInvoices = await prisma.invoice.findMany({
    where: {
      clientId:    invoice.clientId,
      periodMonth: invoice.periodMonth,
      periodYear:  invoice.periodYear,
      type:        invoice.type,
      OR: [
        { id: invoice.id },
        { status: { in: ["PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR"] } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const idx     = batchInvoices.findIndex((i) => i.id === id);
  const prevId  = idx > 0 ? batchInvoices[idx - 1].id : null;
  const nextId  = idx < batchInvoices.length - 1 ? batchInvoices[idx + 1].id : null;
  const position = idx + 1;
  const total    = batchInvoices.length;

  const backHref =
    session.user.role === "ADMIN"
      ? `/dashboard/admin/invoices`
      : `/dashboard/worker/invoices`;

  // Serialize extraction for client component
  const extractionData = latestExtraction ? {
    issuerName: latestExtraction.issuerName,
    issuerCif: latestExtraction.issuerCif,
    receiverName: latestExtraction.receiverName,
    receiverCif: latestExtraction.receiverCif,
    invoiceNumber: latestExtraction.invoiceNumber,
    invoiceDate: latestExtraction.invoiceDate?.toISOString().slice(0, 10) ?? null,
    taxBase: latestExtraction.taxBase ? Number(latestExtraction.taxBase) : null,
    vatRate: latestExtraction.vatRate ? Number(latestExtraction.vatRate) : null,
    vatAmount: latestExtraction.vatAmount ? Number(latestExtraction.vatAmount) : null,
    irpfRate: latestExtraction.irpfRate ? Number(latestExtraction.irpfRate) : null,
    irpfAmount: latestExtraction.irpfAmount ? Number(latestExtraction.irpfAmount) : null,
    totalAmount: latestExtraction.totalAmount ? Number(latestExtraction.totalAmount) : null,
    confidence: latestExtraction.confidence as Record<string, number> | null,
    source: latestExtraction.source,
    createdAt: latestExtraction.createdAt.toISOString(),
  } : null;

  // Look up accounting entry by issuer NIF for auto-assignment
  const suggestedAccount = invoice.issuerCif
    ? await prisma.accountEntry.findUnique({
        where: { clientId_nif: { clientId: invoice.clientId, nif: invoice.issuerCif } },
      })
    : null;

  const accountData = suggestedAccount
    ? {
        supplierAccount: suggestedAccount.supplierAccount,
        expenseAccount: suggestedAccount.expenseAccount,
        defaultVatRate: suggestedAccount.defaultVatRate ? Number(suggestedAccount.defaultVatRate) : null,
        name: suggestedAccount.name,
      }
    : null;

  const issuesData = issues.map((i) => ({
    id: i.id,
    type: i.type,
    status: i.status,
    description: i.description,
    field: i.field,
  }));

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      <ReviewForm
        invoice={invoice}
        prevId={prevId}
        nextId={nextId}
        position={position}
        batchTotal={total}
        backHref={backHref}
        extraction={extractionData}
        issues={issuesData}
        suggestedAccount={accountData}
      />
    </div>
  );
}
