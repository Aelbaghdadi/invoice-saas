/** Diferencia en centimos entre lo calculado (Base+IVA+Recargo-IRPF) y el
 *  Total declarado de una factura. Redondea a centimos antes de restar
 *  para evitar ruido de coma flotante; 0 significa que cuadra
 *  exactamente. La usan tanto el semaforo de ReviewForm como el aviso de
 *  descuadre del export A3 — cualquier cambio de tolerancia debe hacerse
 *  aqui para que ambos sitios se muevan juntos. */
export function invoiceBalanceDiffCents(params: {
  sumBase: number;
  sumAmount: number;
  sumSurcharge?: number;
  irpf?: number;
  total: number;
}): number {
  const { sumBase, sumAmount, sumSurcharge = 0, irpf = 0, total } = params;
  const expected = sumBase + sumAmount + sumSurcharge - irpf;
  return Math.round(expected * 100) - Math.round(total * 100);
}
