import { describe, it, expect } from "vitest";
import {
  countExportExclusions,
  describeExportExclusions,
  exportExclusionReason,
  parseExportExclusionCounts,
} from "@/lib/exportExclusions";

describe("exportExclusionReason", () => {
  it("sin hijas y con importe va al Excel", () => {
    expect(exportExclusionReason({ totalAmount: 121 })).toBeNull();
    expect(exportExclusionReason({ totalAmount: "121.00", _count: { splitInvoices: 0 } })).toBeNull();
  });

  it("con hijas se queda fuera aunque tenga importe", () => {
    expect(exportExclusionReason({ totalAmount: 121, _count: { splitInvoices: 3 } })).toBe("dividida");
  });

  it("total 0 (o nulo) se queda fuera", () => {
    expect(exportExclusionReason({ totalAmount: 0 })).toBe("total_cero");
    expect(exportExclusionReason({ totalAmount: null })).toBe("total_cero");
  });
});

describe("countExportExclusions y describeExportExclusions", () => {
  it("cuenta por motivo", () => {
    expect(countExportExclusions(["total_cero", "dividida", "total_cero"])).toEqual({ total_cero: 2, dividida: 1 });
    expect(countExportExclusions([])).toEqual({ total_cero: 0, dividida: 0 });
  });

  it("describe el desglose en singular y plural", () => {
    expect(describeExportExclusions({ total_cero: 2, dividida: 1 })).toBe("2 con total 0 y 1 dividida en otras facturas");
    expect(describeExportExclusions({ dividida: 2 })).toBe("2 divididas en otras facturas");
    expect(describeExportExclusions({ total_cero: 1, dividida: 0 })).toBe("1 con total 0");
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
