import { sameThirdParty } from "@/lib/supplierMatching";

/**
 * Valores de la auditoria (F-024). Se comparan y se guardan normalizados:
 * con String() a secas una fecha salia como «Thu Sep 10 2026 02:00:00 GMT…»
 * y un importe podia ser «121» en un lado y «121.00» en el otro, y habria
 * cambios falsos solo por el formato.
 *
 *  - null, undefined y "" → null (sin valor).
 *  - Date → YYYY-MM-DD.
 *  - Numeros y Decimal de Prisma → el numero sin ceros sobrantes («121»,
 *    «15.5»), sin el ruido de coma flotante de las sumas.
 *  - Booleanos → "true" / "false" (la pantalla los muestra como Sí / No).
 *  - El resto, String().
 */
export function auditValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "number") return normalizeNumber(value);
  if (typeof value === "boolean") return String(value);
  // Prisma.Decimal (y cualquier objeto numerico con toFixed)
  if (typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
    return normalizeNumber(Number(String(value)));
  }
  return String(value);
}

function normalizeNumber(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** La retencion en una sola entrada: «15 % · 15.04». */
export function irpfAuditValue(rate: number | null | undefined, amount: number | null | undefined): string | null {
  if (rate == null && amount == null) return null;
  return `${auditValue(rate) ?? "—"} % · ${auditValue(amount) ?? "—"}`;
}

/** Una parte de la factura: «Cliente SL (B12345674)». */
export function partyAuditValue(name: string | null | undefined, cif: string | null | undefined): string | null {
  if (!name && !cif) return null;
  return `${name || "—"} (${cif || "—"})`;
}

/**
 * auto:parteCliente: el sistema pone el cliente en su lado de la factura.
 * Solo se audita si lo leido era otra parte: con el CIF del cliente es la
 * misma aunque el nombre venga escrito distinto («CLIENTE A, S.L.» frente a
 * «Cliente A SL»); sin CIF leido, si el nombre no es el del cliente
 * (sameThirdParty). Si no se leyo nada, rellenarlo no es un cambio.
 */
export function clientPartyAudit(
  read: { name: string | null | undefined; cif: string | null | undefined },
  client: { name: string; cif: string },
): { oldValue: string | null; newValue: string | null } | null {
  const readCif = read.cif?.trim() || null;
  const readName = read.name?.trim() || null;
  const other = readCif ? readCif !== client.cif : Boolean(readName) && !sameThirdParty(readName, client.name);
  return other ? { oldValue: partyAuditValue(readName, readCif), newValue: partyAuditValue(client.name, client.cif) } : null;
}
