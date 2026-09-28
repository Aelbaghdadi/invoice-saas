import { describe, it, expect } from "vitest";
import {
  awaitsExport,
  exportExclusionReason,
  exportSuccessExclusionText,
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
    expect(countExportExclusionBoxes(["corregir", "fuera", "corregir", "a_mano"])).toEqual({ corregir: 2, fuera: 1, a_mano: 1 });
    expect(describeExportExclusionBoxes({ corregir: 2, fuera: 1, a_mano: 1 }))
      .toBe("2 que hay que corregir, 1 que hay que registrar a mano en A3 y 1 que no va a A3");
    expect(describeExportExclusionBoxes({ corregir: 2, fuera: 1 })).toBe("2 que hay que corregir y 1 que no va a A3");
    expect(describeExportExclusionBoxes({ fuera: 2 })).toBe("2 que no van a A3");
    expect(describeExportExclusionBoxes({})).toBeNull();
  });

  it("lee la cabecera y descarta lo raro", () => {
    expect(parseExportExclusionBoxes(JSON.stringify({ corregir: 1, fuera: 2 }))).toEqual({ corregir: 1, fuera: 2 });
    expect(parseExportExclusionBoxes(JSON.stringify({ a_mano: 1 }))).toEqual({ a_mano: 1 });
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

  it("las rectificativas a cero con importes: a mano en A3, una sola vez", () => {
    expect(exportSuccessExclusionText({ excluded: 1, boxes: { a_mano: 1 } })).toBe(
      " 1 factura se ha quedado fuera: es una rectificativa con total 0 que hay que registrar a mano en A3 (si ya lo has hecho, no la registres otra vez).",
    );
  });

  it("sin desglose por caja, el total; sin ninguna, nada", () => {
    expect(exportSuccessExclusionText({ excluded: 2, boxes: {} })).toBe(" 2 facturas se han quedado fuera del Excel.");
    expect(exportSuccessExclusionText({ excluded: 0, boxes: {} })).toBe("");
  });
});

describe("awaitsExport: el número de «Exportar (N)» en Lotes (revisión 1 del PR #13, punto 3)", () => {
  const validated = { status: "VALIDATED", exportBatchId: null, totalAmount: 121 };

  it("validada y sin lote: sí, también corregida después de exportarse", () => {
    expect(awaitsExport(validated, false)).toBe(true);
  });

  it("ya en un lote, sin validar o rechazada: no", () => {
    expect(awaitsExport({ ...validated, exportBatchId: "b1" }, false)).toBe(false);
    expect(awaitsExport({ ...validated, status: "PENDING_REVIEW" }, false)).toBe(false);
    expect(awaitsExport({ ...validated, status: "REJECTED" }, false)).toBe(false);
  });

  it("las que el Excel deja fuera para siempre (total 0, original dividida): no", () => {
    expect(awaitsExport({ ...validated, totalAmount: 0 }, false)).toBe(false);
    expect(awaitsExport({ ...validated, totalAmount: "0.00" }, false)).toBe(false);
    expect(awaitsExport(validated, true)).toBe(false);
  });

  it("sin total (bloqueante que se arregla): sí", () => {
    expect(awaitsExport({ ...validated, totalAmount: null }, false)).toBe(true);
  });
});
