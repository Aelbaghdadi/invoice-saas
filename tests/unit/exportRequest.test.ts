import { describe, it, expect } from "vitest";
import { exportInvoiceWhere, parseExportRequest, type ExportRequest } from "@/lib/exportRequest";

const valid = { clientId: "c1", periodType: "MONTHLY", month: 4, year: 2026 };

describe("parseExportRequest", () => {
  it("acepta la petición de la pantalla, con strings de la URL o números del JSON", () => {
    expect(parseExportRequest(valid)).toEqual({
      ok: true,
      request: { ...valid, type: "ALL", format: "a3excel" },
    });
    expect(parseExportRequest({ ...valid, month: "4", year: "2026", type: "SALE" })).toMatchObject({
      ok: true,
      request: { month: 4, year: 2026, type: "SALE" },
    });
  });

  it("sin parámetros no exporta nada (antes consumía todo lo pendiente)", () => {
    const result = parseExportRequest({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Falta o no es válido: cliente, tipo de periodo, mes, año.");
  });

  it.each([
    [{ clientId: "" }, "cliente"],
    [{ clientId: "   " }, "cliente"],
    [{ month: 0 }, "mes"],
    [{ month: 13 }, "mes"],
    [{ year: "dos mil" }, "año"],
    [{ type: "OTRO" }, "tipo de factura"],
    [{ format: "sage50" }, "formato"],
  ])("rechaza %j", (override, field) => {
    const result = parseExportRequest({ ...valid, ...override });
    expect(result).toEqual({ ok: false, error: `Falta o no es válido: ${field}.` });
  });

  it("el trimestre se pide por su primer mes", () => {
    expect(parseExportRequest({ ...valid, periodType: "QUARTERLY", month: 7 }).ok).toBe(true);
    expect(parseExportRequest({ ...valid, periodType: "QUARTERLY", month: 5 })).toEqual({
      ok: false,
      error: "El trimestre se indica con su primer mes (1, 4, 7 o 10).",
    });
  });
});

describe("exportInvoiceWhere", () => {
  const request: ExportRequest = { clientId: "c1", periodType: "MONTHLY", month: 4, year: 2026, type: "ALL", format: "a3excel" };

  it("siempre dentro de la asesoría, del cliente y del periodo, y solo pendientes", () => {
    expect(exportInvoiceWhere(request, "firm1")).toEqual({
      status: "VALIDATED",
      exportBatchId: null,
      client: { advisoryFirmId: "firm1" },
      clientId: "c1",
      periodYear: 2026,
      periodMonth: 4,
    });
  });

  it("trimestral cubre los tres meses", () => {
    expect(exportInvoiceWhere({ ...request, periodType: "QUARTERLY", month: 10 }, "firm1").periodMonth)
      .toEqual({ gte: 10, lte: 12 });
  });

  it("filtra por sentido si se pide", () => {
    expect(exportInvoiceWhere({ ...request, type: "PURCHASE" }, "firm1").type).toBe("PURCHASE");
  });
});
