import { describe, it, expect, vi } from "vitest";
import { buildErrorReport, createAlertLimiter, reportRequestError, scrubMessage } from "@/lib/errorReporting";

const req = { path: "/dashboard/worker/review/abc?q=ana@ejemplo.es", method: "POST" };
const ctx = { routePath: "/dashboard/worker/review/[id]", routeType: "action" };

describe("scrubMessage (F-034): sin datos personales", () => {
  it("quita correos, NIF/CIF/NIE, IBAN y números largos", () => {
    expect(scrubMessage("Usuario ana.perez@ejemplo.es no encontrado")).toBe("Usuario [email] no encontrado");
    expect(scrubMessage("NIF 12345678Z, CIF B12345674, NIE X1234567L")).toBe("NIF [nif], CIF [nif], NIE [nif]");
    expect(scrubMessage("IBAN ES9121000418450200051332")).toBe("IBAN [iban]");
    expect(scrubMessage("teléfono 612345678901")).toBe("teléfono [num]");
  });

  it("NIF con prefijo ES y separadores, IBAN con guiones o en minúsculas, teléfonos con espacios", () => {
    expect(scrubMessage("ESB12345674 B-12345674 12345678-Z X-1234567-L es 12345678z")).toBe("[nif] [nif] [nif] [nif] [nif]");
    expect(scrubMessage("iban es91-2100-0418-4502-0005-1332")).toBe("iban [iban]");
    expect(scrubMessage("tel 612 345 678 o +34 612 34 56 78")).toBe("tel [tel] o [tel]");
  });

  it("un PrismaClientValidationError real no deja pasar los argumentos", () => {
    const prisma = [
      "Invalid `prisma.invoice.update()` invocation:",
      "{", '  where: { id: "cmg1abc" },', "  data: {",
      '    issuerName: "Ana Pérez García",', '    issuerCif: "ESB12345674",', '    receiverName: "O\'Brien \\"Pepe\\" SL",',
      "    totalAmount: \"121,00\"", "  }", "}",
      "Argument `totalAmount`: Invalid value provided. Expected Decimal, provided String.",
    ].join("\n");
    const out = scrubMessage(prisma);
    expect(out).not.toMatch(/Ana|Pérez|B12345674|Brien|Pepe|121,00/);
    expect(out).toContain("Invalid `prisma.invoice.update()` invocation");
  });

  it("recorta los mensajes largos", () => {
    expect(scrubMessage("x".repeat(1000))).toHaveLength(300);
  });
});

describe("buildErrorReport", () => {
  it("ruta sin query, método, ruta del fichero, digest y mensaje limpio; sin cabeceras", () => {
    const err = Object.assign(new Error("fallo con ana@ejemplo.es"), { digest: "123abc" });
    const report = buildErrorReport(err, { ...req, headers: { cookie: "secreto" } } as never, ctx, new Date("2026-09-28T02:00:00Z"));
    expect(report).toEqual({
      level: "error", time: "2026-09-28T02:00:00.000Z", path: "/dashboard/worker/review/abc", method: "POST",
      routePath: "/dashboard/worker/review/[id]", routeType: "action", digest: "123abc", name: "Error", message: "fallo con [email]",
    });
    expect(JSON.stringify(report)).not.toMatch(/secreto|cookie/);
  });

  it("algo que no es un Error", () => {
    expect(buildErrorReport("cadena", req, {}).message).toBe("cadena");
  });
});

describe("createAlertLimiter", () => {
  it("como mucho N por ventana; los callados se dicen en el siguiente", () => {
    const l = createAlertLimiter(2, 1000);
    expect(l.take(0)).toEqual({ suppressedBefore: 0 });
    expect(l.take(10)).toEqual({ suppressedBefore: 0 });
    expect(l.take(20)).toBeNull();
    expect(l.take(30)).toBeNull();
    expect(l.take(1000)).toEqual({ suppressedBefore: 2 });
  });
});

describe("reportRequestError", () => {
  it("siempre una línea JSON en el log; sin ALERT_WEBHOOK_URL no llama a nada", async () => {
    const log = vi.fn();
    const fetchFn = vi.fn();
    await reportRequestError(new Error("x"), req, ctx, { log, fetchFn, webhookUrl: "" });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ level: "error", path: "/dashboard/worker/review/abc" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("con webhook: lo avisa, respetando el límite", async () => {
    const fetchFn = vi.fn(async () => new Response(null));
    const limiter = createAlertLimiter(1, 60_000);
    const deps = { log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter, now: new Date(0) };
    await reportRequestError(new Error("uno"), req, ctx, deps);
    await reportRequestError(new Error("dos"), req, ctx, deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toBe("Error en FacturOCR: POST /dashboard/worker/review/abc — Error: uno");
  });

  it("si el webhook falla, no lanza", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("red"); });
    await expect(reportRequestError(new Error("x"), req, ctx, {
      log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter: createAlertLimiter(5, 1000),
    })).resolves.toBeUndefined();
  });
});
