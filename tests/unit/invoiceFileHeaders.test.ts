import { describe, it, expect } from "vitest";
import { invoiceFileHeaders } from "@/lib/invoiceFileHeaders";
import { filenameFromContentDisposition } from "@/lib/contentDisposition";
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

  it("descarga el XML como binario con el nombre con el que se subió", () => {
    expect(invoiceFileHeaders("application/xml", "inv1", "factura_proveedor.xml")).toEqual({
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        "attachment; filename=\"factura_proveedor.xml\"; filename*=UTF-8''factura_proveedor.xml",
    });
  });

  it("conserva un nombre con tildes o comillas en filename* y lo deja ASCII en filename", () => {
    const header = invoiceFileHeaders("application/xml", "inv1", 'Factura "Añil" 3–2026.xml')[
      "Content-Disposition"
    ];
    expect(header).toBe(
      "attachment; filename=\"Factura_Anil_3_2026.xml\"; " +
        "filename*=UTF-8''Factura%20%22A%C3%B1il%22%203%E2%80%932026.xml",
    );
    expect(filenameFromContentDisposition(header, "x")).toBe('Factura "Añil" 3–2026.xml');
  });

  it.each([undefined, null, "", "   "])("sin nombre (%j) usa factura_<id>.xml", (filename) => {
    expect(invoiceFileHeaders("application/xml", "inv1", filename)["Content-Disposition"]).toBe(
      "attachment; filename=\"factura_inv1.xml\"; filename*=UTF-8''factura_inv1.xml",
    );
  });

  it("los tipos inline no llevan nombre aunque lo haya", () => {
    expect(invoiceFileHeaders("application/pdf", "inv1", "factura.pdf")["Content-Disposition"]).toBe(
      "inline",
    );
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
      "Content-Disposition": "attachment; filename=\"factura_inv1\"; filename*=UTF-8''factura_inv1",
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
