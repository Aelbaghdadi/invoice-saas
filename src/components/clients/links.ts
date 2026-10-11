import { reviewHref } from "@/lib/reviewNavigation";

export type ClientSheetRole = "ADMIN" | "WORKER";

/** A donde lleva una factura desde la ficha: el detalle del administrador o
 *  la revision del gestor, que vuelve a la ficha al terminar. */
export function invoiceHref(role: ClientSheetRole, invoiceId: string, back: string): string {
  return role === "ADMIN" ? `/dashboard/admin/invoices/${invoiceId}` : reviewHref(invoiceId, { back });
}
