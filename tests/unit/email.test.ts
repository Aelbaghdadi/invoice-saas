import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Solo se simula Resend (servicio externo). Resend no lanza: devuelve
// { data, error }.
// Lo que responde el send de Resend en cada test.
let resendReply: (payload: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> =
  async () => ({ data: null, error: null });
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (payload: unknown, options?: { signal?: AbortSignal }) => resendReply(payload, options) };
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

  it("si lanza (red caída), también ok: false", async () => {
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

  it("el resto de correos solo registran el fallo, sin lanzar", async () => {
    resendReply = async () => ({ data: null, error: { name: "rate_limit_exceeded", message: "too many" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(email.sendClosureReminder({
      clientEmail: "cli@empresa.es", clientName: "Cliente", month: 9, year: 2026,
    } as Parameters<typeof email.sendClosureReminder>[0])).resolves.toBeUndefined();
    expect(String(log.mock.calls[0][0])).toContain("recordatorio-cierre");
    log.mockRestore();
  });
});
