import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessClient } from "@/lib/accessibleClients";
import { partyAccountMatchesType, resultAccountMatchesType } from "@/lib/accountingAccount";
import { redirect, notFound } from "next/navigation";
import { ReviewForm } from "./ReviewForm";
import {
  filterFromInvoice,
  getQueuePosition,
  parseBucket,
  queueToSearchParams,
} from "@/lib/reviewQueue";
import { extractBoundingBoxes } from "@/lib/boundingBoxes";
import { extractGeminiBoundingBoxes } from "@/lib/ocrLlm";
import { accountEntryKey, entryNameMatches } from "@/lib/supplierMatching";

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

  // WORKER: solo clientes asignados. ADMIN: solo clientes de su asesoria
  // (antes un ADMIN podia abrir la factura de otra asesoria conociendo su id).
  if (!(await canAccessClient(session, invoice.clientId))) notFound();

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

  // Bounding boxes: cada extractor guarda coordenadas en formato diferente.
  // document_ai       → formato entities de Document AI.
  // gemini_text       → JSON con boundingBoxes por campo (posiciones de pdfjs).
  // gemini_multimodal → mismo JSON propio pero coordenadas de Gemini multimodal.
  // xml_parse         → sin coordenadas.
  const boundingBoxes = (() => {
    if (!latestExtraction?.rawResponse) return {};
    if (latestExtraction.source === "document_ai")
      return extractBoundingBoxes(latestExtraction.rawResponse);
    if (latestExtraction.source === "gemini_text" || latestExtraction.source === "gemini_multimodal")
      return extractGeminiBoundingBoxes(latestExtraction.rawResponse);
    return {};
  })();

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

  // Buscar la cuenta por el NIF de la "otra parte" (la que no es el
  // cliente): emisor en compras, receptor en ventas. Con issuerCif a
  // secas, en una emitida se buscaba el NIF del propio cliente (que
  // nunca esta en su plan de cuentas) y jamas encontraba nada.
  const counterpartyNif = invoice.type === "SALE" ? invoice.receiverCif : invoice.issuerCif;
  const counterpartyName = invoice.type === "SALE" ? invoice.receiverName : invoice.issuerName;
  const counterpartyCountry = invoice.type === "SALE" ? invoice.receiverCountry : invoice.issuerCountry;
  // Clave de identidad del tercero: NIF si es fiable, nombre normalizado si
  // no (proveedores extranjeros sin NIF/VAT valido, ej. chinos). Asi un
  // proveedor sin NIF fiable puede encontrarse por nombre en vez de
  // quedarse siempre "no registrado". El pais ya resuelto (issuerCountry/
  // receiverCountry) es necesario porque el NIF aqui llega SIN el prefijo
  // (se guarda limpio en Invoice) — sin el pais, un VAT extranjero real se
  // intentaria validar como NIF espanol y fallaria por error.
  const entryKey = accountEntryKey(counterpartyNif, counterpartyName, counterpartyCountry);
  const suggestedAccount = entryKey
    ? await prisma.accountEntry.findUnique({
        where: { clientId_nif: { clientId: invoice.clientId, nif: entryKey } },
      })
    : null;
  const accountMatchedByName = entryKey.startsWith("SINNIF:");
  // Encontrada por NIF pero a nombre de otro tercero (dos proveedores que
  // comparten numero): no se rellena nada y se avisa para que el gestor
  // decida. Sin esto, una factura de "Blings Bag" salia con la cuenta de
  // "Hongxin Cosmetics" y banner verde.
  const accountNameMismatch =
    suggestedAccount != null && !accountMatchedByName && !entryNameMatches(suggestedAccount, counterpartyName);

  // Solo sugerimos la cuenta si pertenece a la familia del sentido de esta
  // factura. Un tercero que es proveedor y cliente a la vez comparte fila en
  // AccountEntry, y sin este filtro una emitida se autorrellenaba con la
  // cuenta 400x/6xx aprendida en sus compras.
  const invoiceType = invoice.type === "SALE" ? "SALE" : "PURCHASE";
  const accountData = suggestedAccount
    ? {
        supplierAccount: !accountNameMismatch && partyAccountMatchesType(suggestedAccount.supplierAccount, invoiceType)
          ? suggestedAccount.supplierAccount
          : "",
        expenseAccount: !accountNameMismatch && resultAccountMatchesType(suggestedAccount.expenseAccount, invoiceType)
          ? suggestedAccount.expenseAccount
          : "",
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
  // Convertimos los Decimal de Prisma a number para que Next.js pueda
  // serializar el objeto al cruzar el límite Server → Client Component.
  const toNum = (v: unknown) => (v == null ? null : Number(v));
  const { vatLines: _vl, client: _c, ...invoiceRaw } = invoice;
  const invoiceForForm = {
    ...invoiceRaw,
    taxBase:       toNum(invoiceRaw.taxBase),
    vatRate:       toNum(invoiceRaw.vatRate),
    vatAmount:     toNum(invoiceRaw.vatAmount),
    irpfRate:      toNum(invoiceRaw.irpfRate),
    irpfAmount:    toNum(invoiceRaw.irpfAmount),
    retentionBase: toNum(invoiceRaw.retentionBase),
    totalAmount:   toNum(invoiceRaw.totalAmount),
    equivalenceSurchargeRate:   toNum(invoiceRaw.equivalenceSurchargeRate),
    equivalenceSurchargeAmount: toNum(invoiceRaw.equivalenceSurchargeAmount),
  };

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      <ReviewForm
        /* Se remonta al terminar el OCR: el formulario copia los props a su
           estado al montar, y si se abria en analisis se quedaba vacio y al
           guardar borraba lo que el OCR acababa de extraer. */
        key={invoice.status === "UPLOADED" || invoice.status === "ANALYZING" ? "ocr" : "ready"}
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
        accountMatchedByName={accountMatchedByName}
        accountNameMismatch={accountNameMismatch}
        thirdPartyGoodsType={suggestedAccount && !accountNameMismatch
          ? (invoiceType === "SALE" ? suggestedAccount.intracomGoodsTypeSale : suggestedAccount.intracomGoodsTypePurchase)
          : null}
        canRememberGoodsType={Boolean(entryKey) && !accountNameMismatch}
        queueSuffix={queueSuffix}
        bucket={bucket}
        avgOcrDurationMs={avgOcrDurationMs}
        genericAccounts={{
          supplier: invoice.client.simplifiedSupplierAccount,
          expense: invoice.client.simplifiedExpenseAccount,
        }}
        sessionContext={{
          clientName: invoice.client.name,
          clientCif: invoice.client.cif,
          periodMonth: invoice.periodMonth,
          periodYear: invoice.periodYear,
          type: invoice.type,
          equivalenceSurchargeCustomer: invoice.client.equivalenceSurchargeCustomer,
        }}
      />
    </div>
  );
}
