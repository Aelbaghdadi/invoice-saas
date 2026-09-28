"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessClient } from "@/lib/accessibleClients";
import { appendAuditLogs } from "@/lib/auditLog";
import { learnProviderRule } from "@/lib/providerRouting";
import { clientPartyIssue } from "@/lib/clientParty";
import { detectInvoiceType } from "@/lib/invoiceRouting";
import { duplicateField, findPossibleDuplicate } from "@/lib/duplicates";
import { intracomVatIssue, mathIssues } from "@/lib/mathIssues";
import { isInvoiceBalanced } from "@/lib/invoiceBalance";
import { anyNegativeAmount, hasRectificativeMention, rectificativeSignHint } from "@/lib/rectificative";
import { facturaeXmlIsCorrective } from "@/lib/ocr";
import { proposeSurchargesFromTotal, surchargeAuditValue } from "@/lib/equivalenceSurcharge";
import { clientPartyAudit } from "@/lib/auditValue";
import { proposeOperationType } from "@/lib/operationTypeProposal";
import { parseTaxId, taxIdWithCountry } from "@/lib/validators";
import { accountEntryKey } from "@/lib/supplierMatching";
import { revalidatePath } from "next/cache";

export type ClassifyState = { ok?: boolean; error?: string } | null;

/**
 * Clasifica manualmente una factura "Por clasificar": la asigna al cliente
 * elegido (que debe ser uno de sus candidatos), fuerza la parte conocida del
 * cliente según el tipo y la saca del buzón hacia la cola de revisión normal.
 */
export async function classifyInvoice(invoiceId: string, clientId: string): Promise<ClassifyState> {
  // Una server action no lanza a la UI (AGENTS.md): cualquier fallo, tambien
  // en las lecturas previas a la transaccion, sale como { error } y el gestor
  // puede reintentar. La transaccion no deja nada a medias.
  try {
    return await classify(invoiceId, clientId);
  } catch (err) {
    console.error("classifyInvoice", invoiceId, err);
    return { error: "No se pudo clasificar la factura. Inténtalo de nuevo." };
  }
}

async function classify(invoiceId: string, clientId: string): Promise<ClassifyState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { vatLines: { orderBy: { position: "asc" } } },
  });
  if (!invoice || invoice.status !== "PENDING_ROUTING") {
    return { error: "La factura no está pendiente de clasificar" };
  }
  // El cliente elegido debe ser uno de los candidatos del lote y accesible.
  if (!invoice.routingCandidateIds.includes(clientId)) {
    return { error: "Cliente no válido para esta factura" };
  }
  if (!(await canAccessClient(session, clientId))) {
    return { error: "No tienes acceso a ese cliente" };
  }

  // No clasificar a un periodo ya cerrado del cliente destino.
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: { clientId, month: invoice.periodMonth, year: invoice.periodYear },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: `El periodo ${invoice.periodMonth}/${invoice.periodYear} de ese cliente está cerrado` };
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, cif: true, advisoryFirmId: true, equivalenceSurchargeCustomer: true },
  });
  if (!client) return { error: "Cliente no encontrado" };

  // Si el tipo se subió como "No lo sé", lo detectamos ahora que conocemos el
  // cliente: el lado donde aparece su CIF decide (receptor->compra, emisor->venta).
  // Si no se puede, queda sin confirmar y el gestor lo fija en la revisión.
  let effectiveType = invoice.type;
  let typeStillUnconfirmed = invoice.typeUnconfirmed;
  if (invoice.typeUnconfirmed) {
    const detected = detectInvoiceType(client.cif, {
      issuerCif: invoice.issuerCif,
      receiverCif: invoice.receiverCif,
    });
    if (detected) {
      effectiveType = detected;
      typeStillUnconfirmed = false;
    }
  }

  // Forzar la parte conocida del cliente según el tipo (igual que el pipeline).
  const isPurchase = effectiveType === "PURCHASE";
  const clientSide = isPurchase
    ? { receiverName: client.name, receiverCif: client.cif }
    : { issuerName: client.name, issuerCif: client.cif, issuerCountry: null };

  // Duplicados contra el cliente real, con la misma comprobacion que el OCR
  // (src/lib/duplicates.ts): antes solo se miraba CIF + numero literal y,
  // en una venta sin NIF del destinatario, nada.
  const otherCif = isPurchase ? invoice.issuerCif : invoice.receiverCif;
  const duplicate = await findPossibleDuplicate({
    invoiceId,
    clientId,
    type: effectiveType,
    invoiceNumber: invoice.invoiceNumber,
    issuerCif: isPurchase ? invoice.issuerCif : client.cif,
    receiverCif: isPurchase ? client.cif : invoice.receiverCif,
    issuerCountry: isPurchase ? invoice.issuerCountry : null,
    receiverCountry: isPurchase ? null : invoice.receiverCountry,
    receiverName: invoice.receiverName,
    totalAmount: invoice.totalAmount == null ? null : Number(invoice.totalAmount),
    invoiceDate: invoice.invoiceDate,
    fileHash: invoice.fileHash,
  });
  const isDuplicate = duplicate != null;

  // Tipo de operacion con lo aprendido del tercero en el cliente elegido,
  // como en el OCR: el que habia se calculo con el cliente buzon (INTERIOR)
  // y con el una inversion del sujeto pasivo salia como desglose descuadrado.
  const otherCountry = isPurchase ? invoice.issuerCountry : invoice.receiverCountry;
  const otherName = isPurchase ? invoice.issuerName : invoice.receiverName;
  const otherParsed = parseTaxId(taxIdWithCountry(otherCif, otherCountry));
  const entryKey = accountEntryKey(otherParsed.clean, otherName, otherParsed.countryCode);
  const entry = entryKey
    ? await prisma.accountEntry.findUnique({
        where: { clientId_nif: { clientId, nif: entryKey } },
        select: { nif: true, name: true, defaultOperationType: true, intracomGoodsTypePurchase: true, intracomGoodsTypeSale: true },
      })
    : null;
  const proposal = proposeOperationType({
    direction: effectiveType,
    prefixOperationType: otherParsed.operationType,
    otherPartyName: otherName,
    entry,
    ai: invoice.intracomGoodsSource === "IA" ? invoice.intracomGoodsType : null,
  });

  // Cuadre del total y cuota por linea, como en el OCR (que no las mira en
  // «Por clasificar»). Antes se usaba isValid a secas: con un centimo de
  // descuadre quedaba en «Requiere atención» sin incidencia que resolver.
  const lines = invoice.vatLines.map((l) => ({
    id: l.id,
    taxBase: Number(l.taxBase),
    vatRate: Number(l.vatRate),
    vatAmount: Number(l.vatAmount),
    equivalenceSurchargeRate: l.equivalenceSurchargeRate == null ? null : Number(l.equivalenceSurchargeRate),
    equivalenceSurchargeAmount: l.equivalenceSurchargeAmount == null ? null : Number(l.equivalenceSurchargeAmount),
  }));
  // Cliente en recargo de equivalencia: se propone el recargo desde el total,
  // como hace el OCR con los clientes que ya conoce. Sin esto salia «Error
  // matemático: diferencia 5,20 €» donde el OCR habria puesto el recargo.
  const readSurcharge = surchargeAuditValue(lines);
  const surchargeProposals = client.equivalenceSurchargeCustomer
    ? proposeSurchargesFromTotal(
        lines,
        invoice.totalAmount == null ? null : Number(invoice.totalAmount),
        invoice.irpfAmount == null ? null : Number(invoice.irpfAmount),
      )
    : [];
  for (const p of surchargeProposals) {
    lines[p.index].equivalenceSurchargeRate = p.rate;
    lines[p.index].equivalenceSurchargeAmount = p.amount;
  }
  // Lo que cambia el sistema al clasificar, como en processInvoice (F-024):
  // la parte del cliente y el recargo propuesto.
  const autoAudit: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  const substituted = clientPartyAudit(
    isPurchase ? { name: invoice.receiverName, cif: invoice.receiverCif } : { name: invoice.issuerName, cif: invoice.issuerCif },
    client,
  );
  if (substituted) autoAudit.push({ field: "auto:parteCliente", ...substituted });
  const finalSurcharge = surchargeAuditValue(lines);
  if (finalSurcharge !== readSurcharge) autoAudit.push({ field: "auto:recargo", oldValue: readSurcharge, newValue: finalSurcharge });
  const totalAmount = invoice.totalAmount == null ? null : Number(invoice.totalAmount);
  const irpfAmount = invoice.irpfAmount == null ? null : Number(invoice.irpfAmount);
  const mathProblems = mathIssues({
    lines,
    taxBase: invoice.taxBase == null ? null : Number(invoice.taxBase),
    vatAmount: invoice.vatAmount == null ? null : Number(invoice.vatAmount),
    totalAmount,
    irpfAmount,
    operationType: proposal.operationType,
  });
  // Intracomunitaria con IVA declarado, con el tipo propuesto para el
  // cliente elegido (el OCR no la mira en «Por clasificar»).
  const intracomVat = intracomVatIssue({
    lines,
    vatAmount: invoice.vatAmount == null ? null : Number(invoice.vatAmount),
    vatRate: invoice.vatRate == null ? null : Number(invoice.vatRate),
    operationType: proposal.operationType,
  });
  if (intracomVat) mathProblems.push(intracomVat);
  // Signo (F-012): el OCR no crea incidencias en el buzon. Se miran los
  // importes guardados y la mencion que dejo el OCR en la extraccion.
  const signAmounts = {
    lines,
    taxBase: invoice.taxBase == null ? null : Number(invoice.taxBase),
    vatAmount: invoice.vatAmount == null ? null : Number(invoice.vatAmount),
    totalAmount,
    irpfAmount,
    retentionBase: invoice.retentionBase == null ? null : Number(invoice.retentionBase),
  };
  // Con negativos ya hay incidencia: no hace falta leer la extraccion.
  let mentioned = false;
  if (!anyNegativeAmount(signAmounts)) {
    const lastExtraction = await prisma.invoiceExtraction.findFirst({
      where: { invoiceId }, orderBy: { ocrFinishedAt: "desc" }, select: { rawResponse: true, source: true },
    });
    mentioned = lastExtraction?.source === "xml_parse"
      ? facturaeXmlIsCorrective(lastExtraction.rawResponse ?? "")
      : hasRectificativeMention(lastExtraction?.rawResponse);
  }
  const signHint = rectificativeSignHint(signAmounts, null, mentioned);
  if (signHint) mathProblems.push({ type: "MANUAL", description: signHint, field: "isRectificative" });
  // A nombre de otro (F-019), con lo que leyo el OCR en el lado del cliente.
  // Con el tipo sin confirmar, el lado del cliente es una suposicion.
  const foreign = typeStillUnconfirmed ? null : clientPartyIssue(effectiveType, invoice, client);
  if (foreign) mathProblems.push(foreign);
  // isValid con el recargo ya propuesto, como `finalIsValid` en el OCR: el
  // del buzon se calculo sin recargo y la ficha lo pintaba en rojo.
  const isValid = lines.length > 0 && totalAmount != null
    ? isInvoiceBalanced({
        sumBase: lines.reduce((s, l) => s + l.taxBase, 0),
        sumAmount: lines.reduce((s, l) => s + l.vatAmount, 0),
        sumSurcharge: lines.reduce((s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0),
        irpf: irpfAmount ?? 0,
        total: totalAmount,
      })
    : invoice.isValid;
  const targetStatus = isDuplicate || mathProblems.length > 0 ? "NEEDS_ATTENTION" : "PENDING_REVIEW";

  // Todo en una transaccion que empieza por reclamar la factura: si dos
  // gestores la clasifican a la vez, solo la primera escribe incidencias,
  // historial y auditoria (antes salian duplicados).
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.invoice.updateMany({
      where: { id: invoiceId, status: "PENDING_ROUTING" },
      data: {
        clientId,
        ...clientSide,
        type: effectiveType,
        typeUnconfirmed: typeStillUnconfirmed,
        operationType: proposal.operationType,
        intracomGoodsType: proposal.goodsType,
        intracomGoodsSource: proposal.source,
        isValid,
        status: targetStatus,
        routingCandidateIds: [],
        routingReason: null,
      },
    });
    if (claim.count !== 1) return false;

    const issues = [
      ...(duplicate ? [{ type: "POSSIBLE_DUPLICATE" as const, description: duplicate.description, field: duplicateField(duplicate.originalId) }] : []),
      ...mathProblems,
    ];
    if (issues.length > 0) {
      await tx.invoiceIssue.createMany({ data: issues.map((issue) => ({ invoiceId, ...issue })) });
    }
    for (const p of surchargeProposals) {
      await tx.invoiceVatLine.update({
        where: { id: lines[p.index].id },
        data: { equivalenceSurchargeRate: p.rate, equivalenceSurchargeAmount: p.amount },
      });
    }
    await tx.invoiceStatusHistory.create({
      data: {
        invoiceId,
        fromStatus: "PENDING_ROUTING",
        toStatus: targetStatus,
        changedBy: session.user.id,
        reason: `Clasificada manualmente a ${client.name}`,
      },
    });
    await appendAuditLogs([{
      invoiceId,
      userId: session.user.id,
      field: "status",
      oldValue: "PENDING_ROUTING",
      newValue: targetStatus,
    }, ...autoAudit.map((e) => ({ invoiceId, userId: session.user.id, ...e }))], tx);
    return true;
  }, { timeout: 15_000, maxWait: 5_000 });
  if (!claimed) return { error: "La factura no está pendiente de clasificar" };

  // Aprender: este proveedor (otra parte) va a esta empresa, para auto-rutear
  // las siguientes facturas suyas. No-op si no se leyó el CIF del proveedor.
  // La clasificacion ya esta guardada: si aprender falla, no se deshace ni
  // se le dice al gestor que no se pudo.
  try {
    await learnProviderRule(client.advisoryFirmId, otherCif, clientId);
  } catch (err) {
    console.error("learnProviderRule", invoiceId, err);
  }

  revalidatePath("/dashboard/worker/clasificar");
  revalidatePath("/dashboard/worker/invoices");
  return { ok: true };
}

/** Descarta una factura del buzón (no pertenece a ningún cliente del lote). */
export async function discardUnclassified(invoiceId: string): Promise<ClassifyState> {
  try {
    return await discard(invoiceId);
  } catch (err) {
    console.error("discardUnclassified", invoiceId, err);
    return { error: "No se pudo descartar la factura. Inténtalo de nuevo." };
  }
}

async function discard(invoiceId: string): Promise<ClassifyState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "PENDING_ROUTING") {
    return { error: "La factura no está pendiente de clasificar" };
  }
  // Acceso: el gestor debe tener acceso a alguno de los candidatos del lote.
  const accesses = await Promise.all(invoice.routingCandidateIds.map((c) => canAccessClient(session, c)));
  if (!accesses.some(Boolean)) return { error: "No tienes acceso a esta factura" };

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "REJECTED",
      rejectionCategory: "OTHER",
      rejectionReason: "Descartada al clasificar: no pertenece a ningún cliente del lote.",
      routingReason: null,
    },
  });
  await prisma.invoiceStatusHistory.create({
    data: { invoiceId, fromStatus: "PENDING_ROUTING", toStatus: "REJECTED", changedBy: session.user.id, reason: "Descartada al clasificar" },
  });
  await appendAuditLogs([{ invoiceId, userId: session.user.id, field: "status", oldValue: "PENDING_ROUTING", newValue: "REJECTED" }]);

  revalidatePath("/dashboard/worker/clasificar");
  return { ok: true };
}
