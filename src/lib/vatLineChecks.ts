/**
 * ¿Es cada cuota su base × %? (F-022). El cuadre solo mira el total: con 100
 * al 21 % y cuota 20, y 200 al 10 % y cuota 21, el total cuadra (341) pero el
 * desglose por tipo va mal al libro registro, al 303 y al 390.
 *
 * Desde noviembre de 2026 bloquea la validacion (regla «desglose» de
 * invoiceRules), a peticion del asesor: con los tipos cruzados entre dos
 * lineas el total cuadraba y la factura se validaba. La tolerancia es para
 * las facturas que redondean por linea de producto y no por tipo. Cubre el
 * redondeo habitual, pero no todo: 20 unidades de 1,15 € al 21 % con el IVA
 * redondeado unidad a unidad dan 4,80 € de cuota, y la base × 21 % da 4,83 €.
 * Esa factura no se valida con sus importes. En el OCR y en el export sigue
 * siendo un aviso. Sin dependencias: lo usan invoiceRules, mathIssues, el
 * export y el formulario de revision.
 */
import { formatEur } from "@/lib/format";
import { percentCents, toCents } from "@/lib/money";
import { isSelfAssessedVat, lacksSelfAssessedVat } from "@/lib/selfAssessedVat";

export type CheckedLine = {
  taxBase: number;
  vatRate: number;
  vatAmount: number;
  equivalenceSurchargeRate?: number | null;
  equivalenceSurchargeAmount?: number | null;
};

export type VatLineMismatch = {
  /** Posicion en la lista, empezando por 0. */
  index: number;
  kind: "iva" | "recargo";
  rate: number;
  expected: number;
  actual: number;
};

/** Inversion del sujeto pasivo e intracomunitarias: la factura va sin cuota
 *  (la autoliquida el destinatario), asi que la cuota no es base × %. Salvo
 *  la autorrepercutida que se guarda en las adquisiciones intracomunitarias
 *  (selfAssessedVat): esa si es base × %, y va asi a A3. */
const OPERATIONS_WITHOUT_OWN_VAT = new Set(["INVERSION_SP", "INTRACOM", "INTRACOM_SERVICIOS"]);

/** Tolerancia: max(2 centimos; 0,5 % de la cuota esperada). */
function mismatch(base: number, rate: number, actual: number): { expected: number } | null {
  const expectedCents = percentCents(base, rate);
  const actualCents = toCents(actual);
  const toleranceCents = Math.max(2, Math.abs(expectedCents) * 0.005);
  if (Math.abs(expectedCents - actualCents) <= toleranceCents + 1e-9) return null;
  return { expected: expectedCents / 100 };
}

/** `direction` solo cuando las lineas llevan ya la cuota autorrepercutida
 *  (revision y export). Lo leido del documento (OCR) no la lleva: sin el, una
 *  intracomunitaria no se comprueba. Con el, una linea con base y sin cuota
 *  tampoco: el export le pone el 21 % y su cuota (a3Vat), y a A3 le llega
 *  igual que con el 0 %. Las validadas antes de la autorrepercutida (21 % y
 *  cuota 0) no se quedan sin poder corregirse por eso. */
export function vatLineMismatches(
  lines: CheckedLine[],
  operationType?: string | null,
  direction?: "PURCHASE" | "SALE" | null,
): VatLineMismatch[] {
  const selfAssessed = isSelfAssessedVat(direction, operationType);
  if (operationType && OPERATIONS_WITHOUT_OWN_VAT.has(operationType) && !selfAssessed) {
    return [];
  }
  const found: VatLineMismatch[] = [];
  lines.forEach((line, index) => {
    const iva = selfAssessed && lacksSelfAssessedVat(line) ? null : mismatch(line.taxBase, line.vatRate, line.vatAmount);
    if (iva) found.push({ index, kind: "iva", rate: line.vatRate, expected: iva.expected, actual: line.vatAmount });
    const rate = line.equivalenceSurchargeRate;
    const amount = line.equivalenceSurchargeAmount;
    if (rate != null && amount != null) {
      const re = mismatch(line.taxBase, rate, amount);
      if (re) found.push({ index, kind: "recargo", rate, expected: re.expected, actual: amount });
    }
  });
  return found;
}

/** «7,5», no «7.5». */
const rateText = (rate: number) => String(rate).replace(".", ",");

/** «Línea 2: la cuota de IVA es 20,00 € y la base × 21 % da 21,00 €». */
export function describeVatLineMismatch(m: VatLineMismatch): string {
  const what = m.kind === "iva" ? "la cuota de IVA" : "el recargo de equivalencia";
  return `Línea ${m.index + 1}: ${what} es ${formatEur(m.actual)} y la base × ${rateText(m.rate)} % da ${formatEur(m.expected)}`;
}

/** Tipos de IVA y de recargo que se prueban para arreglar una linea en un
 *  clic (vatLineFix). El 0 explica una cuota 0: la plantilla del OCR trae el
 *  21 % por defecto, y una linea exenta o al 0 % llega como 21 % con cuota 0.
 *  Sin el, se proponia recalcular la cuota (un IVA que la factura no lleva)
 *  o, con una base de hasta 1,24 €, el 2 % (su cuota cabe en la tolerancia). */
const VAT_RATES = [21, 10, 7.5, 5, 4, 2, 0];
const SURCHARGE_RATES = [5.2, 1.75, 1.4, 1, 0.62, 0.5, 0.26, 0];

export type VatLineFix = {
  /** El unico campo de la linea que cambia. */
  field: "vatRate" | "vatAmount" | "equivalenceSurchargeRate" | "equivalenceSurchargeAmount";
  /** Como lo escribe el formulario: «21», «131.22». */
  value: string;
  /** «Cambiar el tipo a 21 %», «Recalcular la cuota (131,22 €)». */
  label: string;
};

/**
 * Arreglo en un clic de una linea que no cuadra. Si otro tipo explica la base
 * y la cuota que ya tiene la linea, con la misma tolerancia, se cambia solo el
 * %: con los tipos cruzados entre lineas la cuota es la del documento. Si
 * explican varios, el mas cercano. Si no explica ninguno, la cuota pasa a ser
 * la base × %.
 *
 * Una cuota 0 la explica el 0 %, salvo con el total descuadrado
 * (`totalBalances` a false): entonces lo probable es que no se haya leido la
 * cuota, y recalcularla es lo que hace cuadrar la factura.
 */
export function vatLineFix(taxBase: number, m: VatLineMismatch, totalBalances = true): VatLineFix {
  const iva = m.kind === "iva";
  const amountMissing = !totalBalances && toCents(m.actual) === 0;
  const candidates: number[] = amountMissing ? [] : iva ? VAT_RATES : SURCHARGE_RATES;
  const distance = (rate: number) => Math.abs(percentCents(taxBase, rate) - toCents(m.actual));
  const [rate] = candidates
    .filter((r) => mismatch(taxBase, r, m.actual) === null)
    .sort((a, b) => distance(a) - distance(b));
  if (rate !== undefined) {
    return {
      field: iva ? "vatRate" : "equivalenceSurchargeRate",
      value: String(rate),
      label: `Cambiar ${iva ? "el tipo" : "el recargo"} a ${rateText(rate)} %`,
    };
  }
  return {
    field: iva ? "vatAmount" : "equivalenceSurchargeAmount",
    value: m.expected.toFixed(2),
    label: `Recalcular ${iva ? "la cuota" : "el recargo"} (${formatEur(m.expected)})`,
  };
}
