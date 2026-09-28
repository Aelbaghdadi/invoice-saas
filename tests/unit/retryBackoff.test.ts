import { describe, it, expect } from "vitest";
import { parseRetryAfter, retryDelayMs, RETRY_AFTER_MAX_MS, RETRY_MAX_MS } from "@/lib/retryBackoff";

describe("parseRetryAfter (F-029)", () => {
  const now = Date.parse("2026-09-28T19:00:00Z");

  it("en segundos", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("en fecha HTTP", () => {
    expect(parseRetryAfter("Mon, 28 Sep 2026 19:00:30 GMT", now)).toBe(30_000);
    // Una fecha ya pasada: sin esperar.
    expect(parseRetryAfter("Mon, 28 Sep 2026 18:59:00 GMT", now)).toBe(0);
  });

  it("sin cabecera o ilegible: null", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("pronto", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("retryDelayMs (F-029)", () => {
  it("exponencial con jitter: entre la mitad y el techo de cada intento", () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(500);
    expect(retryDelayMs(1, null, () => 1)).toBe(1000);
    expect(retryDelayMs(2, null, () => 0)).toBe(1000);
    expect(retryDelayMs(3, null, () => 1)).toBe(4000);
  });

  it("con tope", () => {
    expect(retryDelayMs(20, null, () => 1)).toBe(RETRY_MAX_MS);
  });

  it("el jitter reparte: dos facturas no esperan lo mismo", () => {
    expect(retryDelayMs(2, null, () => 0.1)).not.toBe(retryDelayMs(2, null, () => 0.9));
  });

  it("Retry-After manda, con su propio tope", () => {
    expect(retryDelayMs(1, 7_000, () => 0)).toBe(7_000);
    expect(retryDelayMs(1, 3_600_000)).toBe(RETRY_AFTER_MAX_MS);
  });
});
