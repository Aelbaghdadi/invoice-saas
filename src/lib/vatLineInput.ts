/**
 * Lineas de IVA tal como llegan del formulario de revision (texto), y el
 * criterio de cuando una linea esta completa. Lo usan el servidor al guardar y
 * el semaforo de la pantalla, para que los dos digan lo mismo (F-014).
 *
 * Antes el servidor descartaba en silencio una linea a medio rellenar
 * ([50 / "" / 5]) y el semaforo sumaba lo que pudiera leer de ella: la
 * pantalla salia en verde y se guardaba una factura con una linea de menos.
 */
import { hasMoreThanTwoDecimals } from "@/lib/money";

export type VatLineText = {
  taxBase?: unknown;
  vatRate?: unknown;
  vatAmount?: unknown;
  equivalenceSurchargeRate?: unknown;
  equivalenceSurchargeAmount?: unknown;
};

export type ParsedVatLineInput = {
  taxBase: number;
  vatRate: number;
  vatAmount: number;
  /** null = la linea no lleva recargo (no es lo mismo que 0). */
  equivalenceSurchargeRate: number | null;
  equivalenceSurchargeAmount: number | null;
};

const REQUIRED_FIELDS = [
  ["taxBase", "la base"],
  ["vatRate", "el % de IVA"],
  ["vatAmount", "la cuota"],
] as const;

/** Texto del campo. Un numero (JSON enviado a mano) cuenta como su texto:
 *  antes contaba como vacio y la linea se descartaba en silencio. Lo que no
 *  es ni texto ni un numero finito va como "?" para que salga como «no es
 *  un número» en vez de desaparecer. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "?";
  if (value == null) return "";
  return "?";
}

/** "12,5", "12.5" y "1e3" valen; "", "abc" o "12,5,3" no. */
function parseDecimal(value: string): number | null {
  if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(value)) return null;
  return Number(value.replace(",", "."));
}

function joinSpanish(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}` : items[0];
}

/**
 * Que le pasa a una linea, o null si esta completa o vacia del todo (la fila
 * en blanco del formulario, que no se guarda). `position` es el numero de fila
 * en pantalla, empezando por 1.
 */
export function vatLineProblem(line: VatLineText, position: number): string | null {
  const values = REQUIRED_FIELDS.map(([key, label]) => ({ label, value: text(line[key]) }));
  const surcharge = text(line.equivalenceSurchargeRate) || text(line.equivalenceSurchargeAmount);
  if (values.every((v) => v.value === "") && !surcharge) return null;
  const missing = values.filter((v) => v.value === "").map((v) => v.label);
  if (missing.length > 0) {
    return `La línea ${position} de IVA está incompleta: falta ${joinSpanish(missing)}. Rellénala (0 si es exenta) o bórrala.`;
  }
  const notNumbers = values.filter((v) => parseDecimal(v.value) === null).map((v) => v.label);
  if (notNumbers.length > 0) {
    return `La línea ${position} de IVA tiene un valor que no es un número en ${joinSpanish(notNumbers)}.`;
  }
  // El recargo es opcional, pero si trae algo tiene que ser un numero: antes
  // un valor raro se descartaba sin avisar.
  const badSurcharge = [
    { label: "el % de recargo", value: text(line.equivalenceSurchargeRate) },
    { label: "la cuota de recargo", value: text(line.equivalenceSurchargeAmount) },
  ].filter((v) => v.value !== "" && parseDecimal(v.value) === null).map((v) => v.label);
  if (badSurcharge.length > 0) {
    return `La línea ${position} de IVA tiene un valor que no es un número en ${joinSpanish(badSurcharge)}.`;
  }
  // La BD guarda 2 decimales: 1,005 se guardaria como 1,01 y el cuadre que
  // se calculo con 1,005 dejaria de valer.
  const surchargeValues = [
    { label: "el % de recargo", value: text(line.equivalenceSurchargeRate) },
    { label: "la cuota de recargo", value: text(line.equivalenceSurchargeAmount) },
  ].filter((v) => v.value !== "" && parseDecimal(v.value) !== null);
  const tooPrecise = [...values, ...surchargeValues]
    .filter((v) => hasMoreThanTwoDecimals(parseDecimal(v.value)!))
    .map((v) => v.label);
  if (tooPrecise.length > 0) {
    return `La línea ${position} de IVA tiene más de 2 decimales en ${joinSpanish(tooPrecise)}. Redondéalo a céntimos.`;
  }
  // % de recargo sin cuota: la pantalla la daba por cuadrada (cuenta la cuota
  // como 0) y el servidor la completaba con completeReadSurcharges, con una
  // cuota que el gestor no habia visto (revision 1 del PR #7).
  if (text(line.equivalenceSurchargeRate) && !text(line.equivalenceSurchargeAmount)) {
    return `La línea ${position} de IVA está incompleta: tiene % de recargo de equivalencia pero falta su cuota.`;
  }
  return null;
}

/** El primer problema de la lista, o null si todas estan completas o vacias. */
export function vatLinesProblem(lines: VatLineText[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const problem = vatLineProblem(lines[i], i + 1);
    if (problem) return problem;
  }
  return null;
}

/**
 * Parsea el JSON de lineas del formulario. Las filas vacias se ignoran; una
 * a medio rellenar o con algo que no es un numero es un error, nunca se
 * descarta. El recargo es opcional por linea.
 */
export function parseVatLineInputs(raw: string): { lines: ParsedVatLineInput[] } | { error: string } {
  if (!raw.trim()) return { lines: [] };
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    return { error: "Las líneas de IVA no se han podido leer. Recarga la página y vuelve a intentarlo." };
  }
  if (!Array.isArray(items)) {
    return { error: "Las líneas de IVA no se han podido leer. Recarga la página y vuelve a intentarlo." };
  }
  const lines: ParsedVatLineInput[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const line: VatLineText = item && typeof item === "object" ? (item as VatLineText) : {};
    const problem = vatLineProblem(line, i + 1);
    if (problem) return { error: problem };
    const taxBase = text(line.taxBase);
    if (!taxBase) continue; // fila vacia
    const surchargeRate = parseDecimal(text(line.equivalenceSurchargeRate));
    const surchargeAmount = parseDecimal(text(line.equivalenceSurchargeAmount));
    lines.push({
      taxBase: parseDecimal(taxBase)!,
      vatRate: parseDecimal(text(line.vatRate))!,
      vatAmount: parseDecimal(text(line.vatAmount))!,
      equivalenceSurchargeRate: surchargeRate,
      equivalenceSurchargeAmount: surchargeAmount,
    });
  }
  return { lines };
}
