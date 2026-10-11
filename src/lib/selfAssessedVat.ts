/**
 * IVA autorrepercutido en las adquisiciones intracomunitarias: compras con
 * codigo 3 (bienes) u 8 (servicios). La factura del proveedor viene al 0 %,
 * pero A3 necesita el % y la cuota para generar el soportado (472) y el
 * devengado (477), que se anulan. Con 0 % no sale ninguno de los dos.
 *
 * La cuota no se le paga al proveedor: no suma al total de la factura. Con
 * una base de 94,46 € la cuota es 19,84 € y el total sigue siendo 94,46 €.
 *
 * Lo pidio el asesor el 2026-10-09. Las ventas intracomunitarias (entregas)
 * no se tocan: van al 0 %. Sin dependencias de Next ni de Prisma: lo usan la
 * revision (pantalla y servidor), el OCR, el cuadre y el export.
 */
import { isIntracomOperation } from "@/lib/intracomGoods";
import { isInvoiceBalanced } from "@/lib/invoiceBalance";
import { percentCents, percentOf, toCents } from "@/lib/money";

/** % que se propone. Casi siempre es el general; si la factura va a otro
 *  tipo, lo cambia el gestor en la revision. */
export const SELF_ASSESSED_VAT_RATE = 21;

export function isSelfAssessedVat(
  direction: string | null | undefined,
  operationType: string | null | undefined,
): boolean {
  return direction === "PURCHASE" && isIntracomOperation("PURCHASE", operationType);
}

/**
 * Linea con base y sin cuota: la que hay que autorrepercutir. Se mira la
 * cuota y no el %: la plantilla del OCR trae «21» por defecto y una factura
 * al 0 % podia llegar como 21 % con cuota 0, que a A3 le da igual que un 0 %.
 */
export function lacksSelfAssessedVat(line: { taxBase: number; vatAmount: number }): boolean {
  return toCents(line.taxBase) !== 0 && toCents(line.vatAmount) === 0;
}

/** Linea de IVA tal como la tiene el formulario de revision (texto). */
type VatLineText = { taxBase: string; vatRate: string; vatAmount: string };

/** Vacio cuenta como 0: el % y la cuota de una linea recien leida pueden
 *  llegar sin rellenar. */
function textAmount(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : Number(trimmed.replace(",", "."));
}

function parsedLine(line: VatLineText): { taxBase: number; vatRate: number; vatAmount: number } | null {
  if (line.taxBase.trim() === "") return null;
  const parsed = { taxBase: textAmount(line.taxBase), vatRate: textAmount(line.vatRate), vatAmount: textAmount(line.vatAmount) };
  return Object.values(parsed).every(Number.isFinite) ? parsed : null;
}

/** ¿Va con el % por defecto y su cuota exacta? */
function hasDefaultRate(line: { taxBase: number; vatRate: number; vatAmount: number }): boolean {
  return toCents(line.vatRate) === toCents(SELF_ASSESSED_VAT_RATE)
    && toCents(line.vatAmount) === percentCents(line.taxBase, SELF_ASSESSED_VAT_RATE);
}

/**
 * Pone el % por defecto y su cuota en las lineas con base y sin cuota. Las
 * que ya traen cuota se dejan como estan: es lo que dice la factura o lo que
 * ha puesto el gestor. `applied` dice si ha cambiado alguna.
 */
export function applySelfAssessedRate<T extends VatLineText>(lines: T[]): { lines: T[]; applied: boolean } {
  let applied = false;
  const next = lines.map((line) => {
    const parsed = parsedLine(line);
    if (!parsed || !lacksSelfAssessedVat(parsed)) return line;
    applied = true;
    return {
      ...line,
      vatRate: String(SELF_ASSESSED_VAT_RATE),
      vatAmount: percentOf(parsed.taxBase, SELF_ASSESSED_VAT_RATE).toFixed(2),
    };
  });
  return { lines: applied ? next : lines, applied };
}

/**
 * ¿Sigue el desglose tal como lo propone applySelfAssessedRate? Todas las
 * lineas con base al % por defecto y con su cuota exacta. Asi un borrador
 * guardado sin tocar el IVA sigue contando como propuesto al volver a abrirlo.
 *
 * Salvo que la cuota vaya dentro del total: entonces la ha cobrado el
 * proveedor (Meta o Google Irlanda con IVA español a quien no esta en el
 * ROI) y no es la propuesta. Si contara como propuesta, el aviso diria que
 * la ha puesto el formulario y, al cambiar el tipo de operacion,
 * removeSelfAssessedRate dejaria a 0 un IVA que si esta en la factura.
 */
export function isUntouchedSelfAssessedProposal(
  lines: VatLineText[],
  totalAmount: number | null,
  irpfAmount: number | null = null,
): boolean {
  const withBase = lines.map(parsedLine).filter((l): l is NonNullable<typeof l> => l != null && toCents(l.taxBase) !== 0);
  if (withBase.length === 0 || !withBase.every(hasDefaultRate)) return false;
  if (totalAmount == null) return true;
  return !isInvoiceBalanced({
    sumBase: withBase.reduce((s, l) => s + l.taxBase, 0),
    sumAmount: withBase.reduce((s, l) => s + l.vatAmount, 0),
    irpf: irpfAmount ?? 0,
    total: totalAmount,
  });
}

/**
 * Lo contrario, al dejar de ser una adquisicion intracomunitaria (otro tipo
 * de operacion, o pasa a emitida): vuelve al 0 % de la factura en las lineas
 * que siguen con el % por defecto y su cuota exacta.
 */
export function removeSelfAssessedRate<T extends VatLineText>(lines: T[]): T[] {
  return lines.map((line) => {
    const parsed = parsedLine(line);
    if (!parsed || !hasDefaultRate(parsed)) return line;
    return { ...line, vatRate: "0", vatAmount: "0" };
  });
}
