export type InvoiceBalanceInput = {
  sumBase: number;
  sumAmount: number;
  sumSurcharge?: number;
  irpf?: number;
  total: number;
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
 *  Total declarado de una factura. Redondea a centimos antes de restar
 *  para evitar ruido de coma flotante. */
export function invoiceBalanceDiffCents(params: InvoiceBalanceInput): number {
  const { sumBase, sumAmount, sumSurcharge = 0, irpf = 0, total } = params;
  const expected = sumBase + sumAmount + sumSurcharge - irpf;
  return Math.round(expected * 100) - Math.round(total * 100);
}

/** ¿Cuadra con la tolerancia comun? La usan la revision (servidor y
 *  pantalla), el OCR, issueDetector y el export. */
export function isInvoiceBalanced(params: InvoiceBalanceInput): boolean {
  return Math.abs(invoiceBalanceDiffCents(params)) <= BALANCE_TOLERANCE_CENTS;
}
