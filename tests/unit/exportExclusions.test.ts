import { describe, it, expect } from "vitest";
import {
  countExportExclusions,
  describeExportExclusions,
  exportExclusionReason,
  exportSuccessExclusionText,
  parseExportExclusionCounts,
  countExportExclusionBoxes,
  describeExportExclusionBoxes,
  parseExportExclusionBoxes,
  withSplitCounts,
} from "@/lib/exportExclusions";

describe("exportExclusionReason", () => {
  it("sin hijas y con importe va al Excel", () => {
    expect(exportExclusionReason({ totalAmount: 121 })).toBeNull();
    expect(exportExclusionReason({ totalAmount: "121.00", _count: { splitInvoices: 0 } })).toBeNull();
  });

  it("con hijas se queda fuera aunque tenga importe", () => {
    expect(exportExclusionReason({ totalAmount: 121, _count: { splitInvoices: 3 } })).toBe("dividida");
  });

  it("total 0 se queda fuera; un total vacío no es «total 0» (lo decide sin_total)", () => {
    expect(exportExclusionReason({ totalAmount: 0 })).toBe("total_cero");
    expect(exportExclusionReason({ totalAmount: null })).toBeNull();
  });
});

describe("countExportExclusions y describeExportExclusions", () => {
  it("cuenta por motivo", () => {
    expect(countExportExclusions(["total_cero", "dividida", "total_cero", "bloqueante"])).toEqual({ total_cero: 2, dividida: 1, bloqueante: 1 });
    expect(countExportExclusions([])).toEqual({ total_cero: 0, dividida: 0, bloqueante: 0 });
  });

  it("describe el desglose en singular y plural", () => {
    expect(describeExportExclusions({ total_cero: 2, dividida: 1 })).toBe("2 con total 0 y 1 dividida en otras facturas");
    expect(describeExportExclusions({ dividida: 2 })).toBe("2 divididas en otras facturas");
    expect(describeExportExclusions({ total_cero: 1, dividida: 0 })).toBe("1 con total 0");
    expect(describeExportExclusions({ bloqueante: 1 })).toBe("1 con errores que impiden exportarla");
    expect(describeExportExclusions({ total_cero: 2, dividida: 1, bloqueante: 3 }))
      .toBe("2 con total 0, 1 dividida en otras facturas y 3 con errores que impiden exportarlas");
    expect(describeExportExclusions({})).toBeNull();
  });
});

describe("parseExportExclusionCounts", () => {
  it("lee la cabecera que manda la descarga", () => {
    expect(parseExportExclusionCounts(JSON.stringify({ total_cero: 1, dividida: 2 }))).toEqual({ total_cero: 1, dividida: 2 });
  });

  it.each([null, "", "no es json", "[1,2]", "null", '{"total_cero":"2","dividida":-1,"otro":5}'])(
    "un valor raro (%j) no rompe el aviso: sin desglose",
    (raw) => {
      expect(parseExportExclusionCounts(raw)).toEqual({});
    },
  );
});

describe("withSplitCounts", () => {
  it("marca como divididas solo las que tienen hijas, sin tocar lo demás", () => {
    const rows = [{ id: "a", totalAmount: 121 }, { id: "b", totalAmount: 121 }];
    const marked = withSplitCounts(rows, new Set(["b"]));
    expect(marked.map((r) => r._count.splitInvoices)).toEqual([0, 1]);
    expect(marked.map(exportExclusionReason)).toEqual([null, "dividida"]);
    expect(marked[0]).toMatchObject(rows[0]);
  });
});

describe("resumen por caja (revisión 2 del PR #7)", () => {
  it("cuenta y describe por caja, no por motivo", () => {
    expect(countExportExclusionBoxes(["corregir", "fuera", "corregir"])).toEqual({ corregir: 2, fuera: 1 });
    expect(describeExportExclusionBoxes({ corregir: 2, fuera: 1 })).toBe("2 que hay que corregir y 1 que no va a A3");
    expect(describeExportExclusionBoxes({ fuera: 2 })).toBe("2 que no van a A3");
    expect(describeExportExclusionBoxes({})).toBeNull();
  });

  it("lee la cabecera y descarta lo raro", () => {
    expect(parseExportExclusionBoxes(JSON.stringify({ corregir: 1, fuera: 2 }))).toEqual({ corregir: 1, fuera: 2 });
    expect(parseExportExclusionBoxes("roto")).toEqual({});
    expect(parseExportExclusionBoxes(JSON.stringify({ corregir: -1, fuera: "2" }))).toEqual({});
  });
});

describe("exportSuccessExclusionText", () => {
  it("por caja: las de corregir siguen pendientes; las de fuera, no", () => {
    expect(exportSuccessExclusionText({ excluded: 1, boxes: { corregir: 1 } }))
      .toBe(" 1 factura se ha quedado fuera y sigue pendiente hasta que la corrijas.");
    expect(exportSuccessExclusionText({ excluded: 2, boxes: { fuera: 2 } }))
      .toBe(" 2 facturas se han quedado fuera del Excel: no van a A3 y no hay nada que hacer con ellas.");
    expect(exportSuccessExclusionText({ excluded: 3, boxes: { corregir: 2, fuera: 1 } })).toBe(
      " 2 facturas se han quedado fuera y siguen pendientes hasta que las corrijas."
      + " 1 factura se ha quedado fuera del Excel: no va a A3 y no hay nada que hacer con ella.",
    );
  });

  it("sin desglose por caja, el total; sin ninguna, nada", () => {
    expect(exportSuccessExclusionText({ excluded: 2, boxes: {} })).toBe(" 2 facturas se han quedado fuera del Excel.");
    expect(exportSuccessExclusionText({ excluded: 0, boxes: {} })).toBe("");
  });
});
