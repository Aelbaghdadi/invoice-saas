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

  it("NIF con prefijo ES y separadores, IBAN con guiones, teléfonos con espacios", () => {
    expect(scrubMessage("ESB12345674 B-12345674 12345678-Z X-1234567-L es 12345678z")).toBe("[nif] [nif] [nif] [nif] [nif]");
    expect(scrubMessage("iban ES91-2100-0418-4502-0005-1332")).toBe("iban [iban]");
    expect(scrubMessage("tel 612 345 678 o +34 612 34 56 78")).toBe("tel [tel] o [tel]");
  });

  it("DNI con puntos y teléfonos con puntos o guiones", () => {
    expect(scrubMessage("DNI 12.345.678-Z")).toBe("DNI [nif]");
    expect(scrubMessage("tel 612-345-678 o 612.34.56.78")).toBe("tel [tel] o [tel]");
    expect(scrubMessage("612-345-678 612.34.56.78")).toBe("[tel] [tel]");
  });

  it("no toma por teléfono una IP, un importe, una fecha ni un fichero", () => {
    expect(scrubMessage("ETIMEDOUT 172.31.45.123:5432")).toBe("ETIMEDOUT 172.31.45.123:5432");
    expect(scrubMessage("total 12.345.678,90")).toBe("total 12.345.678,90");
    expect(scrubMessage("el 28.09.26")).toBe("el 28.09.26");
    expect(scrubMessage("chunk-12-34-56.js")).toBe("chunk-12-34-56.js");
  });

  it("un UUID no es un IBAN; fechas y horas quedan", () => {
    expect(scrubMessage("lote ab12cd34-ef56-7890-ab12-cd34ef567890 el 2026-09-28 a las 12:30")).toBe("lote ab12cd34-ef56-7890-ab12-cd34ef567890 el 2026-09-28 a las 12:30");
  });

  it("comillas simples: solo las que no van pegadas a una palabra", () => {
    expect(scrubMessage("Can't resolve 'x' in 'y'")).toBe("Can't resolve '…' in '…'");
    expect(scrubMessage("O'Brien no existe")).toBe("O'Brien no existe");
  });

  it("una comilla doble sin cerrar (mensaje recortado) se quita hasta el final", () => {
    expect(scrubMessage('issuerName: "Ana Pérez Gar')).toBe('issuerName: "…"');
  });

  it("100 KB se limpian en menos de 50 ms", () => {
    const big = ('"' + "a".repeat(99) + " ").repeat(1000);
    const t0 = performance.now();
    scrubMessage(big);
    scrubMessage("'".repeat(100_000));
    scrubMessage("1 ".repeat(50_000));
    // Sin «@», la de correos prueba desde cada posicion hasta el final:
    // cuadratica sin el recorte previo.
    scrubMessage("a".repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(50);
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

  it("ventana deslizante: en ningún tramo de windowMs salen más de N (antes, 2N en el cambio de ventana)", () => {
    const l = createAlertLimiter(10, 300_000);
    let sent = 0;
    for (let t = 299_000; t < 301_000; t += 100) if (l.take(t)) sent++;
    expect(sent).toBe(10);
  });

  it("si el reloj retrocede, no se quedan bloqueados los avisos", () => {
    const l = createAlertLimiter(2, 60_000);
    l.take(1_000_000);
    l.take(1_000_001);
    expect(l.take(5)).toEqual({ suppressedBefore: 0 });
  });
});

describe("reportRequestError", () => {
  it("webhook que responde 410: aviso en el log, sin lanzar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("gone", { status: 410 }));
    const { delivery } = await reportRequestError(new Error("x"), req, ctx, {
      log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter: createAlertLimiter(5, 1000),
    });
    await delivery;
    expect(warn).toHaveBeenCalledWith("[alert] el webhook respondio 410");
    warn.mockRestore();
  });

  it("no espera al webhook: vuelve con el POST aún en curso", async () => {
    let finish!: () => void;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { finish = () => resolve(new Response(null)); }));
    const { delivery } = await reportRequestError(new Error("x"), req, ctx, {
      log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter: createAlertLimiter(5, 1000),
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    finish();
    await delivery;
  });

  it("un texto por servicio: Slack/Mattermost escapado y sin menciones, Discord sin escapar y recortado", async () => {
    const fetchFn = vi.fn(async () => new Response(null));
    const long = "x".repeat(3000);
    const { delivery } = await reportRequestError(new Error("a < b && @channel @all @here"), { path: `/api/${long}`, method: "GET" }, ctx, {
      log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter: createAlertLimiter(5, 1000),
    });
    await delivery;
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("a &lt; b &amp;&amp; @\u200bchannel @\u200ball @\u200bhere");
    expect(body.content).toContain("a < b && @channel");
    expect(body.content.length).toBeLessThanOrEqual(1900);
    // La ruta, recortada: el texto entero cabe en Discord.
    expect(body.path).toHaveLength(200);
  });

  it("sin menciones: <!channel> y @everyone no llegan como tales", async () => {
    const fetchFn = vi.fn(async () => new Response(null));
    const { delivery } = await reportRequestError(new Error("<!channel> @everyone & co"), req, ctx, {
      log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter: createAlertLimiter(5, 1000),
    });
    await delivery;
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("&lt;!channel&gt; @\u200beveryone &amp; co");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

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
    await (await reportRequestError(new Error("uno"), req, ctx, deps)).delivery;
    await (await reportRequestError(new Error("dos"), req, ctx, deps)).delivery;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toBe("Error en FacturOCR: POST /dashboard/worker/review/abc — Error: uno");
  });

  it("si el webhook falla, no lanza", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("red"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { delivery } = await reportRequestError(new Error("x"), req, ctx, {
      log: () => {}, fetchFn: fetchFn as unknown as typeof fetch, webhookUrl: "https://alertas.example/hook", limiter: createAlertLimiter(5, 1000),
    });
    await expect(delivery).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
