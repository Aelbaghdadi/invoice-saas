import { describe, it, expect } from "vitest";
import {
  asciiFilename,
  attachmentContentDisposition,
  filenameFromContentDisposition,
} from "@/lib/contentDisposition";
import { suggestFilename, type InvoiceWithClient } from "@/lib/exportFormats";

function exportName(clientName: string): string {
  const invoice = { client: { id: "c1", name: clientName } } as unknown as InvoiceWithClient;
  return suggestFilename([invoice], "a3excel", 4, 2026);
}

// Nombres de cliente que rompían la descarga del export (F-017).
const HOSTILE_CLIENT_NAMES = [
  "L’Esquirol SCP",
  "CAFÉ – BAR PEPE SL",
  "€uro Servicios SL",
  "Łódź Trading",
  "100% Natural SL",
  'Taller "El Rápido"; SL',
  "Pastelería 🍰 Dulce",
  "Ñandú (Ibérica)*",
];

describe("attachmentContentDisposition", () => {
  it.each(HOSTILE_CLIENT_NAMES)("con %j la cabecera cabe en un Response", (clientName) => {
    const header = attachmentContentDisposition(exportName(clientName));
    expect(() => new Response("x", { headers: { "Content-Disposition": header } })).not.toThrow();
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each(HOSTILE_CLIENT_NAMES)("con %j el nombre UTF-8 vuelve intacto", (clientName) => {
    const name = exportName(clientName);
    const header = new Response("x", {
      headers: { "Content-Disposition": attachmentContentDisposition(name) },
    }).headers.get("Content-Disposition");
    expect(filenameFromContentDisposition(header, "export.xlsx")).toBe(name);
  });

  it("manda filename ASCII y filename* codificado", () => {
    expect(attachmentContentDisposition("facturas_L’Esquirol_SCP_2026-04_a3excel.xlsx")).toBe(
      "attachment; " +
        'filename="facturas_L_Esquirol_SCP_2026-04_a3excel.xlsx"; ' +
        "filename*=UTF-8''facturas_L%E2%80%99Esquirol_SCP_2026-04_a3excel.xlsx",
    );
  });

  it("escapa en filename* los caracteres que RFC 5987 no admite sin codificar", () => {
    expect(attachmentContentDisposition("a'b(c)*.csv")).toContain("filename*=UTF-8''a%27b%28c%29%2A.csv");
  });

  it("no cambia un nombre que ya es ASCII seguro", () => {
    expect(attachmentContentDisposition("facturas_ACME_SL_2026-04_a3excel.xlsx")).toBe(
      'attachment; filename="facturas_ACME_SL_2026-04_a3excel.xlsx"; ' +
        "filename*=UTF-8''facturas_ACME_SL_2026-04_a3excel.xlsx",
    );
  });
});

describe("asciiFilename", () => {
  it("quita tildes y deja solo [A-Za-z0-9._-]", () => {
    expect(asciiFilename("facturas_CAFÉ_–_BAR_PEPE_SL_2026-04_a3excel.xlsx")).toBe(
      "facturas_CAFE_BAR_PEPE_SL_2026-04_a3excel.xlsx",
    );
    expect(asciiFilename("facturas_Ñandú_2026-04_sage50.csv")).toBe("facturas_Nandu_2026-04_sage50.csv");
  });

  it("nunca devuelve un nombre vacío", () => {
    expect(asciiFilename("€€€")).toBe("descarga");
  });
});

describe("filenameFromContentDisposition", () => {
  it("prefiere filename* a filename", () => {
    expect(
      filenameFromContentDisposition(
        "attachment; filename=\"a_b.xlsx\"; filename*=UTF-8''a%E2%80%99b.xlsx",
        "export.xlsx",
      ),
    ).toBe("a’b.xlsx");
  });

  it("usa filename si filename* está mal codificado, sin lanzar", () => {
    expect(
      filenameFromContentDisposition("attachment; filename=\"100_Natural.xlsx\"; filename*=UTF-8''100%_Natural.xlsx", "export.xlsx"),
    ).toBe("100_Natural.xlsx");
  });

  it("acepta filename sin comillas", () => {
    expect(filenameFromContentDisposition("attachment; filename=datos.csv", "export.xlsx")).toBe("datos.csv");
  });

  it("devuelve el nombre por defecto sin cabecera o sin nombre", () => {
    expect(filenameFromContentDisposition(null, "export.xlsx")).toBe("export.xlsx");
    expect(filenameFromContentDisposition("attachment", "export.xlsx")).toBe("export.xlsx");
  });
});
