import { describe, it, expect } from "vitest";
import { duplicateField, duplicateOriginalId, duplicateRejectionReason, normalizeInvoiceNumber } from "@/lib/duplicates";

describe("normalizeInvoiceNumber (F-010)", () => {
  it("mayúsculas, sin espacios ni separadores", () => {
    for (const n of ["F-001", "F 001", "f001", "F/001", " f.001 "]) expect(normalizeInvoiceNumber(n), n).toBe("F001");
  });

  it("solo ASCII: lo demás se quita antes de pasar a mayúsculas (igual que en Postgres)", () => {
    expect(normalizeInvoiceNumber("Nº 12")).toBe("N12");
    expect(normalizeInvoiceNumber("ß-1")).toBe("1");
    expect(normalizeInvoiceNumber("ﬁ-2")).toBe("2");
    expect(normalizeInvoiceNumber("ı-3")).toBe("3");
    expect(normalizeInvoiceNumber("Ñ-4")).toBe("4");
  });

  // Decisiones, no fallos (revisión 1 del PR #10, punto 9): ver el comentario
  // de normalizeInvoiceNumber.
  it("decisión: al quitar separadores, «2026-1-15» y «2026-11-5» son el mismo número", () => {
    expect(normalizeInvoiceNumber("2026-1-15")).toBe(normalizeInvoiceNumber("2026-11-5"));
  });

  it("decisión: los ceros a la izquierda cuentan, «0042» no es «42»", () => {
    expect(normalizeInvoiceNumber("0042")).not.toBe(normalizeInvoiceNumber("42"));
  });

  it("vacío o nulo: cadena vacía", () => {
    expect(normalizeInvoiceNumber(null)).toBe("");
    expect(normalizeInvoiceNumber(" - ")).toBe("");
  });
});

describe("duplicateField / duplicateOriginalId", () => {
  it("guardan y leen la factura original en el field de la incidencia", () => {
    expect(duplicateOriginalId(duplicateField("inv-7"))).toBe("inv-7");
    expect(duplicateOriginalId("taxBase")).toBeNull();
    expect(duplicateOriginalId(null)).toBeNull();
  });
});

describe("duplicateRejectionReason (el motivo que recibe el cliente)", () => {
  it("con la original: la nombra", () => {
    expect(duplicateRejectionReason({
      invoiceNumber: "F-100", filename: "a.pdf", createdAt: new Date("2026-09-10T10:00:00Z"),
      periodType: "MONTHLY", periodMonth: 9, periodYear: 2026, status: "VALIDATED",
    })).toMatch(/^Factura duplicada: ya recibimos la factura F-100 subida el 10\/09\/2026 \(/);
  });

  it.each(["REJECTED", "SPLIT_SOURCE"] as const)("con la original %s: no la nombra", (status) => {
    expect(duplicateRejectionReason({
      invoiceNumber: "F-100", filename: "a.pdf", createdAt: new Date("2026-09-10T10:00:00Z"),
      periodType: "MONTHLY", periodMonth: 9, periodYear: 2026, status,
    })).toBe("Factura duplicada: ya la habíamos recibido.");
  });

  it("sin la original", () => {
    expect(duplicateRejectionReason(null)).toBe("Factura duplicada: ya la habíamos recibido.");
  });
});
