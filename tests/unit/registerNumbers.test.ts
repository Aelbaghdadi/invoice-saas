import { describe, it, expect } from "vitest";
import {
  formatRegisterNumber,
  parseRegisterQuery,
  planRegisterNumbers,
  registerFileStem,
  registerSeriesKey,
  type RegisterPlanRow,
} from "@/lib/registerNumbers";

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));

describe("formatRegisterNumber y registerFileStem", () => {
  it("serie R para las recibidas y E para las emitidas, con cuatro cifras", () => {
    expect(formatRegisterNumber({ type: "PURCHASE", year: 2026 }, 153)).toBe("R-2026/0153");
    expect(formatRegisterNumber({ type: "SALE", year: 2025 }, 7)).toBe("E-2025/0007");
    expect(registerFileStem({ type: "PURCHASE", year: 2026 }, 153)).toBe("R-2026-0153");
  });

  it("con más de 9.999 el número crece sin cortarse", () => {
    expect(formatRegisterNumber({ type: "PURCHASE", year: 2026 }, 12345)).toBe("R-2026/12345");
    expect(registerFileStem({ type: "SALE", year: 2026 }, 12345)).toBe("E-2026-12345");
  });
});

describe("parseRegisterQuery", () => {
  it("con letra, en mayúsculas o minúsculas, con o sin ceros y separadores", () => {
    expect(parseRegisterQuery("R-2026/153")).toEqual({ type: "PURCHASE", year: 2026, number: 153 });
    expect(parseRegisterQuery("r 2026/0153")).toEqual({ type: "PURCHASE", year: 2026, number: 153 });
    expect(parseRegisterQuery("E2025/7")).toEqual({ type: "SALE", year: 2025, number: 7 });
    expect(parseRegisterQuery(" R-2026-0153 ")).toEqual({ type: "PURCHASE", year: 2026, number: 153 });
  });

  it("sin letra vale para las dos series", () => {
    expect(parseRegisterQuery("2026/153")).toEqual({ type: null, year: 2026, number: 153 });
  });

  it("lo que lee es lo que escribe", () => {
    const series = { type: "SALE" as const, year: 2026 };
    expect(parseRegisterQuery(formatRegisterNumber(series, 42))).toEqual({ ...series, number: 42 });
    expect(parseRegisterQuery(registerFileStem(series, 42))).toEqual({ ...series, number: 42 });
  });

  it("no toma por nº de registro otras cosas", () => {
    for (const text of ["", "F-2026/153", "153/2026", "2026-153", "R-2026/0", "R-26/153", "Cárnicas", "1.134,60", "T37"]) {
      expect(parseRegisterQuery(text), text).toBeNull();
    }
  });
});

describe("planRegisterNumbers", () => {
  const row = (id: string, over: Partial<RegisterPlanRow> = {}): RegisterPlanRow => ({
    id,
    clientId: "cli-a",
    type: "PURCHASE",
    periodType: "MONTHLY",
    periodMonth: 3,
    periodYear: 2026,
    accountingPeriodMonth: null,
    accountingPeriodYear: null,
    receivedAt: utc(2026, 4, 1),
    uploadPosition: null,
    splitPart: 0,
    createdAt: utc(2026, 4, 1),
    invoiceDate: utc(2026, 3, 10),
    invoiceNumber: null,
    registerNumber: null,
    ...over,
  });
  const summary = (rows: RegisterPlanRow[], last?: Map<string, number>) =>
    planRegisterNumbers(rows, last).map((block) => ({
      key: block.key,
      entries: block.entries.map((e) => `${e.invoiceId}=${e.number}`),
    }));

  it("separa recibidas y emitidas, y los años del periodo de deducción", () => {
    const rows = [
      row("compra-2026"),
      row("venta-2026", { type: "SALE" }),
      row("compra-contable-2025", { accountingPeriodMonth: 12, accountingPeriodYear: 2025 }),
      row("compra-trimestral-2025", { periodType: "QUARTERLY", periodMonth: 10, periodYear: 2025 }),
    ];
    expect(summary(rows)).toEqual([
      { key: "cli-a|PURCHASE|2025", entries: ["compra-trimestral-2025=1", "compra-contable-2025=2"] },
      { key: "cli-a|PURCHASE|2026", entries: ["compra-2026=1"] },
      { key: "cli-a|SALE|2026", entries: ["venta-2026=1"] },
    ]);
  });

  it("salta las que ya tienen número y sigue desde el último de la serie", () => {
    const rows = [row("ya-numerada", { registerNumber: 152 }), row("nueva-1"), row("nueva-2", { receivedAt: utc(2026, 4, 2) })];
    const last = new Map([[registerSeriesKey({ clientId: "cli-a", type: "PURCHASE", year: 2026 }), 152]]);
    const [block] = planRegisterNumbers(rows, last);
    expect(block.previous).toBe(152);
    expect(block.entries).toEqual([
      { invoiceId: "nueva-1", number: 153 },
      { invoiceId: "nueva-2", number: 154 },
    ]);
  });

  it("los bloques salen en el orden de sus claves: cliente, tipo y año", () => {
    const rows = [
      row("b-venta", { clientId: "cli-b", type: "SALE" }),
      row("b-compra-2026", { clientId: "cli-b" }),
      row("a-venta", { type: "SALE" }),
      row("b-compra-2025", { clientId: "cli-b", periodYear: 2025 }),
      row("a-compra"),
    ];
    expect(planRegisterNumbers(rows).map((block) => block.key)).toEqual([
      "cli-a|PURCHASE|2026",
      "cli-a|SALE|2026",
      "cli-b|PURCHASE|2025",
      "cli-b|PURCHASE|2026",
      "cli-b|SALE|2026",
    ]);
  });

  it("dentro de la serie numera en el orden del archivo, no en el que llegan", () => {
    const tanda = utc(2026, 4, 2);
    const rows = [
      row("abril-tarde", { receivedAt: utc(2026, 4, 9) }),
      row("pos-2", { receivedAt: tanda, uploadPosition: 2 }),
      row("febrero", { periodMonth: 2, receivedAt: utc(2026, 4, 20) }),
      row("pos-1", { receivedAt: tanda, uploadPosition: 1 }),
    ];
    expect(summary(rows)).toEqual([
      { key: "cli-a|PURCHASE|2026", entries: ["febrero=1", "pos-1=2", "pos-2=3", "abril-tarde=4"] },
    ]);
  });

  it("sin facturas pendientes no hay bloques", () => {
    expect(planRegisterNumbers([])).toEqual([]);
    expect(planRegisterNumbers([row("ya", { registerNumber: 3 })])).toEqual([]);
  });
});
