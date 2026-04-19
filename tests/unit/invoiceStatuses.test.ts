import { describe, it, expect } from "vitest";
import {
  completionPercent,
  PENDING_WORK,
  DONE_WORK,
  NEEDS_REVIEW,
  LEGACY_STATUSES,
} from "@/lib/invoiceStatuses";

describe("completionPercent", () => {
  it("returns 0 when total is 0", () => {
    expect(completionPercent({ total: 0, validated: 0, rejected: 0 })).toBe(0);
  });

  it("returns 0 when total negative", () => {
    expect(completionPercent({ total: -5, validated: 0, rejected: 0 })).toBe(0);
  });

  it("counts validated + rejected as done", () => {
    expect(completionPercent({ total: 10, validated: 5, rejected: 5 })).toBe(100);
  });

  it("counts rejected alone as done (not stuck at 0)", () => {
    expect(completionPercent({ total: 4, validated: 0, rejected: 4 })).toBe(100);
  });

  it("includes optional exported in done", () => {
    expect(completionPercent({ total: 10, validated: 3, rejected: 2, exported: 5 })).toBe(100);
  });

  it("rounds to nearest integer", () => {
    // 1/3 = 33.33 → 33
    expect(completionPercent({ total: 3, validated: 1, rejected: 0 })).toBe(33);
    // 2/3 = 66.66 → 67
    expect(completionPercent({ total: 3, validated: 2, rejected: 0 })).toBe(67);
  });

  it("partial", () => {
    expect(completionPercent({ total: 10, validated: 4, rejected: 1 })).toBe(50);
  });
});

describe("status lists", () => {
  it("PENDING_WORK and DONE_WORK do not overlap for active statuses", () => {
    const pendingActive = PENDING_WORK.filter((s) => !LEGACY_STATUSES.includes(s));
    const doneActive = DONE_WORK.filter((s) => !LEGACY_STATUSES.includes(s));
    for (const p of pendingActive) {
      expect(doneActive).not.toContain(p);
    }
  });

  it("NEEDS_REVIEW is subset of PENDING_WORK", () => {
    for (const s of NEEDS_REVIEW) {
      expect(PENDING_WORK).toContain(s);
    }
  });

  it("LEGACY_STATUSES contains ANALYZED and EXPORTED", () => {
    expect(LEGACY_STATUSES).toContain("ANALYZED");
    expect(LEGACY_STATUSES).toContain("EXPORTED");
  });
});
