import { toCents } from "@/lib/money";

export type InvoiceBalanceInput = {
  sumBase: number;
  sumAmount: number;
  sumSurcharge?: number;
  irpf?: number;
  total: number;
  /** Cuota autorrepercutida (adquisicion intracomunitaria, ver
   *  selfAssessedVat): la paga el comprador a Hacienda, no al proveedor, y
   *  no suma al total. */
  selfAssessedVat?: boolean;
};

/**
 * Diferencia maxima, en centimos, entre Base+IVA+Recargo-IRPF y el Total para
 * que una factura cuadre (F-058). Antes habia dos: 0 en la revision y el
 * export, 2 en el servidor y el OCR, asi que el OCR daba por buena una factura
 * que la revision no dejaba validar y el servidor validaba lo que la pantalla
 * rechazaba. Es 0 porque es lo que ya exigia la pantalla en la que el gestor
 * valida; si se cambia, cambia en todos los sitios a la vez.
 */
export const BALANCE_TOLERANCE_CENTS = 0;

/** Diferencia en centimos entre lo calculado (Base+IVA+Recargo-IRPF) y el
 *  Total declarado de una factura. Redondea a centimos antes de restar, igual
 *  en positivo que en negativo (toCents): con Math.round una rectificativa
 *  salia descuadrada con los dos importes iguales en pantalla. */
export function invoiceBalanceDiffCents(params: InvoiceBalanceInput): number {
  return toCents(invoiceBalanceExpected(params)) - toCents(params.total);
}

/** Lo que tendria que dar el total: Base + IVA + Recargo - IRPF, sin el IVA
 *  si es autorrepercutido. */
export function invoiceBalanceExpected(params: InvoiceBalanceInput): number {
  const { sumBase, sumAmount, sumSurcharge = 0, irpf = 0, selfAssessedVat = false } = params;
  return sumBase + (selfAssessedVat ? 0 : sumAmount) + sumSurcharge - irpf;
}

/** ¿Cuadra con la tolerancia comun? La usan la revision (servidor y
 *  pantalla), el OCR, issueDetector y el export. */
export function isInvoiceBalanced(params: InvoiceBalanceInput): boolean {
  return Math.abs(invoiceBalanceDiffCents(params)) <= BALANCE_TOLERANCE_CENTS;
}
