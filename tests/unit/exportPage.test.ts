import { describe, it, expect } from "vitest";
import { exportPageHref, parseExportPageParams, previousPeriod } from "@/lib/exportPage";

// 15 de mayo de 2026, 12:00 en Madrid.
const may = new Date("2026-05-15T10:00:00Z");

describe("previousPeriod (F-041)", () => {
  it("el mes anterior", () => {
    expect(previousPeriod("MONTHLY", may)).toEqual({ month: 4, year: 2026 });
  });

  it("en enero, diciembre del año anterior", () => {
    expect(previousPeriod("MONTHLY", new Date("2026-01-20T10:00:00Z"))).toEqual({ month: 12, year: 2025 });
  });

  it("el trimestre anterior, por su primer mes", () => {
    expect(previousPeriod("QUARTERLY", may)).toEqual({ month: 1, year: 2026 });
    expect(previousPeriod("QUARTERLY", new Date("2026-08-01T10:00:00Z"))).toEqual({ month: 4, year: 2026 });
    expect(previousPeriod("QUARTERLY", new Date("2026-02-01T10:00:00Z"))).toEqual({ month: 10, year: 2025 });
  });

  it("con la hora de Madrid: el 1 de junio a las 00:30 ya es junio", () => {
    // 31 de mayo a las 22:30 UTC.
    expect(previousPeriod("MONTHLY", new Date("2026-05-31T22:30:00Z"))).toEqual({ month: 5, year: 2026 });
  });
});

describe("parseExportPageParams (F-041)", () => {
  const clients = ["c1", "c2"];

  it("sin parámetros: el primer cliente, mensual, el mes anterior y todas", () => {
    expect(parseExportPageParams({}, clients, may)).toEqual({ clientId: "c1", periodType: "MONTHLY", month: 4, year: 2026, type: "ALL" });
  });

  it("con parámetros válidos, esos", () => {
    expect(parseExportPageParams({ clientId: "c2", periodType: "MONTHLY", month: "11", year: "2025", type: "SALE" }, clients, may))
      .toEqual({ clientId: "c2", periodType: "MONTHLY", month: 11, year: 2025, type: "SALE" });
  });

  it("trimestral: cualquier mes del trimestre da su primer mes", () => {
    expect(parseExportPageParams({ periodType: "QUARTERLY", month: "8", year: "2026" }, clients, may))
      .toMatchObject({ periodType: "QUARTERLY", month: 7, year: 2026 });
    // Sin periodo: el trimestre anterior.
    expect(parseExportPageParams({ periodType: "QUARTERLY" }, clients, may)).toMatchObject({ month: 1, year: 2026 });
  });

  it("un cliente que no es de la asesoría no se usa", () => {
    expect(parseExportPageParams({ clientId: "de-otra" }, clients, may).clientId).toBe("c1");
    expect(parseExportPageParams({ clientId: "de-otra" }, [], may).clientId).toBe("");
  });

  it("lo que no vale se ignora, sin romper la pantalla", () => {
    expect(parseExportPageParams({ periodType: "ANUAL", month: "13", year: "2026", type: "OTRO" }, clients, may))
      .toEqual({ clientId: "c1", periodType: "MONTHLY", month: 4, year: 2026, type: "ALL" });
    // Solo el mes: el periodo anterior entero, no un mes de otro año.
    expect(parseExportPageParams({ month: "2" }, clients, may)).toMatchObject({ month: 4, year: 2026 });
    expect(parseExportPageParams({ month: "abc", year: "1900" }, clients, may)).toMatchObject({ month: 4, year: 2026 });
  });

  it("parámetros repetidos: el primero", () => {
    expect(parseExportPageParams({ clientId: ["c2", "c1"], month: ["3", "4"], year: "2026" }, clients, may))
      .toMatchObject({ clientId: "c2", month: 3 });
  });

  it("el enlace se lee igual que se escribe", () => {
    const selection = { clientId: "c2", periodType: "QUARTERLY" as const, month: 7, year: 2026, type: "PURCHASE" as const };
    const href = exportPageHref(selection);
    expect(href.startsWith("/dashboard/admin/export?")).toBe(true);
    const params = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseExportPageParams(params, clients, may)).toEqual(selection);
  });
});
