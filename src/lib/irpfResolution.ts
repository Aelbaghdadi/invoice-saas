/**
 * IRPF que se guarda al analizar (F-073). Antes, con un tipo de retencion
 * puesto (aprendido del tercero o detectado), se guardaba siempre base × %
 * y se machacaba el importe leido: con un 15 % aprendido y una factura que
 * imprime un 7 %, quedaba un IRPF que no era el de la factura.
 *
 * La pantalla calcula la cuota como base × %, asi que lo guardado tiene que
 * ser un par (%, importe) que ella reproduzca. En este orden:
 * 1. Con importe leido y la factura cuadrando con el: el primer % que da
 *    ese importe entre el leido, el aprendido y el deducido de base e
 *    importe. El deducido solo sin % leido o si difiere de el por redondeo:
 *    si no, un 12,5 % que no existe sustituiria al 15 % impreso (con una
 *    linea al 0 %, 150 / 1200) y la factura pasaria en verde.
 * 2. Si no: el primero entre el leido y el aprendido con el que, calculando
 *    el importe, la factura cuadra.
 * 3. Si ninguno: el aprendido, como antes; la factura queda descuadrada y
 *    el gestor lo ve.
 */
import { percentOf } from "@/lib/money";

export type IrpfInput = {
  /** Tipo de retencion puesto (aprendido o detectado); sin el, lo leido. */
  hasRetention: boolean;
  /** % aprendido o propuesto. */
  retentionRate: number | null;
  readRate: number | null;
  readAmount: number | null;
  /** Suma de las bases: la base de la retencion. */
  sumBases: number;
  /** ¿Cuadra la factura con este IRPF? */
  balancedWith: (irpf: number) => boolean;
};

export function resolveIrpf(input: IrpfInput): { rate: number | null; amount: number | null } {
  const { hasRetention, retentionRate, readRate, readAmount, sumBases, balancedWith } = input;
  if (!hasRetention) return { rate: retentionRate ?? readRate, amount: readAmount };

  // El importe leido llega siempre en positivo (auto:signo); en una
  // rectificativa con bases negativas lleva el signo de la base.
  const signed = readAmount == null ? null : (sumBases < 0 ? -1 : 1) * Math.abs(readAmount);
  if (signed != null && signed !== 0 && sumBases !== 0 && balancedWith(signed)) {
    const deduced = Math.round((Math.abs(signed) / Math.abs(sumBases)) * 10_000) / 100;
    const deducedOk = readRate == null || Math.abs(deduced - readRate) <= 0.01;
    for (const rate of [readRate, retentionRate, deducedOk ? deduced : null]) {
      if (rate != null && percentOf(sumBases, rate) === signed) return { rate, amount: signed };
    }
  }
  for (const rate of [readRate, retentionRate]) {
    if (rate != null && balancedWith(percentOf(sumBases, rate))) return { rate, amount: percentOf(sumBases, rate) };
  }
  if (retentionRate != null) return { rate: retentionRate, amount: percentOf(sumBases, retentionRate) };
  return { rate: readRate, amount: readAmount };
}
