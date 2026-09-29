import { validateInvoice, rejectInvoice } from "@/app/dashboard/worker/review/[id]/actions";

/** Lo que manda la pantalla de revision al validar o guardar. */
export function reviewForm(
  invoiceId: string,
  updatedAt: Date,
  client: { name: string; cif: string },
  extra: Record<string, string> = {},
) {
  const fd = new FormData();
  const fields: Record<string, string> = {
    invoiceId, updatedAt: updatedAt.toISOString(), type: "PURCHASE",
    issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: client.name, receiverCif: client.cif,
    invoiceNumber: "F-1", invoiceDate: "2026-09-10", totalAmount: "121",
    vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21" }]),
    supplierAccount: "40000001", expenseAccount: "60000001", operationType: "INTERIOR",
    accountingPeriodMonth: "9", accountingPeriodYear: "2026",
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** { error } de la accion, o null si redirige (exito). */
export function settleAction(p: Promise<{ error?: unknown } | null | void>) {
  return p.then(
    (r) => ({ error: r?.error ?? null }),
    (e) => (e?.message === "NEXT_REDIRECT" ? { error: null } : Promise.reject(e)),
  );
}

export const validate = (fd: FormData) => settleAction(validateInvoice(null, fd));

export function reject(invoiceId: string, reason = "Ilegible") {
  const fd = new FormData();
  fd.set("invoiceId", invoiceId);
  fd.set("rejectionReason", reason);
  return settleAction(rejectInvoice(null, fd));
}
