"use server";

import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { notifyClientInvoiceValidated } from "@/lib/email";

export type ReviewState = { error?: string } | null;

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
};

async function parseAndSave(invoiceId: string, userId: string, data: FieldData, validate: boolean, expectedUpdatedAt?: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "Factura no encontrada" };

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
  };

  // Math validation
  let isValid: boolean | null = null;
  if (newData.taxBase !== null && newData.vatAmount !== null && newData.totalAmount !== null) {
    const irpf = newData.irpfAmount ?? 0;
    const diff = Math.abs(
      Math.round((newData.taxBase + newData.vatAmount - irpf) * 100) -
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

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      ...newData,
      isValid,
      ...(validate ? { status: "VALIDATED" } : {}),
    },
  });

  if (validate) {
    auditEntries.push({ field: "status", oldValue: invoice.status, newValue: "VALIDATED" });
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
  };
}
