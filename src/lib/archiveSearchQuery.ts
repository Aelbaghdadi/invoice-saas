/**
 * Qué se ha tecleado en el buscador del archivo («¿Dónde está?»). Un nº de
 * registro se busca como tal, pero el texto se busca siempre además:
 * «2026/153» también es un nº de factura de proveedor habitual, y
 * «R-2026/153» existe en cada cliente. El taco y la caja llegarán con la
 * entrega del papel.
 */
import { parseRegisterQuery, type RegisterQuery } from "@/lib/registerNumbers";

export type ArchiveQuery =
  | { kind: "registro"; text: string; register: RegisterQuery; amount: number | null }
  | { kind: "texto"; text: string; amount: number | null };

// «1.134,60» y «1.134» (miles con punto), o con decimales sin agrupar:
// «1134,6» o «1134.60».
const GROUPED_AMOUNT_RE = /^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/;
const DECIMAL_AMOUNT_RE = /^-?\d+[.,]\d{1,2}$/;

/**
 * El importe que parece la consulta, o null. Hace falta aparte del texto: el
 * listado busca el importe con el formato de la tabla, y es-ES no agrupa los
 * miles por debajo de 10.000 («1134,60»), así que «1.134,60», tal como sale
 * impreso en la factura, no casaba. Un número sin decimales ni miles no se
 * toma por importe: puede ser un nº de factura o un año.
 */
function searchAmount(text: string): number | null {
  const compact = text.replace(/€/g, "").replace(/\s+/g, "");
  let normalized: string | null = null;
  if (GROUPED_AMOUNT_RE.test(compact)) normalized = compact.replace(/\./g, "").replace(",", ".");
  else if (DECIMAL_AMOUNT_RE.test(compact)) normalized = compact.replace(",", ".");
  if (normalized == null) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** text va sin espacios de sobra, y vacío si no se ha tecleado nada. */
export function parseArchiveQuery(raw: string | null | undefined): ArchiveQuery {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const amount = searchAmount(text);
  const register = parseRegisterQuery(text);
  return register ? { kind: "registro", text, register, amount } : { kind: "texto", text, amount };
}
