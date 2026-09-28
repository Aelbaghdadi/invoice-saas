/**
 * IRPF que se guarda al analizar (F-073). Antes, con un tipo de retencion
 * puesto (aprendido del tercero o detectado), se guardaba siempre base × %
 * y se machacaba el importe leido: con un 15 % aprendido y una factura que
 * imprime un 7 %, quedaba un IRPF que no era el de la factura.
 *
 * La pantalla calcula la cuota como base × %, asi que lo guardado tiene que
 * ser un par (%, importe) que ella reproduzca. En este orden:
 * 1. Con importe leido y la factura cuadrando con el: el primer % que da
 *    ese importe entre el leido, el aprendido y un tipo legal
 *    (legalRateFor). Nunca uno deducido sin mas: con una linea al 0 %,
 *    150 / 1200 daria un 12,5 % que no existe, y la factura pasaria en
 *    verde.
 * 2. Si no: el primero entre el leido y el aprendido con el que, calculando
 *    el importe, la factura cuadra.
 * 3. Si ninguno: el par leido si es coherente consigo mismo (base × % leido
 *    da el importe leido); si no, el % leido con su importe calculado; el
 *    aprendido, solo sin % leido. La factura queda descuadrada y el gestor
 *    lo ve, pero con el tipo impreso.
 */
import { percentOf } from "@/lib/money";
import { LEGAL_RETENTION_RATES } from "@/lib/validators";

/**
 * El tipo legal que da `amount` sobre `sumBases` (con el signo de la base),
 * o null. Con % leido, solo uno que difiera de el por redondeo.
 */
export function legalRateFor(sumBases: number, amount: number, readRate: number | null = null): number | null {
  if (sumBases === 0) return null;
  for (const rate of LEGAL_RETENTION_RATES) {
    if (readRate != null && Math.abs(rate - readRate) > 0.01) continue;
    if (percentOf(sumBases, rate) === amount) return rate;
  }
  return null;
}

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
    for (const rate of [readRate, retentionRate, legalRateFor(sumBases, signed, readRate)]) {
      if (rate != null && percentOf(sumBases, rate) === signed) return { rate, amount: signed };
    }
  }
  for (const rate of [readRate, retentionRate]) {
    if (rate != null && balancedWith(percentOf(sumBases, rate))) return { rate, amount: percentOf(sumBases, rate) };
  }
  // La factura no cuadra con nada: si el par leido es coherente consigo
  // mismo, se queda (el gestor solo corrige lo que falla de verdad).
  if (readRate != null && signed != null && sumBases !== 0 && percentOf(sumBases, readRate) === signed) {
    return { rate: readRate, amount: signed };
  }
  // Si no, el % impreso antes que el aprendido: la factura sigue descuadrada,
  // pero con el tipo de la factura. El aprendido, solo sin % leido.
  if (readRate != null) return { rate: readRate, amount: percentOf(sumBases, readRate) };
  if (retentionRate != null) return { rate: retentionRate, amount: percentOf(sumBases, retentionRate) };
  return { rate: readRate, amount: readAmount };
}
