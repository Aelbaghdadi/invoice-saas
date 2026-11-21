import { describe, it, expect } from "vitest";
import {
  archiveWarnings,
  compareArchiveOrder,
  compareInvoiceNumbers,
  fiscalQuarterLabel,
  fiscalYearEnd,
  fiscalYearLabel,
  fiscalYearOf,
  fiscalYearRange,
  flagLateRegistrations,
  retainUntil,
  suggestRetentionHold,
  RETENTION_MIN_YEARS,
  type ArchiveOrderRow,
  type ArchivePeriodFields,
  type ArchiveWarningRow,
  type RegisteredRow,
} from "@/lib/archiveRules";
import { hasOwnAccountingPeriod, invoicePeriod, periodEndMonth, periodIndex } from "@/lib/period";
import { formatDateEs } from "@/lib/dates";

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));

const monthly = (month: number, year: number, over: Partial<ArchivePeriodFields> = {}): ArchivePeriodFields => ({
  periodType: "MONTHLY",
  periodMonth: month,
  periodYear: year,
  accountingPeriodMonth: null,
  accountingPeriodYear: null,
  ...over,
});

const quarterly = (quarterStart: number, year: number): ArchivePeriodFields => ({
  ...monthly(quarterStart, year),
  periodType: "QUARTERLY",
});

describe("periodo de deducción", () => {
  it("el contable manda sobre el del lote", () => {
    expect(invoicePeriod(monthly(1, 2026, { accountingPeriodMonth: 12, accountingPeriodYear: 2025 }))).toEqual({ month: 12, year: 2025 });
    expect(invoicePeriod(monthly(3, 2026))).toEqual({ month: 3, year: 2026 });
  });

  it("periodIndex cuenta meses: enero va justo detrás de diciembre", () => {
    expect(periodIndex(2026, 1) - periodIndex(2025, 12)).toBe(1);
    expect(periodIndex(2026, 3)).toBe(2026 * 12 + 2);
  });

  it("el periodo contable igual al del lote no es propio: la revisión lo guarda siempre", () => {
    expect(hasOwnAccountingPeriod(monthly(3, 2026))).toBe(false);
    expect(hasOwnAccountingPeriod(monthly(3, 2026, { accountingPeriodMonth: 3, accountingPeriodYear: 2026 }))).toBe(false);
    expect(hasOwnAccountingPeriod(monthly(3, 2026, { accountingPeriodMonth: 4, accountingPeriodYear: 2026 }))).toBe(true);
    expect(hasOwnAccountingPeriod(monthly(3, 2026, { accountingPeriodMonth: 3, accountingPeriodYear: 2025 }))).toBe(true);
  });

  it("periodEndMonth: el último mes del trimestre solo en un lote trimestral sin periodo contable propio", () => {
    expect(periodEndMonth(quarterly(1, 2026))).toEqual({ month: 3, year: 2026 });
    expect(periodEndMonth(quarterly(10, 2025))).toEqual({ month: 12, year: 2025 });
    expect(periodEndMonth({ ...quarterly(1, 2026), accountingPeriodMonth: 1, accountingPeriodYear: 2026 })).toEqual({ month: 3, year: 2026 });
    expect(periodEndMonth({ ...quarterly(1, 2026), accountingPeriodMonth: 2, accountingPeriodYear: 2026 })).toEqual({ month: 2, year: 2026 });
    expect(periodEndMonth(monthly(5, 2026))).toEqual({ month: 5, year: 2026 });
  });
});

describe("ejercicio del cliente", () => {
  it("con inicio en enero es el año natural", () => {
    expect(fiscalYearOf(2026, 3, 1)).toEqual({ startYear: 2026, label: "2026" });
    expect(fiscalYearOf(2026, 12, 1)).toEqual({ startYear: 2026, label: "2026" });
    expect(formatDateEs(fiscalYearEnd(2026, 1))).toBe("31/12/2026");
    expect(fiscalYearRange(2026, 1)).toEqual([periodIndex(2026, 1), periodIndex(2026, 12)]);
  });

  it("con inicio en julio: marzo de 2026 es 2025-26 y julio de 2026 es 2026-27", () => {
    expect(fiscalYearOf(2026, 3, 7)).toEqual({ startYear: 2025, label: "2025-26" });
    expect(fiscalYearOf(2026, 7, 7)).toEqual({ startYear: 2026, label: "2026-27" });
    expect(formatDateEs(fiscalYearEnd(2025, 7))).toBe("30/06/2026");
    expect(fiscalYearRange(2025, 7)).toEqual([periodIndex(2025, 7), periodIndex(2026, 6)]);
  });

  it("la etiqueta del cambio de siglo lleva dos cifras", () => {
    expect(fiscalYearLabel(2099, 7)).toBe("2099-00");
    expect(fiscalYearLabel(2008, 4)).toBe("2008-09");
  });

  it("los trimestres del ejercicio cuentan desde su primer mes (la descarga en ZIP por trimestres)", () => {
    expect(fiscalQuarterLabel(2026, 1, 1)).toBe("T1 (Enero – Marzo 2026)");
    expect(fiscalQuarterLabel(2026, 1, 4)).toBe("T4 (Octubre – Diciembre 2026)");
    expect(fiscalQuarterLabel(2025, 7, 3)).toBe("T3 (Enero – Marzo 2026)");
    expect(fiscalQuarterLabel(2025, 11, 1)).toBe("T1 (Noviembre 2025 – Enero 2026)");
  });
});

describe("retainUntil (conservar hasta)", () => {
  const until = (row: ArchivePeriodFields & { invoiceDate: Date | null; retentionHold?: boolean }, startMonth = 1) =>
    formatDateEs(retainUntil(row, startMonth));

  it("una factura de 2025 se conserva hasta el 31/12/2031", () => {
    expect(RETENTION_MIN_YEARS).toBe(6);
    expect(until({ ...monthly(3, 2025), invoiceDate: utc(2025, 3, 10) })).toBe("31/12/2031");
  });

  it("diciembre de 2025 contabilizada en enero de 2026 cuenta en 2026: 31/12/2032", () => {
    const row = { ...monthly(12, 2025, { accountingPeriodMonth: 1, accountingPeriodYear: 2026 }), invoiceDate: utc(2025, 12, 20) };
    expect(until(row)).toBe("31/12/2032");
  });

  it("ejercicio de julio a junio: la del 2025-26 se conserva hasta el 30/06/2032", () => {
    expect(until({ ...monthly(3, 2026), invoiceDate: utc(2026, 3, 2) }, 7)).toBe("30/06/2032");
    expect(until({ ...monthly(7, 2025), invoiceDate: utc(2025, 7, 2) }, 7)).toBe("30/06/2032");
  });

  it("un lote trimestral cuenta su último mes", () => {
    // Ejercicio de marzo a febrero: enero es del 2025-26 y marzo, del 2026-27.
    expect(until({ ...monthly(1, 2026), invoiceDate: null }, 3)).toBe("29/02/2032");
    expect(until({ ...quarterly(1, 2026), invoiceDate: null }, 3)).toBe("28/02/2033");
  });

  it("también después de guardarla en la revisión, que deja el periodo contable igual al lote", () => {
    const saved = (quarterStart: number) => ({ ...quarterly(quarterStart, 2026), accountingPeriodMonth: quarterStart, accountingPeriodYear: 2026 });
    expect(until({ ...saved(1), invoiceDate: utc(2026, 2, 15) }, 3)).toBe("28/02/2033");
    expect(until({ ...saved(1), invoiceDate: null }, 2)).toBe("31/01/2033");
    expect(until({ ...saved(7), invoiceDate: utc(2026, 7, 15) }, 9)).toBe("31/08/2033");
  });

  it("si la fecha de la factura es posterior al periodo, cuenta la fecha", () => {
    expect(until({ ...monthly(12, 2025), invoiceDate: utc(2026, 1, 5) })).toBe("31/12/2032");
    // Una fecha anterior no adelanta nada: manda el periodo.
    expect(until({ ...monthly(1, 2026), invoiceDate: utc(2025, 12, 28) })).toBe("31/12/2032");
  });

  it("siempre a fin de mes, también en febrero de un año bisiesto", () => {
    expect(until({ ...monthly(2, 2026), invoiceDate: null }, 3)).toBe("29/02/2032");
    expect(until({ ...monthly(2, 2025), invoiceDate: null }, 3)).toBe("28/02/2031");
  });

  it("con «conservar más» no hay fecha", () => {
    expect(retainUntil({ ...monthly(3, 2025), invoiceDate: utc(2025, 3, 10), retentionHold: true }, 1)).toBeNull();
  });
});

describe("compareArchiveOrder (orden del archivo)", () => {
  const row = (id: string, over: Partial<ArchiveOrderRow> = {}): ArchiveOrderRow => ({
    ...monthly(3, 2026),
    id,
    type: "PURCHASE",
    receivedAt: utc(2026, 4, 1),
    uploadPosition: null,
    splitPart: 0,
    createdAt: utc(2026, 4, 1),
    invoiceDate: utc(2026, 3, 10),
    invoiceNumber: null,
    ...over,
  });
  const order = (rows: ArchiveOrderRow[]) => [...rows].sort(compareArchiveOrder).map((r) => r.id);

  it("manda el periodo de deducción, también el contable", () => {
    const rows = [
      row("marzo", { receivedAt: utc(2026, 4, 1) }),
      row("venta-febrero", { type: "SALE", periodMonth: 2 }),
      row("contable-febrero", { accountingPeriodMonth: 2, accountingPeriodYear: 2026, receivedAt: utc(2026, 4, 20) }),
    ];
    expect(order(rows)).toEqual(["contable-febrero", "venta-febrero", "marzo"]);
  });

  it("dentro del periodo, las recibidas antes que las emitidas", () => {
    const rows = [
      row("venta", { type: "SALE", receivedAt: utc(2026, 3, 1) }),
      row("compra", { receivedAt: utc(2026, 4, 30) }),
    ];
    expect(order(rows)).toEqual(["compra", "venta"]);
  });

  it("recibidas: llegada, posición en la tanda y parte de la división", () => {
    const tanda = utc(2026, 4, 2);
    const rows = [
      row("suelta-tarde", { receivedAt: utc(2026, 4, 3) }),
      row("pos10", { receivedAt: tanda, uploadPosition: 10 }),
      row("pos3-parte2", { receivedAt: tanda, uploadPosition: 3, splitPart: 2 }),
      row("pos2", { receivedAt: tanda, uploadPosition: 2 }),
      row("pos3-parte1", { receivedAt: tanda, uploadPosition: 3, splitPart: 1 }),
      row("suelta-pronto", { receivedAt: utc(2026, 4, 1) }),
    ];
    expect(order(rows)).toEqual(["suelta-pronto", "pos2", "pos3-parte1", "pos3-parte2", "pos10", "suelta-tarde"]);
  });

  it("emitidas: por fecha y nº de factura en orden natural (F-2 antes que F-10)", () => {
    const sale = (id: string, invoiceNumber: string | null, invoiceDate: Date | null) =>
      row(id, { type: "SALE", invoiceNumber, invoiceDate, receivedAt: utc(2026, 4, 9) });
    const rows = [
      sale("F-10", "F-10", utc(2026, 3, 5)),
      sale("sin-fecha", "F-1", null),
      sale("F-2", "F-2", utc(2026, 3, 5)),
      sale("F-11-antes", "F-11", utc(2026, 3, 1)),
    ];
    expect(order(rows)).toEqual(["F-11-antes", "F-2", "F-10", "sin-fecha"]);
  });

  it("el desempate por id es estable, venga en el orden que venga", () => {
    const rows = [row("b"), row("c"), row("a")];
    expect(order(rows)).toEqual(["a", "b", "c"]);
    expect(order([...rows].reverse())).toEqual(["a", "b", "c"]);
  });

  it("compareInvoiceNumbers: orden natural con el corte de parseInvoiceNumber", () => {
    const sorted = (numbers: (string | null)[]) => [...numbers].sort(compareInvoiceNumbers);
    expect(sorted(["F-10", "F-2", "F-1"])).toEqual(["F-1", "F-2", "F-10"]);
    expect(sorted(["10/2026", "2/2026"])).toEqual(["2/2026", "10/2026"]);
    expect(sorted(["F-2026-0100", "F-2026-0042"])).toEqual(["F-2026-0042", "F-2026-0100"]);
    // Sin dígitos detrás y sin número al final.
    expect(sorted([null, "SIN NUMERO", "A-1"])).toEqual(["A-1", "SIN NUMERO", null]);
  });
});

describe("flagLateRegistrations (registrada tarde)", () => {
  const reg = (id: string, number: number | null, month: number, over: Partial<RegisteredRow> = {}): RegisteredRow => ({
    ...monthly(month, 2026),
    id,
    registerSeriesId: "R-2026",
    registerNumber: number,
    ...over,
  });

  it("marca la tardía y no la siguiente", () => {
    const rows = [
      reg("ene-1", 1, 1),
      reg("ene-2", 2, 1),
      reg("feb-3", 3, 2),
      reg("feb-4", 4, 2),
      reg("ene-tardia", 5, 1),
      reg("feb-6", 6, 2),
    ];
    expect([...flagLateRegistrations(rows)]).toEqual(["ene-tardia"]);
  });

  it("cuenta el periodo contable y cada serie va por su lado", () => {
    const rows = [
      reg("ene-1", 1, 1),
      reg("feb-2", 2, 2),
      reg("contable-ene", 3, 2, { accountingPeriodMonth: 1, accountingPeriodYear: 2026 }),
      reg("emitida-ene", 9, 1, { registerSeriesId: "E-2026" }),
      reg("sin-numero", null, 1),
    ];
    expect([...flagLateRegistrations(rows)]).toEqual(["contable-ene"]);
  });
});

describe("archiveWarnings", () => {
  const base = (over: Partial<ArchiveWarningRow> = {}): ArchiveWarningRow => ({
    ...monthly(1, 2026),
    type: "PURCHASE",
    invoiceDate: utc(2026, 1, 15),
    registerSeries: { type: "PURCHASE", year: 2026 },
    ...over,
  });
  const labels = (row: ArchiveWarningRow, options?: { lateRegistration?: boolean }) =>
    archiveWarnings(row, options).map((w) => w.label);

  it("una factura normal no lleva avisos", () => {
    expect(labels(base())).toEqual([]);
    expect(labels(base({ registerSeries: null, invoiceDate: null }))).toEqual([]);
  });

  it("fecha de otro periodo, comparada con el periodo de deducción", () => {
    expect(labels(base({ invoiceDate: utc(2025, 12, 28) }))).toEqual(["Fecha de otro periodo"]);
    // Contabilizada en diciembre: la fecha ya es de su periodo (y la serie, de otro año).
    expect(labels(base({ invoiceDate: utc(2025, 12, 28), accountingPeriodMonth: 12, accountingPeriodYear: 2025 })))
      .toEqual(["Nº de otro año"]);
    // Un lote trimestral abarca sus tres meses, también con el periodo contable
    // que guarda la revisión (el del lote).
    expect(labels(base({ ...quarterly(1, 2026), invoiceDate: utc(2026, 3, 31) }))).toEqual([]);
    expect(labels(base({ ...quarterly(1, 2026), accountingPeriodMonth: 1, accountingPeriodYear: 2026, invoiceDate: utc(2026, 2, 15) })))
      .toEqual([]);
    // Con un periodo contable propio se compara con ese mes.
    expect(labels(base({ ...quarterly(1, 2026), accountingPeriodMonth: 12, accountingPeriodYear: 2025, invoiceDate: utc(2026, 2, 15), registerSeries: null })))
      .toEqual(["Fecha de otro periodo"]);
  });

  it("numerada como otro tipo", () => {
    expect(labels(base({ type: "SALE" }))).toEqual(["Numerada como recibida"]);
    expect(labels(base({ registerSeries: { type: "SALE", year: 2026 } }))).toEqual(["Numerada como emitida"]);
  });

  it("nº de otro año si el periodo cambió de año después de numerar", () => {
    expect(labels(base({ registerSeries: { type: "PURCHASE", year: 2025 } }))).toEqual(["Nº de otro año"]);
  });

  it("registrada tarde va la primera", () => {
    expect(labels(base({ invoiceDate: utc(2025, 12, 28) }), { lateRegistration: true }))
      .toEqual(["Registrada tarde", "Fecha de otro periodo"]);
    expect(archiveWarnings(base(), { lateRegistration: true })).toEqual([{ code: "late_registration", label: "Registrada tarde" }]);
  });
});

describe("suggestRetentionHold", () => {
  it("en compras con cuenta 2xx sugiere inmovilizado", () => {
    expect(suggestRetentionHold({ type: "PURCHASE", expenseAccount: "21300000" })).toBe("FIXED_ASSET");
    expect(suggestRetentionHold({ type: "PURCHASE", expenseAccount: "217" })).toBe("FIXED_ASSET");
  });

  it("con cuenta 6xx, sin cuenta o en ventas, no", () => {
    expect(suggestRetentionHold({ type: "PURCHASE", expenseAccount: "62900000" })).toBeNull();
    expect(suggestRetentionHold({ type: "PURCHASE", expenseAccount: null })).toBeNull();
    expect(suggestRetentionHold({ type: "SALE", expenseAccount: "21300000" })).toBeNull();
  });
});
