/**
 * IRPF que se guarda al analizar (F-073). Antes, con un tipo de retencion
 * puesto (aprendido del tercero o detectado), se guardaba siempre base × %
 * y se machacaba el importe leido: con un 15 % aprendido y una factura que
 * imprime un 7 %, quedaba un IRPF que no era el de la factura.
 *
 * - Si el OCR leyo el importe y la factura cuadra con el, se queda el leido,
 *   con el % que lo reproduce (el leido, o el deducido de base e importe).
 *   La pantalla calcula la cuota como base × %: si ningun % de dos decimales
 *   da el importe leido (un 7,005 %), se recalcula como antes.
 * - El % aprendido solo rellena cuando no se leyo importe (o no cuadra).
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
  const { hasRetention, retentionRate, readRate, readAmount, sumBases } = input;
  if (!hasRetention) return { rate: retentionRate ?? readRate, amount: readAmount };

  if (readAmount != null && readAmount !== 0 && sumBases > 0 && input.balancedWith(readAmount)) {
    const deduced = Math.round((Math.abs(readAmount) / sumBases) * 10_000) / 100;
    for (const rate of [readRate, deduced]) {
      if (rate != null && percentOf(sumBases, rate) === readAmount) return { rate, amount: readAmount };
    }
  }
  if (retentionRate != null) return { rate: retentionRate, amount: percentOf(sumBases, retentionRate) };
  return { rate: readRate, amount: readAmount };
}
