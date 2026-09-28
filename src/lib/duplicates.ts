/**
 * Deteccion de posibles duplicados (F-010). Compara lo guardado con lo
 * guardado: el CIF limpio (parseTaxId(...).clean, sin prefijo de pais ni
 * separadores) y el numero de factura normalizado. Antes se comparaba el CIF
 * crudo del OCR («ESB12345678», «B-12345678») con el limpio de la BD y el
 * numero literal, y no casaban.
 */
import type { InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** «F-001», «F 001», «f001» y «F/001» son el mismo numero: mayusculas, sin
 *  espacios ni separadores. */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * La primera factura del cliente (no rechazada, distinta de excludeId) con
 * el mismo numero normalizado y, si se da, el mismo CIF de emisor limpio.
 * El numero se normaliza igual en Postgres que en normalizeInvoiceNumber.
 */
export async function findByInvoiceNumber(input: {
  clientId: string;
  type: InvoiceType;
  excludeId: string;
  invoiceNumber: string;
  issuerCif: string | null;
}): Promise<string | null> {
  const normalized = normalizeInvoiceNumber(input.invoiceNumber);
  if (!normalized) return null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Invoice"
    WHERE "clientId" = ${input.clientId}
      AND type = ${input.type}::"InvoiceType"
      AND id <> ${input.excludeId}
      AND status <> 'REJECTED'
      AND (${input.issuerCif}::text IS NULL OR "issuerCif" = ${input.issuerCif})
      AND regexp_replace(upper("invoiceNumber"), '[^A-Z0-9]', '', 'g') = ${normalized}
    ORDER BY "createdAt"
    LIMIT 1`;
  return rows[0]?.id ?? null;
}
