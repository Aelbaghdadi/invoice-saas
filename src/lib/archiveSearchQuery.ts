/**
 * Qué se ha tecleado en el buscador del archivo («¿Dónde está?»). Un nº de
 * registro, un taco o una caja se buscan como tales, pero el texto se busca
 * siempre además: «2026/153» también es un nº de factura de proveedor
 * habitual, «R-2026/153» existe en cada cliente y «T37» puede ser el nº de
 * una factura.
 */
import { NUMBER_SIGN_PATTERN } from "@/lib/boxProposal";
import { normalizeSearch } from "@/lib/listing";
import { parseRegisterQuery, type RegisterQuery } from "@/lib/registerNumbers";

/** «T37 pág 28»: el Taco 37 y, si se ha dicho, la página. */
export type TacoQuery = { number: number; page: number | null };
/** «caja 3». */
export type BoxQuery = { number: number };

type PaperQuery = { taco: TacoQuery | null; box: BoxQuery | null };

export type ArchiveQuery =
  | ({ kind: "registro"; text: string; register: RegisterQuery; amount: number | null } & PaperQuery)
  | ({ kind: "texto"; text: string; amount: number | null } & PaperQuery);

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

// Sobre el texto sin tildes y en minúsculas, con «nº», «n.º», «n°», «no.»,
// «núm.» o «número» opcionales. La página va con barra («T37/28») o con «p»,
// «pg», «pag» o «pagina» («T37 pág 28», «T37 p28»), y también como sale en la
// tabla («T37 · Pág. 27 del PDF»). «T37abc» o «T37 28» no son un taco.
const TACO_RE = new RegExp(
  String.raw`^(?:taco|t)\s*-?\s*${NUMBER_SIGN_PATTERN}(\d{1,6})(?:(?:\s*\/|\s*[,;·-]?\s*p(?:ag(?:ina)?|g)?\.?)\s*(\d{1,4})(?:\s+del\s+pdf)?)?$`,
);
const BOX_RE = new RegExp(String.raw`^caja\s*-?\s*${NUMBER_SIGN_PATTERN}(\d{1,6})$`);
// El trozo con el que empieza un taco: «T37», «Taco 37».
const TACO_START_RE = new RegExp(String.raw`^(?:taco|t)\s*-?\s*${NUMBER_SIGN_PATTERN}\d`);

/**
 * El taco de una ubicación copiada de la tabla o de la ficha: delante puede
 * ir la caja o la fecha de devolución («Caja 3 · T37 · Pág. 28», «Panadería
 * López · 2026 · Caja 3 · Taco 37 · Pág. 28») y detrás, la nota «(sin
 * guardar)» o «(taco anulado)». Se prueba desde cada trozo que empieza como un
 * taco, porque la etiqueta de la caja también puede empezar por «T».
 */
function tacoInLocation(normalized: string): RegExpExecArray | null {
  if (!normalized.includes("·") && !normalized.endsWith(")")) return null;
  const withoutNote = normalized.replace(/\s*\([^()]*\)$/, "");
  const parts = withoutNote.split("·").map((part) => part.trim());
  for (let start = 0; start < parts.length; start++) {
    if (!TACO_START_RE.test(parts[start])) continue;
    const taco = TACO_RE.exec(parts.slice(start).join(" · "));
    if (taco) return taco;
  }
  return null;
}

function paperQuery(text: string): PaperQuery {
  const normalized = normalizeSearch(text);
  const taco = TACO_RE.exec(normalized) ?? tacoInLocation(normalized);
  if (taco) {
    const number = Number(taco[1]);
    const page = taco[2] != null ? Number(taco[2]) : null;
    // No hay Taco 0 ni página 0.
    const valid = number > 0 && (page == null || page > 0);
    return { taco: valid ? { number, page } : null, box: null };
  }
  const box = BOX_RE.exec(normalized);
  const boxNumber = box ? Number(box[1]) : 0;
  return { taco: null, box: boxNumber > 0 ? { number: boxNumber } : null };
}

/** text va sin espacios de sobra, y vacío si no se ha tecleado nada. */
export function parseArchiveQuery(raw: string | null | undefined): ArchiveQuery {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const amount = searchAmount(text);
  const register = parseRegisterQuery(text);
  const paper = paperQuery(text);
  return register ? { kind: "registro", text, register, amount, ...paper } : { kind: "texto", text, amount, ...paper };
}
