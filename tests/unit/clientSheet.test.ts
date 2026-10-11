import { describe, it, expect } from "vitest";
import { buildPeriodRows, clientStatsFrom, type PeriodCountRow } from "@/lib/clientSheet";

describe("clientStatsFrom", () => {
  it("suma los estados y deja fuera el buzón y las originales divididas", () => {
    const stats = clientStatsFrom(
      [
        { status: "PENDING_REVIEW", count: 3 },
        { status: "NEEDS_ATTENTION", count: 2 },
        { status: "OCR_ERROR", count: 1 },
        { status: "VALIDATED", count: 10 },
        { status: "REJECTED", count: 1 },
        { status: "EXPORTED", count: 3 },
        { status: "SPLIT_SOURCE", count: 1 },
        { status: "PENDING_ROUTING", count: 4 },
      ],
      { exported: 8, readyToExport: 5 },
    );
    expect(stats).toEqual({
      total: 20,
      pending: 6,
      needsAttention: 2,
      ocrError: 1,
      readyToExport: 5,
      exported: 8,
      rejected: 1,
      pct: 70,
    });
  });

  it("sin facturas, todo a cero", () => {
    expect(clientStatsFrom([], { exported: 0, readyToExport: 0 }).pct).toBe(0);
  });
});

describe("buildPeriodRows", () => {
  const row = (periodMonth: number, type: "PURCHASE" | "SALE", status: PeriodCountRow["status"], count: number, periodYear = 2026): PeriodCountRow =>
    ({ periodType: "MONTHLY", periodYear, periodMonth, type, status, count });

  it("una fila por periodo, de la más reciente a la más antigua, con compras, ventas y pendientes", () => {
    const rows = buildPeriodRows({
      counts: [
        row(8, "PURCHASE", "VALIDATED", 5),
        row(8, "SALE", "PENDING_REVIEW", 2),
        row(9, "PURCHASE", "NEEDS_ATTENTION", 1),
        row(9, "PURCHASE", "REJECTED", 1),
        row(9, "SALE", "EXPORTED", 4),
        row(12, "PURCHASE", "VALIDATED", 2, 2025),
      ],
      exported: [{ periodType: "MONTHLY", periodYear: 2026, periodMonth: 8, count: 5 }],
      closures: [
        { month: 8, year: 2026, closedAt: new Date("2026-09-05"), reopenedAt: null },
        { month: 9, year: 2026, closedAt: new Date("2026-10-01"), reopenedAt: new Date("2026-10-02") },
      ],
    });
    expect(rows.map((r) => r.label)).toEqual(["Septiembre 2026", "Agosto 2026", "Diciembre 2025"]);
    expect(rows[1]).toMatchObject({ purchases: 5, sales: 2, total: 7, pending: 2, validated: 5, rejected: 0, exported: 5, closed: true });
    expect(rows[1].closedAt).toEqual(new Date("2026-09-05"));
    // Un cierre reabierto no cuenta como cerrado.
    expect(rows[0]).toMatchObject({ purchases: 2, sales: 4, total: 6, pending: 1, validated: 4, rejected: 1, exported: 0, closed: false, closedAt: null });
  });

  it("un trimestre se etiqueta como tal y se cierra con su primer mes", () => {
    const rows = buildPeriodRows({
      counts: [{ periodType: "QUARTERLY", periodYear: 2026, periodMonth: 7, type: "PURCHASE", status: "VALIDATED", count: 3 }],
      exported: [],
      closures: [{ month: 7, year: 2026, closedAt: new Date("2026-10-20"), reopenedAt: null }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "T3 2026", closed: true, total: 3 });
  });

  it("las originales divididas y el buzón no crean periodo; las exportadas de un periodo sin facturas se ignoran", () => {
    const rows = buildPeriodRows({
      counts: [row(3, "PURCHASE", "SPLIT_SOURCE", 1), row(3, "PURCHASE", "PENDING_ROUTING", 2)],
      exported: [{ periodType: "MONTHLY", periodYear: 2026, periodMonth: 2, count: 9 }],
      closures: [],
    });
    expect(rows).toEqual([]);
  });
});
