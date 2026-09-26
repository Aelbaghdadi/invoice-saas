import { describe, it, expect } from "vitest";
import { exportInvoiceWhere, exportPostHeadersError, parseExportRequest, type ExportRequest } from "@/lib/exportRequest";

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

describe("exportPostHeadersError", () => {
  const base = {
    contentType: "application/json",
    secFetchSite: "same-origin",
    origin: "https://app.faktury.es",
    host: "app.faktury.es",
    forwardedHost: null,
  };

  it("deja pasar la petición de la propia app", () => {
    expect(exportPostHeadersError(base)).toBeNull();
    expect(exportPostHeadersError({ ...base, contentType: "Application/JSON; charset=utf-8" })).toBeNull();
  });

  it.each(["text/plain;x=application/json", "text/plain", "multipart/form-data", "", null])(
    "rechaza Content-Type %j",
    (contentType) => {
      expect(exportPostHeadersError({ ...base, contentType })).toEqual({ status: 415, error: "Se esperaba JSON." });
    },
  );

  it("rechaza Sec-Fetch-Site distinto de same-origin", () => {
    for (const secFetchSite of ["cross-site", "same-site", "none"]) {
      expect(exportPostHeadersError({ ...base, secFetchSite })?.status).toBe(403);
    }
  });

  it("sin Sec-Fetch-Site mira Origin contra el host público (x-forwarded-host detrás del proxy)", () => {
    const noFetchSite = { ...base, secFetchSite: null, host: "10.0.1.5:3000" };
    expect(exportPostHeadersError({ ...noFetchSite, forwardedHost: "app.faktury.es" })).toBeNull();
    expect(exportPostHeadersError({ ...noFetchSite, forwardedHost: "app.faktury.es, 10.0.1.5" })).toBeNull();
    expect(exportPostHeadersError({ ...noFetchSite, forwardedHost: "otra.web" })?.status).toBe(403);
    expect(exportPostHeadersError({ ...noFetchSite, forwardedHost: null })?.status).toBe(403);
    expect(exportPostHeadersError({ ...base, secFetchSite: null, origin: "null" })?.status).toBe(403);
  });

  it("sin Sec-Fetch-Site ni Origin no rechaza: no hay con qué comparar", () => {
    expect(exportPostHeadersError({ ...base, secFetchSite: null, origin: null })).toBeNull();
  });
});
