import { describe, it, expect, vi, afterEach } from "vitest";
import { extractFromDocumentWithGemini } from "@/lib/ocrLlm";
import { OcrHttpError } from "@/lib/ocrErrors";

// Solo se simula la red (Gemini es un servicio externo).
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const reply429 = (body: unknown, headers: Record<string, string> = {}) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 429, headers })));

describe("429 de Gemini: la espera del cuerpo o de la cabecera (revisión 1 del PR #14, punto 5)", () => {
  const body = {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }],
    },
  };

  it("sin cabecera, retryDelay del cuerpo", async () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    reply429(body);
    const err = await extractFromDocumentWithGemini("aGVsbG8=", "image/jpeg").catch((e) => e);
    expect(err).toBeInstanceOf(OcrHttpError);
    expect([err.status, err.retryAfterMs]).toEqual([429, 37_000]);
  });

  it("con Retry-After, la cabecera manda", async () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    reply429(body, { "retry-after": "5" });
    const err = await extractFromDocumentWithGemini("aGVsbG8=", "image/jpeg").catch((e) => e);
    expect(err.retryAfterMs).toBe(5_000);
  });
});
