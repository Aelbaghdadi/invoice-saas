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

  it("una línea al 0 %: el 15 % impreso no se cambia por un 12,5 % deducido; queda descuadrada", () => {
    // 1000 al 21 % y 200 al 0 %; leído 15 % y 150, y el total cuadra con 150.
    const balancedWith = (irpf: number) => Math.abs(1200 + 210 - irpf - 1260) < 0.005;
    expect(resolveIrpf({ sumBases: 1200, balancedWith, hasRetention: true, retentionRate: 15, readRate: 15, readAmount: 150 }))
      .toEqual({ rate: 15, amount: 180 });
  });

  it("base pequeña sin % leído: el 15 % aprendido ya da el importe (no un 15,01 %)", () => {
    const balancedWith = (irpf: number) => Math.abs(45.45 + 9.54 - irpf - 48.17) < 0.005;
    expect(resolveIrpf({ sumBases: 45.45, balancedWith, hasRetention: true, retentionRate: 15, readRate: null, readAmount: 6.82 }))
      .toEqual({ rate: 15, amount: 6.82 });
  });

  it("% leído sin importe y el total cuadra con él: el leído, no el aprendido", () => {
    expect(resolveIrpf({ ...invoice(1140), hasRetention: true, retentionRate: 15, readRate: 7, readAmount: null }))
      .toEqual({ rate: 7, amount: 70 });
  });

  it("rectificativa con bases negativas: el importe leído se queda, con el signo de la base", () => {
    // Abono de −1000 con −210 de IVA y −70 de IRPF (el OCR lo deja en +70),
    // sin % leído y con un 15 % aprendido. Antes: 15 % / −150, descuadrada.
    const balancedWith = (irpf: number) => Math.abs(-1000 - 210 - irpf - -1140) < 0.005;
    expect(resolveIrpf({ sumBases: -1000, balancedWith, hasRetention: true, retentionRate: 15, readRate: null, readAmount: 70 }))
      .toEqual({ rate: 7, amount: -70 });
    expect(resolveIrpf({ sumBases: -1000, balancedWith, hasRetention: true, retentionRate: 15, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 7, amount: -70 });
  });

  it("sin tipo de retención, lo leído tal cual", () => {
    expect(resolveIrpf({ ...invoice(1140), hasRetention: false, retentionRate: null, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 7, amount: 70 });
  });
});
