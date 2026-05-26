import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { ReviewForm } from "./ReviewForm";
import {
  filterFromInvoice,
  getQueuePosition,
  parseBucket,
  queueToSearchParams,
} from "@/lib/reviewQueue";
import { extractBoundingBoxes } from "@/lib/boundingBoxes";

// La cola se calcula en cada render — el conteo cambia segun otro
// gestor valide/rechace facturas. Forzamos dinamico para que el "X de N"
// no quede stale tras un revalidate diferido de Next.
export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ bucket?: string }>;
}) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role))
    redirect("/login");

  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const bucket = parseBucket(sp.bucket);

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      vatLines: { orderBy: { position: "asc" } },
    },
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

  // Cola de revision via helper centralizado. El "bucket" viene de la URL
  // (?bucket=clean|attention|all) y lo preservamos al navegar entre facturas.
  const queueFilter = filterFromInvoice(invoice, bucket);
  const queue = await getQueuePosition(id, queueFilter);
  const prevId = queue.prevId;
  const nextId = queue.nextId;
  const position = queue.index >= 0 ? queue.index + 1 : 1;
  const total = queue.total;
  const queueParams = queueToSearchParams(queueFilter).toString();
  const queueSuffix = queueParams ? `?${queueParams}` : "";

  const backHref =
    session.user.role === "ADMIN"
      ? `/dashboard/admin/invoices`
      : `/dashboard/worker/invoices`;

  // Bounding boxes: solo Document AI devuelve coordenadas (XML no tiene imagen)
  const boundingBoxes =
    latestExtraction?.rawResponse && latestExtraction.source !== "xml_parse"
      ? extractBoundingBoxes(latestExtraction.rawResponse)
      : {};

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

  // Si la factura aun no tiene lineas de IVA pero si tiene base/cuota
  // (datos legacy o pre-OCR), montamos una linea sintetica para la UI.
  const initialVatLines = invoice.vatLines.length > 0
    ? invoice.vatLines.map((l) => ({
        taxBase: Number(l.taxBase),
        vatRate: Number(l.vatRate),
        vatAmount: Number(l.vatAmount),
      }))
    : (invoice.taxBase != null || invoice.vatAmount != null || invoice.vatRate != null)
      ? [{
          taxBase: invoice.taxBase ? Number(invoice.taxBase) : 0,
          vatRate: invoice.vatRate ? Number(invoice.vatRate) : 0,
          vatAmount: invoice.vatAmount ? Number(invoice.vatAmount) : 0,
        }]
      : [];

  // Si la factura sigue en UPLOADED/ANALYZING, calculamos la media
  // historica de duracion OCR de la firma para mostrar una ETA decente
  // en el banner. Si no hay historial, OcrProcessingBanner usa el
  // fallback (10s).
  let avgOcrDurationMs: number | null = null;
  if (invoice.status === "UPLOADED" || invoice.status === "ANALYZING") {
    // Solo aggregamos extractions de la misma firma (acceso via Client).
    const agg = await prisma.invoiceExtraction.aggregate({
      where: {
        ocrDurationMs: { not: null, gt: 0 },
        invoice: { client: { advisoryFirmId: invoice.client.advisoryFirmId } },
      },
      _avg: { ocrDurationMs: true },
    });
    avgOcrDurationMs = agg._avg.ocrDurationMs ? Math.round(agg._avg.ocrDurationMs) : null;
  }

  // El cliente recibe la factura sin las relaciones (el form ya tiene
  // sus campos planos). Quitamos vatLines de invoice para no duplicar.
  const { vatLines: _vl, client: _c, ...invoiceForForm } = invoice;

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      <ReviewForm
        invoice={invoiceForForm}
        initialVatLines={initialVatLines}
        prevId={prevId}
        nextId={nextId}
        position={position}
        batchTotal={total}
        backHref={backHref}
        extraction={extractionData}
        boundingBoxes={boundingBoxes}
        issues={issuesData}
        suggestedAccount={accountData}
        queueSuffix={queueSuffix}
        bucket={bucket}
        avgOcrDurationMs={avgOcrDurationMs}
        sessionContext={{
          clientName: invoice.client.name,
          periodMonth: invoice.periodMonth,
          periodYear: invoice.periodYear,
          type: invoice.type,
        }}
      />
    </div>
  );
}
