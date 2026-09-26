import { describe, it, expect } from "vitest";
import {
  MAX_OCR_RETRIES,
  STUCK_ANALYZING_MS,
  exhaustedAnalyzingWhere,
  isOcrStalled,
  manualStuckAnalyzingWhere,
  ocrFenceWhere,
  stuckAnalyzingCutoff,
  stuckAnalyzingWhere,
} from "@/lib/invoiceStatuses";

describe("ocrFenceWhere", () => {
  it("exige ANALYZING y el ocrAttempts del claim", () => {
    expect(ocrFenceWhere("inv1", 2)).toEqual({ id: "inv1", status: "ANALYZING", ocrAttempts: 2 });
  });

  it("un claim posterior (otro ocrAttempts) deja fuera a la ejecución anterior", () => {
    expect(ocrFenceWhere("inv1", 2)).not.toEqual(ocrFenceWhere("inv1", 3));
  });
});

describe("stuckAnalyzingWhere", () => {
  it("solo ANALYZING sin tocar desde el corte y con intentos pendientes", () => {
    const cutoff = new Date("2026-09-26T10:00:00Z");
    expect(stuckAnalyzingWhere(cutoff)).toEqual({
      status: "ANALYZING",
      updatedAt: { lt: cutoff },
      ocrAttempts: { lt: MAX_OCR_RETRIES },
    });
  });
});

describe("facturas con el análisis parado (F-008, sin salida)", () => {
  const cutoff = new Date("2026-09-26T10:00:00Z");

  it("el corte es el mismo para el cron, el reproceso manual y el banner", () => {
    const now = Date.parse("2026-09-26T10:05:00Z");
    expect(stuckAnalyzingCutoff(now).getTime()).toBe(now - STUCK_ANALYZING_MS);
  });

  it("el cron pasa a OCR_ERROR solo las paradas que ya agotaron los reintentos", () => {
    expect(exhaustedAnalyzingWhere(cutoff)).toEqual({
      status: "ANALYZING",
      updatedAt: { lt: cutoff },
      ocrAttempts: { gte: MAX_OCR_RETRIES },
    });
  });

  it("el reproceso manual no mira los intentos", () => {
    expect(manualStuckAnalyzingWhere("inv1", cutoff)).toEqual({ id: "inv1", status: "ANALYZING", updatedAt: { lt: cutoff } });
  });

  it("el banner la da por parada pasado el corte, y solo en UPLOADED o ANALYZING", () => {
    const now = Date.parse("2026-09-26T10:00:00Z");
    const old = new Date(now - STUCK_ANALYZING_MS - 1000);
    const recent = new Date(now - 60_000);
    expect(isOcrStalled("ANALYZING", old, now)).toBe(true);
    expect(isOcrStalled("UPLOADED", old.toISOString(), now)).toBe(true);
    expect(isOcrStalled("ANALYZING", recent, now)).toBe(false);
    expect(isOcrStalled("PENDING_REVIEW", old, now)).toBe(false);
  });
});
