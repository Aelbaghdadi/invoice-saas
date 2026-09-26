import { prisma } from "@/lib/prisma";

/**
 * A nombre de quien relanza el cron el OCR de una factura. AuditLog.userId
 * tiene FK a User: con el actor "system" la auditoria del final del OCR
 * fallaba y, como va en la misma transaccion, se perdia todo el resultado.
 *
 * Quien subio el documento si sigue existiendo; si no, un ADMIN de la
 * asesoria del cliente (el mas antiguo, para que sea estable). null si no hay
 * ninguno: esa factura no se relanza.
 */
export function pickCronOcrActor(uploaderId: string | null, firmAdminId: string | null): string | null {
  return uploaderId ?? firmAdminId;
}

export async function resolveCronOcrActor(invoiceId: string): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { document: { select: { uploadedBy: true } }, client: { select: { advisoryFirmId: true } } },
  });
  if (!invoice) return null;
  const uploadedBy = invoice.document?.uploadedBy ?? null;
  const uploader = uploadedBy
    ? await prisma.user.findUnique({ where: { id: uploadedBy }, select: { id: true } })
    : null;
  if (uploader) return uploader.id;
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", advisoryFirmId: invoice.client.advisoryFirmId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return pickCronOcrActor(null, admin?.id ?? null);
}
