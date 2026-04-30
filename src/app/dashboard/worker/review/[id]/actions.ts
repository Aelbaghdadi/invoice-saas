"use server";

import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { notifyClientInvoiceValidated, notifyClientInvoiceRejected } from "@/lib/email";
import {
  filterFromInvoice,
  getNextInQueue,
  parseBucket,
  queueToSearchParams,
} from "@/lib/reviewQueue";

export type ReviewState = { error?: string } | null;

async function assertWorkerAccess(userId: string, role: string, clientId: string): Promise<ReviewState> {
  if (role !== "WORKER") return null;
  const assignment = await prisma.workerClientAssignment.findUnique({
    where: { workerId_clientId: { workerId: userId, clientId } },
  });
  if (!assignment) return { error: "No tienes acceso a esta factura." };
  return null;
}

type FieldData = {
  issuerName:    string;
  issuerCif:     string;
  receiverName:  string;
  receiverCif:   string;
  invoiceNumber: string;
  invoiceDate:   string;
  /** JSON-encoded array de lineas: [{taxBase,vatRate,vatAmount}]. */
  vatLines:      string;
  irpfRate:      string;
  irpfAmount:    string;
  totalAmount:   string;
  accountingPeriodMonth: string;
  accountingPeriodYear:  string;
  supplierAccount: string;
  expenseAccount:  string;
};

type ParsedVatLine = { taxBase: number; vatRate: number; vatAmount: number };

/** Parsea el JSON de lineas, descarta las vacias y normaliza a numeros.
 *  Devuelve [] si el JSON es invalido o no hay nada util. */
function parseVatLines(raw: string): ParsedVatLine[] {
  if (!raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const lines: ParsedVatLine[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const tb = typeof o.taxBase === "string" ? o.taxBase.trim() : "";
    const vr = typeof o.vatRate === "string" ? o.vatRate.trim() : "";
    const va = typeof o.vatAmount === "string" ? o.vatAmount.trim() : "";
    // Linea vacia: la ignoramos silenciosamente para que el form pueda
    // tener una fila placeholder sin guardarla.
    if (!tb && !vr && !va) continue;
    const taxBase = parseFloat(tb.replace(",", "."));
    const vatRate = parseFloat(vr.replace(",", "."));
    const vatAmount = parseFloat(va.replace(",", "."));
    if (isNaN(taxBase) || isNaN(vatRate) || isNaN(vatAmount)) continue;
    lines.push({ taxBase, vatRate, vatAmount });
  }
  return lines;
}

async function parseAndSave(invoiceId: string, userId: string, data: FieldData, validate: boolean, expectedUpdatedAt?: string) {
  const session = await auth();
  if (!session?.user) return { error: "No autorizado" };

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  // Workers can only modify invoices of assigned clients
  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr;

  // Check if the period is closed (use accounting period when set, fallback to upload period)
  const parseInt2 = (v: string) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  const checkMonth = parseInt2(data.accountingPeriodMonth) ?? invoice.accountingPeriodMonth ?? invoice.periodMonth;
  const checkYear  = parseInt2(data.accountingPeriodYear)  ?? invoice.accountingPeriodYear  ?? invoice.periodYear;
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: {
        clientId: invoice.clientId,
        month: checkMonth,
        year: checkYear,
      },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: `El periodo ${checkMonth}/${checkYear} está cerrado. No se pueden modificar facturas.` };
  }

  // Optimistic locking: reject if another user modified the invoice
  if (expectedUpdatedAt) {
    const expected = new Date(expectedUpdatedAt).getTime();
    const actual   = invoice.updatedAt.getTime();
    if (actual !== expected) {
      return { error: "Esta factura ha sido modificada por otro usuario. Recarga la página para ver los cambios." };
    }
  }

  const parse = (v: string) => v.trim() === "" ? null : parseFloat(v.replace(",", "."));
  const parseDate = (v: string) => v.trim() === "" ? null : new Date(v);

  const vatLines = parseVatLines(data.vatLines);

  // Validacion de cada linea de IVA antes de calcular nada.
  for (const line of vatLines) {
    if (line.vatRate < 0 || line.vatRate > 100) {
      return { error: "El % IVA debe estar entre 0 y 100 en todas las lineas" };
    }
    if (line.taxBase < 0) {
      return { error: "La base imponible no puede ser negativa" };
    }
    if (line.vatAmount < 0) {
      return { error: "La cuota IVA no puede ser negativa" };
    }
  }

  // Totales denormalizados sobre Invoice. vatRate solo tiene sentido cuando
  // hay una unica linea; multi-IVA -> null.
  const sumBase   = vatLines.reduce((s, l) => s + l.taxBase, 0);
  const sumAmount = vatLines.reduce((s, l) => s + l.vatAmount, 0);
  const denormVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;

  const newData = {
    issuerName:    data.issuerName    || null,
    issuerCif:     data.issuerCif     || null,
    receiverName:  data.receiverName  || null,
    receiverCif:   data.receiverCif   || null,
    invoiceNumber: data.invoiceNumber || null,
    invoiceDate:   parseDate(data.invoiceDate),
    taxBase:       vatLines.length > 0 ? sumBase   : null,
    vatRate:       denormVatRate,
    vatAmount:     vatLines.length > 0 ? sumAmount : null,
    irpfRate:      parse(data.irpfRate),
    irpfAmount:    parse(data.irpfAmount),
    totalAmount:   parse(data.totalAmount),
    accountingPeriodMonth: parseInt2(data.accountingPeriodMonth),
    accountingPeriodYear:  parseInt2(data.accountingPeriodYear),
    supplierAccount: data.supplierAccount || null,
    expenseAccount:  data.expenseAccount  || null,
  };

  if (newData.totalAmount !== null && newData.totalAmount < 0) {
    return { error: "El total no puede ser negativo" };
  }

  // Math validation: Sigma(bases) + Sigma(cuotas) - IRPF = Total
  let isValid: boolean | null = null;
  if (vatLines.length > 0 && newData.totalAmount !== null) {
    const expected = sumBase + sumAmount - (newData.irpfAmount ?? 0);
    const diff = Math.abs(
      Math.round(expected * 100) - Math.round(newData.totalAmount * 100)
    );
    isValid = diff <= 2;
  }

  // Build audit log entries for changed fields
  const auditEntries: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  const trackedFields = [
    "issuerName","issuerCif","receiverName","receiverCif",
    "invoiceNumber","taxBase","vatRate","vatAmount","irpfRate","irpfAmount","totalAmount",
  ] as const;

  for (const field of trackedFields) {
    const oldVal = invoice[field] !== null && invoice[field] !== undefined
      ? String(invoice[field]) : null;
    const newVal = newData[field] !== null && newData[field] !== undefined
      ? String(newData[field]) : null;
    if (oldVal !== newVal) {
      auditEntries.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }

  if (validate && !isValid && isValid !== null) {
    // Allow validating with warning but don't block
  }

  // When saving without validating, transition to PENDING_REVIEW if coming from initial states
  // ANALYZED es legacy (pre-refactor); si aun existe en BD se acepta como draft.
  const draftStatuses = ["ANALYZED", "NEEDS_ATTENTION", "PENDING_REVIEW", "OCR_ERROR"];
  const saveStatus = !validate && draftStatuses.includes(invoice.status)
    ? "PENDING_REVIEW"
    : undefined;

  // Persistir factura + lineas en una transaccion. Borramos las lineas
  // previas y reinsertamos: la UI envia el array completo.
  await prisma.$transaction([
    prisma.invoiceVatLine.deleteMany({ where: { invoiceId } }),
    ...(vatLines.length > 0
      ? [prisma.invoiceVatLine.createMany({
          data: vatLines.map((l, i) => ({
            invoiceId,
            position:  i,
            taxBase:   l.taxBase,
            vatRate:   l.vatRate,
            vatAmount: l.vatAmount,
          })),
        })]
      : []),
    prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        ...newData,
        isValid,
        ...(validate ? { status: "VALIDATED" as const } : saveStatus ? { status: saveStatus as "PENDING_REVIEW" } : {}),
      },
    }),
  ]);

  if (validate) {
    auditEntries.push({ field: "status", oldValue: invoice.status, newValue: "VALIDATED" });
    // Record status transition
    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId,
        fromStatus: invoice.status,
        toStatus: "VALIDATED",
        changedBy: userId,
      },
    });

    // Aprender: si hay CIF emisor + cuentas contables, actualizar plan de cuentas
    const learnNif = newData.issuerCif?.trim().toUpperCase();
    const learnSupplier = newData.supplierAccount?.trim();
    const learnExpense = newData.expenseAccount?.trim();
    const learnName = newData.issuerName?.trim();
    // defaultVatRate solo lo aprendemos cuando hay un unico tipo (multi-IVA
    // no tiene un "tipo por defecto" significativo).
    const learnVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;
    if (learnNif && (learnSupplier || learnExpense)) {
      await prisma.accountEntry.upsert({
        where: { clientId_nif: { clientId: invoice.clientId, nif: learnNif } },
        create: {
          clientId: invoice.clientId,
          nif: learnNif,
          name: learnName || learnNif,
          supplierAccount: learnSupplier || "",
          expenseAccount: learnExpense || "",
          defaultVatRate: learnVatRate != null ? (learnVatRate as any) : null,
        },
        update: {
          ...(learnName ? { name: learnName } : {}),
          ...(learnSupplier ? { supplierAccount: learnSupplier } : {}),
          ...(learnExpense ? { expenseAccount: learnExpense } : {}),
          ...(learnVatRate != null ? { defaultVatRate: learnVatRate as any } : {}),
        },
      });
    }
  }

  if (auditEntries.length > 0) {
    await prisma.auditLog.createMany({
      data: auditEntries.map((e) => ({
        invoiceId,
        userId,
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.newValue,
      })),
    });
  }

  return null; // no error
}

export async function saveInvoiceFields(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  const id = formData.get("invoiceId") as string;
  const expectedUpdatedAt = formData.get("updatedAt") as string | null;
  const err = await parseAndSave(id, session.user.id, extractFields(formData), false, expectedUpdatedAt ?? undefined);
  return err ?? null;
}

export async function validateInvoice(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  const id = formData.get("invoiceId") as string;
  const fallbackNext = formData.get("nextId") as string | null;
  const bucket = parseBucket(formData.get("bucket"));
  const expectedUpdatedAt = formData.get("updatedAt") as string | null;
  const err = await parseAndSave(id, session.user.id, extractFields(formData), true, expectedUpdatedAt ?? undefined);
  if (err) return err;

  // Notify client via email (after response)
  after(async () => {
    try {
      const inv = await prisma.invoice.findUnique({
        where: { id },
        include: { client: { include: { user: { select: { email: true } } } } },
      });
      if (inv?.client?.user?.email) {
        await notifyClientInvoiceValidated({
          clientEmail: inv.client.user.email,
          clientName: inv.client.name,
          invoiceNumber: inv.invoiceNumber ?? "",
          filename: inv.filename,
        });
      }
    } catch (e) {
      console.error("[NOTIFY] Error notifying client:", e);
    }
  });

  // Recomputar el siguiente respetando el bucket actual (puede haber
  // cambiado desde que cargo la pagina: otro gestor valido, etc).
  const nextId = await resolveNextId(id, bucket, fallbackNext);
  if (nextId) {
    const suffix = queueToSearchParams({ bucket }).toString();
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

/**
 * Dado un invoiceId recien procesado, devuelve el siguiente id pendiente
 * de la misma cola (mismo cliente + periodo + tipo + bucket). Si algo
 * falla (factura no encontrada, etc) cae en el fallback que venia del
 * formulario.
 */
async function resolveNextId(
  currentId: string,
  bucket: "clean" | "attention" | "all",
  fallback: string | null,
): Promise<string | null> {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: currentId },
      select: { clientId: true, periodMonth: true, periodYear: true, type: true },
    });
    if (!inv) return fallback || null;
    const filter = filterFromInvoice(inv, bucket);
    const next = await getNextInQueue(currentId, filter);
    return next ?? fallback ?? null;
  } catch {
    return fallback || null;
  }
}

export async function rejectInvoice(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const id = formData.get("invoiceId") as string;
  const reason = (formData.get("rejectionReason") as string)?.trim();
  const category = formData.get("rejectionCategory") as string | null;
  const fallbackNext = formData.get("nextId") as string | null;
  const bucket = parseBucket(formData.get("bucket"));

  if (!reason) {
    return { error: "Debes indicar el motivo del rechazo." };
  }

  const validCategories = ["ILLEGIBLE", "INCOMPLETE", "WRONG_PERIOD", "DUPLICATE", "OTHER"];
  if (category && !validCategories.includes(category)) {
    return { error: "Categoría de rechazo no válida." };
  }

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return { error: "Factura no encontrada" };

  // Workers can only reject invoices of assigned clients
  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr;

  await prisma.invoice.update({
    where: { id },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      ...(category ? { rejectionCategory: category as "ILLEGIBLE" | "INCOMPLETE" | "WRONG_PERIOD" | "DUPLICATE" | "OTHER" } : {}),
    },
  });

  await prisma.invoiceStatusHistory.create({
    data: {
      invoiceId: id,
      fromStatus: invoice.status,
      toStatus: "REJECTED",
      changedBy: session.user.id,
      reason,
    },
  });

  await prisma.auditLog.create({
    data: {
      invoiceId: id,
      userId: session.user.id,
      field: "status",
      oldValue: invoice.status,
      newValue: "REJECTED",
    },
  });

  // Notify client about rejection
  after(async () => {
    try {
      const inv = await prisma.invoice.findUnique({
        where: { id },
        include: { client: { include: { user: { select: { email: true } } } } },
      });
      if (inv?.client?.user?.email) {
        await notifyClientInvoiceRejected({
          clientEmail: inv.client.user.email,
          clientName: inv.client.name,
          invoiceNumber: inv.invoiceNumber ?? "",
          filename: inv.filename,
          reason,
        });
      }
    } catch (e) {
      console.error("[NOTIFY] Error notifying client rejection:", e);
    }
  });

  const nextId = await resolveNextId(id, bucket, fallbackNext);
  if (nextId) {
    const suffix = queueToSearchParams({ bucket }).toString();
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

function extractFields(fd: FormData): FieldData {
  return {
    issuerName:    fd.get("issuerName")    as string ?? "",
    issuerCif:     fd.get("issuerCif")     as string ?? "",
    receiverName:  fd.get("receiverName")  as string ?? "",
    receiverCif:   fd.get("receiverCif")   as string ?? "",
    invoiceNumber: fd.get("invoiceNumber") as string ?? "",
    invoiceDate:   fd.get("invoiceDate")   as string ?? "",
    vatLines:      fd.get("vatLines")      as string ?? "",
    irpfRate:      fd.get("irpfRate")      as string ?? "",
    irpfAmount:    fd.get("irpfAmount")    as string ?? "",
    totalAmount:   fd.get("totalAmount")   as string ?? "",
    accountingPeriodMonth: fd.get("accountingPeriodMonth") as string ?? "",
    accountingPeriodYear:  fd.get("accountingPeriodYear")  as string ?? "",
    supplierAccount: fd.get("supplierAccount") as string ?? "",
    expenseAccount:  fd.get("expenseAccount")  as string ?? "",
  };
}
