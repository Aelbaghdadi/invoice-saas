import { describe, it, expect } from "vitest";
import {
  autoTicketBody,
  autoTicketSubject,
  errorFingerprint,
  isIgnorableError,
  normalizeErrorMessage,
  normalizePath,
  stackFrames,
  type AutoTicketInput,
} from "@/lib/autoTicketText";

const server = (over: Partial<AutoTicketInput> = {}): AutoTicketInput => ({
  kind: "server",
  name: "TypeError",
  message: "Cannot read properties of null (reading 'name')",
  path: "/dashboard/worker/review/cmv4773bu000001o0t2b0vnwe?back=%2Fx",
  routePath: "/dashboard/worker/review/[id]",
  routeType: "render",
  method: "GET",
  ...over,
});

describe("huella del fallo", () => {
  it("el mismo fallo en otra factura u otro día es la misma huella", () => {
    const a = errorFingerprint(server({ message: "Invoice cmv4773bu000001o0t2b0vnwe not found (attempt 3)" }));
    const b = errorFingerprint(server({ message: "Invoice cmv9999zz000002p1t3c1wnxf not found (attempt 7)", path: "/dashboard/worker/review/cmv9999zz000002p1t3c1wnxf" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("otra clase de error, otro mensaje u otra pantalla son otra huella", () => {
    const base = errorFingerprint(server());
    expect(errorFingerprint(server({ name: "RangeError" }))).not.toBe(base);
    expect(errorFingerprint(server({ message: "otra cosa" }))).not.toBe(base);
    expect(errorFingerprint(server({ routePath: "/dashboard/admin/export" }))).not.toBe(base);
  });

  it("en el OCR cuenta el código y el estado HTTP, no el cuerpo (el 403 de facturación son N facturas, un problema)", () => {
    const ocr = (status: number, message: string): AutoTicketInput =>
      ({ kind: "ocr", code: "ERR-OCR-001", name: "OcrHttpError", httpStatus: status, message });
    expect(errorFingerprint(ocr(403, 'Gemini Flash respondió 403: {"message":"projects/209986378072"}')))
      .toBe(errorFingerprint(ocr(403, "Gemini Flash respondió 403: otro cuerpo")));
    expect(errorFingerprint(ocr(403, "x"))).not.toBe(errorFingerprint(ocr(429, "x")));
  });

  it("los datos personales y lo que cambia no entran en la huella", () => {
    expect(normalizeErrorMessage('Cliente "Ana Pérez" ana@correo.es B12345674 falló 3 veces en 2026-10-26'))
      .toBe('Cliente "…" [email] [nif] falló # veces en #-#-#');
    expect(normalizePath("/dashboard/admin/clients/cmrrocmxk000w29p3zjwp5hsz?tab=ajustes")).toBe("/dashboard/admin/clients/:id");
  });
});

describe("texto del ticket", () => {
  it("el asunto dice de dónde viene y cabe en el tope", () => {
    // Lo entrecomillado se quita (scrubMessage): puede ser un dato personal.
    expect(autoTicketSubject(server())).toBe("Error del servidor · TypeError: Cannot read properties of null (reading '…')");
    expect(autoTicketSubject({ kind: "ocr", code: "ERR-OCR-001", name: "OcrHttpError", httpStatus: 403, message: "x" }))
      .toBe("Error del OCR (ERR-OCR-001) · OcrHttpError 403");
    expect(autoTicketSubject(server({ message: "x".repeat(300) })).length).toBeLessThanOrEqual(120);
  });

  it("el detalle lleva dónde, quién, la ruta sin ids ni parámetros y la traza limpia", () => {
    const body = autoTicketBody(
      server({
        digest: "123456",
        stack: "TypeError: Cannot read ana@correo.es\n    at render (.next/server/chunks/a.js:1:2)\n    at async x (.next/b.js:3:4)",
        userAgent: "Mozilla/5.0",
      }),
      { firmName: "Gestoría Demo", userName: "Dev", at: new Date("2026-10-26T10:00:00Z") },
    );
    expect(body).toContain("Error del servidor detectado automáticamente.");
    expect(body).toContain("Dónde: al pintar una pantalla");
    expect(body).toContain("Ruta: GET /dashboard/worker/review/:id");
    expect(body).toContain("Asesoría: Gestoría Demo");
    expect(body).toContain("Usuario: Dev");
    expect(body).toContain("at render (.next/server/chunks/a.js:1:2)");
    // La primera linea de la traza repite el mensaje sin limpiar: no va.
    expect(body).not.toContain("ana@correo.es");
  });

  it("sin sesión lo dice", () => {
    const body = autoTicketBody(server(), { at: new Date() });
    expect(body).toContain("Asesoría: sin sesión");
    expect(body).toContain("Usuario: sin sesión");
  });

  it("la traza: solo las líneas «at», como mucho 8", () => {
    const stack = ["Error: x", ...Array.from({ length: 12 }, (_, i) => `    at f${i} (a.js:${i}:1)`)].join("\n");
    expect(stackFrames(stack)).toHaveLength(8);
    expect(stackFrames(null)).toEqual([]);
  });
});

describe("lo que no es un fallo de la app", () => {
  it("una petición cortada por el usuario no abre ticket", () => {
    expect(isIgnorableError("AbortError", "The operation was aborted")).toBe(true);
    expect(isIgnorableError("Error", "aborted")).toBe(true);
    expect(isIgnorableError("Error", "read ECONNRESET")).toBe(true);
    expect(isIgnorableError("TypeError", "Cannot read properties of null")).toBe(false);
  });
});
