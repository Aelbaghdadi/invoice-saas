"use server";

import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { notifyClientInvoiceValidated, notifyClientInvoiceRejected } from "@/lib/email";

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
  taxBase:       string;
  vatRate:       string;
  vatAmount:     string;
  irpfRate:      string;
  irpfAmount:    string;
  totalAmount:   string;
  accountingPeriodMonth: string;
  accountingPeriodYear:  string;
  supplierAccount: string;
  expenseAccount:  string;
};

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

  const newData = {
    issuerName:    data.issuerName    || null,
    issuerCif:     data.issuerCif     || null,
    receiverName:  data.receiverName  || null,
    receiverCif:   data.receiverCif   || null,
    invoiceNumber: data.invoiceNumber || null,
    invoiceDate:   parseDate(data.invoiceDate),
    taxBase:       parse(data.taxBase),
    vatRate:       parse(data.vatRate),
    vatAmount:     parse(data.vatAmount),
    irpfRate:      parse(data.irpfRate),
    irpfAmount:    parse(data.irpfAmount),
    totalAmount:   parse(data.totalAmount),
    accountingPeriodMonth: parseInt2(data.accountingPeriodMonth),
    accountingPeriodYear:  parseInt2(data.accountingPeriodYear),
    supplierAccount: data.supplierAccount || null,
    expenseAccount:  data.expenseAccount  || null,
  };

  // Server-side bounds validation
  if (newData.vatRate !== null && (newData.vatRate < 0 || newData.vatRate > 100)) {
    return { error: "El % IVA debe estar entre 0 y 100" };
  }
  if (newData.taxBase !== null && newData.taxBase < 0) {
    return { error: "La base imponible no puede ser negativa" };
  }
  if (newData.vatAmount !== null && newData.vatAmount < 0) {
    return { error: "La cuota IVA no puede ser negativa" };
  }
  if (newData.totalAmount !== null && newData.totalAmount < 0) {
    return { error: "El total no puede ser negativo" };
  }

  // Math validation: Base + IVA = Total
  let isValid: boolean | null = null;
  if (newData.taxBase !== null && newData.vatAmount !== null && newData.totalAmount !== null) {
    const diff = Math.abs(
      Math.round((newData.taxBase + newData.vatAmount) * 100) -
      Math.round(newData.totalAmount * 100)
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
  const draftStatuses = ["ANALYZED", "NEEDS_ATTENTION", "PENDING_REVIEW"];
  const saveStatus = !validate && draftStatuses.includes(invoice.status)
    ? "PENDING_REVIEW"
    : undefined;

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      ...newData,
      isValid,
      ...(validate ? { status: "VALIDATED" } : saveStatus ? { status: saveStatus } : {}),
    },
  });

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
  const nextId = formData.get("nextId") as string | null;
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

  if (nextId) {
    redirect(`/dashboard/worker/review/${nextId}`);
  }
  redirect("/dashboard/worker/invoices");
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
  const nextId = formData.get("nextId") as string | null;

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

  if (nextId) {
    redirect(`/dashboard/worker/review/${nextId}`);
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
    taxBase:       fd.get("taxBase")       as string ?? "",
    vatRate:       fd.get("vatRate")       as string ?? "",
    vatAmount:     fd.get("vatAmount")     as string ?? "",
    irpfRate:      fd.get("irpfRate")      as string ?? "",
    irpfAmount:    fd.get("irpfAmount")    as string ?? "",
    totalAmount:   fd.get("totalAmount")   as string ?? "",
    accountingPeriodMonth: fd.get("accountingPeriodMonth") as string ?? "",
    accountingPeriodYear:  fd.get("accountingPeriodYear")  as string ?? "",
    supplierAccount: fd.get("supplierAccount") as string ?? "",
    expenseAccount:  fd.get("expenseAccount")  as string ?? "",
  };
}
