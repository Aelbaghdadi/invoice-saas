import { describe, it, expect } from "vitest";
import { resolveIrpf } from "@/lib/irpfResolution";

// Base 1000, IVA 210: la factura cuadra con el IRPF que da el total.
const invoice = (total: number) => ({ sumBases: 1000, balancedWith: (irpf: number) => Math.abs(1000 + 210 - irpf - total) < 0.005 });

describe("resolveIrpf (F-073)", () => {
  it("un 15 % aprendido no machaca el 7 % leído si la factura cuadra con él", () => {
    expect(resolveIrpf({ ...invoice(1140), hasRetention: true, retentionRate: 15, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 7, amount: 70 });
  });

  it("sin % leído, se deduce del importe", () => {
    expect(resolveIrpf({ ...invoice(1140), hasRetention: true, retentionRate: 15, readRate: null, readAmount: 70 }))
      .toEqual({ rate: 7, amount: 70 });
  });

  it("sin importe leído, el % aprendido rellena", () => {
    expect(resolveIrpf({ ...invoice(1060), hasRetention: true, retentionRate: 15, readRate: null, readAmount: null }))
      .toEqual({ rate: 15, amount: 150 });
  });

  it("con un importe leído que no cuadra, base × % como antes", () => {
    expect(resolveIrpf({ ...invoice(1060), hasRetention: true, retentionRate: 15, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 15, amount: 150 });
  });

  it("si ningún % de dos decimales da el importe (7,005 %), se recalcula con el % redondeado", () => {
    expect(resolveIrpf({ ...invoice(1139.95), hasRetention: true, retentionRate: 7.01, readRate: 7.01, readAmount: 70.05 }))
      .toEqual({ rate: 7.01, amount: 70.1 });
  });

  it("sin tipo de retención, lo leído tal cual", () => {
    expect(resolveIrpf({ ...invoice(1140), hasRetention: false, retentionRate: null, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 7, amount: 70 });
  });
});
