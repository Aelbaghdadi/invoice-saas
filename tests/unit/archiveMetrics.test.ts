import { describe, it, expect } from "vitest";
import {
  addToArchiveCell,
  archiveFiscalYearOf,
  buildArchiveMetrics,
  emptyArchiveCell,
  type ArchiveMetricsRow,
} from "@/lib/archiveMetrics";

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

function row(overrides: Partial<ArchiveMetricsRow> = {}): ArchiveMetricsRow {
  return {
    clientId: "c1",
    type: "PURCHASE",
    status: "VALIDATED",
    periodType: "MONTHLY",
    periodMonth: 3,
    periodYear: 2026,
    accountingPeriodMonth: null,
    accountingPeriodYear: null,
    medium: "ELECTRONIC",
    registered: true,
    retentionHold: false,
    lastInvoiceDate: null,
    count: 1,
    ...overrides,
  };
}

const enero = { id: "c1", name: "Cliente enero", fiscalYearStartMonth: 1 };
const julio = { id: "c2", name: "Cliente julio", fiscalYearStartMonth: 7 };

describe("buildArchiveMetrics", () => {
  it("suma por cliente y ejercicio natural: recibidas, emitidas, medio y registro", () => {
    const metrics = buildArchiveMetrics([
      row({ count: 3 }),
      row({ type: "SALE", medium: "PAPER", registered: false, count: 2 }),
      row({ medium: null, registered: false }),
      row({ periodYear: 2025, periodMonth: 12, count: 4 }),
    ], [enero]);
    expect(metrics.startYears).toEqual([2026, 2025]);
    const [client] = metrics.clients;
    expect(client.years.map((y) => y.label)).toEqual(["2026", "2025"]);
    expect(client.years[0]).toMatchObject({
      startYear: 2026,
      invoices: 6,
      received: 4,
      issued: 2,
      electronic: 3,
      paper: 2,
      unconfirmed: 1,
      registered: 3,
      unregistered: 3,
      retentionHold: 0,
      rejected: 0,
      retainUntil: utc("2032-12-31"),
    });
    expect(client.years[1]).toMatchObject({ startYear: 2025, invoices: 4, retainUntil: utc("2031-12-31") });
  });

  it("con el ejercicio de julio a junio, marzo de 2026 es del 2025-26 y julio del 2026-27", () => {
    const metrics = buildArchiveMetrics([
      row({ clientId: "c2", periodMonth: 3, count: 2 }),
      row({ clientId: "c2", periodMonth: 7 }),
      row({ clientId: "c2", periodYear: 2025, periodMonth: 7 }),
    ], [julio]);
    const years = metrics.clients[0].years;
    expect(years.map((y) => [y.label, y.invoices])).toEqual([["2026-27", 1], ["2025-26", 3]]);
    expect(years[1].retainUntil).toEqual(utc("2032-06-30"));
    expect(years[0].retainUntil).toEqual(utc("2033-06-30"));
  });

  it("el ejercicio va por el periodo de deducción: el contable manda sobre el del lote", () => {
    const metrics = buildArchiveMetrics([
      row({ periodYear: 2025, periodMonth: 12, accountingPeriodYear: 2026, accountingPeriodMonth: 1 }),
    ], [enero]);
    expect(metrics.clients[0].years.map((y) => y.startYear)).toEqual([2026]);
    expect(metrics.clients[0].years[0].retainUntil).toEqual(utc("2032-12-31"));
  });

  it("«Por confirmar» no cuenta como papel", () => {
    const [year] = buildArchiveMetrics([row({ medium: null, count: 5 }), row({ medium: "PAPER" })], [enero]).clients[0].years;
    expect([year.paper, year.unconfirmed, year.electronic]).toEqual([1, 5, 0]);
  });

  it("las rechazadas van aparte y no cuentan en el resto de cifras", () => {
    const [year] = buildArchiveMetrics([
      row({ count: 2 }),
      row({ status: "REJECTED", medium: "PAPER", registered: false, count: 3 }),
    ], [enero]).clients[0].years;
    expect(year).toMatchObject({ invoices: 2, rejected: 3, paper: 0, unregistered: 0, received: 2 });
  });

  it("las originales divididas y las del buzón no cuentan; sus partes sí", () => {
    const [year] = buildArchiveMetrics([
      row({ status: "SPLIT_SOURCE", count: 1 }),
      row({ status: "PENDING_ROUTING", count: 1 }),
      row({ status: "PENDING_REVIEW", count: 2 }),
    ], [enero]).clients[0].years;
    expect(year).toMatchObject({ invoices: 2, pendingValidation: 2 });
  });

  it("«conservar más» se cuenta y no entra en «conservar hasta»", () => {
    const [year] = buildArchiveMetrics([
      row({ retentionHold: true, periodYear: 2026, periodMonth: 12, lastInvoiceDate: utc("2027-02-10") }),
      row({ periodMonth: 3 }),
    ], [enero]).clients[0].years;
    expect(year.retentionHold).toBe(1);
    expect(year.retainUntil).toEqual(utc("2032-12-31"));
  });

  it("«conservar hasta» es el más tardío: una fecha de factura posterior al ejercicio lo alarga", () => {
    const [year] = buildArchiveMetrics([
      row({ periodMonth: 12, lastInvoiceDate: utc("2027-01-15") }),
      row({ periodMonth: 2 }),
    ], [enero]).clients[0].years;
    expect(year.retainUntil).toEqual(utc("2033-12-31"));
  });

  it("todo con «conservar más»: sin fecha", () => {
    const [year] = buildArchiveMetrics([row({ retentionHold: true })], [enero]).clients[0].years;
    expect(year.retainUntil).toBeNull();
  });

  it("totales por año de todos los clientes, y clientes sin facturas sin años", () => {
    const metrics = buildArchiveMetrics([
      row({ count: 2 }),
      row({ clientId: "c2", periodMonth: 8, count: 3 }),
      row({ clientId: "otro", count: 7 }),
    ], [enero, julio, { id: "c3", name: "Vacío", fiscalYearStartMonth: 1 }]);
    expect(metrics.totals.map((t) => [t.startYear, t.invoices])).toEqual([[2026, 5]]);
    expect(metrics.clients.map((c) => [c.name, c.years.length])).toEqual([["Cliente enero", 1], ["Cliente julio", 1], ["Vacío", 0]]);
  });
});

describe("addToArchiveCell y archiveFiscalYearOf", () => {
  it("una fila suelta suma igual que en la matriz", () => {
    const cell = emptyArchiveCell();
    addToArchiveCell(cell, row({ type: "SALE", medium: null, registered: false, status: "OCR_ERROR" }), 1);
    expect(cell).toMatchObject({ invoices: 1, issued: 1, unconfirmed: 1, unregistered: 1, pendingValidation: 1 });
  });

  it("el ejercicio de la fila sale de su primer mes de deducción", () => {
    expect(archiveFiscalYearOf(row({ periodType: "QUARTERLY", periodMonth: 4 }), 7)).toEqual({ startYear: 2025, label: "2025-26" });
  });
});
