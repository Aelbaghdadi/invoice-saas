import { describe, it, expect } from "vitest";
import { invoiceFileHeaders } from "@/lib/invoiceFileHeaders";
import nextConfig from "../../next.config";

describe("invoiceFileHeaders", () => {
  it.each(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"])(
    "sirve %s inline",
    (type) => {
      expect(invoiceFileHeaders(type, "inv1")).toEqual({
        "Content-Type": type,
        "Content-Disposition": "inline",
      });
    },
  );

  it("normaliza mayúsculas y parámetros antes de mirar la lista blanca", () => {
    expect(invoiceFileHeaders("Application/PDF; charset=binary", "inv1")).toEqual({
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
    });
  });

  it("descarga el XML como binario, nunca inline", () => {
    expect(invoiceFileHeaders("application/xml", "inv1")).toEqual({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="factura_inv1.xml"',
    });
  });

  it.each([
    "text/xml",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/html",
    "application/javascript",
    "",
  ])("descarga %j como attachment", (type) => {
    const headers = invoiceFileHeaders(type, "inv1");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Disposition"]).toMatch(/^attachment; /);
  });

  it("descarga cuando no hay tipo guardado", () => {
    expect(invoiceFileHeaders(null, "inv1")).toEqual({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="factura_inv1"',
    });
  });
});

describe("cabeceras de /api/invoices/[id]/raw en next.config", () => {
  it("aplica CSP sandbox y nosniff después de la entrada general", async () => {
    const entries = await nextConfig.headers!();
    const generalIndex = entries.findIndex((e) => e.source === "/(.*)");
    const rawIndex = entries.findIndex((e) => e.source === "/api/invoices/:id/raw");
    expect(generalIndex).toBeGreaterThanOrEqual(0);
    // Con la misma clave gana la última entrada: la de /raw tiene que ir detrás.
    expect(rawIndex).toBeGreaterThan(generalIndex);

    const raw = Object.fromEntries(entries[rawIndex].headers.map((h) => [h.key, h.value]));
    const directives = raw["Content-Security-Policy"].split(";").map((d) => d.trim());
    expect(directives).toContain("sandbox");
    expect(directives).toContain("default-src 'none'");
    expect(raw["X-Content-Type-Options"]).toBe("nosniff");
  });
});
