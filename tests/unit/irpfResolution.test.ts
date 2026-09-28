import { describe, it, expect } from "vitest";
import { legalRateFor, resolveIrpf } from "@/lib/irpfResolution";

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

  it("sin % leído, con una línea al 0 %: el 12,5 % deducido no vale; 15 % / 180, descuadrada", () => {
    const balancedWith = (irpf: number) => Math.abs(1200 + 210 - irpf - 1260) < 0.005;
    expect(resolveIrpf({ sumBases: 1200, balancedWith, hasRetention: true, retentionRate: 15, readRate: null, readAmount: 150 }))
      .toEqual({ rate: 15, amount: 180 });
  });

  it("sin % leído, el deducido va a un tipo legal: 7 %, no 6,99 %; 15 %, no 14,98 %", () => {
    const balanced = (base: number, irpf: number) => (x: number) => Math.abs(x - irpf) < 0.005;
    expect(resolveIrpf({ sumBases: 33.33, balancedWith: balanced(33.33, 2.33), hasRetention: true, retentionRate: 15, readRate: null, readAmount: 2.33 }))
      .toEqual({ rate: 7, amount: 2.33 });
    expect(resolveIrpf({ sumBases: 21.43, balancedWith: balanced(21.43, 3.21), hasRetention: true, retentionRate: 7, readRate: null, readAmount: 3.21 }))
      .toEqual({ rate: 15, amount: 3.21 });
  });

  it("legalRateFor: solo tipos que existen", () => {
    expect(legalRateFor(1200, 150)).toBeNull();
    expect(legalRateFor(33.33, 2.33)).toBe(7);
    expect(legalRateFor(-1000, -70)).toBe(7);
    expect(legalRateFor(1000, 70, 15)).toBeNull();
  });

  it("si no cuadra con nada pero el par leído es coherente, se queda el leído", () => {
    // 15 % y 150 leídos sobre 1000, un total que no cuadra con nada y un 7 % aprendido.
    expect(resolveIrpf({ ...invoice(999), hasRetention: true, retentionRate: 7, readRate: 15, readAmount: 150 }))
      .toEqual({ rate: 15, amount: 150 });
  });

  it("sin nada que cuadre, el % leído va antes que el aprendido", () => {
    // Honorarios de 1000 más un suplido de 200 al 0 %; «IRPF 7 %: 70» leído.
    const total7 = (irpf: number) => Math.abs(1200 + 210 - irpf - 1340) < 0.005;
    expect(resolveIrpf({ sumBases: 1200, balancedWith: total7, hasRetention: true, retentionRate: 15, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 7, amount: 84 });
    // Al revés: 7 % aprendido y 15 % · 150 leído.
    const total15 = (irpf: number) => Math.abs(1200 + 210 - irpf - 1260) < 0.005;
    expect(resolveIrpf({ sumBases: 1200, balancedWith: total15, hasRetention: true, retentionRate: 7, readRate: 15, readAmount: 150 }))
      .toEqual({ rate: 15, amount: 180 });
  });

  it("sin tipo de retención, lo leído tal cual", () => {
    expect(resolveIrpf({ ...invoice(1140), hasRetention: false, retentionRate: null, readRate: 7, readAmount: 70 }))
      .toEqual({ rate: 7, amount: 70 });
  });
});
