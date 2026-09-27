/**
 * Lineas de IVA tal como llegan del formulario de revision (texto), y el
 * criterio de cuando una linea esta completa. Lo usan el servidor al guardar y
 * el semaforo de la pantalla, para que los dos digan lo mismo (F-014).
 *
 * Antes el servidor descartaba en silencio una linea a medio rellenar
 * ([50 / "" / 5]) y el semaforo sumaba lo que pudiera leer de ella: la
 * pantalla salia en verde y se guardaba una factura con una linea de menos.
 */

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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
