import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Solo se simula Resend (servicio externo). Resend no lanza: devuelve
// { data, error }.
// Lo que responde el send de Resend en cada test.
let resendReply: (payload: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> =
  async () => ({ data: null, error: null });
// Envío en lote (F-040): cada llamada a batch.send, con su lista de correos.
const batchCalls: { to: string; subject: string }[][] = [];
let batchReply: () => Promise<unknown> = async () => ({ data: { data: [] }, error: null });
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (payload: unknown, options?: { signal?: AbortSignal }) => resendReply(payload, options) };
    batch = {
      send: (payload: { to: string; subject: string }[]) => {
        batchCalls.push(payload);
        return batchReply();
      },
    };
  },
}));

let email: typeof import("@/lib/email");

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.resetModules();
  email = await import("@/lib/email");
});

afterAll(() => vi.unstubAllEnvs());


describe("maskEmail", () => {
  it("deja la inicial y el dominio", () => {
    expect(email.maskEmail("ana.garcia@dominio.es")).toBe("a***@dominio.es");
    expect(email.maskEmail("x@y.com")).toBe("x***@y.com");
  });

  it("algo que no es un email no se muestra", () => {
    expect(email.maskEmail("sin-arroba")).toBe("***");
    expect(email.maskEmail("@dominio.es")).toBe("***");
  });
});

describe("envío con Resend", () => {
  const reset = { to: "ana@dominio.es", resetUrl: "https://app/login/reset-password?token=t" };

  it("sin error, ok", async () => {
    resendReply = async () => ({ data: { id: "1" }, error: null });
    expect(await email.sendPasswordResetEmail(reset)).toEqual({ ok: true });
  });

  it("con { error } (Resend no lanza) devuelve ok: false y lo registra enmascarado", async () => {
    resendReply = async () => ({ data: null, error: { name: "validation_error", message: "domain not verified" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await email.sendClientInvitationEmail({ to: "ana@dominio.es", clientName: "Ana", inviteUrl: "https://x" })).toEqual({ ok: false });
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("invitacion-cliente");
    expect(line).toContain("a***@dominio.es");
    expect(line).not.toContain("ana@dominio.es");
    expect(line).toContain("domain not verified");
    log.mockRestore();
  });

  it("con la red caída (Resend no lanza: devuelve application_error) devuelve ok: false", async () => {
    // La forma real de Resend 6.9.4 cuando fetch falla.
    resendReply = async () => ({
      data: null,
      error: { name: "application_error", statusCode: null, message: "Unable to fetch data. The request could not be resolved." },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await email.sendPasswordResetEmail(reset)).toEqual({ ok: false });
    expect(String(log.mock.calls[0][0])).toContain("application_error: Unable to fetch data");
    log.mockRestore();
  });

  it("si lanza (fallo inesperado del cliente), también ok: false", async () => {
    resendReply = async () => {
      throw new TypeError("fetch failed");
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await email.sendPasswordResetEmail(reset)).toEqual({ ok: false });
    expect(String(log.mock.calls[0][0])).toContain("restablecer-contrasena");
    log.mockRestore();
  });

  it("si Resend no responde, a los 10 s devuelve ok: false (la invitación no se queda colgada)", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    resendReply = (_payload, options) => {
      signal = options?.signal;
      return new Promise(() => {}); // acepta la conexión y no contesta
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = email.sendClientInvitationEmail({ to: "ana@dominio.es", clientName: "Ana", inviteUrl: "https://x" });
      await vi.advanceTimersByTimeAsync(email.EMAIL_TIMEOUT_MS);
      expect(await pending).toEqual({ ok: false });
      expect(String(log.mock.calls[0][0])).toContain("timeout");
      // Se le pasa a Resend un signal para que cancele la petición.
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it("el recordatorio de cierre registra el fallo, no lanza y devuelve ok: false", async () => {
    resendReply = async () => ({ data: null, error: { name: "rate_limit_exceeded", message: "too many" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // El recordatorio devuelve el resultado: el cron solo cuenta los enviados.
    await expect(email.sendClosureReminder({
      clientEmail: "cli@empresa.es", clientName: "Cliente", month: 9, year: 2026,
    })).resolves.toEqual({ ok: false });
    expect(String(log.mock.calls[0][0])).toContain("recordatorio-cierre");
    log.mockRestore();
  });
});

describe("aviso de subida a los gestores: envío en lote (F-040)", () => {
  const upload = (workerEmails: string[]) => email.notifyWorkersNewUpload({
    workerEmails, clientName: "Cliente SL", count: 5, periodMonth: 4, periodYear: 2026,
  });

  it("una llamada a batch.send para todos los gestores, con las 5 facturas en el asunto", async () => {
    batchCalls.length = 0;
    batchReply = async () => ({ data: { data: [] }, error: null });
    await upload(["ana@dominio.es", "luis@dominio.es", "eva@dominio.es"]);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].map((m) => m.to)).toEqual(["ana@dominio.es", "luis@dominio.es", "eva@dominio.es"]);
    expect(batchCalls[0][0].subject).toContain("5 facturas nuevas");
  });

  it("de 100 en 100 (el máximo de Resend)", async () => {
    batchCalls.length = 0;
    await upload(Array.from({ length: 150 }, (_, i) => `g${i}@dominio.es`));
    expect(batchCalls.map((c) => c.length)).toEqual([100, 50]);
  });

  it("un error del lote se registra enmascarado y no lanza", async () => {
    batchCalls.length = 0;
    batchReply = async () => ({ data: null, error: { name: "rate_limit_exceeded", message: "Too many requests" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(upload(["ana@dominio.es"])).resolves.toBeUndefined();
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("nuevas-facturas-gestor");
    expect(line).toContain("a***@dominio.es");
    expect(line).not.toContain("ana@dominio.es");
    log.mockRestore();
    batchReply = async () => ({ data: { data: [] }, error: null });
  });
});

describe("resumen del periodo al cliente (F-040)", () => {
  it("validadas, rechazadas con su motivo y pendientes; el motivo escapado", async () => {
    let sent: { to: string; subject: string; html: string } | null = null;
    resendReply = async (payload) => {
      sent = payload as typeof sent;
      return { data: { id: "1" }, error: null };
    };
    await email.notifyClientPeriodSummary({
      clientEmail: "cliente@dominio.es", clientName: "Cliente SL", periodType: "QUARTERLY", periodMonth: 7, periodYear: 2026,
      validated: 5, rejected: [{ ref: "F-9", reason: "Ilegible <script>" }], pending: 0,
    });
    expect(sent!.to).toBe("cliente@dominio.es");
    expect(sent!.subject).toBe("Resumen de T3 2026: 5 validadas, 1 rechazada");
    expect(sent!.html).toContain("F-9");
    expect(sent!.html).toContain("Ilegible &lt;script&gt;");
    expect(sent!.html).not.toContain("<script>");
  });
});

describe("sin RESEND_API_KEY", () => {
  it("no envía, cuenta como enviado y no deja el email completo en el log", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.resetModules();
    const sinClave = await import("@/lib/email");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await sinClave.sendPasswordResetEmail({ to: "ana@dominio.es", resetUrl: "https://x" })).toEqual({ ok: true });
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain("a***@dominio.es");
      expect(line).not.toContain("ana@dominio.es");
    } finally {
      log.mockRestore();
      vi.stubEnv("RESEND_API_KEY", "re_test");
    }
  });
});
