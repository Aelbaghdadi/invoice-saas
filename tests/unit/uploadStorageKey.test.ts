import { describe, it, expect } from "vitest";
import { originalAttachmentKey, uploadPeriodSegment, uploadStorageKey } from "@/lib/uploadStorageKey";

const monthly = { clientId: "client1", periodType: "MONTHLY" as const, periodMonth: 9, periodYear: 2026 };
const quarterly = { clientId: "client1", periodType: "QUARTERLY" as const, periodMonth: 8, periodYear: 2026 };

describe("uploadStorageKey", () => {
  it("cliente, periodo, instante, identificador único y nombre", () => {
    expect(uploadStorageKey(monthly, "factura.pdf", { now: 1000, unique: "u-1" })).toBe("client1/2026-09/1000-u-1-factura.pdf");
  });

  it("la resubida lleva su etiqueta detrás del identificador", () => {
    expect(uploadStorageKey(monthly, "corregida.pdf", { tag: "reupload", now: 1000, unique: "u-1" }))
      .toBe("client1/2026-09/1000-u-1-reupload-corregida.pdf");
  });

  it("mismo nombre en el mismo milisegundo: claves distintas y el mismo prefijo cliente/periodo", () => {
    const now = 1_790_000_000_000;
    const a = uploadStorageKey(monthly, "scan.pdf", { now });
    const b = uploadStorageKey(monthly, "scan.pdf", { now });
    expect(a).not.toBe(b);
    for (const key of [a, b]) {
      expect(key.startsWith(`client1/2026-09/${now}-`)).toBe(true);
      expect(key.endsWith("-scan.pdf")).toBe(true);
    }
  });

  it("también en la resubida", () => {
    const now = 1_790_000_000_000;
    expect(uploadStorageKey(monthly, "a.pdf", { tag: "reupload", now }))
      .not.toBe(uploadStorageKey(monthly, "a.pdf", { tag: "reupload", now }));
  });

  it("un lote trimestral va en la carpeta de su trimestre", () => {
    expect(uploadPeriodSegment(quarterly)).toBe("2026-T3");
    expect(uploadStorageKey(quarterly, "a.pdf", { now: 5, unique: "x" })).toBe("client1/2026-T3/5-x-a.pdf");
  });
});

describe("originalAttachmentKey (anexo C19)", () => {
  it("bajo el prefijo del cliente (lo borra el reset de la demo), en originales/, con instante e identificador", () => {
    expect(originalAttachmentKey("client1", "factura.docx", { now: 1000, unique: "u-1" })).toBe("client1/originales/1000-u-1-factura.docx");
  });

  it("el mismo nombre en el mismo milisegundo no comparte objeto", () => {
    const now = 1_790_000_000_000;
    const a = originalAttachmentKey("client1", "factura.doc", { now });
    const b = originalAttachmentKey("client1", "factura.doc", { now });
    expect(a).not.toBe(b);
    for (const key of [a, b]) expect(key).toMatch(/^client1\/originales\/1790000000000-[0-9a-f-]{36}-factura\.doc$/);
  });
});
