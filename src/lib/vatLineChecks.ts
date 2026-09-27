/**
 * ¿Es cada cuota su base × %? (F-022). El cuadre solo mira el total: con 100
 * al 21 % y cuota 20, y 200 al 10 % y cuota 21, el total cuadra (341) pero el
 * desglose por tipo va mal al libro registro, al 303 y al 390.
 *
 * Es un aviso, no un bloqueo: una factura real puede redondear por linea de
 * producto y no por tipo. Sin dependencias: lo usan issueDetector, el export
 * y el formulario de revision.
 */
import { formatEur } from "@/lib/format";

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
 *  (la autoliquida el destinatario), asi que la cuota no es base × %. */
const OPERATIONS_WITHOUT_OWN_VAT = new Set(["INVERSION_SP", "INTRACOM", "INTRACOM_SERVICIOS"]);

/** Tolerancia: max(2 centimos; 0,5 % de la cuota esperada). */
function mismatch(base: number, rate: number, actual: number): { expected: number } | null {
  const expectedCents = Math.round(base * rate); // base × % / 100, en centimos
  const actualCents = Math.round(actual * 100);
  const toleranceCents = Math.max(2, Math.abs(expectedCents) * 0.005);
  if (Math.abs(expectedCents - actualCents) <= toleranceCents + 1e-9) return null;
  return { expected: expectedCents / 100 };
}

export function vatLineMismatches(lines: CheckedLine[], operationType?: string | null): VatLineMismatch[] {
  if (operationType && OPERATIONS_WITHOUT_OWN_VAT.has(operationType)) return [];
  const found: VatLineMismatch[] = [];
  lines.forEach((line, index) => {
    const iva = mismatch(line.taxBase, line.vatRate, line.vatAmount);
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

/** «Línea 2: la cuota de IVA es 20,00 € y la base × 21 % da 21,00 €». */
export function describeVatLineMismatch(m: VatLineMismatch): string {
  const what = m.kind === "iva" ? "la cuota de IVA" : "el recargo de equivalencia";
  const rate = String(m.rate).replace(".", ",");
  return `Línea ${m.index + 1}: ${what} es ${formatEur(m.actual)} y la base × ${rate} % da ${formatEur(m.expected)}`;
}
