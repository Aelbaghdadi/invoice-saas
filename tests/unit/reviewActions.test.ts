import { describe, it, expect } from "vitest";
import type { InvoiceStatus } from "@prisma/client";
import {
  REPLACED_REOPEN_ERROR,
  UNCLASSIFIED_VALIDATE_ERROR,
  REVIEW_LOCKED_STATUSES,
  isReviewReadOnly,
  STATUS_LABELS,
  reviewActionBlockReason,
  reviewAllowedFrom,
  reviewLockReason,
  reviewTargetBlockReason,
  reviewTargetWhere,
  type ReviewAction,
} from "@/lib/invoiceStatuses";

const ACTIONS: ReviewAction[] = ["save", "validate", "reject", "split"];

describe("reviewAllowedFrom", () => {
  it.each(ACTIONS)("%s nunca admite UPLOADED, ANALYZING, SPLIT_SOURCE ni PENDING_ROUTING", (action) => {
    for (const locked of REVIEW_LOCKED_STATUSES) {
      expect(reviewAllowedFrom(action)).not.toContain(locked);
      expect(reviewAllowedFrom(action, { reopen: true })).not.toContain(locked);
    }
  });

  it("validar sin reabrir no admite REJECTED; reabriendo, solo REJECTED", () => {
    expect(reviewAllowedFrom("validate")).not.toContain("REJECTED");
    expect(reviewAllowedFrom("validate", { reopen: true })).toEqual(["REJECTED"]);
  });

  it("validar admite las pendientes de revisión y la corrección de una validada", () => {
    for (const s of ["PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR", "VALIDATED"] as InvoiceStatus[]) {
      expect(reviewAllowedFrom("validate")).toContain(s);
    }
  });

  it("rechazar y dividir no admiten REJECTED ni EXPORTED (legacy)", () => {
    for (const action of ["reject", "split"] as ReviewAction[]) {
      expect(reviewAllowedFrom(action)).not.toContain("REJECTED");
      expect(reviewAllowedFrom(action)).not.toContain("EXPORTED");
      expect(reviewAllowedFrom(action)).toContain("PENDING_REVIEW");
    }
  });

  it("cubre todos los estados del enum (sale de STATUS_LABELS)", () => {
    const all = Object.keys(STATUS_LABELS) as InvoiceStatus[];
    expect(new Set([...reviewAllowedFrom("save"), ...REVIEW_LOCKED_STATUSES])).toEqual(new Set(all));
  });
});

describe("reviewActionBlockReason", () => {
  it("null cuando la acción vale", () => {
    expect(reviewActionBlockReason("PENDING_REVIEW", "validate")).toBeNull();
    expect(reviewActionBlockReason("REJECTED", "validate", { reopen: true })).toBeNull();
    expect(reviewActionBlockReason("REJECTED", "save")).toBeNull();
  });

  it.each(ACTIONS)("en análisis, %s explica que hay que esperar", (action) => {
    expect(reviewActionBlockReason("ANALYZING", action)).toMatch(/analizando/);
    expect(reviewActionBlockReason("UPLOADED", action)).toMatch(/analizando/);
  });

  it.each(ACTIONS)("dividida, %s dice que es solo de consulta", (action) => {
    expect(reviewActionBlockReason("SPLIT_SOURCE", action)).toMatch(/solo de consulta/);
  });

  it.each(ACTIONS)("por clasificar, %s manda a «Por clasificar»", (action) => {
    expect(reviewActionBlockReason("PENDING_ROUTING", action)).toMatch(/Por clasificar/);
  });

  it("rechazada: validar pide «Reabrir y validar»; rechazar dice que ya lo está", () => {
    expect(reviewActionBlockReason("REJECTED", "validate")).toMatch(/Reabrir y validar/);
    expect(reviewActionBlockReason("REJECTED", "reject")).toBe("Esta factura ya está rechazada.");
    expect(reviewActionBlockReason("REJECTED", "split")).toMatch(/rechazada/);
  });

  it("reabrir una que ya no está rechazada pide recargar", () => {
    expect(reviewActionBlockReason("VALIDATED", "validate", { reopen: true })).toMatch(/ya no está rechazada/);
  });
});

describe("reviewLockReason e isReviewReadOnly (pantalla de revisión)", () => {
  it("bloquea con el mismo motivo que da el servidor", () => {
    for (const status of REVIEW_LOCKED_STATUSES) {
      expect(reviewLockReason(status)).toBe(reviewActionBlockReason(status, "save"));
      expect(reviewLockReason(status)).toBeTruthy();
    }
  });

  it("no bloquea las abiertas (rechazada y exportada tienen sus propios botones)", () => {
    for (const status of ["PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR", "VALIDATED", "REJECTED", "EXPORTED"] as const) {
      expect(reviewLockReason(status)).toBeNull();
    }
  });

  it("solo de consulta: la dividida y la por clasificar, no la que se está analizando", () => {
    expect(isReviewReadOnly("SPLIT_SOURCE")).toBe(true);
    expect(isReviewReadOnly("PENDING_ROUTING")).toBe(true);
    expect(isReviewReadOnly("ANALYZING")).toBe(false);
    expect(isReviewReadOnly("UPLOADED")).toBe(false);
    expect(isReviewReadOnly("PENDING_REVIEW")).toBe(false);
  });
});

describe("reviewTargetBlockReason y reviewTargetWhere (rechazada ya sustituida)", () => {
  it("no se reabre una rechazada que el cliente ya sustituyó", () => {
    expect(reviewTargetBlockReason("validate", { replacedById: "B", isUnclassifiedBucket: false }, { reopen: true })).toBe(REPLACED_REOPEN_ERROR);
    expect(reviewTargetWhere("validate", { reopen: true })).toEqual({
      client: { isUnclassifiedBucket: false },
      replacedBy: { is: null },
    });
  });

  it("sin sustituta, o sin reabrir, no cambia nada", () => {
    expect(reviewTargetBlockReason("validate", { replacedById: null, isUnclassifiedBucket: false }, { reopen: true })).toBeNull();
    expect(reviewTargetBlockReason("save", { replacedById: "B", isUnclassifiedBucket: false })).toBeNull();
    expect(reviewTargetWhere("validate")).toEqual({ client: { isUnclassifiedBucket: false } });
    expect(reviewTargetWhere("save", { reopen: true })).toEqual({});
  });
});

describe("buzón «Sin clasificar» (punto 6)", () => {
  const bucket = { replacedById: null, isUnclassifiedBucket: true };

  it("no se valida, ni reabriendo ni sin reabrir", () => {
    expect(reviewTargetBlockReason("validate", bucket, { reopen: true })).toBe(UNCLASSIFIED_VALIDATE_ERROR);
    expect(reviewTargetBlockReason("validate", bucket)).toBe(UNCLASSIFIED_VALIDATE_ERROR);
  });

  it("guardar, rechazar y dividir no cambian", () => {
    for (const action of ["save", "reject", "split"] as const) {
      expect(reviewTargetBlockReason(action, bucket)).toBeNull();
      expect(reviewTargetWhere(action)).toEqual({});
    }
  });
});
